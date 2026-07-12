//! Embeds the built app bundle + asset pack into the EBOOT at build time.
//! Pattern copied from the dreamcart runtime (runtime/build.rs, the
//! PSPJS_GAME pattern), with app selection separated from embed ownership.
//!
//! The stock backend sets `POCKETJS_APP_OUTPUT` and `POCKETJS_EMBED_APP=1`.
//! Custom native hosts consume the same output name but leave embedding to
//! their own primary crate, so this runtime remains a reusable dependency.
//! `POCKETJS_APP=<name>` remains a legacy shorthand that implies embedding.
//!
//! Both embeds have EMPTY fallbacks so include_str!/include_bytes! in main.rs
//! always resolve — an EBOOT built with no app boots to the JS-error screen
//! rather than failing the build.

use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    let legacy_app = env::var("POCKETJS_APP").unwrap_or_default();
    let app = env::var("POCKETJS_APP_OUTPUT").unwrap_or_else(|_| legacy_app.clone());
    let embed_app = match env::var("POCKETJS_EMBED_APP") {
        Ok(value) => match value.as_str() {
            "0" => false,
            "1" => true,
            _ => panic!("POCKETJS_EMBED_APP must be 0 or 1, got {value:?}"),
        },
        Err(_) => !legacy_app.is_empty(),
    };
    assert!(
        !embed_app || !app.is_empty(),
        "POCKETJS_EMBED_APP=1 requires POCKETJS_APP_OUTPUT"
    );
    let target = env::var("POCKETJS_TARGET").unwrap_or_else(|_| "psp".into());
    let host_abi = env::var("POCKETJS_HOST_ABI").unwrap_or_else(|_| "1".into());
    let contract_hash = env::var("POCKETJS_CONTRACT_HASH").unwrap_or_default();
    let dist = env::var_os("POCKETJS_OUTPUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../dist"));
    let out_dir = env::var("OUT_DIR").unwrap();

    // App JS bundle -> $OUT_DIR/game.js, NUL-terminated for JS_Eval (which
    // requires input[len] == '\0'; main.rs evals with len - 1).
    let mut code = if !embed_app {
        String::new()
    } else {
        let path = dist.join(format!("{app}.js"));
        fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "could not read {} (compile the resolved plan first): {e}",
                path.display()
            )
        })
    };
    code.push('\0');
    fs::write(Path::new(&out_dir).join("game.js"), code).unwrap();

    // Asset pack (styles.bin + font atlases + images; .pak container) ->
    // $OUT_DIR/app.pak. Empty when absent; main.rs skips an empty pack.
    let pak = if !embed_app {
        Vec::new()
    } else {
        fs::read(dist.join(format!("{app}.pak"))).unwrap_or_default()
    };
    fs::write(Path::new(&out_dir).join("app.pak"), pak).unwrap();

    // Scripted input for deterministic capture builds (test/e2e-ppsspp.ts):
    // "frame:mask,frame:mask" baked into the EBOOT, consumed by main.rs only
    // under --features capture (same pattern as dreamcart runtime/build.rs
    // PSPJS_CAPTURE_INPUT).
    let capture_input = env::var("POCKETJS_CAPTURE_INPUT").unwrap_or_default();
    // Optional real-hardware boot trace. scripts/hw.ts serves the build dir as
    // host0:, so main.rs can append trace lines to host0:/PocketJS-trace.txt.
    let trace = env::var("POCKETJS_TRACE").unwrap_or_default();
    // Per-demo capture window (frames dumped = cap_start..cap_start+cap_n);
    // empty -> main.rs defaults (16/32).
    let cap_start = env::var("POCKETJS_CAP_START").unwrap_or_default();
    let cap_n = env::var("POCKETJS_CAP_N").unwrap_or_default();
    // Optional bench-only knobs. POCKETJS_ARENA_BYTES caps the single arena so
    // scripts/bench-ppsspp.ts can scan minimum viable heap sizes; empty keeps
    // the production "free memory minus margin" behavior. Bench runs can also
    // skip raw frame dumps while still using the capture window to exit.
    let arena_bytes = env::var("POCKETJS_ARENA_BYTES").unwrap_or_default();
    let bench_dump_frames = env::var("POCKETJS_BENCH_DUMP_FRAMES").unwrap_or_default();

    println!("cargo:rustc-env=POCKETJS_APP={app}");
    println!("cargo:rustc-env=POCKETJS_TARGET={target}");
    println!("cargo:rustc-env=POCKETJS_HOST_ABI={host_abi}");
    println!("cargo:rustc-env=POCKETJS_CONTRACT_HASH={contract_hash}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_INPUT={capture_input}");
    println!("cargo:rustc-env=POCKETJS_TRACE={trace}");
    println!("cargo:rustc-env=POCKETJS_CAP_START={cap_start}");
    println!("cargo:rustc-env=POCKETJS_CAP_N={cap_n}");
    println!("cargo:rustc-env=POCKETJS_ARENA_BYTES={arena_bytes}");
    println!("cargo:rustc-env=POCKETJS_BENCH_DUMP_FRAMES={bench_dump_frames}");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP_OUTPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_EMBED_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_OUTPUT_DIR");
    println!("cargo:rerun-if-env-changed=POCKETJS_TARGET");
    println!("cargo:rerun-if-env-changed=POCKETJS_HOST_ABI");
    println!("cargo:rerun-if-env-changed=POCKETJS_CONTRACT_HASH");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_INPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_TRACE");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAP_START");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAP_N");
    println!("cargo:rerun-if-env-changed=POCKETJS_ARENA_BYTES");
    println!("cargo:rerun-if-env-changed=POCKETJS_BENCH_DUMP_FRAMES");
    if let Ok(entries) = fs::read_dir(&dist) {
        for e in entries.flatten() {
            println!("cargo:rerun-if-changed={}", e.path().display());
        }
    }
}
