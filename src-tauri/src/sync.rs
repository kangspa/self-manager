//! Manual local save/load and Google Drive sync.
//!
//! Copies of the data:
//! - live DB (`live.db`)    : the "auto-save", always equal to what the UI shows
//! - manual DB (`manual.db`): written only by the "수동 저장" button
//! - Drive backup           : `SelfManager/selfmanager-backup.db`
//! - base DB (`base.db`)    : what live and Drive last agreed on; the merge base
//!
//! Every DB stamps `meta.last_modified` on each write, and the Drive file
//! carries that stamp as an appProperty. Comparing those stamps with the one
//! recorded at the last sync tells which side changed, like git:
//! one side changed -> fast-forward; both changed -> three-way merge.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{now_ms, validate_db_file};
use crate::error::{Error, Result};
use crate::google::{self, DriveFile};
use crate::merge::{merge_files, Prefer};
use crate::AppState;

#[derive(Serialize)]
pub struct SyncStatus {
    pub auto_saved_at: i64,
    pub manual_saved_at: Option<i64>,
    pub manual_local_modified: Option<i64>,
    pub drive: Option<DriveFile>,
    pub drive_error: Option<String>,
    pub synced_local_modified: Option<i64>,
    pub last_backup_at: Option<i64>,
    pub last_load_at: Option<i64>,
    pub auto_backup: bool,
    pub auto_load: bool,
    pub logged_in: bool,
    pub email: Option<String>,
    /// The login this status belongs to: a screen keeps Drive info from an
    /// earlier status only while this is the same.
    pub session: u64,
    /// Live DB changed since it last matched Drive.
    pub unsynced: bool,
}

pub fn logged_in(app: &AppHandle) -> bool {
    let g = app.state::<AppState>().device.get().google;
    g.authorized && (g.refresh_token.is_some() || cfg!(mobile))
}

pub async fn status(app: &AppHandle, with_drive: bool) -> Result<SyncStatus> {
    let state = app.state::<AppState>();
    let auto = state.db.last_modified()?;
    let started = state.device.get().google.session;
    let (mut drive, mut drive_error) = if with_drive && logged_in(app) {
        match google::find_backup(app).await {
            Ok(f) => (f, None),
            Err(e) if google::is_stale_session_error(app, &e) => (None, None),
            Err(e) => (None, Some(e.to_string())),
        }
    } else {
        (None, None)
    };
    // Read after the Drive query: it may have found the login expired and ended it.
    let cfg = state.device.get();
    let li = logged_in(app);
    // A login or logout during the query: what it found was another session's.
    if cfg.google.session != started {
        drive = None;
        drive_error = None;
    }
    Ok(SyncStatus {
        auto_saved_at: auto,
        manual_saved_at: cfg.manual_saved_at.filter(|_| state.manual_path.exists()),
        manual_local_modified: cfg.manual_local_modified,
        drive,
        drive_error,
        synced_local_modified: cfg.synced_local_modified,
        last_backup_at: cfg.last_backup_at,
        last_load_at: cfg.last_load_at,
        auto_backup: cfg.auto_backup,
        auto_load: cfg.auto_load,
        logged_in: li,
        email: cfg.google.email,
        session: cfg.google.session,
        unsynced: cfg.synced_local_modified != Some(auto),
    })
}

pub fn manual_save(app: &AppHandle) -> Result<i64> {
    let state = app.state::<AppState>();
    let tmp = state.manual_path.with_extension("db.tmp");
    state.db.snapshot_to(&tmp)?;
    std::fs::rename(&tmp, &state.manual_path)?;
    let lm = state.db.last_modified()?;
    let now = now_ms();
    state.device.update(|d| {
        d.manual_saved_at = Some(now);
        d.manual_local_modified = Some(lm);
    })?;
    Ok(now)
}

pub fn load_manual(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    if !state.manual_path.exists() {
        return Err(Error::msg("수동 저장된 DB가 없습니다"));
    }
    validate_db_file(&state.manual_path)?;
    state.db.replace_with(&state.manual_path)?;
    let _ = app.emit("db-replaced", "manual");
    Ok(())
}

fn base_path(app: &AppHandle) -> std::path::PathBuf {
    app.state::<AppState>().data_dir.join("base.db")
}

/// Uploads the live DB as-is and records it as the new merge base.
async fn upload_live(app: &AppHandle) -> Result<DriveFile> {
    let state = app.state::<AppState>();
    let tmp = state.cache_dir.join("upload.db");
    state.db.snapshot_to(&tmp)?;
    // Stamp from the snapshot itself, so content and stamp always match even if
    // the user edits while we upload.
    let lm = validate_db_file(&tmp)?;
    let f = match google::upload_backup(app, &tmp, lm).await {
        Ok(f) => f,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
    };
    let base = base_path(app);
    let _ = tokio::fs::remove_file(&base).await;
    tokio::fs::rename(&tmp, &base).await?;
    let now = now_ms();
    state.device.update(|d| {
        d.synced_local_modified = Some(lm);
        d.last_backup_at = Some(now);
    })?;
    Ok(f)
}

