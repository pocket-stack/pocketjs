//! Isolate implementation symbols without giving build-std two incompatible
//! copies of compiler-owned allocator entry points.
use std::{
    env,
    ffi::OsString,
    process::{exit, Command},
};

fn main() {
    let mut args = env::args_os().skip(1);
    let rustc = args.next().expect("RUSTC_WRAPPER requires rustc");
    let mut args: Vec<OsString> = args.collect();
    let name = args
        .windows(2)
        .find(|pair| pair[0] == "--crate-name")
        .map(|pair| pair[1].to_string_lossy().into_owned());
    const STANDARD: &[&str] = &[
        "core",
        "alloc",
        "std",
        "test",
        "compiler_builtins",
        "panic_abort",
        "panic_unwind",
        "unwind",
        "profiler_builtins",
        "rustc_std_workspace_core",
        "rustc_std_workspace_alloc",
        "rustc_std_workspace_std",
    ];
    if let Some(name) = name {
        if !STANDARD.contains(&name.as_str()) {
            let namespace =
                env::var("POCKETJS_RUST_NAMESPACE").expect("missing Rust symbol namespace");
            args.push(format!("-Cmetadata={namespace}").into());
        }
    }
    exit(
        Command::new(rustc)
            .args(args)
            .status()
            .expect("could not run rustc")
            .code()
            .unwrap_or(1),
    );
}
