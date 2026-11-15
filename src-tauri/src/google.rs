//! Google OAuth + Drive (backup file) + Calendar REST calls.
//! Desktop uses the loopback-redirect PKCE flow; Android asks the native
//! plugin (Google Identity AuthorizationClient) for an access token.

use base64::Engine;
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::AppState;

pub const SCOPES: &str = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const BACKUP_NAME: &str = "selfmanager-backup.db";
const FOLDER_NAME: &str = "SelfManager";

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    expires_in: Option<i64>,
    refresh_token: Option<String>,
}

/// Device setting first, then the client baked in from .env at build time.
pub fn client(g: &crate::device::GoogleConfig) -> crate::device::GoogleConfig {
    let mut g = g.clone();
    if g.client_id.trim().is_empty() {
        g.client_id = option_env!("SM_GOOGLE_CLIENT_ID").unwrap_or("").to_string();
    }
    if g.client_secret.trim().is_empty() {
        g.client_secret = option_env!("SM_GOOGLE_CLIENT_SECRET").unwrap_or("").to_string();
    }
    g
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn with_secret<'a>(mut form: Vec<(&'a str, &'a str)>, secret: &'a str) -> Vec<(&'a str, &'a str)> {
    if !secret.trim().is_empty() {
        form.push(("client_secret", secret.trim()));
    }
    form
}

fn now_s() -> i64 {
    chrono::Utc::now().timestamp()
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(Error::msg(format!("Google API {status}: {}", body.chars().take(400).collect::<String>())))
}

// ---------------- Desktop OAuth ----------------

#[cfg(desktop)]
pub async fn login_desktop(app: &AppHandle) -> Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let state = app.state::<AppState>();
    let cfg = client(&state.device.get().google);
    if cfg.client_id.trim().is_empty() {
        return Err(Error::msg("구글 OAuth 클라이언트 ID가 없습니다 (.env의 GOOGLE_CLIENT_ID 또는 설정 화면)"));
    }
    let verifier: String = rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(64).map(char::from).collect();
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let csrf: String = rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(24).map(char::from).collect();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent&state={}",
        urlencoding::encode(cfg.client_id.trim()),
        urlencoding::encode(&redirect),
        urlencoding::encode(SCOPES),
        challenge,
        csrf
    );
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| Error::msg(e.to_string()))?;

    // Wait (max 5 min) for the browser to hit the loopback redirect.
    let code = tokio::time::timeout(std::time::Duration::from_secs(300), async {
        loop {
            let (mut sock, _) = listener.accept().await?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await?;
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
            let query = path.split_once('?').map(|x| x.1).unwrap_or("");
            let mut code = None;
            let mut st = None;
            let mut err = None;
            for kv in query.split('&') {
                if let Some((k, v)) = kv.split_once('=') {
                    let v = urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default();
                    match k {
                        "code" => code = Some(v),
                        "state" => st = Some(v),
                        "error" => err = Some(v),
                        _ => {}
                    }
                }
            }
            if code.is_none() && err.is_none() {
                // favicon or similar; ignore
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                continue;
            }
            let ok = err.is_none() && st.as_deref() == Some(csrf.as_str());
            let html = if ok { "로그인 완료. 이 창을 닫고 앱으로 돌아가세요." } else { "로그인 실패. 앱에서 다시 시도하세요." };
            let body = format!("<html><meta charset='utf-8'><body style='font-family:sans-serif;padding:40px'>{html}</body></html>");
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
            if let Some(e) = err {
                return Err(Error::msg(format!("구글 로그인 거부: {e}")));
            }
            if !ok {
                return Err(Error::msg("OAuth state 불일치"));
            }
            return Ok::<String, Error>(code.unwrap());
        }
    })
    .await
    .map_err(|_| Error::msg("로그인 시간이 초과됐습니다 (5분)"))??;

    let tok: TokenResp = check(
        state
            .http
            .post(TOKEN_URL)
            .form(&with_secret(
                vec![
                    ("code", code.as_str()),
                    ("client_id", cfg.client_id.trim()),
                    ("redirect_uri", redirect.as_str()),
                    ("grant_type", "authorization_code"),
                    ("code_verifier", verifier.as_str()),
                ],
                &cfg.client_secret,
            ))
            .send()
            .await?,
    )
    .await?
    .json()
    .await?;
    let email = fetch_email(&state.http, &tok.access_token).await.ok();
    state.device.update(|d| {
        d.google.access_token = Some(tok.access_token.clone());
        d.google.expires_at = now_s() + tok.expires_in.unwrap_or(3600) - 60;
        if tok.refresh_token.is_some() {
            d.google.refresh_token = tok.refresh_token.clone();
        }
        d.google.email = email.clone();
        d.google.authorized = true;
    })?;
    Ok(email.unwrap_or_default())
}

