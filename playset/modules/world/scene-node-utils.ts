// playset/modules/world/scene-node-utils.ts — scene-graph disposal helper.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/Object3DUtils.js. Renamed disposeObject3D →
// disposeSceneNode: three's Object3D became scene3d's SceneNode, and
// node.destroy() already detaches the whole subtree — geometry/material
// lifetime is host-side (geomFree/materialFree), so the original's recursive
// geometry.dispose()/material.dispose() traverse has no guest analog. The
// disposeObject3D name stays exported as an alias for port compatibility.

/** The one thing disposal needs — SceneNode qualifies, and so does any
 *  structurally-driven visual group a logic module was handed. */
export interface DisposableNode {
  destroy(): void;
}

export function disposeSceneNode(node: DisposableNode | null | undefined): void {
  node?.destroy();
}

/** GameBlocks-name alias (see header). */
export const disposeObject3D = disposeSceneNode;
