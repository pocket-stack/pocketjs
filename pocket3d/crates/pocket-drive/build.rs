//! Optionally embeds a cooked `.pdrv` pack (DRIVE_PACK) as the fallback for
//! running without a memory-stick file, plus the capture window envs. Empty
//! fallbacks keep bare `cargo psp` builds green.

use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let out = env::var("OUT_DIR").unwrap();
    let pack = env::var("DRIVE_PACK").unwrap_or_default();
    println!("cargo:rerun-if-env-changed=DRIVE_PACK");
    println!("cargo:rerun-if-env-changed=DRIVE_CAP_START");
    println!("cargo:rerun-if-env-changed=DRIVE_CAP_N");
    let dst = Path::new(&out).join("city.pdrv");
    if !pack.is_empty() && Path::new(&pack).exists() {
        println!("cargo:rerun-if-changed={pack}");
        fs::copy(&pack, &dst).expect("copying DRIVE_PACK");
    } else {
        fs::write(&dst, []).expect("writing empty city.pdrv");
    }
    let cap_start = env::var("DRIVE_CAP_START").unwrap_or_default();
    let cap_n = env::var("DRIVE_CAP_N").unwrap_or_default();
    println!("cargo:rustc-env=DRIVE_CAP_START={cap_start}");
    println!("cargo:rustc-env=DRIVE_CAP_N={cap_n}");
}
