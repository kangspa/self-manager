mod attachments;
mod calendar;
mod db;
mod device;
mod error;
mod google;
mod llm;
mod merge;
mod mobile;
mod models;
mod notif;
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
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub manual_path: PathBuf,
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

// ---------------- Generic data commands ----------------

#[tauri::command]
async fn db_list(state: State<'_, AppState>, table: String, query: Option<db::ListQuery>) -> Result<Vec<Value>> {
    let q = query.unwrap_or_default();
    state.db.with(|c| db::list(c, &table, &q))
}

#[tauri::command]
async fn db_get(state: State<'_, AppState>, table: String, id: i64) -> Result<Option<Value>> {
    state.db.with(|c| db::get(c, &table, id))
}

#[tauri::command]
async fn db_upsert(state: State<'_, AppState>, table: String, row: Map<String, Value>) -> Result<Value> {
    state.db.write(|tx| db::upsert(tx, &table, &row))
}

#[tauri::command]
async fn db_delete(state: State<'_, AppState>, table: String, id: i64) -> Result<()> {
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
async fn db_bulk(state: State<'_, AppState>, ops: Vec<BulkOp>) -> Result<Vec<Value>> {
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
async fn work_move(state: State<'_, AppState>, id: i64, project_id: Option<i64>) -> Result<()> {
    state.db.write(|tx| db::move_work_item(tx, id, project_id))
}

#[tauri::command]
async fn expense_dashboard(state: State<'_, AppState>, from: String, to: String) -> Result<Value> {
    state.db.with(|c| queries::expense_dashboard(c, &from, &to))
}

#[tauri::command]
async fn subscription_schedule(state: State<'_, AppState>, from: String, to: String) -> Result<Vec<Value>> {
    state.db.with(|c| queries::subscription_schedule(c, &from, &to))
}

#[tauri::command]
async fn daily_view(state: State<'_, AppState>, from: String, to: String) -> Result<Value> {
    state.db.with(|c| queries::daily_view(c, &from, &to))
}

// ---------------- Notifications → ledger ----------------

#[tauri::command]
fn notif_preview(rule: Value, title: String, text: String) -> Option<notif::Parsed> {
    notif::preview(&rule, &title, &text)
}

#[tauri::command]
async fn notif_ingest(state: State<'_, AppState>, items: Vec<notif::RawNotification>) -> Result<usize> {
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
async fn notif_sync(app: AppHandle) -> Result<usize> {
    notif_sync_inner(&app)
}

#[tauri::command]
async fn native_call(app: AppHandle, cmd: String) -> Result<Value> {
    mobile::passthrough(&app, &cmd)
}

// ---------------- Backup / sync ----------------

#[tauri::command]
async fn sync_status(app: AppHandle, with_drive: bool) -> Result<sync::SyncStatus> {
    sync::status(&app, with_drive).await
}

#[tauri::command]
async fn sync_manual_save(app: AppHandle) -> Result<i64> {
    sync::manual_save(&app)
}

#[tauri::command]
async fn sync_load_manual(app: AppHandle) -> Result<()> {
    sync::load_manual(&app)
}

#[tauri::command]
async fn sync_drive_backup(app: AppHandle) -> Result<sync::Outcome> {
    // Merges first when Drive changed too, so the other device's work is kept.
    sync::reconcile(&app, sync::Mode::Backup, true, None).await
}

/// Full sync; `prefer` resolves conflicts ("local" = this device's auto-saved DB).
#[tauri::command]
async fn sync_now(app: AppHandle, prefer: Option<merge::Prefer>) -> Result<sync::Outcome> {
    sync::reconcile(&app, sync::Mode::Full, true, prefer).await
}

#[tauri::command]
async fn sync_drive_load(app: AppHandle) -> Result<()> {
    sync::drive_load(&app).await
}

#[tauri::command]
async fn sync_set_auto(state: State<'_, AppState>, auto_backup: bool, auto_load: bool) -> Result<()> {
    state.device.update(|d| {
        d.auto_backup = auto_backup;
        d.auto_load = auto_load;
    })?;
    Ok(())
}

#[tauri::command]
async fn google_set_client(state: State<'_, AppState>, client_id: String, client_secret: String) -> Result<()> {
    state.device.update(|d| {
        d.google.client_id = client_id.trim().to_string();
        // Blank means "keep the stored secret" (the UI never echoes it back).
        if !client_secret.trim().is_empty() {
            d.google.client_secret = client_secret.trim().to_string();
        }
    })?;
    Ok(())
}

#[tauri::command]
async fn google_login(app: AppHandle) -> Result<String> {
    #[cfg(desktop)]
    return google::login_desktop(&app).await;
    #[cfg(mobile)]
    return google::login_mobile(&app).await;
}

#[tauri::command]
async fn google_logout(app: AppHandle) -> Result<()> {
    google::logout(&app).await
}

#[tauri::command]
async fn gcal_sync(app: AppHandle) -> Result<calendar::SyncReport> {
    calendar::sync(&app).await
}

#[tauri::command]
async fn event_delete(app: AppHandle, id: i64) -> Result<()> {
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
            "client_id": cfg.google.client_id,
            "has_secret": !cfg.google.client_secret.is_empty(),
            "email": cfg.google.email,
            "env_client": option_env!("SM_GOOGLE_CLIENT_ID").is_some(),
            "env_secret": option_env!("SM_GOOGLE_CLIENT_SECRET").is_some(),
        },
        "models_size": models::total_size(&app),
        "gcal_last_sync": cfg.gcal_last_sync,
        "platform": if cfg!(target_os = "android") { "android" } else { "desktop" },
        "ai_enabled": cfg!(feature = "ai"),
        "data_dir": app.state::<AppState>().data_dir,
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

fn set_meeting(app: &AppHandle, id: i64, fields: Value) -> Result<Value> {
    let mut row = fields.as_object().cloned().unwrap_or_default();
    row.insert("id".into(), json!(id));
    let v = app.state::<AppState>().db.write(|tx| db::upsert(tx, "meetings", &row))?;
    let _ = app.emit("meeting-updated", &v);
    Ok(v)
}

#[tauri::command]
async fn meeting_rec_start(app: AppHandle, id: i64) -> Result<()> {
    let path = stt::audio_path(&app, id);
    app.state::<AppState>().recorder.start(&path, id)?;
    set_meeting(&app, id, json!({ "status": "recording", "audio_path": path.to_string_lossy() }))?;
    Ok(())
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
    let id: i64 = request.headers().get("x-meeting-id").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).ok_or_else(|| Error::msg("x-meeting-id 누락"))?;
    state.recorder.append(id, &body_bytes(&request)?)
}

#[tauri::command]
async fn meeting_rec_stop(app: AppHandle, id: i64) -> Result<Value> {
    let dur = app.state::<AppState>().recorder.stop(id)?;
    let name = format!("녹음 {}.wav", chrono::Local::now().format("%Y-%m-%d %H%M"));
    attachments::adopt_file(&app, &stt::audio_path(&app, id), "meetings", id, "audio", &name, "audio/wav")?;
    set_meeting(&app, id, json!({ "status": "recorded", "duration_sec": dur, "audio_path": null }))
}

#[tauri::command]
async fn meeting_import(app: AppHandle, id: i64, path: String) -> Result<Value> {
    let dest = stt::audio_path(&app, id);
    let src = PathBuf::from(path);
    let src_name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "녹음.wav".into());
    let d2 = dest.clone();
    set_meeting(&app, id, json!({ "status": "importing" }))?;
    let dur = tauri::async_runtime::spawn_blocking(move || stt::import_audio(&src, &d2)).await.map_err(|e| Error::msg(e.to_string()))?;
    match dur {
        Ok(dur) => {
            let name = std::path::Path::new(&src_name).with_extension("wav").to_string_lossy().to_string();
            attachments::adopt_file(&app, &dest, "meetings", id, "audio", &name, "audio/wav")?;
            set_meeting(&app, id, json!({ "status": "recorded", "duration_sec": dur, "audio_path": null, "error": null }))
        }
        Err(e) => {
            set_meeting(&app, id, json!({ "status": "error", "error": e.to_string() }))?;
            Err(e)
        }
    }
}

fn job_start(app: &AppHandle, id: i64) -> Result<Arc<AtomicBool>> {
    let state = app.state::<AppState>();
    let mut jobs = state.ai_jobs.lock().unwrap();
    if jobs.contains_key(&id) {
        return Err(Error::msg("이미 처리 중입니다"));
    }
    let flag = Arc::new(AtomicBool::new(false));
    jobs.insert(id, flag.clone());
    Ok(flag)
}

fn job_end(app: &AppHandle, id: i64) {
    app.state::<AppState>().ai_jobs.lock().unwrap().remove(&id);
}

#[tauri::command]
async fn meeting_cancel(app: AppHandle, id: i64) {
    if let Some(f) = app.state::<AppState>().ai_jobs.lock().unwrap().get(&id) {
        f.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
async fn meeting_transcribe(app: AppHandle, id: i64) -> Result<Value> {
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
async fn meeting_summarize(app: AppHandle, id: i64) -> Result<Value> {
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

#[tauri::command]
async fn meeting_delete(app: AppHandle, id: i64) -> Result<()> {
    let _ = std::fs::remove_file(stt::audio_path(&app, id));
    app.state::<AppState>().db.write(|tx| db::delete(tx, "meetings", id))?;
    attachments::gc_local(&app)?;
    Ok(())
}

// ---------------- Attachments ----------------

#[tauri::command]
async fn att_list(app: AppHandle, owner_table: String, owner_id: i64) -> Result<Vec<attachments::AttachmentView>> {
    attachments::list(&app, &owner_table, owner_id)
}

#[tauri::command]
async fn att_begin(app: AppHandle, owner_table: String, owner_id: i64, name: String, mime: Option<String>) -> Result<String> {
    attachments::begin(&app, &owner_table, owner_id, &name, mime)
}

/// Raw body = next chunk of the file. Header `x-upload` = token from att_begin.
#[tauri::command]
fn att_chunk(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<()> {
    let token = request.headers().get("x-upload").and_then(|v| v.to_str().ok()).ok_or_else(|| Error::msg("x-upload 누락"))?.to_string();
    attachments::chunk(&app, &token, &body_bytes(&request)?)
}

#[tauri::command]
async fn att_finish(app: AppHandle, token: String) -> Result<Value> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || attachments::finish(&app2, &token)).await.map_err(|e| Error::msg(e.to_string()))?
}

#[tauri::command]
async fn att_cancel(app: AppHandle, token: String) {
    attachments::cancel(&app, &token)
}

#[tauri::command]
async fn att_delete(app: AppHandle, id: i64) -> Result<()> {
    app.state::<AppState>().db.write(|tx| db::delete(tx, "attachments", id))?;
    attachments::gc_local(&app)?;
    Ok(())
}

/// Opens an attachment with the system's default app. Stored files are named by
/// hash, so a copy with the real name (and extension) is opened instead.
#[tauri::command]
async fn att_open(app: AppHandle, id: i64) -> Result<()> {
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
async fn att_summary(app: AppHandle) -> Result<Value> {
    attachments::summary(&app)
}

#[tauri::command]
async fn att_set_limit(app: AppHandle, mb: f64) -> Result<()> {
    attachments::set_limit_mb(&app, mb)
}

/// Syncs the DB first (so the file list is current), then only the files that differ.
#[tauri::command]
async fn files_sync(app: AppHandle) -> Result<Value> {
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
            let _ = app.emit("sync-error", format!("자동 로드 실패: {e}"));
        }
        if let Err(e) = notif_sync_inner(&app) {
            eprintln!("notif sync: {e}");
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Must be the first plugin: a second launch hands over to the running app
    // (its window comes to the front) and exits before touching any data.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
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
            let db = db::Db::open(data_dir.join("live.db")).map_err(|e| e.to_string())?;
            let device = device::Device::load(data_dir.join("device.json"));
            let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(600)).connect_timeout(std::time::Duration::from_secs(15)).build()?;
            app.manage(AppState {
                db,
                device,
                http,
                manual_path: data_dir.join("manual.db"),
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
            // Desktop: back up to Drive when the window's X is pressed.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let app = window.app_handle().clone();
                let state = app.state::<AppState>();
                if state.closing.load(Ordering::SeqCst) {
                    return;
                }
                let cfg = state.device.get();
                let needs = cfg.auto_backup && sync::logged_in(&app) && cfg.synced_local_modified != state.db.last_modified().ok();
                if !needs {
                    return;
                }
                api.prevent_close();
                state.closing.store(true, Ordering::SeqCst);
                let _ = app.emit("closing-backup", ());
                tauri::async_runtime::spawn(async move {
                    let r = tokio::time::timeout(std::time::Duration::from_secs(30), sync::auto_backup(&app)).await;
                    if !matches!(r, Ok(Ok(_))) {
                        eprintln!("auto backup on close failed: {:?}", r.map(|x| x.map_err(|e| e.to_string())));
                    }
                    app.exit(0);
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
            google_set_client,
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
            att_summary,
            att_set_limit,
            files_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
