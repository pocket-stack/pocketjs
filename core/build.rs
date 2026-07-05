//! Build-time screen dimensions for pocketjs-core.
//!
//! SCREEN_W/H used to be baked constants in the generated `spec.rs` (480×272,
//! the PSP). They are now a DEVICE-PROFILE knob (spec/devices.ts): each backend
//! build (scripts/psp.ts, scripts/3ds.ts, scripts/wasm.ts) exports
//! `POCKETJS_SCREEN_W`/`POCKETJS_SCREEN_H` for its profile; cargo passes those
//! env vars down to this dependency build script, and `spec.rs` `include!`s the
//! `screen.rs` we emit here. Unset defaults to 480×272, so PSP, wasm, the host
//! tests and the committed goldens stay byte-for-byte unchanged.

use std::{env, fs, path::Path};

fn dim(var: &str, default: u32) -> u32 {
    println!("cargo:rerun-if-env-changed={var}");
    env::var(var)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(default)
}

fn main() {
    let w = dim("POCKETJS_SCREEN_W", 480);
    let h = dim("POCKETJS_SCREEN_H", 272);
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("screen.rs");
    fs::write(
        &out,
        format!("pub const SCREEN_W: u32 = {w};\npub const SCREEN_H: u32 = {h};\n"),
    )
    .unwrap();
}
