//! On-device AI model files: catalog, resumable download, delete, import.
//! Speech models (whisper.cpp ggml .bin) live in models/stt, summary models
//! (llama.cpp .gguf) in models/llm. Nothing is bundled with the app, so a user
//! who never records meetings never spends the disk space.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{Error, Result};
use crate::AppState;

#[derive(Clone, Copy, PartialEq, Eq, Hash, serde::Deserialize, Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Stt,
    Llm,
}

impl Kind {
    fn dir(self) -> &'static str {
        match self {
            Kind::Stt => "stt",
            Kind::Llm => "llm",
        }
    }
    fn ext_ok(self, name: &str) -> bool {
        let n = name.to_ascii_lowercase();
        match self {
            Kind::Stt => n.ends_with(".bin"),
            Kind::Llm => n.ends_with(".gguf"),
        }
    }
}

pub struct Preset {
    pub kind: Kind,
    pub file: &'static str,
    pub label: &'static str,
    pub note: &'static str,
    pub url: &'static str,
    pub size: u64,
}

pub const PRESETS: &[Preset] = &[
    Preset { kind: Kind::Stt, file: "ggml-base.bin", label: "Whisper base", note: "가장 빠름, 정확도 낮음", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin", size: 147_951_465 },
    Preset { kind: Kind::Stt, file: "ggml-small.bin", label: "Whisper small", note: "폰 권장", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin", size: 487_601_967 },
    Preset { kind: Kind::Stt, file: "ggml-large-v3-turbo-q5_0.bin", label: "Whisper large-v3 turbo (Q5)", note: "가장 정확, PC 권장", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin", size: 574_041_195 },
    Preset { kind: Kind::Llm, file: "Qwen3.5-2B-Q4_K_M.gguf", label: "Qwen3.5 2B", note: "폰 권장 (RAM 6GB 이상)", url: "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf", size: 1_280_835_840 },
    Preset { kind: Kind::Llm, file: "Qwen3.5-4B-Q4_K_M.gguf", label: "Qwen3.5 4B", note: "고사양 폰(RAM 8GB+) · PC", url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf", size: 2_740_937_888 },
    Preset { kind: Kind::Llm, file: "gemma-4-E2B-it-Q4_K_M.gguf", label: "Gemma 4 E2B", note: "PC · 한국어 요약 품질 좋음", url: "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf", size: 3_106_738_272 },
    Preset { kind: Kind::Llm, file: "gemma-4-E4B-it-Q4_K_M.gguf", label: "Gemma 4 E4B", note: "PC 권장 · 요약 품질 가장 좋음", url: "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf", size: 4_977_171_584 },
];

#[derive(Default)]
pub struct Downloads {
    cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

pub fn dir(app: &AppHandle, kind: Kind) -> PathBuf {
    app.state::<AppState>().data_dir.join("models").join(kind.dir())
}

/// Path of an installed model file, or None. Also finds files from the
/// pre-0.2 layout (models/ggml-*.bin).
pub fn path_of(app: &AppHandle, kind: Kind, file: &str) -> Option<PathBuf> {
    if file.is_empty() || file.contains(['/', '\\']) {
        return None;
    }
    let p = dir(app, kind).join(file);
    if p.exists() {
        return Some(p);
    }
    let legacy = app.state::<AppState>().data_dir.join("models").join(file);
    (kind == Kind::Stt && legacy.exists()).then_some(legacy)
}

#[derive(Serialize)]
pub struct ModelInfo {
    pub kind: Kind,
    pub file: String,
    pub label: String,
    pub note: String,
    pub size: u64,
    pub installed: bool,
    pub preset: bool,
    /// Bytes already downloaded into a .part file (resumable).
    pub partial: u64,
    pub downloading: bool,
}

pub fn list(app: &AppHandle) -> Vec<ModelInfo> {
    let dl = app.state::<AppState>().downloads.cancel.lock().unwrap().keys().cloned().collect::<Vec<_>>();
    let mut out = Vec::new();
    for kind in [Kind::Stt, Kind::Llm] {
        let d = dir(app, kind);
        for p in PRESETS.iter().filter(|p| p.kind == kind) {
            let installed = path_of(app, kind, p.file);
            let partial = std::fs::metadata(d.join(format!("{}.part", p.file))).map(|m| m.len()).unwrap_or(0);
            out.push(ModelInfo {
                kind,
                file: p.file.into(),
                label: p.label.into(),
                note: p.note.into(),
                size: installed.as_ref().and_then(|x| std::fs::metadata(x).ok()).map(|m| m.len()).unwrap_or(p.size),
                installed: installed.is_some(),
                preset: true,
                partial,
                downloading: dl.contains(&p.file.to_string()),
            });
        }
        // Files the user added by URL or import.
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !kind.ext_ok(&name) || PRESETS.iter().any(|p| p.file == name) {
                    continue;
                }
                out.push(ModelInfo {
                    kind,
                    label: name.trim_end_matches(".gguf").trim_end_matches(".bin").to_string(),
                    note: "직접 추가한 모델".into(),
                    size: e.metadata().map(|m| m.len()).unwrap_or(0),
                    file: name,
                    installed: true,
                    preset: false,
                    partial: 0,
                    downloading: false,
                });
            }
        }
    }
    out
}

fn file_from_url(url: &str) -> String {
    url.split('?').next().unwrap_or(url).rsplit('/').next().unwrap_or("").to_string()
}

/// Downloads `url` into the model folder, resuming a previous partial download.
pub async fn download(app: &AppHandle, kind: Kind, file: Option<String>, url: Option<String>) -> Result<String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let (file, url) = match (file, url) {
        (Some(f), None) => {
            let p = PRESETS.iter().find(|p| p.file == f && p.kind == kind).ok_or_else(|| Error::msg("알 수 없는 모델"))?;
            (p.file.to_string(), p.url.to_string())
        }
        (_, Some(u)) => {
            if !u.starts_with("https://") {
                return Err(Error::msg("https:// 주소만 받을 수 있습니다"));
            }
            let f = file_from_url(&u);
            if !kind.ext_ok(&f) || f.contains(['/', '\\']) {
                return Err(Error::msg(if kind == Kind::Llm { "주소가 .gguf 파일이어야 합니다" } else { "주소가 whisper ggml .bin 파일이어야 합니다" }));
            }
            (f, u)
        }
        _ => return Err(Error::msg("모델을 지정하세요")),
    };
    let state = app.state::<AppState>();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.downloads.cancel.lock().unwrap();
        if map.contains_key(&file) {
            return Err(Error::msg("이미 받는 중입니다"));
        }
        map.insert(file.clone(), cancel.clone());
    }
    let result = async {
        let d = dir(app, kind);
        tokio::fs::create_dir_all(&d).await?;
        let dest = d.join(&file);
        let part = d.join(format!("{file}.part"));
        let have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
        let mut req = state.http.get(&url).timeout(std::time::Duration::from_secs(6 * 3600));
        if have > 0 {
            req = req.header("Range", format!("bytes={have}-"));
        }
        let resp = req.send().await?.error_for_status()?;
        let resumed = resp.status().as_u16() == 206;
        let total = resp.content_length().map(|l| if resumed { l + have } else { l }).unwrap_or(0);
        let mut f = if resumed { tokio::fs::OpenOptions::new().append(true).open(&part).await? } else { tokio::fs::File::create(&part).await? };
        let mut got = if resumed { have } else { 0 };
        let mut last = 0u64;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::SeqCst) {
                f.flush().await?;
                return Err(Error::msg("다운로드를 멈췄습니다 (이어받기 가능)"));
            }
            let chunk = chunk?;
            f.write_all(&chunk).await?;
            got += chunk.len() as u64;
            if got - last > 4_000_000 || got == total {
                last = got;
                let _ = app.emit("model-progress", json!({ "file": file, "got": got, "total": total }));
            }
        }
        f.flush().await?;
        drop(f);
        if total > 0 && got < total {
            return Err(Error::msg("다운로드가 중간에 끊겼습니다. 다시 누르면 이어받습니다"));
        }
        tokio::fs::rename(&part, &dest).await?;
        Ok(file.clone())
    }
    .await;
    state.downloads.cancel.lock().unwrap().remove(&file);
    result
}

