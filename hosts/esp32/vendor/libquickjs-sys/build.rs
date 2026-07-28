use std::path::{Path, PathBuf};

use std::env;

fn exists(path: impl AsRef<Path>) -> bool {
    PathBuf::from(path.as_ref()).exists()
}

const LIB_NAME: &str = "quickjs";

#[cfg(all(not(feature = "system"), not(feature = "bundled")))]
fn main() {
    panic!("Invalid config for crate libquickjs-sys: must enable either the 'bundled' or the 'system' feature");
}

#[cfg(feature = "system")]
extern crate bindgen;

#[cfg(feature = "system")]
fn main() {
    #[cfg(not(feature = "bindgen"))]
    panic!("Invalid configuration for libquickjs-sys: Must either enable the bundled or the bindgen feature");

    #[cfg(feature = "patched")]
    panic!("Invalid configuration for libquickjs-sys: the patched feature is incompatible with the system feature");

    let lib: std::borrow::Cow<str> = if let Ok(lib) = env::var("QUICKJS_LIBRARY_PATH") {
        lib.into()
    } else if cfg!(unix) {
        if exists(format!("/usr/lib/quickjs/{}.a", LIB_NAME)) {
            "/usr/lib/quickjs".into()
        } else if exists("/usr/local/lib/quickjs") {
            "/usr/local/lib/quickjs".into()
        } else {
            panic!("quickjs library could not be found. Try setting the QUICKJS_LIBRARY_PATH env variable");
        }
    } else {
        panic!("quickjs error: Windows is not supported yet");
    };

    // Instruct cargo to statically link quickjs.
    println!("cargo:rustc-link-search=native={}", lib);
    println!("cargo:rustc-link-lib=static={}", LIB_NAME);
}

