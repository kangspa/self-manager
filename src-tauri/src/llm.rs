#![cfg_attr(not(feature = "ai"), allow(unused))]
//! Meeting summarization with an on-device model (llama.cpp, GGUF). Runs the
//! same way on PC and Android; nothing leaves the device.
//!
//! Long meetings are summarized map-reduce style: windows that fit the model's
//! context are noted first, then the notes are merged (repeatedly if needed).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};
use crate::stt::Segment;

const SYSTEM: &str = "당신은 회의록 작성 도우미입니다. 음성 인식으로 만든 회의 전사본을 받아 한국어로 정리합니다. \
전사본에는 인식 오류가 있을 수 있으니 문맥으로 바로잡되, 전사본에 없는 내용은 지어내지 마세요. 발언자 구분 정보는 없습니다.";

const FORMAT: &str = "다음 형식의 마크다운으로만 답하세요(머리말 없이):\n\
## 요약\n3~5문장\n\n## 주요 논의\n- 주제별 핵심 (관련 시각 [mm:ss] 포함)\n\n\
## 결정 사항\n- 결정된 내용 (없으면 '없음')\n\n## 할 일\n- [ ] 할 일 내용 (담당자/기한이 언급됐으면 괄호로)\n\n## 기타 메모\n- 미해결 질문, 다음 회의 안건 등";

