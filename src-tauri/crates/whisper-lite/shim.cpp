// Narrow C API over whisper.cpp so Rust never mirrors whisper_full_params
// (a large struct whose layout changes between releases).
#include "whisper.h"

#include <atomic>
#include <cstdint>

extern "C" {

typedef void (*sm_progress_fn)(int progress, void * user);

struct sm_cb {
    sm_progress_fn progress;
    void * user;
    const std::atomic<bool> * cancel;
};

static void on_progress(struct whisper_context *, struct whisper_state *, int p, void * user) {
    auto * cb = static_cast<sm_cb *>(user);
    if (cb && cb->progress) cb->progress(p, cb->user);
}

static bool on_abort(void * user) {
    auto * cb = static_cast<sm_cb *>(user);
    return cb && cb->cancel && cb->cancel->load();
}

struct whisper_context * sm_whisper_init(const char * model_path) {
    whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = false;
    return whisper_init_from_file_with_params(model_path, cp);
}

void sm_whisper_free(struct whisper_context * ctx) {
    if (ctx) whisper_free(ctx);
}

// language: "ko", "en" or "auto". cancel_flag points to a Rust AtomicBool (may be null).
int sm_whisper_transcribe(struct whisper_context * ctx, const float * samples, int n_samples, const char * language,
                          int n_threads, sm_progress_fn progress, void * user, const void * cancel_flag) {
    sm_cb cb{progress, user, static_cast<const std::atomic<bool> *>(cancel_flag)};
    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.language = language;
    p.n_threads = n_threads > 0 ? n_threads : 4;
    p.print_progress = false;
    p.print_realtime = false;
    p.print_timestamps = false;
    p.print_special = false;
    p.progress_callback = on_progress;
    p.progress_callback_user_data = &cb;
    p.abort_callback = on_abort;
    p.abort_callback_user_data = &cb;
    return whisper_full(ctx, p, samples, n_samples);
}

int sm_whisper_n_segments(struct whisper_context * ctx) { return whisper_full_n_segments(ctx); }
const char * sm_whisper_segment_text(struct whisper_context * ctx, int i) { return whisper_full_get_segment_text(ctx, i); }
int64_t sm_whisper_segment_t0(struct whisper_context * ctx, int i) { return whisper_full_get_segment_t0(ctx, i); }
int64_t sm_whisper_segment_t1(struct whisper_context * ctx, int i) { return whisper_full_get_segment_t1(ctx, i); }

}
