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
    /// Android: whether the user completed the authorization flow once.
    pub authorized: bool,
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

pub struct Device {
    path: PathBuf,
    pub cfg: Mutex<DeviceConfig>,
}

impl Device {
    pub fn load(path: PathBuf) -> Self {
        let cfg = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Device { path, cfg: Mutex::new(cfg) }
    }

    pub fn get(&self) -> DeviceConfig {
        self.cfg.lock().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn update(&self, f: impl FnOnce(&mut DeviceConfig)) -> Result<DeviceConfig> {
        let mut guard = self.cfg.lock().map_err(|_| Error::msg("config lock poisoned"))?;
        f(&mut guard);
        // Write-then-rename so a crash mid-write never corrupts the file.
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&*guard)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(guard.clone())
    }
}