fn ts(sec: f64) -> String {
    let s = sec.max(0.0) as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

fn line(s: &Segment) -> String {
    format!("[{}] {}", ts(s.start), s.text)
}

/// Removes reasoning blocks some models emit even when asked not to.
pub fn strip_thinking(s: &str) -> String {
    let mut out = s.to_string();
    for (open, close) in [("<think>", "</think>"), ("<|channel>thought", "<channel|>")] {
        while let Some(a) = out.find(open) {
            match out[a..].find(close) {
                Some(b) => out.replace_range(a..a + b + close.len(), ""),
                None => out.truncate(a),
            }
        }
    }
    out.trim().to_string()
}

#[cfg(feature = "ai")]
mod engine {
    use super::*;
    use llama_cpp_2::context::params::LlamaContextParams;
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::llama_batch::LlamaBatch;
    use llama_cpp_2::model::params::LlamaModelParams;
    use llama_cpp_2::model::LlamaModel;
    use llama_cpp_2::sampling::LlamaSampler;
    use std::num::NonZeroU32;
    use std::sync::OnceLock;

    static BACKEND: OnceLock<LlamaBackend> = OnceLock::new();

    fn backend() -> Result<&'static LlamaBackend> {
        if let Some(b) = BACKEND.get() {
            return Ok(b);
        }
        let mut b = LlamaBackend::init().map_err(|e| Error::msg(format!("llama 초기화 실패: {e}")))?;
        b.void_logs();
        Ok(BACKEND.get_or_init(|| b))
    }

    #[derive(Clone, Copy)]
    enum Style {
        Gemma4,
        ChatMl,
        Native,
    }

    pub struct Engine {
        model: LlamaModel,
        style: Style,
        n_ctx: u32,
        threads: i32,
    }

    impl Engine {
        pub fn load(path: &Path, threads: i32) -> Result<Self> {
            let be = backend()?;
            let params = LlamaModelParams::default().with_n_gpu_layers(0);
            let model = LlamaModel::load_from_file(be, path, &params).map_err(|e| Error::msg(format!("AI 모델을 열 수 없습니다: {e}")))?;
            let tmpl = model.chat_template(None).ok().and_then(|t| t.to_string().ok()).unwrap_or_default();
            let arch = model.meta_val_str("general.architecture").unwrap_or_default();
            // llama.cpp has no built-in Gemma 4 template, so format it by hand.
            let style = if arch.starts_with("gemma4") || tmpl.contains("<|turn>") {
                Style::Gemma4
            } else if tmpl.contains("<|im_start|>") || arch.starts_with("qwen") {
                Style::ChatMl
            } else {
                Style::Native
            };
            // 8k keeps memory low on phones and is plenty per window.
            let n_ctx = model.n_ctx_train().clamp(2048, 8192);
            Ok(Engine { model, style, n_ctx, threads: threads.max(1) })
        }

        /// Token budget available for one window of transcript text.
        pub fn window_tokens(&self) -> usize {
            (self.n_ctx as usize).saturating_sub(2600).max(1200)
        }

        pub fn count(&self, text: &str) -> usize {
            self.model.vocab().tokenize(text.as_bytes(), false, false).len()
        }

        pub fn n_ctx(&self) -> usize {
            self.n_ctx as usize
        }

        /// A conversation as the model's prompt, ending where the model's
        /// answer starts. `turns` are ("user" | "assistant", text).
        pub fn chat_prompt(&self, system: &str, turns: &[(&str, &str)]) -> Result<String> {
            Ok(match self.style {
                Style::Gemma4 => {
                    let mut s = format!("<|turn>system\n{system}<turn|>\n");
                    for (role, text) in turns {
                        s += &format!("<|turn>{}\n{text}<turn|>\n", if *role == "assistant" { "model" } else { "user" });
                    }
                    s + "<|turn>model\n"
                }
                // Empty think block = Qwen's documented way to skip reasoning.
                Style::ChatMl => {
                    let mut s = format!("<|im_start|>system\n{system}<|im_end|>\n");
                    for (role, text) in turns {
                        s += &format!("<|im_start|>{}\n{text}<|im_end|>\n", if *role == "assistant" { "assistant" } else { "user" });
                    }
                    s + "<|im_start|>assistant\n<think>\n\n</think>\n\n"
                }
                Style::Native => {
                    use llama_cpp_2::model::LlamaChatMessage;
                    let tmpl = self.model.chat_template(None).map_err(|e| Error::msg(format!("채팅 템플릿 없음: {e}")))?;
                    let mut msgs = vec![LlamaChatMessage::new("system".into(), system.into()).map_err(|e| Error::msg(e.to_string()))?];
                    for (role, text) in turns {
                        msgs.push(LlamaChatMessage::new(role.to_string(), text.to_string()).map_err(|e| Error::msg(e.to_string()))?);
                    }
                    self.model.apply_chat_template(&tmpl, &msgs, true).map_err(|e| Error::msg(e.to_string()))?
                }
            })
        }

        /// What follows the model's tool call in its prompt: the call's turn
        /// closed, the result as the user's turn, the model's next turn opened.
        /// None when only the model's own template knows (rebuild the prompt).
        pub fn tool_reply(&self, result: &str) -> Option<String> {
            match self.style {
                Style::Gemma4 => Some(format!("<turn|>\n<|turn>user\n{result}<turn|>\n<|turn>model\n")),
                Style::ChatMl => Some(format!("<|im_end|>\n<|im_start|>user\n{result}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n")),
                Style::Native => None,
            }
        }

        /// An inference context: feed text, sample text, repeat. What was fed
        /// and sampled stays in it, so a follow-up costs only the new text.
        pub fn run(&self) -> Result<Run<'_>> {
            let cp = LlamaContextParams::default()
                .with_n_ctx(NonZeroU32::new(self.n_ctx))
                .with_n_batch(512)
                .with_n_threads(self.threads)
                .with_n_threads_batch(self.threads);
            let ctx = self.model.new_context(backend()?, cp).map_err(|e| Error::msg(format!("추론 준비 실패: {e}")))?;
            let sampler = LlamaSampler::chain_simple([
                LlamaSampler::penalties(self.model.n_vocab(), 256, 1.1, 0.0, 0.0),
                LlamaSampler::top_k(40),
                LlamaSampler::top_p(0.9, 1),
                LlamaSampler::temp(0.3),
                LlamaSampler::dist(1234),
            ]);
            Ok(Run { eng: self, ctx, batch: LlamaBatch::new(512, 1), pos: 0, sampler })
        }

        pub fn generate(&self, system: &str, user: &str, max_new: usize, cancel: &AtomicBool) -> Result<String> {
            let prompt = self.chat_prompt(system, &[("user", user)])?;
            let n = self.count(&prompt);
            let max_new = max_new.min(self.n_ctx as usize / 2);
            if n + max_new > self.n_ctx as usize {
                return Err(Error::msg(format!("입력이 모델 문맥보다 깁니다 ({n}토큰)")));
            }
            let mut run = self.run()?;
            let res = run.feed(&prompt, cancel).and_then(|_| run.sample(max_new, &[], false, cancel, |_| {}));
            match res {
                Ok(text) => Ok(visible(&text)),
                Err(_) if cancel.load(Ordering::SeqCst) => Err(Error::msg("요약을 취소했습니다")),
                Err(e) => Err(e),
            }
        }
    }

    pub struct Run<'a> {
        eng: &'a Engine,
        ctx: llama_cpp_2::context::LlamaContext<'a>,
        batch: LlamaBatch<'static>,
        pos: i32,
        sampler: LlamaSampler,
    }

    impl Run<'_> {
        /// Tokens in the context so far.
        pub fn used(&self) -> usize {
            self.pos as usize
        }

        /// Starts over (an empty context).
        pub fn reset(&mut self) {
            self.ctx.clear_kv_cache();
            self.pos = 0;
        }

        pub fn feed(&mut self, text: &str, cancel: &AtomicBool) -> Result<()> {
            let tokens = self.eng.model.vocab().tokenize(text.as_bytes(), self.pos == 0, true);
            if tokens.is_empty() {
                return Ok(());
            }
            if self.pos as usize + tokens.len() + 16 > self.eng.n_ctx as usize {
                return Err(Error::msg("대화가 모델이 한 번에 읽을 수 있는 길이를 넘었습니다. 새 대화로 시작해 주세요."));
            }
            let mut done = 0usize;
            for chunk in tokens.chunks(512) {
                if cancel.load(Ordering::SeqCst) {
                    return Err(Error::msg(CANCELLED));
                }
                self.batch.clear();
                for (i, t) in chunk.iter().enumerate() {
                    let last = done + i == tokens.len() - 1;
                    self.batch.add(*t, self.pos + i as i32, &[0], last).map_err(|e| Error::msg(e.to_string()))?;
                }
                self.ctx.decode(&mut self.batch).map_err(|e| Error::msg(format!("추론 실패: {e}")))?;
                self.pos += chunk.len() as i32;
                done += chunk.len();
            }
            Ok(())
        }

        /// Samples the model's text until its turn ends, a `stops` string
        /// appears (kept in the result), or `max_new` tokens. Every token,
        /// the stop's too, goes into the context, so feeding can continue.
        /// `special`: control tokens appear as text (tool-call tags can be
        /// such tokens). `on_text` gets the whole text so far.
        pub fn sample(&mut self, max_new: usize, stops: &[&str], special: bool, cancel: &AtomicBool, mut on_text: impl FnMut(&str)) -> Result<String> {
            let vocab = self.eng.model.vocab();
            let room = (self.eng.n_ctx as usize).saturating_sub(self.pos as usize + 1);
            let mut out: Vec<u8> = Vec::new();
            for _ in 0..max_new.min(room) {
                if cancel.load(Ordering::SeqCst) {
                    return Err(Error::msg(CANCELLED));
                }
                let tok = self.sampler.sample(&self.ctx, self.batch.n_tokens() - 1);
                self.sampler.accept(tok);
                if vocab.is_eog(tok) {
                    break;
                }
                out.extend(vocab.token_to_piece(tok, special, None));
                self.batch.clear();
                self.batch.add(tok, self.pos, &[0], true).map_err(|e| Error::msg(e.to_string()))?;
                self.pos += 1;
                self.ctx.decode(&mut self.batch).map_err(|e| Error::msg(format!("추론 실패: {e}")))?;
                // A character can span tokens: show only whole ones.
                let valid = match std::str::from_utf8(&out) {
                    Ok(s) => s,
                    Err(e) => std::str::from_utf8(&out[..e.valid_up_to()]).unwrap_or(""),
                };
                on_text(valid);
                if valid.contains("<turn|>") || valid.contains("<|im_end|>") || stops.iter().any(|s| valid.contains(s)) {
                    break;
                }
            }
            Ok(String::from_utf8_lossy(&out).into_owned())
        }
    }
}