async fn download_remote(app: &AppHandle, f: &DriveFile) -> Result<std::path::PathBuf> {
    let state = app.state::<AppState>();
    let bytes = google::download_backup(app, &f.id).await?;
    let tmp = state.cache_dir.join("download.db");
    tokio::fs::write(&tmp, &bytes).await?;
    if let Err(e) = validate_db_file(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(tmp)
}

/// Makes `file` the live DB.
/// - `expected_lm`: swap only if the live DB is still at this stamp (None = force,
///   for the explicit "불러오기" button). Returns false when the user edited meanwhile.
/// - `base_src` / `synced`: the state now known to be identical to Drive. After a
///   merge that is the *remote* file, not the merged one, until the merged result
///   is uploaded; otherwise a failed upload would make the next sync think only
///   Drive changed and overwrite the merged local changes.
/// What to record as the stamp both sides agree on after a swap.
enum SyncPoint {
    /// The swapped-in file *is* Drive's content (download): use its own stamp.
    Swapped,
    /// Drive's stamp as reported, possibly unknown. Used after a merge, where the
    /// live DB holds local changes Drive does not have yet.
    Drive(Option<i64>),
}

fn adopt(app: &AppHandle, file: &std::path::Path, why: &str, expected_lm: Option<i64>, base_src: &std::path::Path, synced: SyncPoint) -> Result<bool> {
    let state = app.state::<AppState>();
    // The agreed state is the file as received. Opening it may still repair it
    // (and bump the live stamp); that repair then counts as a local change.
    let source_lm = validate_db_file(file)?;
    let swapped = match expected_lm {
        Some(lm) => state.db.replace_if_unchanged(file, lm)?,
        None => {
            state.db.replace_with(file)?;
            true
        }
    };
    if !swapped {
        return Ok(false);
    }
    let base = base_path(app);
    if base_src != base.as_path() {
        std::fs::copy(base_src, &base)?;
    }
    // Never let an unknown Drive stamp become the merged stamp: that would mark
    // un-uploaded local changes as synced, and a failed upload would then lose them.
    let synced = match synced {
        SyncPoint::Swapped => Some(source_lm),
        SyncPoint::Drive(stamp) => stamp,
    };
    let now = now_ms();
    state.device.update(|d| {
        d.synced_local_modified = synced;
        d.last_load_at = Some(now);
    })?;
    let _ = app.emit("db-replaced", why);
    Ok(true)
}

/// "드라이브 백업 불러오기" button: explicit overwrite of the live DB.
pub async fn drive_load(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let _one_at_a_time = state.sync_lock.lock().await;
    let f = google::find_backup(app).await?.ok_or_else(|| Error::msg("드라이브에 백업이 없습니다"))?;
    let tmp = download_remote(app, &f).await?;
    let r = adopt(app, &tmp, "drive", None, &tmp, SyncPoint::Swapped);
    let _ = std::fs::remove_file(&tmp);
    r.map(|_| ())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Start / resume (auto-load): bring remote changes in.
    Load,
    /// Window close / app to background / "드라이브에 백업": push local changes out.
    Backup,
    /// Conflict resolution or manual sync: whatever is needed.
    Full,
}

#[derive(Serialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Nothing,
    Uploaded,
    Downloaded,
    Merged { from_local: usize, from_remote: usize, conflicts: usize },
    /// Local unchanged, Drive newer, but this run was only allowed to upload.
    RemoteNewer,
    /// Same data changed differently on both sides; the user must pick a side.
    NeedsChoice { local_saved_at: i64, drive_saved_at: Option<i64>, conflicts: usize },
}

fn drive_saved_ms(f: &DriveFile) -> Option<i64> {
    f.modified_time.as_deref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|d| d.timestamp_millis())
}

/// Decides from the saved timestamps what to do:
/// only one side changed since the last sync -> download or upload;
/// both changed -> three-way merge; real conflicts -> ask (or skip when not interactive).
pub async fn reconcile(app: &AppHandle, mode: Mode, interactive: bool, prefer: Option<Prefer>) -> Result<Outcome> {
    // Overlapping syncs would share upload/merge temp files; run them in turn
    // (the second one then simply sees the first one's result).
    let state = app.state::<AppState>();
    let _one_at_a_time = state.sync_lock.lock().await;
    // A pass returns None when the user edited during it; the next pass then
    // sees the edit and takes the merge path instead of overwriting it.
    for _ in 0..3 {
        if let Some(o) = reconcile_once(app, mode, interactive, prefer).await? {
            // Files follow the DB: move only the attachments that differ, in the
            // background so the UI never waits for large files.
            if !matches!(o, Outcome::NeedsChoice { .. }) && mode != Mode::Backup {
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::attachments::sync_files(&app2).await {
                        eprintln!("file sync: {e}");
                    }
                });
            }
            return Ok(o);
        }
    }
    Err(Error::msg("편집 중이라 동기화를 마치지 못했습니다. 잠시 후 다시 시도하세요"))
}

