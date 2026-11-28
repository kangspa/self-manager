mod attachments;
mod calendar;
mod chat;
mod db;
mod device;
mod error;
mod google;
mod llm;
mod merge;
mod mobile;
mod models;
mod notif;
mod profiles;
mod queries;
mod schema;
mod stt;
mod sync;

use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};

pub struct AppState {
    pub db: db::Db,
    pub device: device::Device,
    pub http: reqwest::Client,
    /// App data folder: shared files (AI models, profiles.json); also the
    /// default profile's folder.
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    /// Profiles and the active one's folder (see profiles.rs).
    pub profiles: Mutex<profiles::Registry>,
    pub profile_root: std::sync::RwLock<PathBuf>,
    /// Read-held by work bound to the active profile; a switch takes it.
    pub profile_lock: tokio::sync::RwLock<()>,
    pub recorder: stt::Recorder,
    pub downloads: models::Downloads,
    pub uploads: attachments::Uploads,
    pub file_sync: attachments::FileSync,
    /// One Drive sync at a time (resume, close, buttons can overlap; they share temp files).
    pub sync_lock: tokio::sync::Mutex<()>,
    /// Cancel flags of running transcribe/summarize jobs, by meeting id.
    ai_jobs: Mutex<HashMap<i64, Arc<AtomicBool>>>,
    closing: AtomicBool,
}

impl AppState {
    /// The active profile's data folder (DB, files, recordings, device.json).
    pub fn profile_dir(&self) -> PathBuf {
        self.profile_root.read().map(|p| p.clone()).unwrap_or_else(|_| self.data_dir.clone())
    }

    pub fn manual_path(&self) -> PathBuf {
        self.profile_dir().join("manual.db")
    }
}

/// Holds the active profile for as long as the caller runs: a profile switch
/// waits for it (briefly) or is refused, and while a switch is under way this
/// fails at once instead of running against the profile being swapped in.
///
/// `screen` is the profile the calling screen shows: every command a screen
/// calls requires it (the frontend sends it with every call), only the app's
/// own background work passes None. Checked under the lock: a call from a screen whose profile
/// was switched away - sent just before the switch, run just after - is
/// refused instead of writing into the other account.
pub fn hold<'a>(state: &'a AppState, screen: Option<&str>) -> Result<tokio::sync::RwLockReadGuard<'a, ()>> {
    let guard = state.profile_lock.try_read().map_err(|_| Error::msg(profiles::BUSY))?;
    if let Some(s) = screen {
        let active = state.profiles.lock().map(|r| r.active.clone()).map_err(|_| Error::msg("profiles lock poisoned"))?;
        if active != s {
            return Err(Error::msg(profiles::SCREEN_STALE));
        }
    }
    Ok(guard)
}

/// Runs `f` - replacing the whole DB (a load or merge) - only while no
/// recording, meeting job or upload is in flight, and keeps them from starting
/// until it is done (they register under the same jobs lock). The new content
/// may lack the meeting or record they would save into, leaving an attachment
/// that belongs to nothing.
pub fn without_record_work<T>(app: &AppHandle, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let state = app.state::<AppState>();
    let jobs = state.ai_jobs.lock().map_err(|_| Error::msg("jobs lock poisoned"))?;
    if !jobs.is_empty() || state.recorder.busy() || state.uploads.busy() {
        return Err(Error::msg("녹음·받아쓰기·요약·파일 업로드 중에는 DB를 불러오거나 합치지 않습니다. 끝난 뒤 다시 동기화해 주세요."));
    }
    f()
}

/// A transcription or summary still running (it writes into the active profile).
pub fn ai_jobs_running(app: &AppHandle) -> bool {
    app.state::<AppState>().ai_jobs.lock().map(|j| !j.is_empty()).unwrap_or(true)
}

// ---------------- Profiles ----------------

#[tauri::command]
async fn profile_list(app: AppHandle) -> Result<Value> {
    profiles::list(&app)
}

/// After a switch: tidy the new profile's files, then sync it like at start.
fn after_switch(app: &AppHandle) {
    let _ = attachments::gc_local(app);
    spawn_auto_load(app);
}

/// Payment notifications captured so far belong to the profile in use: take
/// them in before it goes, or they would land in the next one's ledger.
fn before_switch(app: &AppHandle) {
    if let Err(e) = notif_sync_inner(app) {
        eprintln!("notif sync before switch: {e}");
    }
}

#[tauri::command]
async fn profile_switch(app: AppHandle, id: String) -> Result<()> {
    before_switch(&app);
    if profiles::active_id(&app) != id {
        backup_before_leaving(&app).await?;
    }
    profiles::switch(&app, &id).await?;
    after_switch(&app);
    Ok(())
}

#[tauri::command]
async fn profile_add(app: AppHandle) -> Result<String> {
    before_switch(&app);
    backup_before_leaving(&app).await?;
    let id = profiles::add(&app).await?;
    after_switch(&app);
    Ok(id)
}

#[tauri::command]
async fn profile_remove(app: AppHandle, id: String) -> Result<()> {
    profiles::remove(&app, &id)
}

// ---------------- Generic data commands ----------------

