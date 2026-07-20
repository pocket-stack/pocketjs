// playset/modules/world/object/factory/plant-visual-factory.ts — prng-
// randomized trees (conifer/broadleaf) and grass blades.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/object/factory/PlantVisualFactory.js. PRNG draw
// order is preserved call-for-call, so a seeded tree is deterministic.
// Deliberate changes for the scene3d surface:
//   - material factories take `scene` and return material HANDLES;
//     roughness/flatShading dropped (fixed-function lighting; facets are a
//     host tessellation-quality decision). createTreeMaterials' options
//     object gains an `= {}` default so the documented no-arg call works.
//   - conifer cones lose openEnded (no such flag; caps are invisible from
//     outside the canopy anyway).
//   - broadleaf DodecahedronGeometry clusters become low-segment spheres —
//     the faceted stand-in for polyhedron geoms.
//   - cast/receive-shadow traverse dropped (blob decals).

import { Euler } from "../../../../math/euler.ts";
import { MathUtils } from "../../../../math/math-utils.ts";
import { Vector3 } from "../../../../math/vector3.ts";
import type { Scene3D, SceneNode } from "../../../../scene3d/client.ts";
import { DEFAULT_PRNG, type RandomGenerator } from "../../../math/random-utils.ts";
import { rgbToAbgr } from "../../color-utils.ts";

const UP = new Vector3(0, 1, 0);

export interface TreeMaterials {
  trunk: number;
  barkShadow: number;
  leaves: number[];
}

export interface TreeMaterialsOptions {
  trunkColor?: number;
  barkShadowColor?: number;
  leafColors?: readonly (number | { color: number; roughness?: number })[];
}

export function createTreeMaterials(
  scene: Scene3D,
  {
    trunkColor = 0x6d472b,
    barkShadowColor = 0x3f281b,
    leafColors = [
      { color: 0x245d3a, roughness: 0.86 },
      { color: 0x3f783f, roughness: 0.84 },
      { color: 0x6e8f3a, roughness: 0.86 },
      { color: 0x8fa65a, roughness: 0.88 },
    ],
  }: TreeMaterialsOptions = {},
): TreeMaterials {
  return {
    trunk: scene.material(rgbToAbgr(trunkColor), 0),
    barkShadow: scene.material(rgbToAbgr(barkShadowColor), 0),
    leaves: leafColors.map((entry) => {
      const color = typeof entry === "number" ? entry : entry.color;
      return scene.material(rgbToAbgr(color), 0);
    }),
  };
}

export interface TreeVisualOptions {
  height: number;
  radius: number;
  materials?: TreeMaterials;
  prng?: RandomGenerator;
}

export function createTreeVisual(
  scene: Scene3D,
  { height, radius, materials, prng = DEFAULT_PRNG }: TreeVisualOptions,
): SceneNode {
  if (!prng) throw new Error("createTreeVisual requires a PRNG");
  const mats = materials ?? createTreeMaterials(scene);

  const tree = scene.node();
  const trunk = scene.mesh(
    scene.cylinder(radius * 0.58, radius * 1.03, height, 9),
    mats.trunk,
    tree,
  );
  trunk.position.y = height * 0.5;

  const rootFlare = scene.mesh(
    scene.cylinder(radius * 1.35, radius * 1.7, Math.max(0.18, radius * 0.52), 9),
    mats.barkShadow,
    tree,
  );
  rootFlare.position.y = Math.max(0.09, radius * 0.26);

  if (prng.random() < 0.52) {
    const branchCount = prng.random() < 0.45 ? 2 : 1;
    for (let i = 0; i < branchCount; i += 1) {
      createBranchStub(scene, tree, height, radius, prng, mats.barkShadow);
    }
  }

  if (prng.random() < 0.74) {
    addConiferCanopy(scene, tree, height, prng, mats.leaves);
  } else {
    addBroadleafCanopy(scene, tree, height, prng, mats.leaves);
  }

  return tree;
}

export function createGrassMaterial(scene: Scene3D, color = 0xa2b86a): number {
  return scene.material(rgbToAbgr(color), 0);
}

