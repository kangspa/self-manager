//! Compiles only whisper.cpp's own sources. ggml comes from llama-cpp-sys-2, so
//! the program contains exactly one ggml (two copies collide at link time).
//! whisper.cpp v1.9.5 was picked because it ships the same ggml 0.26 headers
//! as llama-cpp-sys-2 0.1.161 — bump both together.
use std::env;
use std::path::PathBuf;

fn main() {
    let cmake_dir = env::var("DEP_LLAMA_GGML_CMAKE_DIR").expect("llama-cpp-sys-2 did not export its ggml install (DEP_LLAMA_GGML_CMAKE_DIR)");
    // <out>/lib/cmake -> <out>
    let prefix = PathBuf::from(&cmake_dir).parent().and_then(|p| p.parent()).expect("bad ggml cmake dir").to_path_buf();
    let ggml_include = prefix.join("include");
    assert!(ggml_include.join("ggml.h").exists(), "ggml.h not found under {}", ggml_include.display());

    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let mut b = cc::Build::new();
    b.cpp(true)
        .std("c++17")
        .include("whisper.cpp/include")
        .include("whisper.cpp/src")
        .include(&ggml_include)
        .file("whisper.cpp/src/whisper.cpp")
        .file("whisper.cpp/src/aneforge/whisper-aneforge.cpp")
        .file("shim.cpp")
        .define("WHISPER_VERSION", "\"1.9.5\"")
        .define("_CRT_SECURE_NO_WARNINGS", None)
        .warnings(false);
    if target_env == "msvc" {
        b.flag("/utf-8").flag("/EHsc");
    }
    b.compile("whisper_lite");

    println!("cargo:rerun-if-changed=shim.cpp");
    println!("cargo:rerun-if-changed=whisper.cpp/src/whisper.cpp");
}
