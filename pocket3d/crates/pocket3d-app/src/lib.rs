use anyhow::Result;
use pocket3d_core::InputSnapshot;
use pocket3d_render::SceneView;

pub struct AppInitContext<'a> {
    pub asset_root: &'a std::path::Path,
}

pub struct FixedUpdateContext<'a> {
    pub dt: f32,
    pub input: &'a InputSnapshot,
}

pub struct FrameUpdateContext<'a> {
    pub dt: f32,
    pub interpolation_alpha: f32,
    pub input: &'a InputSnapshot,
}

pub struct RenderContext<'a> {
    pub scene: &'a mut SceneView,
}

pub trait Pocket3dApp {
    fn init(&mut self, ctx: &mut AppInitContext<'_>) -> Result<()>;
    fn fixed_update(&mut self, ctx: &mut FixedUpdateContext<'_>);
    fn update(&mut self, ctx: &mut FrameUpdateContext<'_>);
    fn render(&mut self, ctx: &mut RenderContext<'_>);
}
