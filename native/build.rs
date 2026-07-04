//! Embeds the built app bundle + asset pack into the EBOOT at build time.
//! Pattern copied from the dreamcart runtime (runtime/build.rs, the
//! PSPJS_GAME pattern), renamed to POCKETJS_APP.
//!
//! Set `POCKETJS_APP` to an app name whose build outputs exist in ../dist/
//! (written by scripts/build.ts as `<app>.js` + `<app>.dcpak`):
//!   POCKETJS_APP=hero bun scripts/psp.ts
//!
//! Both embeds have EMPTY fallbacks so include_str!/include_bytes! in main.rs
//! always resolve — an EBOOT built with no app boots to the JS-error screen
//! rather than failing the build.

use std::path::Path;
use std::{env, fs};

fn main() {
    let app = env::var("POCKETJS_APP").unwrap_or_default();
    let dist = Path::new("../dist");
    let out_dir = env::var("OUT_DIR").unwrap();

    // App JS bundle -> $OUT_DIR/game.js, NUL-terminated for JS_Eval (which
    // requires input[len] == '\0'; main.rs evals with len - 1).
    let mut code = if app.is_empty() {
        String::new()
    } else {
        fs::read_to_string(dist.join(format!("{app}.js"))).unwrap_or_else(|e| {
            panic!("could not read dist/{app}.js (run `bun run build {app}` first): {e}")
        })
    };
    code.push('\0');
    fs::write(Path::new(&out_dir).join("game.js"), code).unwrap();

    // Asset pack (styles.bin + font atlases + images; .dcpak container) ->
    // $OUT_DIR/app.dcpak. Empty when absent; main.rs skips an empty pack.
    let dcpak = if app.is_empty() {
        Vec::new()
    } else {
        fs::read(dist.join(format!("{app}.dcpak"))).unwrap_or_default()
    };
    fs::write(Path::new(&out_dir).join("app.dcpak"), dcpak).unwrap();

    // Scripted input for deterministic capture builds (test/e2e-ppsspp.ts):
    // "frame:mask,frame:mask" baked into the EBOOT, consumed by main.rs only
    // under --features capture (same pattern as dreamcart runtime/build.rs
    // PSPJS_CAPTURE_INPUT).
    let capture_input = env::var("POCKETJS_CAPTURE_INPUT").unwrap_or_default();
    // Optional real-hardware boot trace. scripts/hw.ts serves the build dir as
    // host0:, so main.rs can append trace lines to host0:/PocketJS-trace.txt.
    let trace = env::var("POCKETJS_TRACE").unwrap_or_default();
    let engine = env::var("POCKETJS_ENGINE").unwrap_or_default();
    // Per-demo capture window (frames dumped = cap_start..cap_start+cap_n);
    // empty -> main.rs defaults (16/32).
    let cap_start = env::var("POCKETJS_CAP_START").unwrap_or_default();
    let cap_n = env::var("POCKETJS_CAP_N").unwrap_or_default();

    println!("cargo:rustc-env=POCKETJS_APP={app}");
    println!("cargo:rustc-env=POCKETJS_ENGINE={engine}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_INPUT={capture_input}");
    println!("cargo:rustc-env=POCKETJS_TRACE={trace}");
    println!("cargo:rustc-env=POCKETJS_CAP_START={cap_start}");
    println!("cargo:rustc-env=POCKETJS_CAP_N={cap_n}");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_ENGINE");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_INPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_TRACE");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAP_START");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAP_N");
    if let Ok(entries) = fs::read_dir(dist) {
        for e in entries.flatten() {
            println!("cargo:rerun-if-changed={}", e.path().display());
        }
    }
}