#[tauri::command]
async fn db_list(state: State<'_, AppState>, table: String, query: Option<db::ListQuery>, profile_token: String) -> Result<Vec<Value>> {
    let _profile = hold(&state, Some(&profile_token))?;
    let q = query.unwrap_or_default();
    state.db.with(|c| db::list(c, &table, &q))
}

#[tauri::command]
async fn db_get(state: State<'_, AppState>, table: String, id: i64, profile_token: String) -> Result<Option<Value>> {
    let _profile = hold(&state, Some(&profile_token))?;
    state.db.with(|c| db::get(c, &table, id))
}

#[tauri::command]
async fn db_upsert(state: State<'_, AppState>, table: String, row: Map<String, Value>, profile_token: String) -> Result<Value> {
    let _profile = hold(&state, Some(&profile_token))?;
    state.db.write(|tx| db::upsert(tx, &table, &row))
}

#[tauri::command]
async fn db_delete(state: State<'_, AppState>, table: String, id: i64, profile_token: String) -> Result<()> {
    let _profile = hold(&state, Some(&profile_token))?;
    state.db.write(|tx| db::delete(tx, &table, id))
}

#[derive(Deserialize)]
struct BulkOp {
    table: String,
    #[serde(default)]
    row: Option<Map<String, Value>>,
    #[serde(default)]
    delete: Option<i64>,
}

/// Several writes in one transaction (reordering, template saves, ...).
#[tauri::command]
async fn db_bulk(state: State<'_, AppState>, ops: Vec<BulkOp>, profile_token: String) -> Result<Vec<Value>> {
    let _profile = hold(&state, Some(&profile_token))?;
    state.db.write(|tx| {
        let mut out = Vec::new();
        for op in &ops {
            if let Some(id) = op.delete {
                db::delete(tx, &op.table, id)?;
                out.push(Value::Null);
            } else if let Some(row) = &op.row {
                out.push(db::upsert(tx, &op.table, row)?);
            }
        }
        Ok(out)
    })
}

/// Move a work item (with its sub-items and AI notes) to another project, atomically.
#[tauri::command]
async fn work_move(state: State<'_, AppState>, id: i64, project_id: Option<i64>, profile_token: String) -> Result<()> {
    let _profile = hold(&state, Some(&profile_token))?;
    state.db.write(|tx| db::move_work_item(tx, id, project_id))
}

#[tauri::command]
async fn expense_dashboard(state: State<'_, AppState>, from: String, to: String, profile_token: String) -> Result<Value> {
    let _profile = hold(&state, Some(&profile_token))?;
    state.db.with(|c| queries::expense_dashboard(c, &from, &to))
}

#[tauri::command]
async fn subscription_schedule(state: State<'_, AppState>, from: String, to: String, profile_token: String) -> Result<Vec<Value>> {
    let _profile = hold(&state, Some(&profile_token))?;
    state.db.with(|c| queries::subscription_schedule(c, &from, &to))
}

#[tauri::command]
async fn daily_view(state: State<'_, AppState>, from: String, to: String, profile_token: String) -> Result<Value> {
    let _profile = hold(&state, Some(&profile_token))?;
    state.db.with(|c| queries::daily_view(c, &from, &to))
}

// ---------------- Notifications → ledger ----------------

#[tauri::command]
fn notif_preview(rule: Value, title: String, text: String) -> Option<notif::Parsed> {
    notif::preview(&rule, &title, &text)
}

#[tauri::command]
async fn notif_ingest(state: State<'_, AppState>, items: Vec<notif::RawNotification>, profile_token: String) -> Result<usize> {
    let _profile = hold(&state, Some(&profile_token))?;
    state.db.write(|tx| notif::ingest(tx, &items))
}

fn watched_packages(app: &AppHandle) -> Result<Vec<String>> {
    let rows = app.state::<AppState>().db.with(|c| db::query_json(c, "SELECT package FROM notif_apps WHERE enabled=1", &[]))?;
    Ok(rows.iter().filter_map(|r| r["package"].as_str().map(String::from)).collect())
}

/// Android: push the watched list to the listener and import its queue.
fn notif_sync_inner(app: &AppHandle) -> Result<usize> {
    if !cfg!(target_os = "android") {
        return Ok(0);
    }
    let _profile = hold(app.state::<AppState>().inner(), None)?;
    mobile::set_watched(app, watched_packages(app)?)?;
    let items = mobile::drain_notifications(app)?;
    if items.is_empty() {
        return Ok(0);
    }
    let n = app.state::<AppState>().db.write(|tx| notif::ingest(tx, &items))?;
    let _ = app.emit("notif-imported", n);
    Ok(n)
}

#[tauri::command]
async fn notif_sync(app: AppHandle, profile_token: String) -> Result<usize> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    notif_sync_inner(&app)
}

#[tauri::command]
async fn native_call(app: AppHandle, cmd: String) -> Result<Value> {
    mobile::passthrough(&app, &cmd)
}

// ---------------- Backup / sync ----------------

#[tauri::command]
async fn sync_status(app: AppHandle, with_drive: bool, profile_token: String) -> Result<sync::SyncStatus> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    sync::status(&app, with_drive).await
}

#[tauri::command]
async fn sync_manual_save(app: AppHandle, profile_token: String) -> Result<i64> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    sync::manual_save(&app)
}