export interface GrassBladeOptions {
  material?: number;
  prng?: RandomGenerator;
}

export function createGrassBladeVisual(
  scene: Scene3D,
  { material, prng = DEFAULT_PRNG }: GrassBladeOptions = {},
): SceneNode {
  const mat = material ?? createGrassMaterial(scene);
  const blade = scene.mesh(scene.cone(0.08, prng.uniform(0.45, 1.2), 4), mat);
  blade.quaternion.setFromEuler(new Euler(0, prng.uniform(0, Math.PI * 2), 0));
  return blade;
}

function createBranchStub(
  scene: Scene3D,
  tree: SceneNode,
  height: number,
  radius: number,
  prng: RandomGenerator,
  material: number,
): void {
  const length = prng.uniform(0.48, 0.88);
  const branch = scene.mesh(
    scene.cylinder(radius * 0.13, radius * 0.2, length, 7),
    material,
    tree,
  );
  const angle = prng.uniform(0, Math.PI * 2);
  const sideLean = prng.uniform(0.74, 0.98);
  const direction = new Vector3(
    Math.cos(angle) * sideLean,
    prng.uniform(0.22, 0.42),
    Math.sin(angle) * sideLean,
  ).normalize();
  branch.position.set(
    direction.x * length * 0.34,
    height * prng.uniform(0.48, 0.68),
    direction.z * length * 0.34,
  );
  branch.quaternion.setFromUnitVectors(UP, direction);
}

function addConiferCanopy(
  scene: Scene3D,
  tree: SceneNode,
  height: number,
  prng: RandomGenerator,
  leafMaterials: number[],
): void {
  const baseRadius = prng.uniform(1.85, 3.3) * MathUtils.clamp(height / 7.6, 0.82, 1.18);
  const layers = [
    { y: height * 0.68, radius: baseRadius, height: height * prng.uniform(0.44, 0.56) },
    {
      y: height * 0.88,
      radius: baseRadius * prng.uniform(0.72, 0.84),
      height: height * prng.uniform(0.36, 0.48),
    },
    {
      y: height * 1.06,
      radius: baseRadius * prng.uniform(0.48, 0.62),
      height: height * prng.uniform(0.28, 0.38),
    },
  ];

  for (const layer of layers) {
    const crown = scene.mesh(
      scene.cone(layer.radius, layer.height, 9),
      prng.choice(leafMaterials),
      tree,
    );
    crown.position.y = layer.y;
    crown.quaternion.setFromEuler(new Euler(0, prng.uniform(0, Math.PI * 2), 0));
    crown.scale.set(prng.uniform(0.88, 1.12), 1, prng.uniform(0.88, 1.12));
  }
}

function addBroadleafCanopy(
  scene: Scene3D,
  tree: SceneNode,
  height: number,
  prng: RandomGenerator,
  leafMaterials: number[],
): void {
  const crownSize = prng.uniform(1.25, 2.0) * MathUtils.clamp(height / 7.2, 0.85, 1.25);
  const clusters = [
    { x: 0, y: height * 0.93, z: 0, scale: 1.25 },
    { x: -crownSize * 0.45, y: height * 0.82, z: crownSize * 0.12, scale: 0.86 },
    { x: crownSize * 0.42, y: height * 0.84, z: -crownSize * 0.18, scale: 0.8 },
    { x: crownSize * 0.06, y: height * 1.08, z: -crownSize * 0.05, scale: 0.72 },
  ];

  for (const cluster of clusters) {
    // DodecahedronGeometry(r, 0) → low-segment sphere stand-in (see header).
    const crown = scene.mesh(
      scene.sphere(crownSize * cluster.scale, 6),
      prng.choice(leafMaterials),
      tree,
    );
    crown.position.set(cluster.x, cluster.y, cluster.z);
    crown.quaternion.setFromEuler(
      new Euler(prng.uniform(-0.2, 0.2), prng.uniform(0, Math.PI * 2), prng.uniform(-0.2, 0.2)),
    );
    crown.scale.set(
      prng.uniform(0.95, 1.18),
      prng.uniform(0.78, 1.08),
      prng.uniform(0.92, 1.18),
    );
  }
}
