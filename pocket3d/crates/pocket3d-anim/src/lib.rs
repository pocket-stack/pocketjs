use glam::{Mat4, Quat, Vec3};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AnimError {
    #[error("glTF import failed: {0}")]
    Gltf(#[from] gltf::Error),
}

#[derive(Debug, Clone)]
pub struct Joint {
    pub name: String,
    pub parent: Option<usize>,
    pub inverse_bind: Mat4,
}

#[derive(Debug, Clone)]
pub struct Skeleton {
    pub joints: Vec<Joint>,
}

#[derive(Debug, Clone, Copy)]
pub struct JointPose {
    pub translation: Vec3,
    pub rotation: Quat,
    pub scale: Vec3,
}

impl JointPose {
    pub const IDENTITY: Self = Self {
        translation: Vec3::ZERO,
        rotation: Quat::IDENTITY,
        scale: Vec3::ONE,
    };

    pub fn matrix(self) -> Mat4 {
        Mat4::from_scale_rotation_translation(self.scale, self.rotation, self.translation)
    }
}

#[derive(Debug, Clone)]
pub struct Pose {
    pub joints: Vec<JointPose>,
}

impl Pose {
    pub fn identity(skeleton: &Skeleton) -> Self {
        Self {
            joints: vec![JointPose::IDENTITY; skeleton.joints.len()],
        }
    }

    pub fn joint_matrices(&self, skeleton: &Skeleton) -> Vec<Mat4> {
        let mut globals = vec![Mat4::IDENTITY; skeleton.joints.len()];
        for (idx, joint) in skeleton.joints.iter().enumerate() {
            let local = self
                .joints
                .get(idx)
                .copied()
                .unwrap_or(JointPose::IDENTITY)
                .matrix();
            globals[idx] = if let Some(parent) = joint.parent {
                globals[parent] * local
            } else {
                local
            };
        }
        globals
            .into_iter()
            .enumerate()
            .map(|(idx, global)| global * skeleton.joints[idx].inverse_bind)
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct AnimationClip {
    pub name: String,
    pub duration_seconds: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BotAnimState {
    Idle,
    Walk,
    Death,
}

#[derive(Debug, Clone)]
pub struct AnimationStateMachine {
    pub state: BotAnimState,
    pub time: f32,
}

impl Default for AnimationStateMachine {
    fn default() -> Self {
        Self {
            state: BotAnimState::Idle,
            time: 0.0,
        }
    }
}

impl AnimationStateMachine {
    pub fn update(&mut self, speed: f32, alive: bool, dt: f32) {
        let next = if !alive {
            BotAnimState::Death
        } else if speed > 5.0 {
            BotAnimState::Walk
        } else {
            BotAnimState::Idle
        };
        if next != self.state {
            self.state = next;
            self.time = 0.0;
        } else {
            self.time += dt;
        }
    }

    pub fn sample_procedural_humanoid(&self) -> Pose {
        let mut pose = Pose {
            joints: vec![JointPose::IDENTITY; 6],
        };
        match self.state {
            BotAnimState::Idle => {
                pose.joints[2].rotation = Quat::from_rotation_y((self.time * 2.0).sin() * 0.08);
                pose.joints[3].rotation = Quat::from_rotation_y(-(self.time * 2.0).sin() * 0.08);
            }
            BotAnimState::Walk => {
                let swing = (self.time * 8.0).sin() * 0.35;
                pose.joints[2].rotation = Quat::from_rotation_y(swing);
                pose.joints[3].rotation = Quat::from_rotation_y(-swing);
                pose.joints[4].rotation = Quat::from_rotation_y(-swing);
                pose.joints[5].rotation = Quat::from_rotation_y(swing);
            }
            BotAnimState::Death => {
                pose.joints[0].rotation = Quat::from_rotation_x(1.35);
                pose.joints[1].rotation = Quat::from_rotation_x(0.4);
            }
        }
        pose
    }
}

pub fn procedural_humanoid_skeleton() -> Skeleton {
    Skeleton {
        joints: vec![
            Joint {
                name: "hips".to_string(),
                parent: None,
                inverse_bind: Mat4::IDENTITY,
            },
            Joint {
                name: "head".to_string(),
                parent: Some(0),
                inverse_bind: Mat4::IDENTITY,
            },
            Joint {
                name: "left_arm".to_string(),
                parent: Some(0),
                inverse_bind: Mat4::IDENTITY,
            },
            Joint {
                name: "right_arm".to_string(),
                parent: Some(0),
                inverse_bind: Mat4::IDENTITY,
            },
            Joint {
                name: "left_leg".to_string(),
                parent: Some(0),
                inverse_bind: Mat4::IDENTITY,
            },
            Joint {
                name: "right_leg".to_string(),
                parent: Some(0),
                inverse_bind: Mat4::IDENTITY,
            },
        ],
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GltfSummary {
    pub mesh_count: usize,
    pub skin_count: usize,
    pub animation_count: usize,
}

pub fn inspect_gltf(path: impl AsRef<std::path::Path>) -> Result<GltfSummary, AnimError> {
    let doc = gltf::Gltf::open(path)?;
    Ok(GltfSummary {
        mesh_count: doc.meshes().count(),
        skin_count: doc.skins().count(),
        animation_count: doc.animations().count(),
    })
}
