use std::path::{Path, PathBuf};
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
    assert_eq!(target, "vita", "Vita host requires POCKETJS_TARGET=vita");
    let host_abi = env::var("POCKETJS_HOST_ABI").unwrap_or_else(|_| "2".into());
    assert_eq!(host_abi, "2", "Vita host requires POCKETJS_HOST_ABI=2");
    let dist = env::var_os("POCKETJS_OUTPUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../../dist"));
    let out_dir = env::var("OUT_DIR").unwrap();

    // The resolved build plan supplies the logical/physical viewports. Vita's
    // The resolved plan keeps PSP-compatible layout while independently
    // specifying physical presentation and target raster density.
    let logical_width = positive_dimension("POCKETJS_LOGICAL_WIDTH", 480);
    let logical_height = positive_dimension("POCKETJS_LOGICAL_HEIGHT", 272);
    let physical_width = positive_dimension("POCKETJS_PHYSICAL_WIDTH", 960);
    let physical_height = positive_dimension("POCKETJS_PHYSICAL_HEIGHT", 544);
    let raster_density = positive_dimension("POCKETJS_RASTER_DENSITY", 2);
    let presentation = env::var("POCKETJS_PRESENTATION").unwrap_or_else(|_| "integer-fit".into());
    assert_eq!(
        (logical_width, logical_height),
        (480, 272),
        "Vita host requires the PSP-compatible 480x272 logical viewport"
    );
    assert_eq!(
        (physical_width, physical_height),
        (960, 544),
        "Vita host requires the native 960x544 physical viewport"
    );
    assert_eq!(
        presentation, "integer-fit",
        "Vita host currently supports only integer-fit presentation"
    );
    assert_eq!(raster_density, 2, "Vita host requires raster density 2");
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
             pub const RASTER_DENSITY: u32 = {raster_density};\n\
             pub const SCALE: f32 = {scale_x} as f32;\n"
        ),
    )
    .unwrap();

    // App JS bundle
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
    println!("cargo:rustc-env=POCKETJS_CAPTURE_INPUT={capture_input}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_FRAMES={capture_frames}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_DIR={capture_dir}");

    println!(
        "cargo:rerun-if-changed={}",
        dist.join(format!("{app}.js")).display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        dist.join(format!("{app}.pak")).display()
    );
    println!("cargo:rerun-if-env-changed=POCKETJS_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP_OUTPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_EMBED_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_OUTPUT_DIR");
    println!("cargo:rerun-if-env-changed=POCKETJS_TARGET");
    println!("cargo:rerun-if-env-changed=POCKETJS_HOST_ABI");
    println!("cargo:rerun-if-env-changed=POCKETJS_LOGICAL_WIDTH");
    println!("cargo:rerun-if-env-changed=POCKETJS_LOGICAL_HEIGHT");
    println!("cargo:rerun-if-env-changed=POCKETJS_PHYSICAL_WIDTH");
    println!("cargo:rerun-if-env-changed=POCKETJS_PHYSICAL_HEIGHT");
    println!("cargo:rerun-if-env-changed=POCKETJS_PRESENTATION");
    println!("cargo:rerun-if-env-changed=POCKETJS_RASTER_DENSITY");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_INPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_FRAMES");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_DIR");
}
