//! What the renderer draws each frame. Grows with the runtime; every field
//! is plain data so gameplay code stays renderer-agnostic.

use std::sync::Arc;

use glam::Vec3;

use crate::model::ModelInstance;
use crate::world::WorldModel;

/// Procedural gradient sky (no cubemap assets required).
#[derive(Clone, Copy, Debug)]
pub struct Sky {
    pub zenith: Vec3,
    pub horizon: Vec3,
    /// Sun disc direction (pointing *from* the scene *towards* the sun).
    pub sun_dir: Vec3,
    pub sun_color: Vec3,
}

impl Default for Sky {
    fn default() -> Self {
        Self {
            // Dust-flavored defaults: warm horizon, desaturated blue zenith.
            zenith: Vec3::new(0.34, 0.48, 0.66),
            horizon: Vec3::new(0.87, 0.78, 0.62),
            sun_dir: Vec3::new(0.35, 0.65, 0.30).normalize(),
            sun_color: Vec3::new(1.0, 0.95, 0.85),
        }
    }
}

/// Simple analytic lighting for dynamic models (world geometry uses baked
/// lightmaps instead).
#[derive(Clone, Copy, Debug)]
pub struct ModelLighting {
    pub sun_dir: Vec3,
    pub sun_color: Vec3,
    pub ambient: Vec3,
}

impl Default for ModelLighting {
    fn default() -> Self {
        Self {
            sun_dir: Vec3::new(0.35, 0.65, 0.30).normalize(),
            sun_color: Vec3::new(0.95, 0.9, 0.8),
            ambient: Vec3::new(0.42, 0.4, 0.38),
        }
    }
}

/// A camera-facing quad (muzzle flashes, impact puffs). Additive-blended.
#[derive(Clone, Copy, Debug)]
pub struct Sprite {
    pub pos: Vec3,
    pub size: f32,
    pub color: [f32; 4],
}

/// A world-space line rendered as a view-aligned ribbon (tracers).
#[derive(Clone, Copy, Debug)]
pub struct Beam {
    pub a: Vec3,
    pub b: Vec3,
    pub width: f32,
    pub color: [f32; 4],
}

#[derive(Default)]
pub struct Scene {
    pub sky: Sky,
    pub lighting: ModelLighting,
    pub world: Option<Arc<WorldModel>>,
    /// Dynamic models (bots, props). Rebuilt or mutated per frame by the game.
    pub models: Vec<ModelInstance>,
    /// First-person weapon, drawn in its own depth range so it never clips
    /// into walls.
    pub viewmodel: Option<ModelInstance>,
    pub sprites: Vec<Sprite>,
    pub beams: Vec<Beam>,
    /// Seconds since startup (drives shader effects).
    pub time: f32,
}
