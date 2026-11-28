//! Files attached to records (images, video, PDFs, meeting recordings, ...).
//!
//! Bytes are stored content-addressed in `files/<sha256>`; the `attachments`
//! table only holds metadata. Because a file's name *is* its hash, syncing with
//! Drive is a set comparison: upload what Drive lacks, download what this device
//! lacks, never re-transfer a file that is already there.
//!
//! Whether a file syncs: `sync_mode` 'on' / 'off' per attachment, or 'auto' =
//! size <= the shared limit (`app_settings.sync_max_mb`).

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::db::{self, new_id, now_ms, query_json};
use crate::error::{Error, Result};
use crate::AppState;

pub const DEFAULT_LIMIT_MB: f64 = 10.0;

pub fn files_dir(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().profile_dir().join("files")
}

fn uploads_dir(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().cache_dir.join("uploads")
}

pub fn local_path(app: &AppHandle, sha: &str) -> PathBuf {
    files_dir(app).join(sha)
}

fn valid_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn limit_bytes(app: &AppHandle) -> Result<u64> {
    let v: Option<String> = app.state::<AppState>().db.with(|c| Ok(c.query_row("SELECT value FROM app_settings WHERE key='sync_max_mb'", [], |r| r.get(0)).optional()?))?;
    let mb = v.and_then(|s| s.parse::<f64>().ok()).unwrap_or(DEFAULT_LIMIT_MB).max(0.0);
    Ok((mb * 1024.0 * 1024.0) as u64)
}

pub fn effective_sync(mode: &str, size: u64, limit: u64) -> bool {
    match mode {
        "on" => true,
        "off" => false,
        _ => size <= limit,
    }
}

// ---------------- Adding files ----------------

/// In-progress uploads from the webview (`<input type=file>` works the same on
/// PC and Android, so files arrive as chunks instead of paths).
impl Uploads {
    /// A file being sent in chunks (it lands in the active profile's store).
    pub fn busy(&self) -> bool {
        self.open.lock().map(|m| !m.is_empty()).unwrap_or(true)
    }
}

#[derive(Default)]
pub struct Uploads {
    open: Mutex<HashMap<String, PendingUpload>>,
    /// Held while a file is moved into the store and its row inserted, and
    /// while garbage is collected, so gc never sees a stored-but-unlisted file.
    store_lock: Mutex<()>,
}

struct PendingUpload {
    path: PathBuf,
    owner_table: String,
    owner_id: i64,
    name: String,
    mime: Option<String>,
    hasher: Sha256,
    size: u64,
}

pub fn begin(app: &AppHandle, owner_table: &str, owner_id: i64, name: &str, mime: Option<String>) -> Result<String> {
    crate::schema::table(owner_table).ok_or_else(|| Error::msg("알 수 없는 문서 종류"))?;
    let dir = uploads_dir(app);
    std::fs::create_dir_all(&dir)?;
    let token = format!("{}", new_id());
    let path = dir.join(&token);
    std::fs::File::create(&path)?;
    app.state::<AppState>().uploads.open.lock().unwrap().insert(
        token.clone(),
        PendingUpload { path, owner_table: owner_table.into(), owner_id, name: name.chars().take(200).collect(), mime, hasher: Sha256::new(), size: 0 },
    );
    Ok(token)
}

pub fn chunk(app: &AppHandle, token: &str, bytes: &[u8]) -> Result<()> {
    let state = app.state::<AppState>();
    let mut map = state.uploads.open.lock().unwrap();
    let up = map.get_mut(token).ok_or_else(|| Error::msg("업로드가 시작되지 않았습니다"))?;
    let mut f = std::fs::OpenOptions::new().append(true).open(&up.path)?;
    f.write_all(bytes)?;
    up.hasher.update(bytes);
    up.size += bytes.len() as u64;
    Ok(())
}

