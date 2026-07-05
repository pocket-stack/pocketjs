use glam::Vec3;
use pocket3d_bsp::{BspTrace, BspWorld};
use pocket3d_core::CharacterBody;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RayHit {
    pub position: Vec3,
    pub normal: Vec3,
    pub fraction: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Capsule {
    pub radius: f32,
    pub height: f32,
}

pub struct PhysicsWorld<'a> {
    pub bsp: &'a BspWorld,
}

impl<'a> PhysicsWorld<'a> {
    pub fn new(bsp: &'a BspWorld) -> Self {
        Self { bsp }
    }

    pub fn raycast(&self, from: Vec3, to: Vec3) -> Option<RayHit> {
        self.bsp.raycast(from, to).map(
            |BspTrace {
                 position,
                 normal,
                 fraction,
                 ..
             }| RayHit {
                position,
                normal,
                fraction,
            },
        )
    }

    pub fn point_is_solid(&self, point: Vec3) -> bool {
        self.bsp.point_is_solid(point)
    }

    pub fn body_capsule(body: CharacterBody) -> Capsule {
        Capsule {
            radius: body.radius,
            height: body.height,
        }
    }
}