#[tauri::command]
async fn sync_load_manual(app: AppHandle, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    sync::load_manual(&app)
}

#[tauri::command]
async fn sync_drive_backup(app: AppHandle, profile_token: String) -> Result<sync::Outcome> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    // Merges first when Drive changed too, so the other device's work is kept.
    sync::reconcile(&app, sync::Mode::Backup, true, None).await
}

/// Full sync; `prefer` resolves conflicts ("local" = this device's auto-saved DB).
#[tauri::command]
async fn sync_now(app: AppHandle, prefer: Option<merge::Prefer>, profile_token: String) -> Result<sync::Outcome> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    sync::reconcile(&app, sync::Mode::Full, true, prefer).await
}

#[tauri::command]
async fn sync_drive_load(app: AppHandle, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    sync::drive_load(&app).await
}

#[tauri::command]
async fn sync_set_auto(app: AppHandle, auto_backup: bool, auto_load: bool, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    if (auto_backup || auto_load) && !sync::logged_in(&app) {
        return Err(Error::msg("구글 로그인 후 켤 수 있습니다"));
    }
    let state = app.state::<AppState>();
    state.device.update(|d| {
        d.auto_backup = auto_backup;
        d.auto_load = auto_load;
    })?;
    Ok(())
}

#[tauri::command]
async fn google_login(app: AppHandle, profile_token: String) -> Result<String> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    #[cfg(desktop)]
    return google::login_desktop(&app).await;
    #[cfg(mobile)]
    return google::login_mobile(&app).await;
}

#[tauri::command]
async fn google_logout(app: AppHandle, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    google::logout(&app).await
}

#[tauri::command]
async fn gcal_sync(app: AppHandle, profile_token: String) -> Result<calendar::SyncReport> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    calendar::sync(&app).await
}

#[tauri::command]
async fn event_delete(app: AppHandle, id: i64, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    let state = app.state::<AppState>();
    let gid: Option<String> = state.db.with(|c| Ok(db::get(c, "events", id)?.and_then(|e| e["gcal_id"].as_str().map(String::from))))?;
    state.db.write(|tx| db::delete(tx, "events", id))?;
    if let Some(g) = gid {
        // Deleted remotely on the next calendar sync.
        calendar::add_tombstone(&app, &g)?;
    }
    Ok(())
}

// ---------------- Device settings (AI / STT) ----------------

#[tauri::command]
async fn device_settings(app: AppHandle) -> Result<Value> {
    let cfg = app.state::<AppState>().device.get();
    Ok(json!({
        "llm": cfg.llm, "stt": { "model": cfg.stt.model_file(), "language": cfg.stt.language, "threads": cfg.stt.threads },
        "google": {
            "email": cfg.google.email,
            "env_client": option_env!("SM_GOOGLE_CLIENT_ID").is_some_and(|v| !v.trim().is_empty()),
        },
        "models_size": models::total_size(&app),
        "total_ram": models::total_ram(),
        "gcal_last_sync": cfg.gcal_last_sync,
        "platform": if cfg!(target_os = "android") { "android" } else { "desktop" },
        "ai_enabled": cfg!(feature = "ai"),
        "data_dir": app.state::<AppState>().profile_dir(),
    }))
}

#[tauri::command]
async fn device_set_llm(state: State<'_, AppState>, llm: device::LlmConfig) -> Result<()> {
    state.device.update(|d| d.llm = llm)?;
    Ok(())
}

#[tauri::command]
async fn device_set_stt(state: State<'_, AppState>, stt: device::SttConfig) -> Result<()> {
    state.device.update(|d| d.stt = stt)?;
    Ok(())
}

// ---------------- Meetings ----------------

/// The meeting is still there. Its audio is only ever stored onto an existing
/// meeting, or the attachment would belong to nothing.
fn meeting_exists(app: &AppHandle, id: i64) -> Result<bool> {
    app.state::<AppState>().db.with(|c| Ok(db::get(c, "meetings", id)?.is_some()))
}

const NO_MEETING: &str = "이 회의는 이미 지워졌습니다";

fn set_meeting(app: &AppHandle, id: i64, fields: Value) -> Result<Value> {
    let mut row = fields.as_object().cloned().unwrap_or_default();
    row.insert("id".into(), json!(id));
    let v = app.state::<AppState>().db.write(|tx| db::upsert(tx, "meetings", &row))?;
    let _ = app.emit("meeting-updated", &v);
    Ok(v)
}

#[tauri::command]
/// Returns the recording's token; the chunks of this recording must carry it.
async fn meeting_rec_start(app: AppHandle, id: i64, profile_token: String) -> Result<String> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    let state = app.state::<AppState>();
    let path = stt::staged_path(&app, id);
    let before: Option<String> = state.db.with(|c| Ok(db::get(c, "meetings", id)?.and_then(|m| m["status"].as_str().map(String::from))))?;
    let token = {
        // Checked and opened under the jobs lock (job_start checks the other way
        // round under it too): a recording and a transcription / summary /
        // import of the same meeting never run at once, so neither can leave
        // the other's status behind.
        let jobs = state.ai_jobs.lock().unwrap();
        if jobs.contains_key(&id) {
            return Err(Error::msg("받아쓰기·요약·가져오기가 끝난 뒤 녹음해 주세요"));
        }
        // Under the same lock a delete registers itself: once it is done the
        // row is gone and this refuses; while it runs, the check above does.
        if !meeting_exists(&app, id)? {
            return Err(Error::msg(NO_MEETING));
        }
        state.recorder.start(&path, id, before)?
    };
    set_meeting(&app, id, json!({ "status": "recording", "audio_path": path.to_string_lossy() }))?;
    Ok(token)
}