pub fn finish(app: &AppHandle, token: &str) -> Result<Value> {
    let up = app.state::<AppState>().uploads.open.lock().unwrap().remove(token).ok_or_else(|| Error::msg("업로드가 시작되지 않았습니다"))?;
    let sha = format!("{:x}", up.hasher.finalize());
    let st = app.state::<AppState>();
    let _g = st.uploads.store_lock.lock().unwrap();
    store(app, &up.path, &sha)?;
    insert_row(app, &up.owner_table, up.owner_id, None, &up.name, up.mime.as_deref(), up.size, &sha)
}

/// Temp files of uploads that never finished (app closed mid-upload).
pub fn clear_stale_uploads(app: &AppHandle) {
    let _ = std::fs::remove_dir_all(uploads_dir(app));
}

pub fn cancel(app: &AppHandle, token: &str) {
    if let Some(up) = app.state::<AppState>().uploads.open.lock().unwrap().remove(token) {
        let _ = std::fs::remove_file(up.path);
    }
}

/// Moves `src` into the content store (or drops it if that content exists).
fn store(app: &AppHandle, src: &Path, sha: &str) -> Result<()> {
    let dest = local_path(app, sha);
    std::fs::create_dir_all(dest.parent().unwrap())?;
    if dest.exists() {
        std::fs::remove_file(src)?;
    } else if std::fs::rename(src, &dest).is_err() {
        std::fs::copy(src, &dest)?;
        std::fs::remove_file(src)?;
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<(String, u64)> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        size += n as u64;
    }
    Ok((format!("{:x}", h.finalize()), size))
}

/// An attachment is only ever added to a record that exists - checked in the
/// same transaction as the insert. The live DB may have been replaced (a load
/// or merge) or the record deleted since the upload or recording began; the
/// stored file is then simply left for gc_local.
pub const NO_OWNER: &str = "첨부할 기록이 이미 지워져 첨부하지 않았습니다";

fn ensure_owner(tx: &rusqlite::Transaction, owner_table: &str, owner_id: i64) -> Result<()> {
    let t = crate::schema::table(owner_table).filter(|t| t.name != "attachments").ok_or_else(|| Error::msg(format!("unknown table {owner_table}")))?;
    let found = tx.query_row(&format!("SELECT 1 FROM {} WHERE id=?1", t.name), [owner_id], |_| Ok(())).optional()?.is_some();
    if !found {
        return Err(Error::msg(NO_OWNER));
    }
    Ok(())
}

fn insert_row(app: &AppHandle, owner_table: &str, owner_id: i64, role: Option<&str>, name: &str, mime: Option<&str>, size: u64, sha: &str) -> Result<Value> {
    let state = app.state::<AppState>();
    let mut row = serde_json::Map::new();
    row.insert("owner_table".into(), json!(owner_table));
    row.insert("owner_id".into(), json!(owner_id));
    row.insert("role".into(), json!(role));
    row.insert("name".into(), json!(name));
    row.insert("mime".into(), json!(mime));
    row.insert("size".into(), json!(size));
    row.insert("sha256".into(), json!(sha));
    row.insert("sync_mode".into(), json!("auto"));
    state.db.write(|tx| {
        ensure_owner(tx, owner_table, owner_id)?;
        // A file with a role (a meeting's recording) replaces the previous one -
        // in this same transaction, so the old one is never dropped without the new.
        if let Some(r) = role {
            tx.execute("DELETE FROM attachments WHERE owner_table=?1 AND owner_id=?2 AND role=?3", params![owner_table, owner_id, r])?;
        }
        db::upsert(tx, "attachments", &row)
    })
}

/// Takes ownership of a finished file (meeting recording / imported audio) and
/// attaches it with `role`, replacing any previous attachment with that role.
pub fn adopt_file(app: &AppHandle, src: &Path, owner_table: &str, owner_id: i64, role: &str, name: &str, mime: &str) -> Result<Value> {
    let (sha, size) = hash_file(src)?;
    let v = {
        let st = app.state::<AppState>();
    let _g = st.uploads.store_lock.lock().unwrap();
        store(app, src, &sha)?;
        insert_row(app, owner_table, owner_id, Some(role), name, Some(mime), size, &sha)?
    };
    gc_local(app)?;
    Ok(v)
}

