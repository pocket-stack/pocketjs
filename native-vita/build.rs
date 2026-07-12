use std::path::Path;
use std::{env, fs};

fn positive_dimension(name: &str, fallback: u32) -> u32 {
    match env::var(name) {
        Ok(value) => value
            .parse::<u32>()
            .ok()
            .filter(|value| *value > 0)
            .unwrap_or_else(|| panic!("{name} must be a positive integer, got {value:?}")),
        Err(_) => fallback,
    }
}

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
    let target = env::var("POCKETJS_TARGET").unwrap_or_else(|_| "vita".into());
    let host_abi = env::var("POCKETJS_HOST_ABI").unwrap_or_else(|_| "1".into());
    let contract_hash = env::var("POCKETJS_CONTRACT_HASH").unwrap_or_default();
    let dist = Path::new("../dist");
    let out_dir = env::var("OUT_DIR").unwrap();

    // The resolved build plan supplies the logical/physical viewports. Vita's
    // current backend implements a fullscreen integer-fit presentation, so
    // reject a plan that would require stretching, letterboxing, or a
    // different physical display instead of silently rendering it wrong.
    let logical_width = positive_dimension("POCKETJS_LOGICAL_WIDTH", 480);
    let logical_height = positive_dimension("POCKETJS_LOGICAL_HEIGHT", 272);
    let physical_width = positive_dimension("POCKETJS_PHYSICAL_WIDTH", 960);
    let physical_height = positive_dimension("POCKETJS_PHYSICAL_HEIGHT", 544);
    assert_eq!(
        (physical_width, physical_height),
        (960, 544),
        "Vita host requires the native 960x544 physical viewport"
    );
    assert!(
        physical_width % logical_width == 0 && physical_height % logical_height == 0,
        "Vita host requires an integer-fit logical viewport"
    );
    let scale_x = physical_width / logical_width;
    let scale_y = physical_height / logical_height;
    assert_eq!(
        scale_x, scale_y,
        "Vita host requires one uniform fullscreen scale"
    );
    fs::write(
        Path::new(&out_dir).join("build_plan.rs"),
        format!(
            "pub const LOGICAL_W: i32 = {logical_width};\n\
             pub const LOGICAL_H: i32 = {logical_height};\n\
             pub const PHYSICAL_W: i32 = {physical_width};\n\
             pub const PHYSICAL_H: i32 = {physical_height};\n\
             pub const INTEGER_SCALE: usize = {scale_x};\n\
             pub const SCALE: f32 = {scale_x} as f32;\n"
        ),
    )
    .unwrap();

    // App JS bundle
    let mut code = if !embed_app {
        String::new()
    } else {
        fs::read_to_string(dist.join(format!("{app}.js"))).unwrap_or_else(|e| {
            panic!("could not read dist/{app}.js (run `bun run build {app}` first): {e}")
        })
    };
    code.push('\0');
    fs::write(Path::new(&out_dir).join("game.js"), code).unwrap();

    // Asset pack
    let pak = if !embed_app {
        Vec::new()
    } else {
        fs::read(dist.join(format!("{app}.pak"))).unwrap_or_default()
    };
    fs::write(Path::new(&out_dir).join("app.pak"), pak).unwrap();

    let capture_input = env::var("POCKETJS_CAPTURE_INPUT").unwrap_or_default();
    let capture_frames = env::var("POCKETJS_CAPTURE_FRAMES").unwrap_or_default();
    let capture_dir = env::var("POCKETJS_CAPTURE_DIR")
        .unwrap_or_else(|_| String::from("ux0:data/pocketjs-captures"));

    println!("cargo:rustc-env=POCKETJS_TARGET={target}");
    println!("cargo:rustc-env=POCKETJS_HOST_ABI={host_abi}");
    println!("cargo:rustc-env=POCKETJS_CONTRACT_HASH={contract_hash}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_INPUT={capture_input}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_FRAMES={capture_frames}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_DIR={capture_dir}");

    println!("cargo:rerun-if-changed=../dist/{app}.js");
    println!("cargo:rerun-if-changed=../dist/{app}.pak");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP_OUTPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_EMBED_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_TARGET");
    println!("cargo:rerun-if-env-changed=POCKETJS_HOST_ABI");
    println!("cargo:rerun-if-env-changed=POCKETJS_CONTRACT_HASH");
    println!("cargo:rerun-if-env-changed=POCKETJS_LOGICAL_WIDTH");
    println!("cargo:rerun-if-env-changed=POCKETJS_LOGICAL_HEIGHT");
    println!("cargo:rerun-if-env-changed=POCKETJS_PHYSICAL_WIDTH");
    println!("cargo:rerun-if-env-changed=POCKETJS_PHYSICAL_HEIGHT");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_INPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_FRAMES");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_DIR");
}