async fn fetch_email(http: &reqwest::Client, token: &str) -> Result<String> {
    let v: Value = check(http.get("https://www.googleapis.com/oauth2/v3/userinfo").bearer_auth(token).send().await?).await?.json().await?;
    Ok(v["email"].as_str().unwrap_or("").to_string())
}

/// Returns a valid access token, refreshing (desktop) or asking the native
/// plugin (Android) when needed.
pub async fn access_token(app: &AppHandle) -> Result<String> {
    let state = app.state::<AppState>();
    let g = client(&state.device.get().google);
    if let Some(t) = &g.access_token {
        if g.expires_at > now_s() {
            return Ok(t.clone());
        }
    }
    #[cfg(mobile)]
    {
        if !g.authorized {
            return Err(Error::msg("구글 로그인이 필요합니다"));
        }
        let r = crate::mobile::google_authorize(app, false)?;
        state.device.update(|d| {
            d.google.access_token = Some(r.access_token.clone());
            d.google.expires_at = now_s() + 50 * 60;
        })?;
        return Ok(r.access_token);
    }
    #[cfg(desktop)]
    {
        let refresh = g.refresh_token.ok_or_else(|| Error::msg("구글 로그인이 필요합니다"))?;
        let tok: TokenResp = check(
            state
                .http
                .post(TOKEN_URL)
                .form(&with_secret(vec![("client_id", g.client_id.trim()), ("refresh_token", refresh.as_str()), ("grant_type", "refresh_token")], &g.client_secret))
                .send()
                .await?,
        )
        .await?
        .json()
        .await?;
        state.device.update(|d| {
            d.google.access_token = Some(tok.access_token.clone());
            d.google.expires_at = now_s() + tok.expires_in.unwrap_or(3600) - 60;
        })?;
        Ok(tok.access_token)
    }
}

#[cfg(mobile)]
pub async fn login_mobile(app: &AppHandle) -> Result<String> {
    let state = app.state::<AppState>();
    let r = crate::mobile::google_authorize(app, true)?;
    let email = match r.email.clone().filter(|e| !e.is_empty()) {
        Some(e) => Some(e),
        None => fetch_email(&state.http, &r.access_token).await.ok(),
    };
    state.device.update(|d| {
        d.google.access_token = Some(r.access_token.clone());
        d.google.expires_at = now_s() + 50 * 60;
        d.google.email = email.clone();
        d.google.authorized = true;
    })?;
    Ok(email.unwrap_or_default())
}

pub async fn logout(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let g = state.device.get().google;
    if let Some(t) = g.refresh_token.or(g.access_token) {
        let _ = state.http.post("https://oauth2.googleapis.com/revoke").form(&[("token", t)]).send().await;
    }
    state.device.update(|d| {
        d.google.access_token = None;
        d.google.refresh_token = None;
        d.google.email = None;
        d.google.authorized = false;
        d.google.expires_at = 0;
        d.drive_file_id = None;
        d.drive_folder_id = None;
        d.drive_files_folder_id = None;
        d.auto_backup = false;
        d.auto_load = false;
    })?;
    Ok(())
}

// ---------------- Drive ----------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct DriveFile {
    pub id: String,
    pub modified_time: Option<String>,
    pub size: Option<String>,
    /// `last_modified` of the uploaded DB contents (ms), stored as appProperty.
    pub local_modified: Option<i64>,
    pub device: Option<String>,
}