#[cfg(feature = "ai")]
pub use engine::Engine;

/// The error a cancelled run ends with.
pub const CANCELLED: &str = "취소했습니다";

/// Removes end-of-turn and other control tokens left in sampled text.
pub fn clean_tokens(s: &str) -> String {
    let re = regex::Regex::new(r"<\|[A-Za-z_]+\|>|<\|[A-Za-z_]+>|<[A-Za-z_]+\|>").unwrap();
    re.replace_all(s, "").into_owned()
}

/// What the reader should see of sampled text: no reasoning, no control tokens.
pub fn visible(s: &str) -> String {
    clean_tokens(&strip_thinking(s))
}

/// Splits transcript lines into windows of at most `budget` tokens.
fn windows_by(lines: &[String], budget: usize, count: impl Fn(&str) -> usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut used = 0;
    for l in lines {
        let n = count(l) + 1;
        if used + n > budget && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
            used = 0;
        }
        cur.push_str(l);
        cur.push('\n');
        used += n;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(feature = "ai")]
pub fn summarize(app: &AppHandle, meeting_id: i64, model: &Path, threads: i32, title: &str, segs: &[Segment], cancel: &AtomicBool) -> Result<String> {
    if segs.is_empty() {
        return Err(Error::msg("전사된 내용이 없습니다"));
    }
    let eng = engine::Engine::load(model, threads)?;
    let budget = eng.window_tokens();
    let lines: Vec<String> = segs.iter().map(line).collect();
    let windows = windows_by(&lines, budget, |s| eng.count(s));
    let progress = |done: usize, total: usize, stage: &str| {
        let _ = app.emit("llm-progress", json!({ "id": meeting_id, "done": done, "total": total, "stage": stage }));
    };

    if windows.len() == 1 {
        progress(0, 1, "요약 중");
        let user = format!("회의 제목: {title}\n\n<전사본>\n{}</전사본>\n\n{FORMAT}", windows[0]);
        return eng.generate(SYSTEM, &user, 1800, cancel);
    }

    // Map: notes per window.
    let total = windows.len() + 1;
    let mut notes = Vec::new();
    for (i, w) in windows.iter().enumerate() {
        progress(i, total, &format!("구간 {}/{} 정리 중", i + 1, windows.len()));
        let user = format!("회의 '{title}'의 {}번째 구간 전사본입니다. 이 구간의 논의, 결정, 할 일을 빠짐없이 짧은 글머리표로 정리하세요. 시각 [mm:ss]를 유지하세요.\n\n{w}", i + 1);
        notes.push(format!("### 구간 {}\n{}", i + 1, eng.generate(SYSTEM, &user, 700, cancel)?));
    }
    // Reduce: merge notes, in rounds if they still do not fit one context.
    let mut round = notes;
    while round.iter().map(|n| eng.count(n)).sum::<usize>() > budget && round.len() > 1 {
        let groups = windows_by(&round, budget, |s| eng.count(s));
        if groups.len() >= round.len() {
            break;
        }
        let mut next = Vec::new();
        for g in groups {
            let user = format!("아래 회의 메모들을 중복 없이 하나의 글머리표 메모로 합치세요. 시각은 유지하세요.\n\n{g}");
            next.push(eng.generate(SYSTEM, &user, 900, cancel)?);
        }
        round = next;
    }
    progress(total - 1, total, "전체 회의록 작성 중");
    let user = format!("회의 제목: {title}\n\n아래는 회의를 구간별로 정리한 메모입니다. 이를 하나의 회의록으로 합치세요. 중복은 합치고 순서는 시간순으로.\n\n{}\n\n{FORMAT}", round.join("\n\n"));
    eng.generate(SYSTEM, &user, 1800, cancel)
}

#[cfg(not(feature = "ai"))]
pub fn summarize(_: &AppHandle, _: i64, _: &Path, _: i32, _: &str, _: &[Segment], _: &AtomicBool) -> Result<String> {
    Err(Error::msg("이 빌드에는 온디바이스 AI(ai 기능)가 포함되지 않았습니다"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_respect_budget() {
        let lines: Vec<String> = (0..10).map(|i| format!("line {i}")).collect();
        let w = windows_by(&lines, 9, |s| s.len() / 2); // each line ~3+1 tokens
        assert!(w.len() >= 4);
        assert_eq!(w.concat().lines().count(), 10);
        assert_eq!(ts(3725.0), "1:02:05");
    }

    #[test]
    fn strips_reasoning() {
        assert_eq!(strip_thinking("<think>hmm</think>\n## 요약\nok"), "## 요약\nok");
        assert_eq!(strip_thinking("## 요약<think>unfinished"), "## 요약");
    }
}
