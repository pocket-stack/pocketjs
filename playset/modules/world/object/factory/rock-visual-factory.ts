// playset/modules/world/object/factory/rock-visual-factory.ts — squashed
// ground rocks and irregular boulders.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/object/factory/RockVisualFactory.js. Deliberate
// changes for the scene3d surface:
//   - DodecahedronGeometry/IcosahedronGeometry become low-segment spheres —
//     the faceted stand-in for polyhedron geoms (roughness/flatShading
//     dropped; facets are a host tessellation decision).
//   - applySeamSafeIrregularity mutated the icosahedron's vertex buffer with
//     one prng scale per welded vertex; parametric sphere geoms have no
//     guest-side vertex buffer, so the per-vertex draws are SKIPPED —
//     createIrregularRockVisual's prng stream position differs from
//     GameBlocks after this call (the per-axis scale draws that follow are
//     kept, in order). Irregularity is accepted and folded into nothing.
//   - cast/receive-shadow flags + mesh names dropped (blob decals).

import { Euler } from "../../../../math/euler.ts";
import type { Scene3D, SceneNode } from "../../../../scene3d/client.ts";
import { DEFAULT_PRNG, type RandomGenerator } from "../../../math/random-utils.ts";
import { rgbToAbgr } from "../../color-utils.ts";

export function createRockMaterial(scene: Scene3D, color = 0x7b827a): number {
  return scene.material(rgbToAbgr(color), 0);
}

export interface GroundRockOptions {
  material?: number;
  prng?: RandomGenerator;
}

export function createGroundRockVisual(
  scene: Scene3D,
  { material, prng = DEFAULT_PRNG }: GroundRockOptions = {},
): SceneNode {
  const mat = material ?? createRockMaterial(scene);
  // DodecahedronGeometry(uniform(0.7, 2.0), 0) → faceted sphere stand-in.
  const rock = scene.mesh(scene.sphere(prng.uniform(0.7, 2.0), 6), mat);
  rock.scale.y = prng.uniform(0.35, 0.8);
  rock.quaternion.setFromEuler(
    new Euler(prng.random() * Math.PI, prng.random() * Math.PI, prng.random() * Math.PI),
  );
  return rock;
}

export interface IrregularRockOptions {
  radius?: number;
  color?: number;
  detail?: number;
  irregularity?: number;
  scaleVariance?: number;
  roughness?: number;
  metalness?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  prng?: RandomGenerator;
}

export interface IrregularRockVisual {
  mesh: SceneNode;
  radius: number;
}

export function createIrregularRockVisual(
  scene: Scene3D,
  {
    radius = 1,
    color = 0x8e95a3,
    detail = 1,
    irregularity = 0.16,
    scaleVariance = 0.12,
    roughness = 0.9,
    metalness = 0.05,
    castShadow = true,
    receiveShadow = true,
    prng = DEFAULT_PRNG,
  }: IrregularRockOptions = {},
): IrregularRockVisual {
  // No fixed-function / guest-side analogs (see header).
  void irregularity; void roughness; void metalness; void castShadow; void receiveShadow;

  const safeRadius = Math.max(0.05, radius);
  // IcosahedronGeometry(r, detail) → sphere stand-in; detail maps to a
  // matching coarseness (detail 0 ≈ 6 segments, +4 per subdivision level).
  const segments = 6 + Math.max(0, Math.floor(detail)) * 4;
  const material = scene.material(rgbToAbgr(color), 0);

  const mesh = scene.mesh(scene.sphere(safeRadius, segments), material);
  mesh.scale.set(
    prng.uniform(1 - scaleVariance, 1 + scaleVariance),
    prng.uniform(1 - scaleVariance, 1 + scaleVariance),
    prng.uniform(1 - scaleVariance, 1 + scaleVariance),
  );

  return {
    mesh,
    radius: safeRadius,
  };
}