/// Bytes of a binary IPC call. Desktop webviews deliver a raw body; Android's
/// WebView has no custom-protocol IPC, so Tauri falls back to postMessage and the
/// body arrives as JSON: `{"b64": "..."}` from our frontend, or a number array.
fn body_bytes(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>> {
    use base64::Engine;
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        tauri::ipc::InvokeBody::Json(Value::Object(o)) if o.get("b64").is_some() => base64::engine::general_purpose::STANDARD
            .decode(o["b64"].as_str().unwrap_or(""))
            .map_err(|e| Error::msg(format!("잘못된 데이터: {e}"))),
        tauri::ipc::InvokeBody::Json(Value::Array(a)) => Ok(a.iter().map(|v| v.as_u64().unwrap_or(0) as u8).collect()),
        _ => Err(Error::msg("파일 데이터 형식을 알 수 없습니다")),
    }
}

/// Raw body: little-endian i16 PCM at 16 kHz. Header `x-meeting-id`.
#[tauri::command]
fn meeting_rec_append(request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> Result<()> {
    // No profile lock: appends to the recording opened at start (see att_chunk).
    let id: i64 = request.headers().get("x-meeting-id").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).ok_or_else(|| Error::msg("x-meeting-id 누락"))?;
    let token = request.headers().get("x-rec-token").and_then(|v| v.to_str().ok()).ok_or_else(|| Error::msg("x-rec-token 누락"))?.to_string();
    state.recorder.append(id, &token, &body_bytes(&request)?)
}

#[tauri::command]
async fn meeting_rec_stop(app: AppHandle, id: i64, profile_token: String) -> Result<Value> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    // Saving is work on the meeting until the file is its attachment: no
    // delete, import or new recording slips in once the recorder lets go.
    let _flag = job_start_inner(&app, id, true)?;
    let _job = JobGuard(&app, id);
    let stopped = app.state::<AppState>().recorder.stop(id)?;
    let staged = stopped.path.clone();
    if stopped.seconds <= 0.0 {
        // Nothing was recorded (e.g. the microphone never started): the
        // meeting keeps its previous recording, transcript and status.
        let _ = std::fs::remove_file(&staged);
        let m = app.state::<AppState>().db.with(|c| db::get(c, "meetings", id))?.unwrap_or(Value::Null);
        if m["status"].as_str() != Some("recording") {
            // Changed meanwhile by something else: leave it as it is.
            return set_meeting(&app, id, json!({ "audio_path": null }));
        }
        return set_meeting(&app, id, json!({ "status": status_without_recording(&app, id, &m, stopped.before.as_deref())?, "audio_path": null }));
    }
    if !meeting_exists(&app, id)? {
        let _ = std::fs::remove_file(&staged);
        return Err(Error::msg(NO_MEETING));
    }
    let name = format!("녹음 {}.wav", chrono::Local::now().format("%Y-%m-%d %H%M"));
    attachments::adopt_file(&app, &staged, "meetings", id, "audio", &name, "audio/wav")?;
    set_meeting(&app, id, json!({ "status": "recorded", "duration_sec": stopped.seconds, "audio_path": null }))
}

#[tauri::command]
async fn meeting_import(app: AppHandle, id: i64, path: String, profile_token: String) -> Result<Value> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    let dest = stt::staged_path(&app, id);
    let src = PathBuf::from(path);
    let src_name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "녹음.wav".into());
    let d2 = dest.clone();
    let _flag = job_start(&app, id)?;
    let _job = JobGuard(&app, id);
    // A delete can't run while this job is registered; one done before is caught here.
    if !meeting_exists(&app, id)? {
        return Err(Error::msg(NO_MEETING));
    }
    set_meeting(&app, id, json!({ "status": "importing" }))?;
    let dur = tauri::async_runtime::spawn_blocking(move || stt::import_audio(&src, &d2)).await.map_err(|e| Error::msg(e.to_string()))?;
    match dur {
        Ok(dur) => {
            let name = std::path::Path::new(&src_name).with_extension("wav").to_string_lossy().to_string();
            attachments::adopt_file(&app, &dest, "meetings", id, "audio", &name, "audio/wav")?;
            set_meeting(&app, id, json!({ "status": "recorded", "duration_sec": dur, "audio_path": null, "error": null }))
        }
        Err(e) => {
            // This import's own file; nothing else uses it.
            let _ = std::fs::remove_file(&dest);
            set_meeting(&app, id, json!({ "status": "error", "error": e.to_string() }))?;
            Err(e)
        }
    }
}

