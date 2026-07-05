use pocket3d_core::{Camera, Transform, Vec3};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MeshHandle(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TextureHandle(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MaterialHandle(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WorldHandle(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SkeletonHandle(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AnimationClipHandle(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterialKind {
    BspWorldLit,
    BspSky,
    BspWater,
    StaticUnlit,
    StaticLit,
    SkinnedLit,
    Viewmodel,
    Debug,
}

#[derive(Debug, Clone)]
pub struct RenderMesh {
    pub name: String,
    pub positions: Vec<Vec3>,
    pub normals: Vec<Vec3>,
    pub uvs: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
    pub material_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DrawInstance {
    pub mesh: MeshHandle,
    pub material: MaterialHandle,
    pub transform: Transform,
}

#[derive(Debug, Clone)]
pub enum DebugPrimitive {
    Line {
        from: Vec3,
        to: Vec3,
        color: [f32; 4],
    },
    Capsule {
        center: Vec3,
        radius: f32,
        height: f32,
        color: [f32; 4],
    },
    Point {
        pos: Vec3,
        color: [f32; 4],
    },
}

#[derive(Debug, Clone)]
pub struct HudState {
    pub health: i32,
    pub ammo_text: String,
    pub round_text: String,
    pub debug_text: Vec<String>,
    pub crosshair: bool,
}

impl Default for HudState {
    fn default() -> Self {
        Self {
            health: 100,
            ammo_text: "INF".to_string(),
            round_text: String::new(),
            debug_text: Vec::new(),
            crosshair: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SceneView {
    pub camera: Camera,
    pub world_meshes: Vec<RenderMesh>,
    pub instances: Vec<DrawInstance>,
    pub debug: Vec<DebugPrimitive>,
    pub hud: HudState,
}

impl Default for SceneView {
    fn default() -> Self {
        Self {
            camera: Camera::default(),
            world_meshes: Vec::new(),
            instances: Vec::new(),
            debug: Vec::new(),
            hud: HudState::default(),
        }
    }
}
