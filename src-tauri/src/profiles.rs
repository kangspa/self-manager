//! Profiles: one per Google account (personal, work, ...), each with its own
//! data folder - live DB, merge base, manual save, attachments, recordings and
//! the device.json holding its Google session, Drive state and sync points.
//!
//! The first profile ("default") is the app data folder itself, so the data
//! from before profiles stays where it is; the others live in
//! `profiles/<id>/`. AI model files stay shared in the app data folder.
//!
//! Switching swaps the open DB and settings in place. Work of a profile that
//! must not cross into another (Drive sync, file sync, calendar sync, a Drive
//! query, a login) holds `AppState::profile_lock` for reading; a switch only
//! happens when it can take that lock at once and nothing else is in flight
//! (recording, transcription, an upload), so it never waits on them and they
//! never finish into the wrong profile.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::AppState;

pub const DEFAULT_ID: &str = "default";
pub const SCREEN_STALE: &str = "다른 계정으로 바뀌어 이 화면의 요청은 처리하지 않았습니다.";
pub const BUSY: &str = "동기화·녹음·받아쓰기·업로드가 진행 중입니다. 끝난 뒤 다시 바꿔 주세요.";

#[derive(Serialize, Deserialize, Clone)]
pub struct Profile {
    pub id: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Registry {
    pub active: String,
    pub profiles: Vec<Profile>,
}

fn registry_path(data_dir: &Path) -> PathBuf {
    data_dir.join("profiles.json")
}

/// Ids are made here (hex) and only ever looked up in the registry, so they
/// can't point outside the profiles folder.
fn valid_id(id: &str) -> bool {
    id == DEFAULT_ID || (id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub fn dir_of(data_dir: &Path, id: &str) -> PathBuf {
    if id == DEFAULT_ID {
        data_dir.to_path_buf()
    } else {
        data_dir.join("profiles").join(id)
    }
}

pub fn load(data_dir: &Path) -> Registry {
    let mut r: Registry = std::fs::read_to_string(registry_path(data_dir)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    r.profiles.retain(|p| valid_id(&p.id));
    if !r.profiles.iter().any(|p| p.id == DEFAULT_ID) {
        r.profiles.insert(0, Profile { id: DEFAULT_ID.into(), created_at: 0 });
    }
    if !r.profiles.iter().any(|p| p.id == r.active) {
        r.active = DEFAULT_ID.into();
    }
    r
}

fn save(data_dir: &Path, r: &Registry) -> Result<()> {
    let path = registry_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(r)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn active_id(app: &AppHandle) -> String {
    app.state::<AppState>().profiles.lock().map(|r| r.active.clone()).unwrap_or_else(|_| DEFAULT_ID.into())
}

/// The Google account a profile's data belongs to (kept after logout or
/// expiry: the data is still that account's).
fn account_of(app: &AppHandle, id: &str) -> crate::device::GoogleConfig {
    let state = app.state::<AppState>();
    if id == active_id(app) {
        return state.device.get().google;
    }
    let path = dir_of(&state.data_dir, id).join("device.json");
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<crate::device::DeviceConfig>(&s).ok()).unwrap_or_default().google
}

/// Another profile already holding `email`, if any: one account per profile,
/// or two profiles would sync the same Drive backup.
pub fn profile_with_email(app: &AppHandle, email: &str, except: &str) -> Option<String> {
    let ids: Vec<String> = app.state::<AppState>().profiles.lock().map(|r| r.profiles.iter().map(|p| p.id.clone()).collect()).unwrap_or_default();
    ids.into_iter().filter(|id| id != except).find(|id| account_of(app, id).email.is_some_and(|e| e.eq_ignore_ascii_case(email)))
}

pub fn list(app: &AppHandle) -> Result<Value> {
    let r = app.state::<AppState>().profiles.lock().map_err(|_| Error::msg("profiles lock poisoned"))?.clone();
    let items: Vec<Value> = r
        .profiles
        .iter()
        .map(|p| {
            let g = account_of(app, &p.id);
            let logged_in = g.authorized && (g.refresh_token.is_some() || cfg!(mobile));
            json!({ "id": p.id, "email": g.email, "logged_in": logged_in, "active": p.id == r.active, "default": p.id == DEFAULT_ID })
        })
        .collect();
    Ok(json!({ "active": r.active, "profiles": items }))
}

/// Nothing of the current profile is in flight, so the switch can't race it.
fn idle(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    !state.recorder.busy() && !state.uploads.busy() && !crate::ai_jobs_running(app)
}

pub async fn switch(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    // Refused before waiting: a waiting switch makes new calls fail, which
    // would drop the chunks of a running recording or upload.
    if !idle(app) {
        return Err(Error::msg(BUSY));
    }
    // Every command touching profile data holds the lock for reading: quick
    // ones (a query) finish within moments; long ones (a sync, a login) make
    // this give up. It only tries (never waits in line), so calls keep running
    // normally until the moment the lock is actually free.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let _no_profile_work = loop {
        if let Ok(g) = state.profile_lock.try_write() {
            break g;
        }
        if std::time::Instant::now() >= deadline {
            return Err(Error::msg(BUSY));
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    };
    // Checked again now that nothing can start: a recording or upload begun
    // after the check above.
    if !idle(app) {
        return Err(Error::msg(BUSY));
    }
    let mut reg = state.profiles.lock().map_err(|_| Error::msg("profiles lock poisoned"))?;
    if !reg.profiles.iter().any(|p| p.id == id) {
        return Err(Error::msg("없는 프로필입니다"));
    }
    if reg.active == id {
        return Ok(());
    }
    let old_dir = dir_of(&state.data_dir, &reg.active);
    let dir = dir_of(&state.data_dir, id);
    std::fs::create_dir_all(&dir)?;
    // Each step is undone if a later one fails, so a failed switch leaves the
    // old profile fully in place.
    state.db.switch_to(dir.join("live.db"))?;
    if let Err(e) = state.device.switch_to(dir.join("device.json")) {
        let _ = state.db.switch_to(old_dir.join("live.db"));
        return Err(e);
    }
    let previous = reg.active.clone();
    reg.active = id.to_string();
    if let Err(e) = save(&state.data_dir, &reg) {
        reg.active = previous;
        let _ = state.device.switch_to(old_dir.join("device.json"));
        let _ = state.db.switch_to(old_dir.join("live.db"));
        return Err(e);
    }
    *state.profile_root.write().map_err(|_| Error::msg("profile lock poisoned"))? = dir;
    Ok(())
}

pub async fn add(app: &AppHandle) -> Result<String> {
    let state = app.state::<AppState>();
    let id = format!("{:016x}", rand::random::<u64>());
    {
        let mut reg = state.profiles.lock().map_err(|_| Error::msg("profiles lock poisoned"))?;
        reg.profiles.push(Profile { id: id.clone(), created_at: crate::db::now_ms() });
        if let Err(e) = save(&state.data_dir, &reg) {
            reg.profiles.retain(|p| p.id != id);
            return Err(e);
        }
    }
    if let Err(e) = switch(app, &id).await {
        // Leave no empty profile behind when it can't be opened right now.
        let _ = remove(app, &id);
        return Err(e);
    }
    Ok(id)
}

/// Deletes a profile that is not in use, with its data folder. Its Google
/// access is revoked first (best effort; it can also be revoked in the Google
/// account settings). The default profile is the app folder and stays.
pub fn remove(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    if id == DEFAULT_ID {
        return Err(Error::msg("기본 프로필은 지울 수 없습니다"));
    }
    let in_use = Error::msg("사용 중인 프로필은 지울 수 없습니다. 다른 프로필로 바꾼 뒤 지워 주세요.");
    if active_id(app) == id {
        return Err(in_use);
    }
    // Read before taking the registry lock (account_of takes it too).
    let g = account_of(app, id);
    {
        let mut reg = state.profiles.lock().map_err(|_| Error::msg("profiles lock poisoned"))?;
        // Checked again under the lock: a switch to it may have happened since.
        if reg.active == id {
            return Err(in_use);
        }
        if !reg.profiles.iter().any(|p| p.id == id) {
            return Ok(());
        }
        reg.profiles.retain(|p| p.id != id);
        save(&state.data_dir, &reg)?;
    }
    if let Some(t) = g.refresh_token.or(g.access_token) {
        let http = state.http.clone();
        tauri::async_runtime::spawn(async move {
            let _ = http.post("https://oauth2.googleapis.com/revoke").form(&[("token", t)]).send().await;
        });
    }
    let dir = dir_of(&state.data_dir, id);
    std::fs::remove_dir_all(&dir).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sm-prof-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_registry_always_has_the_default_profile_and_a_valid_active_one() {
        let dir = tmp("reg");
        // No file yet (data from before profiles): the default profile, active.
        let r = load(&dir);
        assert_eq!(r.active, DEFAULT_ID);
        assert_eq!(r.profiles.len(), 1);
        assert_eq!(dir_of(&dir, DEFAULT_ID), dir, "the default profile is the app folder itself");
        // Ids that could leave the profiles folder are dropped; a missing active falls back.
        std::fs::write(
            registry_path(&dir),
            r#"{"active":"../x","profiles":[{"id":"../x","created_at":1},{"id":"00112233aabbccdd","created_at":2}]}"#,
        )
        .unwrap();
        let r = load(&dir);
        assert_eq!(r.active, DEFAULT_ID);
        let ids: Vec<&str> = r.profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec![DEFAULT_ID, "00112233aabbccdd"]);
        assert_eq!(dir_of(&dir, "00112233aabbccdd"), dir.join("profiles").join("00112233aabbccdd"));
        // A broken file reads as the default profile.
        std::fs::write(registry_path(&dir), "{oops").unwrap();
        assert_eq!(load(&dir).active, DEFAULT_ID);
    }
}
