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

    println!("cargo:rerun-if-changed=../dist/{app}.js");
    println!("cargo:rerun-if-changed=../dist/{app}.pak");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP");
}