/// Local file of the attachment with `role` on a record, if this device has it.
pub fn role_file(app: &AppHandle, owner_table: &str, owner_id: i64, role: &str) -> Result<Option<PathBuf>> {
    let sha: Option<String> = app.state::<AppState>().db.with(|c| {
        Ok(c.query_row("SELECT sha256 FROM attachments WHERE owner_table=?1 AND owner_id=?2 AND role=?3 ORDER BY id DESC LIMIT 1", params![owner_table, owner_id, role], |r| r.get(0)).optional()?)
    })?;
    Ok(sha.map(|s| local_path(app, &s)).filter(|p| p.exists()))
}

// ---------------- Status ----------------

/// Drive's file names (hashes) as of the last file sync, cached per device so
/// views can show "동기화됨 / 업로드 대기" without a network call.
pub fn remote_cache_path(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().profile_dir().join("remote_files.json")
}

pub fn remote_cache(app: &AppHandle) -> HashSet<String> {
    std::fs::read_to_string(remote_cache_path(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

#[derive(Serialize)]
pub struct AttachmentView {
    #[serde(flatten)]
    pub row: Value,
    pub local: bool,
    pub path: Option<String>,
    pub sync: bool,
    pub on_drive: bool,
    pub downloading: bool,
}

pub fn list(app: &AppHandle, owner_table: &str, owner_id: i64) -> Result<Vec<AttachmentView>> {
    let rows = app.state::<AppState>().db.with(|c| {
        query_json(c, "SELECT * FROM attachments WHERE owner_table=?1 AND owner_id=?2 ORDER BY created_at, id", &[owner_table.to_string().into(), owner_id.into()])
    })?;
    let limit = limit_bytes(app)?;
    let remote = remote_cache(app);
    let busy = app.state::<AppState>().file_sync.downloading.lock().unwrap().clone();
    Ok(rows
        .into_iter()
        .map(|r| {
            let sha = r["sha256"].as_str().unwrap_or("").to_string();
            let p = local_path(app, &sha);
            let local = valid_sha(&sha) && p.exists();
            let sync = effective_sync(r["sync_mode"].as_str().unwrap_or("auto"), r["size"].as_u64().unwrap_or(0), limit);
            AttachmentView { local, path: local.then(|| p.to_string_lossy().to_string()), sync, on_drive: remote.contains(&sha), downloading: busy.contains(&sha), row: r }
        })
        .collect())
}

/// Totals for the settings screen.
pub fn summary(app: &AppHandle) -> Result<Value> {
    let rows = app.state::<AppState>().db.with(|c| query_json(c, "SELECT sha256, size, sync_mode FROM attachments", &[]))?;
    let limit = limit_bytes(app)?;
    let (mut n, mut synced, mut synced_bytes, mut local_only, mut missing) = (0, 0, 0u64, 0, 0);
    let mut seen = HashSet::new();
    for r in rows {
        let sha = r["sha256"].as_str().unwrap_or("").to_string();
        if !seen.insert(sha.clone()) {
            continue;
        }
        n += 1;
        let size = r["size"].as_u64().unwrap_or(0);
        let local = local_path(app, &sha).exists();
        if effective_sync(r["sync_mode"].as_str().unwrap_or("auto"), size, limit) {
            synced += 1;
            synced_bytes += size;
        } else if local {
            local_only += 1;
        }
        if !local {
            missing += 1;
        }
    }
    Ok(json!({ "files": n, "synced": synced, "synced_bytes": synced_bytes, "local_only": local_only, "not_here": missing, "limit_mb": limit as f64 / 1024.0 / 1024.0 }))
}

pub fn set_limit_mb(app: &AppHandle, mb: f64) -> Result<()> {
    if !(0.0..=100_000.0).contains(&mb) {
        return Err(Error::msg("0 ~ 100000 MB 사이로 입력하세요"));
    }
    app.state::<AppState>().db.write(|tx| {
        tx.execute(
            "INSERT INTO app_settings(id, key, value, updated_at) VALUES(1, 'sync_max_mb', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            params![mb.to_string(), now_ms()],
        )?;
        Ok(())
    })
}

/// Deletes content-store files no attachment row references (any more).
pub fn gc_local(app: &AppHandle) -> Result<usize> {
    let st = app.state::<AppState>();
    // The rows and the files must be the same profile's, or this deletes files
    // another profile still uses: skip it while a switch is under way.
    let Ok(_profile) = crate::hold(&st, None) else {
        return Ok(0);
    };
    let _g = st.uploads.store_lock.lock().unwrap();
    let used: HashSet<String> = app.state::<AppState>().db.with(|c| {
        let mut s = c.prepare("SELECT DISTINCT sha256 FROM attachments")?;
        let v = s.query_map([], |r| r.get::<_, String>(0))?.collect::<std::result::Result<HashSet<_>, _>>()?;
        Ok(v)
    })?;
    let mut removed = 0;
    if let Ok(rd) = std::fs::read_dir(files_dir(app)) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if valid_sha(&name) && !used.contains(&name) && std::fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

// ---------------- Drive file sync ----------------

#[derive(Default)]
pub struct FileSync {
    /// Passes run one after another: a request that arrives during a pass waits
    /// and then runs its own full pass, so no change is ever skipped.
    pass: tokio::sync::Mutex<()>,
    pub downloading: Mutex<HashSet<String>>,
}

/// Brings Drive's file store in line with the (already merged) DB:
/// upload synced files Drive lacks, download synced files this device lacks,
/// delete Drive files nothing wants synced any more. Only differences move.
/// sha256 -> (size, a name) of every content some attachment wants synced.
fn wanted_files(app: &AppHandle) -> Result<HashMap<String, (u64, String)>> {
    let limit = limit_bytes(app)?;
    let rows = app.state::<AppState>().db.with(|c| query_json(c, "SELECT sha256, size, sync_mode, name FROM attachments", &[]))?;
    let mut wanted = HashMap::new();
    for r in &rows {
        let sha = r["sha256"].as_str().unwrap_or("").to_string();
        let size = r["size"].as_u64().unwrap_or(0);
        if valid_sha(&sha) && effective_sync(r["sync_mode"].as_str().unwrap_or("auto"), size, limit) {
            wanted.insert(sha, (size, r["name"].as_str().unwrap_or("").to_string()));
        }
    }
    Ok(wanted)
}

pub async fn sync_files(app: &AppHandle) -> Result<Value> {
    use tauri::Emitter;
    let state = app.state::<AppState>();
    // Bound to the active profile: no switch while this runs (see profiles.rs).
    let _profile = crate::hold(&state, None)?;
    let _pass = state.file_sync.pass.lock().await;
    // Everything this pass learns about Drive belongs to the account it started
    // with; after a switch it neither prunes nor records anything.
    let epoch = state.device.get().drive_epoch;
    let result = async {
        // A file syncs if *any* attachment using that content wants it.
        let wanted = wanted_files(app)?;
        let remote = crate::google::list_files(app, epoch).await?;
        let (mut up, mut down, mut removed) = (0, 0, 0);
        // One bad file (network drop, corrupt download) must not block the rest;
        // it is retried on the next pass.
        let mut failed: Vec<String> = Vec::new();
        let total = wanted.len();
        let mut now_remote: HashSet<String> = remote.keys().cloned().collect();
        for (done, (sha, (size, name))) in wanted.iter().enumerate() {
            // Another account now: `remote` is the old one's list; stop the pass.
            crate::google::drive_state(app, epoch)?;
            let local = local_path(app, sha);
            if local.exists() && !remote.contains_key(sha) {
                let _ = app.emit("files-progress", json!({ "stage": "upload", "name": name, "done": done, "total": total }));
                match crate::google::upload_file(app, epoch, sha, &local, *size).await {
                    Ok(()) => {
                        up += 1;
                        now_remote.insert(sha.clone());
                    }
                    Err(e) => failed.push(format!("{name}: {e}")),
                }
            } else if !local.exists() && remote.contains_key(sha) {
                let _ = app.emit("files-progress", json!({ "stage": "download", "name": name, "done": done, "total": total }));
                state.file_sync.downloading.lock().unwrap().insert(sha.clone());
                // Unmarked however this ends, also when the pass is dropped mid-download.
                struct Unmark<'a>(&'a std::sync::Mutex<HashSet<String>>, &'a str);
                impl Drop for Unmark<'_> {
                    fn drop(&mut self) {
                        if let Ok(mut d) = self.0.lock() {
                            d.remove(self.1);
                        }
                    }
                }
                let _unmark = Unmark(&state.file_sync.downloading, sha);
                let r = crate::google::download_file(app, epoch, &remote[sha], &local, sha).await;
                match r {
                    Ok(()) => down += 1,
                    Err(e) => failed.push(format!("{name}: {e}")),
                }
            }
        }
        // Prune Drive only when this DB is exactly what Drive holds right now
        // (our DB unchanged since the last sync AND Drive's DB at that same
        // stamp), and judge "unused" from the attachment list read *now*, under
        // the DB-sync lock so no merge can swap the DB in while we decide.
        // The list read at the start of this pass may be stale by now.
        {
            let _no_db_sync = state.sync_lock.lock().await;
            // `remote` was listed with this account; a login (which resets the
            // state under this same lock) may have switched it since.
            crate::google::drive_state(app, epoch)?;
            let local_lm = state.db.last_modified()?;
            let synced = state.device.get().synced_local_modified;
            let drive_lm = crate::google::find_backup(app).await?.and_then(|f| f.local_modified);
            if synced == Some(local_lm) && drive_lm == Some(local_lm) {
                let wanted_now = wanted_files(app)?;
                // An edit between the stamp check and the read changes the stamp.
                if state.db.last_modified()? == local_lm {
                    for (sha, id) in &remote {
                        if wanted_now.contains_key(sha) {
                            continue;
                        }
                        match crate::google::delete_file(app, epoch, id).await {
                            Ok(()) => {
                                now_remote.remove(sha);
                                removed += 1;
                            }
                            Err(e) => failed.push(format!("drive cleanup: {e}")),
                        }
                    }
                }
            }
        }
        // Under the config lock, like the reset that removes it on a switch.
        let bytes = serde_json::to_vec(&now_remote)?;
        let cache = remote_cache_path(app);
        let mut wrote = Ok(());
        crate::google::record_drive(app, epoch, |_| wrote = std::fs::write(&cache, &bytes))?;
        wrote?;
        Ok::<Value, Error>(json!({ "uploaded": up, "downloaded": down, "removed_from_drive": removed, "failed": failed }))
    }
    .await;
    // Records deleted since (with their attachment rows) leave unreferenced files.
    let _ = gc_local(app);
    let _ = app.emit("files-synced", &result.as_ref().ok());
    result
}

#[cfg(test)]
mod tests {
    use super::effective_sync;

    /// An attachment can only join a record that is there (checked in the insert's transaction).
    #[test]
    fn attachments_only_join_existing_records() {
        let dir = std::env::temp_dir().join(format!("sm-att-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::db::Db::open(dir.join("live.db")).unwrap();
        let memo = db.write(|tx| crate::db::upsert(tx, "memos", serde_json::json!({ "title": "m" }).as_object().unwrap())).unwrap();
        let id = memo["id"].as_i64().unwrap();
        db.write(|tx| super::ensure_owner(tx, "memos", id)).unwrap();
        let gone = db.write(|tx| super::ensure_owner(tx, "memos", id + 1)).unwrap_err().to_string();
        assert_eq!(gone, super::NO_OWNER);
        assert!(db.write(|tx| super::ensure_owner(tx, "no_such_table", id)).is_err());
        assert!(db.write(|tx| super::ensure_owner(tx, "attachments", id)).is_err(), "attachments don't own attachments");
    }

    #[test]
    fn per_file_override_beats_size_limit() {
        let mb = 1024 * 1024;
        assert!(effective_sync("auto", 10 * mb, 10 * mb), "exactly at the limit syncs");
        assert!(!effective_sync("auto", 10 * mb + 1, 10 * mb));
        assert!(effective_sync("on", 500 * mb, 10 * mb), "important big PDF");
        assert!(!effective_sync("off", 1000, 10 * mb), "small image the user excluded");
    }
}
