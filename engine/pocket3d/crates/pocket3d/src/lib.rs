//! Pocket3D — a small, modern, extensible 3D runtime.
//!
//! Design goals:
//! - **Lean core**: wgpu forward renderer, first-person camera, fixed-step
//!   loop, input, skeletal animation, and a trace-based character controller.
//! - **Formats as modules**: world formats plug in as data providers. GoldSrc
//!   BSP is the first first-class citizen (feature `bsp`).
//! - **Headless-first verification**: everything renders into any
//!   `wgpu::TextureView`, so offscreen capture and scripted tests are trivial.

pub mod anim;
pub mod app;
pub mod camera;
pub mod collide;
pub mod gpu;
pub mod hud;
pub mod input;
pub mod model;
pub mod renderer;
pub mod scene;
pub mod texture;
pub mod time;
pub mod world;

pub use anyhow;
pub use glam;
pub use wgpu;
pub use winit;

#[cfg(feature = "bsp")]
pub use pocket3d_bsp as bsp;

pub mod prelude {
    pub use crate::anim::AnimState;
    pub use crate::app::{AppConfig, Game};
    pub use crate::camera::Camera;
    pub use crate::collide::{
        CharacterState, HullKind, MoveInput, MoveParams, Trace, TraceWorld, step_character,
    };
    pub use crate::gpu::{DEPTH_FORMAT, Gpu, OFFSCREEN_FORMAT, OffscreenTarget};
    pub use crate::hud::Hud;
    pub use crate::input::Input;
    pub use crate::model::{ModelAsset, ModelInstance};
    pub use crate::renderer::Renderer;
    pub use crate::scene::Scene;
    pub use crate::scene::{Beam, Sprite};
    pub use crate::time::FixedTimestep;
    pub use crate::world::WorldModel;
    pub use glam::{Mat4, Quat, Vec2, Vec3, Vec4};
}
