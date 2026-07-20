// @pocketjs/playset/scene3d — the scene3d surface: contract, client, viewport.

export {
  GEOM_KIND,
  MAT,
  POSE_STRIDE,
  SPRITE_STRIDE,
  BEAM_STRIDE,
  detectScene3d,
  type Scene3dOps,
} from "./ops.ts";
export { Scene3D, SceneNode, Camera3D, SpritePool, BeamPool } from "./client.ts";
export { Viewport3D, type Viewport3DProps } from "./viewport.ts";
export { createScene3dSim } from "./sim.ts";
