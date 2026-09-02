//! Hybrid PocketJS DrawList backend for SiFli SF32LB5x GPUs.
//!
//! The render target is always opaque RGB565. The DrawList is decoded once
//! per frame into a plan, and for every damage region the emitter turns that
//! plan into [`cmd::Cmd`]s for an executor implementing [`submit::Submit`],
//! or into batches for the core's RGB565 software rasterizer, all in painter
//! order. What may go to hardware is decided up front from the executor's
//! [`caps::Capabilities`]; executors never decline a command the planner was
//! allowed to build.
//!
//! Executors: the SiFli host's C command queue over EPIC and VG Lite, and
//! [`mock::MockGpu`], a recording software executor with the core's exact
//! pixel formulas (feature `mock`, always available to tests).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod caps;
pub mod cmd;
mod emit;
pub mod geom;
pub mod mask;
#[cfg(any(test, feature = "mock"))]
pub mod mock;
mod plan;
pub mod quad;
mod renderer;
pub mod submit;

pub use caps::{Capabilities, Engine, Formats, Thresholds};
pub use cmd::{
    Cmd, Corners, Filter, MaskId, MaskRef, Mirror, PixelFormat, TexSrc, TileId, MODULATE_NONE,
};
pub use geom::{Clip, Point, Quad, Rect};
pub use renderer::{RenderDamagePlan, RenderStats, RenderTargetState, Renderer, RendererConfig};
pub use submit::{Frame, Submit, SubmitError, TargetKind};

#[cfg(test)]
mod tests;
