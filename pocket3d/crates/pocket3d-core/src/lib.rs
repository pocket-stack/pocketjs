pub use glam::{Mat4, Quat, Vec2, Vec3, Vec4};

use serde::{Deserialize, Serialize};

pub const DEFAULT_FIXED_HZ: f32 = 60.0;
pub const DEFAULT_FIXED_DT: f32 = 1.0 / DEFAULT_FIXED_HZ;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EntityId {
    pub slot: u32,
    pub generation: u32,
}

impl EntityId {
    pub const INVALID: Self = Self {
        slot: u32::MAX,
        generation: u32::MAX,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    pub position: Vec3,
    pub rotation: Quat,
    pub scale: Vec3,
}

impl Transform {
    pub const IDENTITY: Self = Self {
        position: Vec3::ZERO,
        rotation: Quat::IDENTITY,
        scale: Vec3::ONE,
    };

    pub fn from_position(position: Vec3) -> Self {
        Self {
            position,
            ..Self::IDENTITY
        }
    }

    pub fn matrix(self) -> Mat4 {
        Mat4::from_scale_rotation_translation(self.scale, self.rotation, self.position)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Camera {
    pub eye: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub fov_y_radians: f32,
    pub near: f32,
    pub far: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            eye: Vec3::new(0.0, 0.0, 64.0),
            yaw: 0.0,
            pitch: 0.0,
            fov_y_radians: 80_f32.to_radians(),
            near: 0.03,
            far: 8192.0,
        }
    }
}

impl Camera {
    pub fn forward(self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        Vec3::new(cy * cp, sy * cp, sp).normalize_or_zero()
    }

    pub fn right(self) -> Vec3 {
        self.forward().cross(Vec3::Z).normalize_or_zero()
    }

    pub fn view_matrix(self) -> Mat4 {
        Mat4::look_to_rh(self.eye, self.forward(), Vec3::Z)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct InputSnapshot {
    pub movement: Vec2,
    pub look_delta: Vec2,
    pub jump: bool,
    pub fire: bool,
    pub sprint: bool,
    pub debug_toggle: bool,
}

impl Default for InputSnapshot {
    fn default() -> Self {
        Self {
            movement: Vec2::ZERO,
            look_delta: Vec2::ZERO,
            jump: false,
            fire: false,
            sprint: false,
            debug_toggle: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FixedTimestep {
    dt: f32,
    accumulator: f32,
    max_steps: u32,
}

impl FixedTimestep {
    pub fn new(hz: f32) -> Self {
        Self {
            dt: 1.0 / hz,
            accumulator: 0.0,
            max_steps: 5,
        }
    }

    pub fn push_frame_time(&mut self, seconds: f32) -> u32 {
        self.accumulator += seconds.max(0.0).min(0.25);
        let mut steps = 0;
        while self.accumulator >= self.dt && steps < self.max_steps {
            self.accumulator -= self.dt;
            steps += 1;
        }
        if steps == self.max_steps {
            self.accumulator = self.accumulator.min(self.dt);
        }
        steps
    }

    pub fn dt(self) -> f32 {
        self.dt
    }

    pub fn alpha(self) -> f32 {
        (self.accumulator / self.dt).clamp(0.0, 1.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RoundState {
    Loading,
    PreRound,
    Live,
    PlayerWon,
    PlayerLost,
    Intermission,
    Restarting,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WeaponDefinition {
    pub damage: f32,
    pub fire_interval_ms: u32,
    pub range: f32,
    pub spread_degrees: f32,
}

impl Default for WeaponDefinition {
    fn default() -> Self {
        Self {
            damage: 35.0,
            fire_interval_ms: 120,
            range: 4096.0,
            spread_degrees: 0.5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CharacterBody {
    pub position: Vec3,
    pub velocity: Vec3,
    pub radius: f32,
    pub height: f32,
    pub grounded: bool,
}

impl CharacterBody {
    pub fn eye(self, eye_height: f32) -> Vec3 {
        self.position + Vec3::Z * eye_height
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CharacterMoveResult {
    pub position: Vec3,
    pub velocity: Vec3,
    pub grounded: bool,
    pub ground_normal: Vec3,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_timestep_accumulates_steps() {
        let mut clock = FixedTimestep::new(60.0);
        assert_eq!(clock.push_frame_time(1.0 / 120.0), 0);
        assert_eq!(clock.push_frame_time(1.0 / 120.0), 1);
        assert!(clock.alpha() < 0.01);
    }

    #[test]
    fn camera_forward_uses_z_up_yaw_pitch() {
        let camera = Camera {
            yaw: 0.0,
            pitch: 0.0,
            ..Camera::default()
        };
        assert!((camera.forward() - Vec3::X).length() < 0.001);
        let camera = Camera {
            yaw: 90_f32.to_radians(),
            pitch: 0.0,
            ..Camera::default()
        };
        assert!((camera.forward() - Vec3::Y).length() < 0.001);
    }
}
