// playset/modules/world/object/factory/car-visual-factory.ts — the box car:
// body + cabin + four steerable/spinning wheels.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/object/factory/CarVisualFactory.js. Deliberate
// changes for the scene3d surface:
//   - metalness and cast/receive-shadow flags dropped (fixed-function
//     lighting; shadows are blob decals — world/blob-shadow.ts).
//   - The original baked wheelGeometry.rotateZ(π/2) into the geometry so the
//     axle runs along X. Geometry ops take no transforms, so each `wheels[i]`
//     entry is a bare spin node whose child mesh carries the Z-rotation —
//     spinning wheels[i] about local X behaves exactly like the original.
//   - ArrowHelper (debug aid) is emulated with an unlit shaft cylinder +
//     cone head group pointing down -Z (length 3.6, head 0.8/0.5).

import { Euler } from "../../../../math/euler.ts";
import { MAT, type Scene3D, type SceneNode } from "../../../../scene3d/client.ts";
import { rgbToAbgr } from "../../color-utils.ts";

export interface CarVisualOptions {
  paintColor?: number;
  cabinColor?: number;
  wheelColor?: number;
  arrowColor?: number | null;
  wheelOffsets?: readonly (readonly [number, number, number])[];
}

export interface CarVisual {
  group: SceneNode;
  wheels: SceneNode[];
  wheelPivots: SceneNode[];
  forwardArrow: SceneNode | null;
}

export function createCarVisual(
  scene: Scene3D,
  {
    paintColor = 0xc75238,
    cabinColor = 0xf4f7ff,
    wheelColor = 0x181c22,
    arrowColor = null,
    wheelOffsets = [
      [-0.84, 0.26, -1.07],
      [0.84, 0.26, -1.07],
      [-0.84, 0.26, 1.07],
      [0.84, 0.26, 1.07],
    ],
  }: CarVisualOptions = {},
): CarVisual {
  const group = scene.node();

  const body = scene.mesh(
    scene.box(0.85, 0.29, 1.5), // BoxGeometry(1.7, 0.58, 3.0)
    scene.material(rgbToAbgr(paintColor), 0),
    group,
  );
  body.position.y = 0.42;

  const cabin = scene.mesh(
    scene.box(0.62, 0.225, 0.65), // BoxGeometry(1.24, 0.45, 1.3)
    scene.material(rgbToAbgr(cabinColor), 0),
    group,
  );
  cabin.position.set(0, 0.83, -0.1);

  const wheelMaterial = scene.material(rgbToAbgr(wheelColor), 0);
  const wheelGeometry = scene.cylinder(0.35, 0.35, 0.32, 16);
  const axleQuat = new Euler(0, 0, Math.PI * 0.5); // rotateZ(π/2): axle along X

  const wheels: SceneNode[] = [];
  const wheelPivots: SceneNode[] = [];
  for (const [x, y, z] of wheelOffsets) {
    const wheelPivot = scene.node(group);
    wheelPivot.position.set(x, y, z);

    const wheel = scene.node(wheelPivot); // spin node (the returned "mesh")
    const axleMesh = scene.mesh(wheelGeometry, wheelMaterial, wheel);
    axleMesh.quaternion.setFromEuler(axleQuat);

    wheelPivots.push(wheelPivot);
    wheels.push(wheel);
  }

  let forwardArrow: SceneNode | null = null;
  if (arrowColor != null) {
    // ArrowHelper(dir(0,0,-1), origin, length 3.6, color, head 0.8, 0.5)
    forwardArrow = scene.node(group);
    const arrowMat = scene.material(rgbToAbgr(arrowColor), MAT.unlit);
    const along = new Euler(-Math.PI * 0.5, 0, 0); // +Y → -Z
    const shaft = scene.mesh(scene.cylinder(0.02, 0.02, 2.8, 8), arrowMat, forwardArrow);
    shaft.quaternion.setFromEuler(along);
    shaft.position.z = -1.4;
    const head = scene.mesh(scene.cone(0.25, 0.8, 8), arrowMat, forwardArrow);
    head.quaternion.setFromEuler(along);
    head.position.z = -3.2;
  }

  return {
    group,
    wheels,
    wheelPivots,
    forwardArrow,
  };
}
