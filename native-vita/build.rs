use std::path::Path;
use std::{env, fs};

fn main() {
    let app = env::var("POCKETJS_APP").unwrap_or_default();
    let dist = Path::new("../dist");
    let out_dir = env::var("OUT_DIR").unwrap();

    // App JS bundle
    let mut code = if app.is_empty() {
        String::new()
    } else {
        fs::read_to_string(dist.join(format!("{app}.js"))).unwrap_or_else(|e| {
            panic!("could not read dist/{app}.js (run `bun run build {app}` first): {e}")
        })
    };
    code.push('\0');
    fs::write(Path::new(&out_dir).join("game.js"), code).unwrap();

    // Asset pack
    let pak = if app.is_empty() {
        Vec::new()
    } else {
        fs::read(dist.join(format!("{app}.pak"))).unwrap_or_default()
    };
    fs::write(Path::new(&out_dir).join("app.pak"), pak).unwrap();

    let capture_input = env::var("POCKETJS_CAPTURE_INPUT").unwrap_or_default();
    let capture_frames = env::var("POCKETJS_CAPTURE_FRAMES").unwrap_or_default();
    let capture_dir = env::var("POCKETJS_CAPTURE_DIR")
        .unwrap_or_else(|_| String::from("ux0:data/pocketjs-captures"));

    println!("cargo:rustc-env=POCKETJS_CAPTURE_INPUT={capture_input}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_FRAMES={capture_frames}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_DIR={capture_dir}");

    println!("cargo:rerun-if-changed=../dist/{app}.js");
    println!("cargo:rerun-if-changed=../dist/{app}.pak");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_INPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_FRAMES");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_DIR");
}