async fn reconcile_once(app: &AppHandle, mode: Mode, interactive: bool, prefer: Option<Prefer>) -> Result<Option<Outcome>> {
    let state = app.state::<AppState>();
    if !logged_in(app) {
        return Err(Error::msg("구글 로그인이 필요합니다"));
    }
    let cfg = state.device.get();
    let remote = google::find_backup(app).await?;
    let local_lm = state.db.last_modified()?;
    let synced = cfg.synced_local_modified;
    // A brand-new DB nobody has edited yet counts as unchanged.
    let untouched = state.db.meta_get("created_at")?.and_then(|v| v.parse::<i64>().ok()) == Some(local_lm);
    let local_changed = synced != Some(local_lm) && !(synced.is_none() && untouched);

    let Some(remote) = remote else {
        if mode != Mode::Load || cfg.auto_backup {
            upload_live(app).await?;
            return Ok(Some(Outcome::Uploaded));
        }
        return Ok(Some(Outcome::Nothing));
    };
    // Equal stamps alone don't prove equal content (two devices can edit the
    // same copy and land on the same stamp), so there is no shortcut here: only
    // "nothing changed since the last sync on either side" skips work. Anything
    // ambiguous goes through the merge below, which is harmless when both sides
    // really are the same.
    let remote_changed = remote.local_modified.is_none() || remote.local_modified != synced;

    match (local_changed, remote_changed) {
        (false, false) => Ok(Some(Outcome::Nothing)),
        (true, false) => {
            // Only this device changed. Auto-load also retries a backup that failed
            // earlier (e.g. the phone was offline) when auto-backup is on.
            if mode != Mode::Load || cfg.auto_backup {
                upload_live(app).await?;
                Ok(Some(Outcome::Uploaded))
            } else {
                Ok(Some(Outcome::Nothing))
            }
        }
        (false, true) => {
            if mode == Mode::Backup {
                return Ok(Some(Outcome::RemoteNewer));
            }
            let tmp = download_remote(app, &remote).await?;
            // Swap only if nothing was typed while downloading.
            let r = adopt(app, &tmp, "drive", Some(local_lm), &tmp, SyncPoint::Swapped);
            let _ = std::fs::remove_file(&tmp);
            Ok(r?.then_some(Outcome::Downloaded))
        }
        (true, true) => {
            let remote_file = download_remote(app, &remote).await?;
            let base = base_path(app);
            let has_base = base.exists();
            let c = |n: &str| state.cache_dir.join(n);
            let (local_snap, remote_copy, base_copy, out) = (c("merge-local.db"), c("merge-remote.db"), c("merge-base.db"), c("merge-out.db"));
            let _ = std::fs::remove_file(&out);
            let lm_before = state.db.last_modified()?;
            state.db.snapshot_to(&local_snap)?;
            std::fs::copy(&remote_file, &remote_copy)?;
            if has_base {
                std::fs::copy(&base, &base_copy)?;
            }
            let rep = merge_files(has_base.then_some(base_copy.as_path()), &local_snap, &remote_copy, &out, prefer);
            let rep = match rep {
                Ok(r) => r,
                Err(e) => {
                    let _ = std::fs::remove_file(&remote_file);
                    return Err(e);
                }
            };
            if !rep.applied {
                let _ = std::fs::remove_file(&remote_file);
                let o = Outcome::NeedsChoice { local_saved_at: local_lm, drive_saved_at: drive_saved_ms(&remote), conflicts: rep.conflicts };
                if interactive {
                    let _ = app.emit("sync-conflict", &o);
                    return Ok(Some(o));
                }
                return Ok(Some(Outcome::Nothing));
            }
            // The merge result now equals "remote + local changes": record the remote
            // file as the agreed state until the upload below succeeds.
            let swapped = adopt(app, &out, "merge", Some(lm_before), &remote_file, SyncPoint::Drive(remote.local_modified));
            let _ = std::fs::remove_file(&remote_file);
            if !swapped? {
                return Ok(None); // edited during the merge: redo with the new edit
            }
            upload_live(app).await?;
            Ok(Some(Outcome::Merged { from_local: rep.from_local, from_remote: rep.from_remote, conflicts: rep.conflicts }))
        }
    }
}

/// Called when the desktop window closes / the Android app goes to background.
/// Never prompts: an unresolved conflict waits for the next start.
pub async fn auto_backup(app: &AppHandle) -> Result<bool> {
    let cfg = app.state::<AppState>().device.get();
    if !cfg.auto_backup || !logged_in(app) {
        return Ok(false);
    }
    let o = reconcile(app, Mode::Backup, false, None).await?;
    // Closing / going to background: push new files now (the caller bounds the time;
    // an interrupted upload simply happens again next time).
    if !matches!(o, Outcome::NeedsChoice { .. } | Outcome::RemoteNewer) {
        crate::attachments::sync_files(app).await?;
    }
    Ok(matches!(o, Outcome::Uploaded | Outcome::Merged { .. }))
}

/// Called on start (both platforms) and on resume (Android).
pub async fn auto_load(app: &AppHandle) -> Result<()> {
    let cfg = app.state::<AppState>().device.get();
    if !cfg.auto_load || !logged_in(app) {
        return Ok(());
    }
    reconcile(app, Mode::Load, true, None).await.map(|_| ())
}