fn parse_drive_file(v: &Value) -> DriveFile {
    DriveFile {
        id: v["id"].as_str().unwrap_or("").to_string(),
        modified_time: v["modifiedTime"].as_str().map(String::from),
        size: v["size"].as_str().map(String::from),
        local_modified: v["appProperties"]["localModified"].as_str().and_then(|s| s.parse().ok()),
        device: v["appProperties"]["device"].as_str().map(String::from),
    }
}

/// drive.file scope only sees files this OAuth project created, so a name
/// query finds exactly our backup (shared by the desktop and Android clients
/// as long as both belong to the same Google Cloud project).
pub async fn find_backup(app: &AppHandle) -> Result<Option<DriveFile>> {
    let state = app.state::<AppState>();
    let token = access_token(app).await?;
    let q = format!("name='{BACKUP_NAME}' and trashed=false");
    let v: Value = check(
        state
            .http
            .get("https://www.googleapis.com/drive/v3/files")
            .bearer_auth(&token)
            .query(&[("q", q.as_str()), ("spaces", "drive"), ("fields", "files(id,name,modifiedTime,size,appProperties)"), ("orderBy", "modifiedTime desc")])
            .send()
            .await?,
    )
    .await?
    .json()
    .await?;
    let file = v["files"].as_array().and_then(|a| a.first()).map(parse_drive_file);
    if let Some(f) = &file {
        state.device.update(|d| d.drive_file_id = Some(f.id.clone()))?;
    }
    Ok(file)
}

async fn ensure_folder(app: &AppHandle, token: &str) -> Result<String> {
    let state = app.state::<AppState>();
    if let Some(id) = state.device.get().drive_folder_id {
        return Ok(id);
    }
    let q = format!("name='{FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    let v: Value = check(state.http.get("https://www.googleapis.com/drive/v3/files").bearer_auth(token).query(&[("q", q.as_str()), ("fields", "files(id)")]).send().await?).await?.json().await?;
    let id = match v["files"].as_array().and_then(|a| a.first()).and_then(|f| f["id"].as_str()) {
        Some(id) => id.to_string(),
        None => {
            let created: Value = check(
                state
                    .http
                    .post("https://www.googleapis.com/drive/v3/files")
                    .bearer_auth(token)
                    .json(&json!({"name": FOLDER_NAME, "mimeType": "application/vnd.google-apps.folder"}))
                    .send()
                    .await?,
            )
            .await?
            .json()
            .await?;
            created["id"].as_str().unwrap_or("").to_string()
        }
    };
    state.device.update(|d| d.drive_folder_id = Some(id.clone()))?;
    Ok(id)
}

/// Uploads the DB snapshot at `path` (streamed, resumable: no 5MB multipart limit).
pub async fn upload_backup(app: &AppHandle, path: &std::path::Path, local_modified: i64) -> Result<DriveFile> {
    let state = app.state::<AppState>();
    let token = access_token(app).await?;
    let size = tokio::fs::metadata(path).await?.len();
    let existing = match state.device.get().drive_file_id {
        Some(id) => Some(id),
        None => find_backup(app).await?.map(|f| f.id),
    };
    let device = if cfg!(target_os = "android") { "android" } else { "desktop" };
    let mut meta = json!({ "appProperties": { "localModified": local_modified.to_string(), "device": device } });
    if existing.is_none() {
        let folder = ensure_folder(app, &token).await?;
        meta["name"] = json!(BACKUP_NAME);
        meta["parents"] = json!([folder]);
    }
    let v = match resumable_upload(app, &token, path, size, meta, existing.as_deref()).await {
        Err(Error::Msg(m)) if m == "drive-file-missing" => {
            // The file was deleted from Drive; forget the id and create a new one.
            state.device.update(|d| d.drive_file_id = None)?;
            return Box::pin(upload_backup(app, path, local_modified)).await;
        }
        r => r?,
    };
    let f = parse_drive_file(&v);
    state.device.update(|d| d.drive_file_id = Some(f.id.clone()))?;
    Ok(f)
}

pub async fn download_backup(app: &AppHandle, id: &str) -> Result<Vec<u8>> {
    let state = app.state::<AppState>();
    let token = access_token(app).await?;
    let resp = check(state.http.get(format!("https://www.googleapis.com/drive/v3/files/{id}?alt=media")).bearer_auth(&token).send().await?).await?;
    Ok(resp.bytes().await?.to_vec())
}

// ---------------- Calendar ----------------

pub async fn calendar_list(app: &AppHandle, time_min: &str, time_max: &str) -> Result<Vec<Value>> {
    let state = app.state::<AppState>();
    let token = access_token(app).await?;
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let mut q: Vec<(&str, String)> = vec![
            ("timeMin", time_min.to_string()),
            ("timeMax", time_max.to_string()),
            ("singleEvents", "true".into()),
            ("showDeleted", "true".into()),
            ("maxResults", "2500".into()),
        ];
        if let Some(p) = &page {
            q.push(("pageToken", p.clone()));
        }
        let v: Value = check(state.http.get("https://www.googleapis.com/calendar/v3/calendars/primary/events").bearer_auth(&token).query(&q).send().await?).await?.json().await?;
        if let Some(items) = v["items"].as_array() {
            out.extend(items.iter().cloned());
        }
        match v["nextPageToken"].as_str() {
            Some(p) => page = Some(p.to_string()),
            None => break,
        }
    }
    Ok(out)
}

