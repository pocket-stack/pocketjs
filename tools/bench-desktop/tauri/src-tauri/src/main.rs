//! bench-tauri — see Cargo.toml. BENCH_QUERY carries the storm config into
//! the shared editor page's query string.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let query = std::env::var("BENCH_QUERY").unwrap_or_default();
    tauri::Builder::default()
        .setup(move |app| {
            let url = if query.is_empty() {
                "editor.html".to_string()
            } else {
                format!("editor.html?{query}")
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
                .title("Bench Note")
                .inner_size(420.0, 560.0)
                .focused(true)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("bench-tauri: run failed");
}
