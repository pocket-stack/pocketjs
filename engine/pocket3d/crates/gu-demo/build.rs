//! Embeds the cooked map selected by GU_DEMO_MAP (a .p3d path) plus the
//! capture window envs. Empty fallbacks keep bare `cargo psp` builds green.

use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let out = env::var("OUT_DIR").unwrap();
    let map = env::var("GU_DEMO_MAP").unwrap_or_default();
    println!("cargo:rerun-if-env-changed=GU_DEMO_MAP");
    println!("cargo:rerun-if-env-changed=GU_DEMO_CAP_START");
    println!("cargo:rerun-if-env-changed=GU_DEMO_CAP_N");
    let dst = Path::new(&out).join("map.p3d");
    if !map.is_empty() && Path::new(&map).exists() {
        println!("cargo:rerun-if-changed={map}");
        fs::copy(&map, &dst).expect("copying GU_DEMO_MAP");
    } else {
        fs::write(&dst, []).expect("writing empty map.p3d");
    }
    let cap_start = env::var("GU_DEMO_CAP_START").unwrap_or_default();
    let cap_n = env::var("GU_DEMO_CAP_N").unwrap_or_default();
    println!("cargo:rustc-env=GU_DEMO_CAP_START={cap_start}");
    println!("cargo:rustc-env=GU_DEMO_CAP_N={cap_n}");
}