pub fn cancel_download(app: &AppHandle, file: &str) {
    if let Some(c) = app.state::<AppState>().downloads.cancel.lock().unwrap().get(file) {
        c.store(true, Ordering::SeqCst);
    }
}

/// Removes an installed model (and any partial download of it).
pub fn delete(app: &AppHandle, kind: Kind, file: &str) -> Result<()> {
    if file.is_empty() || file.contains(['/', '\\']) || !kind.ext_ok(file) {
        return Err(Error::msg("잘못된 파일 이름"));
    }
    cancel_download(app, file);
    if let Some(p) = path_of(app, kind, file) {
        std::fs::remove_file(p)?;
    }
    let part = dir(app, kind).join(format!("{file}.part"));
    if part.exists() {
        std::fs::remove_file(part)?;
    }
    Ok(())
}

/// Copies a model file the user already has (PC) into the model folder.
pub fn import(app: &AppHandle, kind: Kind, src: &Path) -> Result<String> {
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if !kind.ext_ok(&name) {
        return Err(Error::msg(if kind == Kind::Llm { ".gguf 파일만 추가할 수 있습니다" } else { ".bin(whisper ggml) 파일만 추가할 수 있습니다" }));
    }
    let d = dir(app, kind);
    std::fs::create_dir_all(&d)?;
    std::fs::copy(src, d.join(&name))?;
    Ok(name)
}

pub fn total_size(app: &AppHandle) -> u64 {
    fn walk(p: &Path) -> u64 {
        std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| if e.path().is_dir() { walk(&e.path()) } else { e.metadata().map(|m| m.len()).unwrap_or(0) }).sum()).unwrap_or(0)
    }
    walk(&app.state::<AppState>().data_dir.join("models"))
}