/// Insert (id = None) or update a primary-calendar event. Returns the API object.
pub async fn calendar_put(app: &AppHandle, gcal_id: Option<&str>, body: &Value) -> Result<Value> {
    let state = app.state::<AppState>();
    let token = access_token(app).await?;
    let base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    let req = match gcal_id {
        Some(id) => state.http.put(format!("{base}/{}", urlencoding::encode(id))),
        None => state.http.post(base),
    };
    Ok(check(req.bearer_auth(&token).json(body).send().await?).await?.json().await?)
}

pub async fn calendar_delete(app: &AppHandle, gcal_id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let token = access_token(app).await?;
    let resp = state.http.delete(format!("https://www.googleapis.com/calendar/v3/calendars/primary/events/{}", urlencoding::encode(gcal_id))).bearer_auth(&token).send().await?;
    // 404/410 = already gone, which is what we wanted.
    if resp.status().is_success() || resp.status().as_u16() == 404 || resp.status().as_u16() == 410 {
        Ok(())
    } else {
        check(resp).await.map(|_| ())
    }
}

// ---------------- Attachment files (SelfManager/files/<sha256>) ----------------

async fn ensure_files_folder(app: &AppHandle, token: &str) -> Result<String> {
    let state = app.state::<AppState>();
    if let Some(id) = state.device.get().drive_files_folder_id {
        return Ok(id);
    }
    let parent = ensure_folder(app, token).await?;
    let q = format!("name='files' and '{parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
    let v: Value = check(state.http.get("https://www.googleapis.com/drive/v3/files").bearer_auth(token).query(&[("q", q.as_str()), ("fields", "files(id)")]).send().await?).await?.json().await?;
    let id = match v["files"].as_array().and_then(|a| a.first()).and_then(|f| f["id"].as_str()) {
        Some(id) => id.to_string(),
        None => {
            let created: Value = check(
                state
                    .http
                    .post("https://www.googleapis.com/drive/v3/files")
                    .bearer_auth(token)
                    .json(&json!({"name": "files", "mimeType": "application/vnd.google-apps.folder", "parents": [parent]}))
                    .send()
                    .await?,
            )
            .await?
            .json()
            .await?;
            created["id"].as_str().unwrap_or("").to_string()
        }
    };
    state.device.update(|d| d.drive_files_folder_id = Some(id.clone()))?;
    Ok(id)
}

/// sha256 -> Drive file id of every stored attachment.
pub async fn list_files(app: &AppHandle) -> Result<std::collections::HashMap<String, String>> {
    let state = app.state::<AppState>();
    let token = access_token(app).await?;
    let folder = ensure_files_folder(app, &token).await?;
    let q = format!("'{folder}' in parents and trashed=false");
    let mut out = std::collections::HashMap::new();
    let mut page: Option<String> = None;
    loop {
        let mut query: Vec<(&str, String)> = vec![("q", q.clone()), ("fields", "nextPageToken,files(id,name)".into()), ("pageSize", "1000".into())];
        if let Some(p) = &page {
            query.push(("pageToken", p.clone()));
        }
        let v: Value = check(state.http.get("https://www.googleapis.com/drive/v3/files").bearer_auth(&token).query(&query).send().await?).await?.json().await?;
        for f in v["files"].as_array().into_iter().flatten() {
            if let (Some(name), Some(id)) = (f["name"].as_str(), f["id"].as_str()) {
                out.insert(name.to_string(), id.to_string());
            }
        }
        match v["nextPageToken"].as_str() {
            Some(p) => page = Some(p.to_string()),
            None => break,
        }
    }
    Ok(out)
}

/// Streams a file to Drive through a resumable session (no size limit, never
/// held in memory). `existing` = Drive id to overwrite, else a new file.
pub async fn resumable_upload(app: &AppHandle, token: &str, path: &std::path::Path, size: u64, meta: Value, existing: Option<&str>) -> Result<Value> {
    use futures_util::stream;
    use tokio::io::AsyncReadExt;
    let state = app.state::<AppState>();
    let fields = "fields=id,modifiedTime,size,appProperties";
    let url = match existing {
        Some(id) => format!("https://www.googleapis.com/upload/drive/v3/files/{id}?uploadType=resumable&{fields}"),
        None => format!("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&{fields}"),
    };
    let req = if existing.is_some() { state.http.patch(url) } else { state.http.post(url) };
    let init = req.bearer_auth(token).header("X-Upload-Content-Length", size.to_string()).json(&meta).send().await?;
    if init.status().as_u16() == 404 && existing.is_some() {
        return Err(Error::msg("drive-file-missing"));
    }
    let init = check(init).await?;
    let session = init.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| Error::msg("업로드 세션을 열지 못했습니다"))?.to_string();
    let file = tokio::fs::File::open(path).await?;
    let body = stream::unfold(file, |mut f| async move {
        let mut buf = vec![0u8; 1 << 20];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<Vec<u8>, std::io::Error>(buf), f))
            }
            Err(e) => Some((Err(e), f)),
        }
    });
    let resp = state
        .http
        .put(session)
        .timeout(std::time::Duration::from_secs(6 * 3600))
        .header("Content-Length", size.to_string())
        .body(reqwest::Body::wrap_stream(body))
        .send()
        .await?;
    Ok(check(resp).await?.json().await?)
}