/// The status to go back to after a recording that got no audio. The status
/// from before it is used if it describes a finished state; one that says work
/// is under way (left by a crash, say) is not brought back - the status then
/// follows what the meeting actually has.
fn status_without_recording(app: &AppHandle, id: i64, m: &Value, before: Option<&str>) -> Result<Option<String>> {
    if let Some(b) = before.filter(|b| matches!(*b, "recorded" | "transcribed" | "done" | "error")) {
        return Ok(Some(b.to_string()));
    }
    let has = |k: &str| m[k].as_str().is_some_and(|s| !s.trim().is_empty());
    Ok(if has("summary_md") {
        Some("done".into())
    } else if has("transcript_json") {
        Some("transcribed".into())
    } else if attachments::role_file(app, "meetings", id, "audio")?.is_some() {
        Some("recorded".into())
    } else {
        // Nothing yet: the table's default for a new meeting.
        Some("recording".into())
    })
}

fn job_start(app: &AppHandle, id: i64) -> Result<Arc<AtomicBool>> {
    job_start_inner(app, id, false)
}

/// Registers work on meeting `id`. While it is registered no recording starts,
/// no other job runs, the meeting can't be deleted and the profile can't be
/// switched. `while_recording`: the job is the recording's own save.
fn job_start_inner(app: &AppHandle, id: i64, while_recording: bool) -> Result<Arc<AtomicBool>> {
    let state = app.state::<AppState>();
    let mut jobs = state.ai_jobs.lock().unwrap();
    if jobs.contains_key(&id) {
        return Err(Error::msg("이미 처리 중입니다"));
    }
    // See meeting_rec_start: checked under the same lock.
    if !while_recording && state.recorder.is_recording(id) {
        return Err(Error::msg("녹음 중에는 할 수 없습니다. 녹음을 끝낸 뒤 다시 해 주세요."));
    }
    let flag = Arc::new(AtomicBool::new(false));
    jobs.insert(id, flag.clone());
    Ok(flag)
}

fn job_end(app: &AppHandle, id: i64) {
    app.state::<AppState>().ai_jobs.lock().unwrap().remove(&id);
}

/// Ends the job of a meeting when dropped (every return path).
struct JobGuard<'a>(&'a AppHandle, i64);
impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        job_end(self.0, self.1);
    }
}

#[tauri::command]
async fn meeting_cancel(app: AppHandle, id: i64, profile_token: String) -> Result<()> {
    // Only the screen of the profile the job runs in may stop it (ids alone could match).
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    if let Some(f) = app.state::<AppState>().ai_jobs.lock().unwrap().get(&id) {
        f.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
async fn meeting_transcribe(app: AppHandle, id: i64, profile_token: String) -> Result<Value> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    let cfg = app.state::<AppState>().device.get().stt;
    // The recording is an attachment; it may live only on another device if it
    // was larger than the sync limit (or excluded from sync).
    let wav = match attachments::role_file(&app, "meetings", id, "audio")? {
        Some(p) => p,
        None if stt::audio_path(&app, id).exists() => stt::audio_path(&app, id),
        None => return Err(Error::msg("녹음 파일이 이 기기에 없습니다 (동기화되지 않음)")),
    };
    let model = models::path_of(&app, models::Kind::Stt, &cfg.model_file()).ok_or_else(|| Error::msg("음성 인식 모델이 없습니다. 설정 › AI 모델에서 내려받고 선택하세요"))?;
    let cancel = job_start(&app, id)?;
    set_meeting(&app, id, json!({ "status": "transcribing", "error": null }))?;
    let app2 = app.clone();
    let lang = if cfg.language == "auto" { "auto".to_string() } else { cfg.language.clone() };
    let res = tauri::async_runtime::spawn_blocking(move || stt::transcribe(&app2, id, &wav, &model, &lang, cfg.threads, &cancel)).await.map_err(|e| Error::msg(e.to_string()));
    job_end(&app, id);
    match res.and_then(|r| r) {
        Ok(segs) => set_meeting(&app, id, json!({ "status": "transcribed", "transcript_json": serde_json::to_string(&segs)? })),
        Err(e) => {
            set_meeting(&app, id, json!({ "status": "recorded", "error": e.to_string() }))?;
            Err(e)
        }
    }
}

#[tauri::command]
async fn meeting_summarize(app: AppHandle, id: i64, profile_token: String) -> Result<Value> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    let state = app.state::<AppState>();
    let m = state.db.with(|c| db::get(c, "meetings", id))?.ok_or_else(|| Error::msg("회의가 없습니다"))?;
    let segs: Vec<stt::Segment> = m["transcript_json"].as_str().and_then(|s| serde_json::from_str::<Vec<Value>>(s).ok()).unwrap_or_default().into_iter().filter_map(|v| {
        Some(stt::Segment { start: v["start"].as_f64()?, end: v["end"].as_f64().unwrap_or(0.0), text: v["text"].as_str()?.to_string() })
    }).collect();
    let cfg = state.device.get();
    let model = models::path_of(&app, models::Kind::Llm, &cfg.llm.model).ok_or_else(|| Error::msg("요약 모델이 없습니다. 설정 › AI 모델에서 내려받고 선택하세요"))?;
    let prev_status = m["status"].as_str().unwrap_or("transcribed").to_string();
    let cancel = job_start(&app, id)?;
    set_meeting(&app, id, json!({ "status": "summarizing", "error": null }))?;
    let title = m["title"].as_str().unwrap_or("회의").to_string();
    let app2 = app.clone();
    let threads = cfg.stt.threads;
    let res = tauri::async_runtime::spawn_blocking(move || llm::summarize(&app2, id, &model, threads, &title, &segs, &cancel)).await.map_err(|e| Error::msg(e.to_string()));
    job_end(&app, id);
    match res.and_then(|r| r) {
        Ok(md) => set_meeting(&app, id, json!({ "status": "done", "summary_md": md })),
        Err(e) => {
            let back = if prev_status == "done" { "done" } else { "transcribed" };
            set_meeting(&app, id, json!({ "status": back, "error": e.to_string() }))?;
            Err(e)
        }
    }
}

