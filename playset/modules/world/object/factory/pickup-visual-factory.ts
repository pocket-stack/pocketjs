// playset/modules/world/object/factory/pickup-visual-factory.ts — ammo /
// health / armor pickup visuals (driven by PickupObject).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/object/factory/PickupVisualFactory.js. Deliberate
// changes for the scene3d surface: the shared MeshStandardMaterial's
// emissive (color×0.2 at per-part intensity) / metalness 0.25 / roughness
// 0.4 have no fixed-function analog and are dropped — parts keep their base
// colors as plain lit materials.

import { Euler } from "../../../../math/euler.ts";
import type { Scene3D, SceneNode } from "../../../../scene3d/client.ts";
import { rgbToAbgr } from "../../color-utils.ts";

export interface PickupVisual {
  mesh: SceneNode;
  radius: number;
}

function createMaterial(scene: Scene3D, color: number, emissiveIntensity = 0.2): number {
  void emissiveIntensity; // no emissive in scene3d v1 (see header)
  return scene.material(rgbToAbgr(color), 0);
}

export function buildAmmoPickupVisual(
  scene: Scene3D,
  color: number | null = null,
  accentColor: number | null = null,
): PickupVisual {
  const group = scene.node();
  scene.mesh(
    scene.box(0.6, 0.4, 0.45), // BoxGeometry(1.2, 0.8, 0.9)
    createMaterial(scene, color ?? 0x4b7b51),
    group,
  );
  const belt = scene.mesh(
    scene.box(0.54, 0.1, 0.46), // BoxGeometry(1.08, 0.2, 0.92)
    createMaterial(scene, accentColor ?? 0xd9e56a, 0.35),
    group,
  );
  belt.position.y = 0.16;
  return { mesh: group, radius: 0.85 };
}

export function buildHealthPickupVisual(
  scene: Scene3D,
  color: number | null = null,
  crossColor: number | null = null,
): PickupVisual {
  const size = 0.75;
  const group = scene.node();
  scene.mesh(
    scene.box(size / 2, size / 2, size / 2),
    createMaterial(scene, color ?? 0xaa1f24),
    group,
  );
  const thick = size * 0.2;
  const vertical = scene.mesh(
    scene.box(thick / 2, (size * 0.75) / 2, (size * 1.01) / 2),
    createMaterial(scene, crossColor ?? 0xffffff, 0.5),
    group,
  );
  const horizontal = scene.mesh(
    scene.box((size * 0.75) / 2, thick / 2, (size * 1.01) / 2),
    createMaterial(scene, crossColor ?? 0xffffff, 0.5),
    group,
  );
  vertical.position.z = size * 0.51;
  horizontal.position.z = size * 0.51;
  return { mesh: group, radius: 0.8 };
}

export function buildArmorPickupVisual(
  scene: Scene3D,
  color: number | null = null,
  ringColor: number | null = null,
): PickupVisual {
  const group = scene.node();
  scene.mesh(
    scene.cylinder(0.28, 0.28, 1.0, 10),
    createMaterial(scene, color ?? 0x2d66ff, 0.4),
    group,
  );
  const ring = scene.mesh(
    scene.torus(0.4, 0.05, 12, 24),
    createMaterial(scene, ringColor ?? 0x77a3ff, 0.6),
    group,
  );
  ring.quaternion.setFromEuler(new Euler(Math.PI * 0.5, 0, 0));
  return { mesh: group, radius: 0.82 };
}

export interface CreatePickupVisualOptions {
  type: string | null | undefined;
  color?: number | null;
  accentColor?: number | null;
  crossColor?: number | null;
  ringColor?: number | null;
}

export function createPickupVisual(
  scene: Scene3D,
  { type, color = null, accentColor = null, crossColor = null, ringColor = null }: CreatePickupVisualOptions,
): PickupVisual {
  if (type === "ammo") return buildAmmoPickupVisual(scene, color, accentColor);
  if (type === "health") return buildHealthPickupVisual(scene, color, crossColor);
  return buildArmorPickupVisual(scene, color, ringColor);
}
