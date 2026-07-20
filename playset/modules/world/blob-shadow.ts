// playset/modules/world/blob-shadow.ts — flattened dark disc that fakes a
// contact shadow under an entity.
//
// Not a GameBlocks port. scene3d has no shadow maps by contract (ops.ts:
// "No shadow maps ever; use blob decals") — every castShadow/receiveShadow
// flag the world/ factories dropped is replaced by one of these: an unlit
// transparent squashed cylinder sitting just above the ground under the
// entity. The owner calls updateBlobShadow each frame before scene.flush().

import { MAT, type Scene3D, type SceneNode } from "../../scene3d/client.ts";
import { rgbToAbgr } from "./color-utils.ts";

/** Lift above the ground surface — enough to clear terrain z-fighting. */
const GROUND_CLEARANCE = 0.02;

export interface BlobShadowOptions {
  radius?: number;
  opacity?: number;
  parent?: SceneNode;
}

export function createBlobShadow(
  scene: Scene3D,
  { radius = 1, opacity = 0.35, parent }: BlobShadowOptions = {},
): SceneNode {
  // A unit-height cylinder squashed flat: a filled disc facing +Y.
  const geom = scene.cylinder(radius, radius, 1, 24);
  const mat = scene.material(rgbToAbgr(0x000000, opacity), MAT.unlit | MAT.transparent);
  const node = scene.mesh(geom, mat, parent);
  node.scale.set(1, GROUND_CLEARANCE, 1);
  return node;
}

/** Snap the shadow under the entity: planar position from the entity, height
 *  from the ground (terrain sampler / floor), plus a small clearance. */
export function updateBlobShadow(
  node: SceneNode,
  groundHeight: number,
  entityPlanarPos: { x: number; z: number },
): void {
  node.position.set(entityPlanarPos.x, groundHeight + GROUND_CLEARANCE, entityPlanarPos.z);
}