pub async fn upload_file(app: &AppHandle, sha: &str, path: &std::path::Path, size: u64) -> Result<()> {
    let token = access_token(app).await?;
    let folder = ensure_files_folder(app, &token).await?;
    resumable_upload(app, &token, path, size, json!({ "name": sha, "parents": [folder] }), None).await?;
    Ok(())
}

/// Downloads to `<dest>.part`, checks the hash, then moves into place.
pub async fn download_file(app: &AppHandle, id: &str, dest: &std::path::Path, sha: &str) -> Result<()> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let state = app.state::<AppState>();
    let token = access_token(app).await?;
    let resp = check(state.http.get(format!("https://www.googleapis.com/drive/v3/files/{id}?alt=media")).timeout(std::time::Duration::from_secs(6 * 3600)).bearer_auth(&token).send().await?).await?;
    tokio::fs::create_dir_all(dest.parent().unwrap()).await?;
    let part = dest.with_extension("part");
    let mut f = tokio::fs::File::create(&part).await?;
    let mut h = Sha256::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        h.update(&chunk);
        f.write_all(&chunk).await?;
    }
    f.flush().await?;
    drop(f);
    if format!("{:x}", h.finalize()) != sha {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(Error::msg("받은 파일이 손상됐습니다 (해시 불일치)"));
    }
    tokio::fs::rename(&part, dest).await?;
    Ok(())
}

pub async fn delete_file(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let token = access_token(app).await?;
    let resp = state.http.delete(format!("https://www.googleapis.com/drive/v3/files/{id}")).bearer_auth(&token).send().await?;
    if resp.status().is_success() || resp.status().as_u16() == 404 {
        Ok(())
    } else {
        check(resp).await.map(|_| ())
    }
}