#[cfg(feature = "bundled")]
fn main() {
    println!("cargo:rerun-if-env-changed=PSPDEV");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let embed_path = manifest_dir.join("embed");
    let psp_root = env::var_os("PSPDEV")
        .map(|path| PathBuf::from(path).join("psp"))
        .unwrap_or_else(|| manifest_dir.join("../../mipsel-sony-psp/psp"));
    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap());
    let target = env::var("TARGET").unwrap_or_default();
    let is_psp = target.contains("psp");
    let is_vita = target.contains("vita");
    let is_esp32 = target == "xtensa-esp32-none-elf";

    let code_dir = out_path.join("quickjs");
    if exists(&code_dir) {
        std::fs::remove_dir_all(&code_dir).unwrap();
    }
    copy_dir::copy_dir(embed_path.join("quickjs"), &code_dir)
        .expect("Could not copy quickjs directory");

    #[cfg(feature = "patched")]
    apply_patches(&code_dir);

    std::fs::copy(
        embed_path.join("static-functions.c"),
        code_dir.join("static-functions.c"),
    )
    .expect("Could not copy static-functions.c");

    eprintln!("Compiling quickjs...");
    let quickjs_version =
        std::fs::read_to_string(code_dir.join("VERSION")).expect("failed to read quickjs version");
    let mut sources = vec![
        "cutils.c",
        "dtoa.c",
        "libregexp.c",
        "libunicode.c",
        "quickjs.c",
        // Custom wrappers.
        "static-functions.c",
    ];
    // patch.c supplies __truncdfsf2 for PSP/Vita toolchains.  The Xtensa Rust
    // target already exports that compiler builtin, so including it there
    // creates a duplicate definition at the final firmware link.
    if !is_esp32 {
        sources.push("patch.c");
    }

    let mut build = cc::Build::new();
    build
        .files(sources.iter().map(|f| code_dir.join(f)))
        .define("_GNU_SOURCE", None)
        .define(
            "CONFIG_VERSION",
            format!("\"{}\"", quickjs_version.trim()).as_str(),
        )
        // The below flags are used by the official Makefile.
        .flag_if_supported("-Wchar-subscripts")
        .flag_if_supported("-Wno-array-bounds")
        .flag_if_supported("-Wno-format-truncation")
        .flag_if_supported("-Wno-missing-field-initializers")
        .flag_if_supported("-Wno-sign-compare")
        .flag_if_supported("-Wno-unused-parameter")
        .flag_if_supported("-Wundef")
        .flag_if_supported("-Wuninitialized")
        .flag_if_supported("-Wunused")
        .flag_if_supported("-Wwrite-strings")
        .flag_if_supported("-funsigned-char")
        // QuickJS's official Makefile requires wrapping signed arithmetic.
        // Without this, Xtensa GCC may miscompile bytecode generation at -O2
        // and the interpreter later observes invalid opcodes.
        .flag_if_supported("-fwrapv")
        // Below flags are added to supress warnings that appear on some
        // platforms.
        .flag_if_supported("-Wno-cast-function-type")
        .flag_if_supported("-Wno-implicit-fallthrough")
        .flag_if_supported("-Wno-enum-conversion")
        // The ESP32 prebuild selects Espressif GCC 13+; GCC 8.4 is known to
        // miscompile this translation unit.  Optimised interpreter frames are
        // required because FreeRTOS task stacks live in scarce internal RAM.
        .opt_level(if is_esp32 { 2 } else { 0 })
        .flag_if_supported("-fno-strict-aliasing");

    if is_psp {
        build
            .define("__PSP__", None)
            .define("__psp__", None)
            .include(psp_root.join("include"));
    }

    if is_esp32 {
        // QuickJS is a large translation unit.  Xtensa's default CALL0/CALL8
        // range cannot reach every section once it is linked with Arduino,
        // Bluetooth and the PocketJS core, so emit long calls for C objects.
        // libquickjs-sys selects the native 64-bit NaN-boxed JSValue for this
        // 32-bit target, matching QuickJS's default representation.
        build
            .define("__ESP32__", None)
            .flag_if_supported("-mlongcalls")
            // QuickJS objects live in ESP32 PSRAM.  These are the same cache
            // erratum workarounds used by the surrounding PlatformIO build;
            // omitting them corrupts GC object links during large walks.
            .flag_if_supported("-mfix-esp32-psram-cache-issue")
            .flag_if_supported("-mfix-esp32-psram-cache-strategy=memw");
    }

    // QuickJS defaults to NaN-boxed JSValue on 32-bit targets, while the
    // checked-in Rust bindings use the portable 16-byte tagged structure.
    // Keep both sides of the Vita FFI on that same representation. Vita's
    // newlib also lacks tm_gmtoff; quickjs.c has a small target guard below.
    if is_vita {
        build
            .define("__PSVITA__", None)
            .define("__vita__", None)
            .define("JS_NO_NAN_BOXING", None);
    }

    build.compile(LIB_NAME);

    if is_psp {
        println!(
            "cargo:rustc-link-search=native={}",
            psp_root.join("lib").display()
        );
        println!("cargo:rustc-link-lib=static:-bundle=c");
        println!("cargo:rustc-link-lib=static:-bundle=m");
        println!("cargo:rustc-link-lib=static:-bundle=pthread-psp");
        if psp_root.join("lib/libcglue.a").exists() {
            println!("cargo:rustc-link-lib=static:-bundle=cglue");
        }
    }

    std::fs::copy(embed_path.join("bindings.rs"), out_path.join("bindings.rs"))
        .expect("Could not copy bindings.rs");
}

#[cfg(feature = "patched")]
fn apply_patches(code_dir: &PathBuf) {
    use std::fs;

    eprintln!("Applying patches...");
    let embed_path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("embed");
    let patches_path = embed_path.join("patches");
    for patch in fs::read_dir(patches_path).expect("Could not open patches directory") {
        let patch = patch.expect("Could not open patch");
        eprintln!("Applying {:?}...", patch.file_name());
        let status = std::process::Command::new("patch")
            .current_dir(&code_dir)
            .arg("-i")
            .arg(patch.path())
            .spawn()
            .expect("Could not apply patches")
            .wait()
            .expect("Could not apply patches");
        assert!(
            status.success(),
            "Patch command returned non-zero exit code"
        );
    }
}
