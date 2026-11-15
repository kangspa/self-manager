#![cfg_attr(not(feature = "ai"), allow(unused))]
//! Meeting audio: recording sink, file import (decode + resample to 16 kHz mono),
//! whisper.cpp model management and transcription.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{Error, Result};
use crate::AppState;

pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Default)]
pub struct Recorder {
    writers: Mutex<HashMap<i64, hound::WavWriter<BufWriter<File>>>>,
}

fn wav_spec() -> hound::WavSpec {
    hound::WavSpec { channels: 1, sample_rate: SAMPLE_RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int }
}

pub fn audio_path(app: &AppHandle, meeting_id: i64) -> PathBuf {
    app.state::<AppState>().data_dir.join("audio").join(format!("meeting-{meeting_id}.wav"))
}

impl Recorder {
    pub fn start(&self, path: &Path, meeting_id: i64) -> Result<()> {
        std::fs::create_dir_all(path.parent().unwrap())?;
        let w = hound::WavWriter::create(path, wav_spec()).map_err(|e| Error::msg(e.to_string()))?;
        self.writers.lock().unwrap().insert(meeting_id, w);
        Ok(())
    }

    /// `pcm` is little-endian i16 mono at 16 kHz, streamed from the webview.
    pub fn append(&self, meeting_id: i64, pcm: &[u8]) -> Result<()> {
        let mut map = self.writers.lock().unwrap();
        let w = map.get_mut(&meeting_id).ok_or_else(|| Error::msg("녹음이 시작되지 않았습니다"))?;
        for ch in pcm.chunks_exact(2) {
            w.write_sample(i16::from_le_bytes([ch[0], ch[1]])).map_err(|e| Error::msg(e.to_string()))?;
        }
        Ok(())
    }

    /// Finalizes the WAV header. Returns the duration in seconds.
    pub fn stop(&self, meeting_id: i64) -> Result<f64> {
        let w = self.writers.lock().unwrap().remove(&meeting_id).ok_or_else(|| Error::msg("녹음 중이 아닙니다"))?;
        let samples = w.len();
        w.finalize().map_err(|e| Error::msg(e.to_string()))?;
        Ok(samples as f64 / SAMPLE_RATE as f64)
    }
}

/// Decodes any supported audio file (mp3, m4a/aac, wav, flac, ogg) to 16 kHz mono WAV.
pub fn import_audio(src: &Path, dest: &Path) -> Result<f64> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = File::open(src)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = src.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| Error::msg(format!("지원하지 않는 오디오 형식입니다: {e}")))?;
    let mut format = probed.format;
    let track = format.default_track().ok_or_else(|| Error::msg("오디오 트랙이 없습니다"))?;
    let track_id = track.id;
    let src_rate = track.codec_params.sample_rate.unwrap_or(SAMPLE_RATE);
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).map_err(|e| Error::msg(e.to_string()))?;

    std::fs::create_dir_all(dest.parent().unwrap())?;
    let mut writer = hound::WavWriter::create(dest, wav_spec()).map_err(|e| Error::msg(e.to_string()))?;
    let mut resampler = LinearResampler::new(src_rate, SAMPLE_RATE);
    let mut written: u64 = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(symphonia::core::errors::Error::ResetRequired) => break,
            Err(e) => return Err(Error::msg(e.to_string())),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(Error::msg(e.to_string())),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        let mono: Vec<f32> = buf.samples().chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect();
        for s in resampler.process(&mono) {
            writer.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).map_err(|e| Error::msg(e.to_string()))?;
            written += 1;
        }
    }
    writer.finalize().map_err(|e| Error::msg(e.to_string()))?;
    Ok(written as f64 / SAMPLE_RATE as f64)
}

/// Streaming linear-interpolation resampler. Good enough for speech
/// recognition, which only needs content below 8 kHz.
struct LinearResampler {
    step: f64,
    pos: f64,
    prev: f32,
}

impl LinearResampler {
    fn new(from: u32, to: u32) -> Self {
        LinearResampler { step: from as f64 / to as f64, pos: 0.0, prev: 0.0 }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity((input.len() as f64 / self.step) as usize + 1);
        // Virtual array v = [prev, input[0], input[1], ...]; `pos` indexes v and
        // we interpolate between v[k] and v[k+1].
        let prev = self.prev;
        let v = |j: usize| if j == 0 { prev } else { input[j - 1] };
        while self.pos < input.len() as f64 {
            let k = self.pos.floor() as usize;
            let frac = (self.pos - k as f64) as f32;
            let (a, b) = (v(k), v(k + 1));
            out.push(a + (b - a) * frac);
            self.pos += self.step;
        }
        self.pos -= input.len() as f64;
        if let Some(l) = input.last() {
            self.prev = *l;
        }
        out
    }
}

// ---------------- Transcription ----------------

#[derive(Serialize, Clone)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

fn read_wav_16k(path: &Path) -> Result<Vec<f32>> {
    let mut r = hound::WavReader::open(path).map_err(|e| Error::msg(e.to_string()))?;
    let spec = r.spec();
    if spec.sample_rate != SAMPLE_RATE || spec.channels != 1 {
        return Err(Error::msg("16kHz 모노 WAV만 지원합니다"));
    }
    Ok(r.samples::<i16>().filter_map(|s| s.ok()).map(|s| s as f32 / i16::MAX as f32).collect())
}

/// Chunk length fed to whisper at once. Keeps memory flat on phones and lets
/// us report progress (and honour cancel) between chunks.
const CHUNK_SEC: usize = 600;

#[cfg(feature = "ai")]
pub fn transcribe(app: &AppHandle, meeting_id: i64, wav: &Path, model: &Path, language: &str, threads: i32, cancel: &std::sync::atomic::AtomicBool) -> Result<Vec<Segment>> {
    let samples = read_wav_16k(wav)?;
    let mut w = whisper_lite::Whisper::load(model).map_err(Error::Msg)?;
    let chunk = CHUNK_SEC * SAMPLE_RATE as usize;
    let n_chunks = samples.len().div_ceil(chunk).max(1);
    let mut out = Vec::new();
    for (ci, part) in samples.chunks(chunk).enumerate() {
        let offset = (ci * CHUNK_SEC) as f64;
        let app2 = app.clone();
        let segs = w
            .transcribe(part, language, threads, cancel, move |p| {
                let overall = (ci as f64 + p as f64 / 100.0) / n_chunks as f64;
                let _ = app2.emit("stt-progress", json!({ "id": meeting_id, "progress": overall }));
            })
            .map_err(|e| if e == "cancelled" { Error::msg("받아쓰기를 취소했습니다") } else { Error::Msg(e) })?;
        out.extend(segs.into_iter().filter(|s| !s.text.is_empty()).map(|s| Segment { start: offset + s.start, end: offset + s.end, text: s.text }));
    }
    Ok(out)
}

#[cfg(not(feature = "ai"))]
pub fn transcribe(_: &AppHandle, _: i64, _: &Path, _: &Path, _: &str, _: i32, _: &std::sync::atomic::AtomicBool) -> Result<Vec<Segment>> {
    Err(Error::msg("이 빌드에는 온디바이스 AI(ai 기능)가 포함되지 않았습니다"))
}

#[cfg(test)]
mod tests {
    use super::LinearResampler;

    #[test]
    fn resampler_ratio() {
        let mut r = LinearResampler::new(48_000, 16_000);
        let total: usize = (0..10).map(|_| r.process(&vec![0.5; 4800]).len()).sum();
        assert!((15_990..=16_010).contains(&total), "{total}");
    }
}
