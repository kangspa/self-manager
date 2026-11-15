//! Safe wrapper over the C shim in `shim.cpp`.
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;
use std::sync::atomic::AtomicBool;

// Keeps the ggml static libraries from llama-cpp-sys-2 in the link.
extern crate llama_cpp_sys_2 as _;

#[repr(C)]
struct RawCtx {
    _p: [u8; 0],
}

type ProgressFn = extern "C" fn(c_int, *mut c_void);

extern "C" {
    fn sm_whisper_init(path: *const c_char) -> *mut RawCtx;
    fn sm_whisper_free(ctx: *mut RawCtx);
    fn sm_whisper_transcribe(ctx: *mut RawCtx, samples: *const f32, n: c_int, lang: *const c_char, threads: c_int, progress: Option<ProgressFn>, user: *mut c_void, cancel: *const c_void) -> c_int;
    fn sm_whisper_n_segments(ctx: *mut RawCtx) -> c_int;
    fn sm_whisper_segment_text(ctx: *mut RawCtx, i: c_int) -> *const c_char;
    fn sm_whisper_segment_t0(ctx: *mut RawCtx, i: c_int) -> i64;
    fn sm_whisper_segment_t1(ctx: *mut RawCtx, i: c_int) -> i64;
}

pub struct Segment {
    /// seconds
    pub start: f64,
    pub end: f64,
    pub text: String,
}

pub struct Whisper {
    ctx: *mut RawCtx,
}

// whisper_context is used from one thread at a time (we never share &Whisper).
unsafe impl Send for Whisper {}

impl Whisper {
    pub fn load(model: &Path) -> Result<Self, String> {
        let p = CString::new(model.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let ctx = unsafe { sm_whisper_init(p.as_ptr()) };
        if ctx.is_null() {
            return Err(format!("음성 인식 모델을 열 수 없습니다: {}", model.display()));
        }
        Ok(Whisper { ctx })
    }

    /// Transcribes 16 kHz mono samples. `progress` receives 0..=100.
    /// Setting `cancel` to true stops early (returns Err("cancelled")).
    pub fn transcribe(&mut self, samples: &[f32], language: &str, threads: i32, cancel: &AtomicBool, mut progress: impl FnMut(i32)) -> Result<Vec<Segment>, String> {
        extern "C" fn tramp(p: c_int, user: *mut c_void) {
            let f = unsafe { &mut *(user as *mut &mut dyn FnMut(i32)) };
            f(p);
        }
        let lang = CString::new(language).map_err(|e| e.to_string())?;
        let mut dynf: &mut dyn FnMut(i32) = &mut progress;
        let user = &mut dynf as *mut &mut dyn FnMut(i32) as *mut c_void;
        // AtomicBool has the same in-memory representation as std::atomic<bool>.
        let cancel_ptr = cancel as *const AtomicBool as *const c_void;
        let rc = unsafe { sm_whisper_transcribe(self.ctx, samples.as_ptr(), samples.len() as c_int, lang.as_ptr(), threads, Some(tramp), user, cancel_ptr) };
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        if rc != 0 {
            return Err(format!("whisper_full 실패 (코드 {rc})"));
        }
        let n = unsafe { sm_whisper_n_segments(self.ctx) };
        let mut out = Vec::with_capacity(n.max(0) as usize);
        for i in 0..n {
            let t = unsafe { sm_whisper_segment_text(self.ctx, i) };
            let text = if t.is_null() { String::new() } else { unsafe { CStr::from_ptr(t) }.to_string_lossy().trim().to_string() };
            // whisper timestamps are in 10 ms units
            let start = unsafe { sm_whisper_segment_t0(self.ctx, i) } as f64 / 100.0;
            let end = unsafe { sm_whisper_segment_t1(self.ctx, i) } as f64 / 100.0;
            out.push(Segment { start, end, text });
        }
        Ok(out)
    }
}

impl Drop for Whisper {
    fn drop(&mut self) {
        unsafe { sm_whisper_free(self.ctx) };
    }
}
