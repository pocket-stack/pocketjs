use glam::Vec3;
use pocket3d_core::{CharacterBody, CharacterMoveResult};
use pocket3d_physics::PhysicsWorld;

pub trait CharacterController {
    fn move_character(
        &mut self,
        world: &PhysicsWorld<'_>,
        character: CharacterBody,
        desired_delta: Vec3,
        dt: f32,
    ) -> CharacterMoveResult;
}

#[derive(Debug, Clone, Copy)]
pub struct KccConfig {
    pub slope_limit_degrees: f32,
    pub step_height: f32,
    pub skin_width: f32,
    pub ground_probe: f32,
}

impl Default for KccConfig {
    fn default() -> Self {
        Self {
            slope_limit_degrees: 45.0,
            step_height: 18.0,
            skin_width: 1.5,
            ground_probe: 6.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct BspCharacterController {
    pub config: KccConfig,
}

impl CharacterController for BspCharacterController {
    fn move_character(
        &mut self,
        world: &PhysicsWorld<'_>,
        character: CharacterBody,
        desired_delta: Vec3,
        dt: f32,
    ) -> CharacterMoveResult {
        let mut position = character.position;
        let mut velocity = if dt > 0.0 {
            desired_delta / dt
        } else {
            character.velocity
        };
        let mut delta = desired_delta;

        let feet = position + Vec3::Z * self.config.skin_width;
        let target_feet = feet + delta;
        if delta.z < 0.0
            && let Some(hit) = world.raycast(feet, target_feet - Vec3::Z * self.config.ground_probe)
            && hit.normal.z > self.min_ground_z()
        {
            let correction = hit.position.z + self.config.skin_width - feet.z;
            if correction <= 0.0 {
                delta.z = correction.max(delta.z);
                velocity.z = 0.0;
            }
        }

        let body_probe_height = character.height * 0.5;
        let start_mid = position + Vec3::Z * body_probe_height;
        let mut remaining = Vec3::new(delta.x, delta.y, 0.0);
        for _ in 0..2 {
            if remaining.length_squared() < 0.0001 {
                break;
            }
            let end_mid = start_mid + remaining;
            if let Some(hit) = world.raycast(start_mid, end_mid)
                && hit.normal.z.abs() < self.min_ground_z()
            {
                let traveled = remaining * hit.fraction.max(0.0);
                position += traveled;
                let slide = remaining - traveled;
                remaining = slide - hit.normal * slide.dot(hit.normal);
                velocity -= hit.normal * velocity.dot(hit.normal).min(0.0);
                continue;
            }
            position += remaining;
            remaining = Vec3::ZERO;
        }

        position.z += delta.z;
        let (grounded, ground_normal, ground_z) = self.probe_ground(world, character, position);
        if grounded && position.z <= ground_z + self.config.ground_probe {
            position.z = ground_z;
            velocity.z = velocity.z.max(0.0);
        }

        CharacterMoveResult {
            position,
            velocity,
            grounded,
            ground_normal,
        }
    }
}

impl BspCharacterController {
    fn min_ground_z(self) -> f32 {
        self.config.slope_limit_degrees.to_radians().cos()
    }

    fn probe_ground(
        self,
        world: &PhysicsWorld<'_>,
        character: CharacterBody,
        position: Vec3,
    ) -> (bool, Vec3, f32) {
        let start = position + Vec3::Z * (self.config.step_height + self.config.skin_width);
        let end = position - Vec3::Z * self.config.ground_probe;
        if let Some(hit) = world.raycast(start, end)
            && hit.normal.z >= self.min_ground_z()
        {
            return (true, hit.normal, hit.position.z + self.config.skin_width);
        }

        let offsets = [
            Vec3::new(character.radius * 0.65, 0.0, 0.0),
            Vec3::new(-character.radius * 0.65, 0.0, 0.0),
            Vec3::new(0.0, character.radius * 0.65, 0.0),
            Vec3::new(0.0, -character.radius * 0.65, 0.0),
        ];
        for offset in offsets {
            if let Some(hit) = world.raycast(start + offset, end + offset)
                && hit.normal.z >= self.min_ground_z()
            {
                return (true, hit.normal, hit.position.z + self.config.skin_width);
            }
        }
        (false, Vec3::Z, position.z)
    }
}
