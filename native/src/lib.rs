#![no_std]
#![feature(alloc_error_handler)]
#![feature(asm_experimental_arch)]
#![allow(static_mut_refs)]

//! PocketJS PSP host library — the reusable half of the EBOOT.
//!
//! The `pocketjs-psp` bin is one composition of these pieces (the 2D UI
//! runtime); a game runtime (e.g. OpenStrike's PSP EBOOT) is another: it
//! links this library for the arena allocator trio, the QuickJS embedding,
//! the `ui` surface, the DrawList GE backend, the pak feeder and the
//! DevTools mailbox, then adds its own surfaces and frame loop.
//!
//! Linking this library installs the arena-backed `#[global_allocator]`
//! (and `#[alloc_error_handler]`) program-wide — the single-kernel-block
//! memory model from DESIGN.md "Memory (the blocker fix)".

extern crate alloc;

// A crate-root module literally named `alloc` would collide with
// `extern crate alloc` — keep the DESIGN.md file name, alias the module.
#[path = "alloc.rs"]
mod allocator;
pub mod arena;
pub mod c_heap;
pub mod dbg;
pub mod ffi;
pub mod ge;
pub mod ge3d;
pub mod host;
pub mod pak;
pub mod qjs_alloc;
pub mod scene3d;