// ---------------- Chatbot ----------------

#[tauri::command]
async fn chat_sessions(app: AppHandle, profile_token: String) -> Result<Value> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    chat::sessions(&app)
}

#[tauri::command]
async fn chat_messages(app: AppHandle, session: i64, profile_token: String) -> Result<Value> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    chat::messages(&app, session)
}

#[tauri::command]
async fn chat_send(app: AppHandle, session: Option<i64>, text: String, web: bool, profile_token: String) -> Result<Value> {
    // Held for the whole answer: it reads this profile's records and saves
    // into its conversations. A profile switch stops the answer first.
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    chat::send(&app, session, text, web).await
}

/// The 🌐 switch, also for an answer already being made.
/// Not async: commands like this run one after another in the order they
/// were sent, so fast clicks end in the state of the last click.
#[tauri::command]
fn chat_set_web(on: bool) -> bool {
    chat::set_web(on);
    on
}

#[tauri::command]
async fn chat_cancel() {
    chat::cancel();
}

#[tauri::command]
async fn chat_rename(app: AppHandle, session: i64, title: String, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    chat::rename(&app, session, &title)
}

#[tauri::command]
async fn chat_delete(app: AppHandle, session: i64, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    chat::delete(&app, session)
}

#[tauri::command]
async fn meeting_delete(app: AppHandle, id: i64, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    // Not while it records or other work runs on it, and nothing starts on it
    // while it is being deleted: they would write into a meeting that is gone.
    let _flag = job_start(&app, id).map_err(|_| Error::msg("녹음·받아쓰기·요약·가져오기가 끝난 뒤 지워 주세요"))?;
    let _job = JobGuard(&app, id);
    let _ = std::fs::remove_file(stt::audio_path(&app, id));
    app.state::<AppState>().db.write(|tx| db::delete(tx, "meetings", id))?;
    attachments::gc_local(&app)?;
    Ok(())
}

// ---------------- Attachments ----------------

#[tauri::command]
async fn att_list(app: AppHandle, owner_table: String, owner_id: i64, profile_token: String) -> Result<Vec<attachments::AttachmentView>> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    attachments::list(&app, &owner_table, owner_id)
}

#[tauri::command]
async fn att_begin(app: AppHandle, owner_table: String, owner_id: i64, name: String, mime: Option<String>, profile_token: String) -> Result<String> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    attachments::begin(&app, &owner_table, owner_id, &name, mime)
}

/// Raw body = next chunk of the file. Header `x-upload` = token from att_begin.
#[tauri::command]
fn att_chunk(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<()> {
    // No profile lock: a chunk only adds to the upload opened by att_begin, and a
    // switch is refused while one is open - so a tried switch never drops one.
    let token = request.headers().get("x-upload").and_then(|v| v.to_str().ok()).ok_or_else(|| Error::msg("x-upload 누락"))?.to_string();
    attachments::chunk(&app, &token, &body_bytes(&request)?)
}

#[tauri::command]
async fn att_finish(app: AppHandle, token: String, profile_token: String) -> Result<Value> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || attachments::finish(&app2, &token)).await.map_err(|e| Error::msg(e.to_string()))?
}

#[tauri::command]
async fn att_cancel(app: AppHandle, token: String) {
    attachments::cancel(&app, &token)
}

#[tauri::command]
async fn att_delete(app: AppHandle, id: i64, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    app.state::<AppState>().db.write(|tx| db::delete(tx, "attachments", id))?;
    attachments::gc_local(&app)?;
    Ok(())
}

/// Opens an attachment with the system's default app. Stored files are named by
/// hash, so a copy with the real name (and extension) is opened instead.
/// Saves a copy of an attachment where the user can find it: to `dest` (the
/// path picked in the save dialog, desktop) or to the phone's Download folder.
#[tauri::command]
async fn att_export(app: AppHandle, id: i64, dest: Option<String>, profile_token: String) -> Result<String> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    let row = app.state::<AppState>().db.with(|c| db::get(c, "attachments", id))?.ok_or_else(|| Error::msg("첨부 파일이 없습니다"))?;
    let src = attachments::local_path(&app, row["sha256"].as_str().unwrap_or(""));
    if !src.exists() {
        return Err(Error::msg("이 기기에 파일이 없습니다 (동기화되지 않음)"));
    }
    let name: String = row["name"].as_str().unwrap_or("file").chars().map(|c| if r#"/\:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    match dest {
        Some(d) => {
            std::fs::copy(&src, &d)?;
            Ok(d)
        }
        None => {
            mobile::save_to_downloads(&app, &src, &name, row["mime"].as_str().unwrap_or("application/octet-stream"))
        }
    }
}

