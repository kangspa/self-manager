//! Per-device settings that must never travel with the DB backup
//! (tokens, API keys, sync bookkeeping). Stored as `device.json`.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct GoogleConfig {
    /// OAuth client of type "Desktop app" (desktop only; Android uses the
    /// Android client registered with the APK signing SHA-1).
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: Option<String>,
    pub access_token: Option<String>,
    pub expires_at: i64,
    pub email: Option<String>,
    /// The account's profile picture (shown in the account menu).
    pub picture: Option<String>,
    /// Android: whether the user completed the authorization flow once.
    pub authorized: bool,
    /// Bumped by every login. Work that began in one session changes the
    /// session (stores a token, ends it) only while this is unchanged, so it
    /// never undoes a newer login - not even one as the same account.
    pub session: u64,
}

/// On-device summary model (GGUF file name in models/llm). Empty = none chosen.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct LlmConfig {
    pub model: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct SttConfig {
    /// whisper.cpp ggml file name in models/stt, e.g. "ggml-small.bin"
    pub model: String,
    pub language: String,
    /// CPU threads for both speech recognition and summarization.
    pub threads: i32,
}

impl Default for SttConfig {
    fn default() -> Self {
        let cores = std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4);
        SttConfig { model: String::new(), language: "ko".into(), threads: cores.clamp(2, 8) }
    }
}

impl SttConfig {
    /// Accepts the pre-0.2 short names ("small") as well as file names.
    pub fn model_file(&self) -> String {
        if self.model.is_empty() || self.model.ends_with(".bin") {
            self.model.clone()
        } else {
            format!("ggml-{}.bin", self.model)
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct DeviceConfig {
    pub auto_backup: bool,
    pub auto_load: bool,
    pub google: GoogleConfig,
    pub drive_folder_id: Option<String>,
    /// SelfManager/files: attachment bytes, one Drive file per sha256.
    pub drive_files_folder_id: Option<String>,
    pub drive_file_id: Option<String>,
    /// Bumped whenever the Drive state above is reset for another account.
    /// Work that started before (a status check, a file sync) records what it
    /// found only while this is unchanged, so it never brings back the old
    /// account's ids.
    pub drive_epoch: u64,
    /// Local `last_modified` value at the moment local and Drive were last identical.
    /// If the live DB has changed since, an auto-load would discard those edits.
    pub synced_local_modified: Option<i64>,
    pub last_backup_at: Option<i64>,
    pub last_load_at: Option<i64>,
    pub manual_saved_at: Option<i64>,
    /// `last_modified` of the DB contents captured by the manual save.
    pub manual_local_modified: Option<i64>,
    pub llm: LlmConfig,
    pub stt: SttConfig,
    pub gcal_last_sync: Option<i64>,
}

/// The active profile's settings file (device.json in the profile folder).
/// Each profile keeps its own Google session, Drive state and sync points;
/// the AI model settings belong to the device and follow every switch.
pub struct Device {
    path: Mutex<PathBuf>,
    pub cfg: Mutex<DeviceConfig>,
}

fn read_config(path: &PathBuf) -> DeviceConfig {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write_config(path: &PathBuf, cfg: &DeviceConfig) -> Result<()> {
    // Write-then-rename so a crash mid-write never corrupts the file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(cfg)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

impl Device {
    pub fn load(path: PathBuf) -> Self {
        let cfg = read_config(&path);
        Device { path: Mutex::new(path), cfg: Mutex::new(cfg) }
    }

    /// Continues with another profile's settings file, carrying over the
    /// device-wide AI settings. Saved before it takes effect.
    pub fn switch_to(&self, path: PathBuf) -> Result<()> {
        let mut guard = self.cfg.lock().map_err(|_| Error::msg("config lock poisoned"))?;
        let mut next = read_config(&path);
        next.llm = guard.llm.clone();
        next.stt = guard.stt.clone();
        write_config(&path, &next)?;
        *guard = next;
        *self.path.lock().map_err(|_| Error::msg("config path lock poisoned"))? = path;
        Ok(())
    }

    pub fn get(&self) -> DeviceConfig {
        self.cfg.lock().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn update(&self, f: impl FnOnce(&mut DeviceConfig)) -> Result<DeviceConfig> {
        let mut guard = self.cfg.lock().map_err(|_| Error::msg("config lock poisoned"))?;
        f(&mut guard);
        let path = self.path.lock().map_err(|_| Error::msg("config path lock poisoned"))?.clone();
        write_config(&path, &guard)?;
        Ok(guard.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each profile keeps its own Google session and sync state; the AI
    /// settings belong to the device and follow the switch.
    #[test]
    fn switching_keeps_sessions_apart_and_carries_the_ai_settings() {
        let dir = std::env::temp_dir().join(format!("sm-dev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.json"), dir.join("b.json"));
        let dev = Device::load(a.clone());
        dev.update(|d| {
            d.google.email = Some("work@example.com".into());
            d.synced_local_modified = Some(7);
            d.stt.language = "ko".into();
        })
        .unwrap();
        dev.switch_to(b.clone()).unwrap();
        let now = dev.get();
        assert_eq!(now.google.email, None, "B has no session yet");
        assert_eq!(now.synced_local_modified, None);
        assert_eq!(now.stt.language, "ko", "AI settings follow the device");
        dev.update(|d| d.google.email = Some("me@example.com".into())).unwrap();
        dev.switch_to(a.clone()).unwrap();
        assert_eq!(dev.get().google.email.as_deref(), Some("work@example.com"));
        assert_eq!(dev.get().synced_local_modified, Some(7));
        // Both files hold their own account.
        let read = |p: &PathBuf| serde_json::from_str::<DeviceConfig>(&std::fs::read_to_string(p).unwrap()).unwrap().google.email;
        assert_eq!(read(&b).as_deref(), Some("me@example.com"));
        assert_eq!(read(&a).as_deref(), Some("work@example.com"));
    }
}