#[tauri::command]
async fn att_open(app: AppHandle, id: i64, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    let row = app.state::<AppState>().db.with(|c| db::get(c, "attachments", id))?.ok_or_else(|| Error::msg("첨부 파일이 없습니다"))?;
    let src = attachments::local_path(&app, row["sha256"].as_str().unwrap_or(""));
    if !src.exists() {
        return Err(Error::msg("이 기기에 파일이 없습니다 (동기화되지 않음)"));
    }
    let name: String = row["name"].as_str().unwrap_or("file").chars().map(|c| if r#"/\:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    let dir = app.state::<AppState>().cache_dir.join("open").join(id.to_string());
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(name);
    std::fs::copy(&src, &dest)?;
    tauri_plugin_opener::open_path(dest, None::<&str>).map_err(|e| Error::msg(e.to_string()))
}

#[tauri::command]
async fn att_summary(app: AppHandle, profile_token: String) -> Result<Value> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    attachments::summary(&app)
}

#[tauri::command]
async fn att_set_limit(app: AppHandle, mb: f64, profile_token: String) -> Result<()> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    attachments::set_limit_mb(&app, mb)
}

/// Syncs the DB first (so the file list is current), then only the files that differ.
#[tauri::command]
async fn files_sync(app: AppHandle, profile_token: String) -> Result<Value> {
    let _profile = hold(app.state::<AppState>().inner(), Some(&profile_token))?;
    if let sync::Outcome::NeedsChoice { .. } = sync::reconcile(&app, sync::Mode::Full, true, None).await? {
        return Err(Error::msg("먼저 동기화 충돌에서 우선할 쪽을 골라 주세요"));
    }
    attachments::sync_files(&app).await
}

#[tauri::command]
async fn models_list(app: AppHandle) -> Vec<models::ModelInfo> {
    models::list(&app)
}

#[tauri::command]
async fn model_download(app: AppHandle, kind: models::Kind, file: Option<String>, url: Option<String>) -> Result<String> {
    models::download(&app, kind, file, url).await
}

#[tauri::command]
async fn model_cancel(app: AppHandle, file: String) {
    models::cancel_download(&app, &file)
}

#[tauri::command]
async fn model_delete(app: AppHandle, kind: models::Kind, file: String) -> Result<()> {
    models::delete(&app, kind, &file)?;
    // Forget the selection if the chosen model was removed.
    app.state::<AppState>().device.update(|d| match kind {
        models::Kind::Stt if d.stt.model_file() == file => d.stt.model.clear(),
        models::Kind::Llm if d.llm.model == file => d.llm.model.clear(),
        _ => {}
    })?;
    Ok(())
}

#[tauri::command]
async fn model_import(app: AppHandle, kind: models::Kind, path: String) -> Result<String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || models::import(&app2, kind, std::path::Path::new(&path))).await.map_err(|e| Error::msg(e.to_string()))?
}

// ---------------- App lifecycle ----------------

fn spawn_auto_load(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync::auto_load(&app).await {
            if !google::is_stale_session_error(&app, &e) {
                let _ = app.emit("sync-error", format!("자동 로드 실패: {e}"));
            }
        }
        if let Err(e) = notif_sync_inner(&app) {
            eprintln!("notif sync: {e}");
        }
        if let Err(e) = google::refresh_picture(&app).await {
            eprintln!("profile picture: {e}");
        }
    });
}

/// The profile being left has edits not on Drive yet: back them up first
/// (auto backup on), or they would wait until the next time that profile is
/// opened. Bounded: offline or slow, the switch goes ahead and the edits stay
/// on this device for the next backup.
async fn backup_before_leaving(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let cfg = state.device.get();
    if !(cfg.auto_backup && sync::logged_in(app)) {
        return Ok(());
    }
    // A file sync moving files right now: its files must not be left behind
    // half way (and the switch would be refused once it holds the profile).
    if state.file_sync.busy() {
        return Err(Error::msg("첨부 파일을 드라이브와 주고받는 중입니다. 끝난 뒤 다시 계정을 바꿔 주세요."));
    }
    if cfg.synced_local_modified == state.db.last_modified().ok() {
        return Ok(());
    }
    let _ = app.emit("switch-backup", ());
    match tokio::time::timeout(std::time::Duration::from_secs(20), sync::backup_db(app)).await {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => return Ok(()),
        Ok(Err(e)) => return Ok(eprintln!("backup before switch: {e}")),
        Err(_) => return Ok(eprintln!("backup before switch: timed out")),
    }
    // The profile's new files: nothing uploads them once it is no longer in
    // use, so the switch waits for them (a failed file is retried when the
    // profile is used again; the limit only guards against a stuck network).
    match tokio::time::timeout(std::time::Duration::from_secs(30 * 60), attachments::upload_files_before_exit(app)).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => eprintln!("files before switch: {e}"),
        Err(_) => eprintln!("files before switch: timed out"),
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Must be the first plugin: a second launch hands over to the running app
    // (its window comes to the front) and exits before touching any data.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // Opened again while the closed window was still backing up: stay open.
        if let Some(state) = app.try_state::<AppState>() {
            state.closing.store(false, Ordering::SeqCst);
        }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(mobile::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&cache_dir)?;
            // The profile used last; a profile folder that can't be opened falls
            // back to the default one rather than not starting at all.
            let mut registry = profiles::load(&data_dir);
            let mut profile_dir = profiles::dir_of(&data_dir, &registry.active);
            let db = match std::fs::create_dir_all(&profile_dir).map_err(error::Error::from).and_then(|_| db::Db::open(profile_dir.join("live.db"))) {
                Ok(db) => db,
                Err(_) if registry.active != profiles::DEFAULT_ID => {
                    registry.active = profiles::DEFAULT_ID.into();
                    profile_dir = data_dir.clone();
                    db::Db::open(profile_dir.join("live.db")).map_err(|e| e.to_string())?
                }
                Err(e) => return Err(e.to_string().into()),
            };
            let device = device::Device::load(profile_dir.join("device.json"));
            let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(600)).connect_timeout(std::time::Duration::from_secs(15)).build()?;
            app.manage(AppState {
                db,
                device,
                http,
                profiles: Mutex::new(registry),
                profile_root: std::sync::RwLock::new(profile_dir),
                profile_lock: tokio::sync::RwLock::new(()),
                data_dir,
                cache_dir,
                recorder: stt::Recorder::default(),
                downloads: models::Downloads::default(),
                uploads: attachments::Uploads::default(),
                file_sync: attachments::FileSync::default(),
                sync_lock: tokio::sync::Mutex::new(()),
                ai_jobs: Mutex::new(HashMap::new()),
                closing: AtomicBool::new(false),
            });
            #[cfg(desktop)]
            calendar::spawn_reminder_loop(app.handle().clone());
            // Files left behind by records deleted while offline / not logged in.
            attachments::clear_stale_uploads(app.handle());
            let _ = attachments::gc_local(app.handle());
            spawn_auto_load(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Desktop: back up to Drive when the window's X is pressed. The
            // window goes away at once and the backup finishes out of sight.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let app = window.app_handle().clone();
                let state = app.state::<AppState>();
                if state.closing.load(Ordering::SeqCst) {
                    return;
                }
                let cfg = state.device.get();
                // Also when nothing changed but a file sync is moving files right
                // now: quitting would cut its upload off.
                let syncing_files = state.file_sync.busy();
                let needs = cfg.auto_backup && sync::logged_in(&app) && (cfg.synced_local_modified != state.db.last_modified().ok() || syncing_files);
                if !needs {
                    return;
                }
                api.prevent_close();
                state.closing.store(true, Ordering::SeqCst);
                let _ = window.hide();
                tauri::async_runtime::spawn(async move {
                    // The window is gone already: large files get time to finish,
                    // and a file sync already running is let finish before exit.
                    let r = tokio::time::timeout(std::time::Duration::from_secs(30 * 60), async {
                        // Files only when the DB went up cleanly (no conflict
                        // waiting, Drive not newer), as in every backup.
                        let files_ok = sync::backup_db(&app).await?;
                        if files_ok {
                            // A file still being added from the screen finishes first.
                            let st = app.state::<AppState>();
                            while st.uploads.busy() {
                                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                            }
                            attachments::upload_files_before_exit(&app).await?;
                        }
                        Ok::<bool, Error>(files_ok)
                    })
                    .await;
                    if !matches!(r, Ok(Ok(_))) {
                        eprintln!("auto backup on close failed: {:?}", r.map(|x| x.map_err(|e| e.to_string())));
                    }
                    // Unless the app was opened again meanwhile (see single_instance).
                    if app.state::<AppState>().closing.load(Ordering::SeqCst) {
                        app.exit(0);
                    }
                });
            }
            // Android: onPause → back up; onResume → load + import notifications.
            #[cfg(mobile)]
            tauri::WindowEvent::Suspended => {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = sync::auto_backup(&app).await {
                        eprintln!("auto backup on suspend failed: {e}");
                    }
                });
            }
            #[cfg(mobile)]
            tauri::WindowEvent::Resumed => spawn_auto_load(window.app_handle()),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            db_list,
            db_get,
            db_upsert,
            work_move,
            db_delete,
            db_bulk,
            expense_dashboard,
            subscription_schedule,
            daily_view,
            notif_preview,
            notif_ingest,
            notif_sync,
            native_call,
            sync_status,
            sync_manual_save,
            sync_load_manual,
            sync_drive_backup,
            sync_drive_load,
            sync_set_auto,
            profile_list,
            profile_switch,
            profile_add,
            profile_remove,
            google_login,
            google_logout,
            gcal_sync,
            event_delete,
            device_settings,
            device_set_llm,
            device_set_stt,
            meeting_rec_start,
            meeting_rec_append,
            meeting_rec_stop,
            meeting_import,
            meeting_transcribe,
            meeting_summarize,
            chat_sessions,
            chat_messages,
            chat_send,
            chat_cancel,
            chat_set_web,
            chat_rename,
            chat_delete,
            meeting_delete,
            meeting_cancel,
            sync_now,
            models_list,
            model_download,
            model_cancel,
            model_delete,
            model_import,
            att_list,
            att_begin,
            att_chunk,
            att_finish,
            att_cancel,
            att_delete,
            att_open,
            att_export,
            att_summary,
            att_set_limit,
            files_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
