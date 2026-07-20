// playset/modules/world/object/factory/projectile-visual-factory.ts —
// bullet tracer + missile visuals (driven by ProjectileObject).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/object/factory/ProjectileVisualFactory.js.
// Deliberate changes for the scene3d surface:
//   - per-frame material.opacity writes become nodeSetTint over a material
//     whose alpha is 1: bullet fade = 0.95·(1-age/lifetime) rides in the
//     tint alpha (material carries the 0.95); the missile flame's flicker
//     REPLACES its opacity, so the flame material alpha is 1 and the tint
//     alpha is the flicker itself.
//   - depthTest:false / renderOrder / emissive / group names dropped.
//   - setCylinderBetween is verbatim (midpoint + scale.y + quaternion from
//     (0,1,0) → delta) — scene3d cylinders are +Y-aligned like three's.

import { Quaternion } from "../../../../math/quaternion.ts";
import { Vector3 } from "../../../../math/vector3.ts";
import { MAT, type Scene3D, type SceneNode } from "../../../../scene3d/client.ts";
import { clamp } from "../../../math/scalar-utils.ts";
import { rgbToAbgr } from "../../color-utils.ts";

const LOCAL_CONE_FORWARD = new Vector3(0, 1, 0);
const LOCAL_CYLINDER_FORWARD = new Vector3(0, 1, 0);

interface PoseTarget {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
}

function setCylinderBetween(mesh: PoseTarget, start: Vector3, end: Vector3): void {
  const delta = end.clone().sub(start);
  const length = Math.max(0.001, delta.length());
  const midpoint = start.clone().addScaledVector(delta, 0.5);
  mesh.position.copy(midpoint);
  mesh.scale.set(1, length, 1);
  mesh.quaternion.setFromUnitVectors(LOCAL_CYLINDER_FORWARD, delta.normalize());
}

export interface BulletVisualStepState {
  position: Vector3;
  ageSeconds: number;
  lifetimeSeconds: number;
}

export interface BulletProjectileVisual {
  group: SceneNode;
  mesh: SceneNode;
  step(state: BulletVisualStepState): void;
}

export function createBulletProjectileVisual(scene: Scene3D): BulletProjectileVisual {
  const group = scene.node();

  const mesh = scene.mesh(
    scene.sphere(2.6, 12),
    scene.material(rgbToAbgr(0xfff3a1, 0.95), MAT.unlit | MAT.transparent),
    group,
  );

  return {
    group,
    mesh,
    step({ position, ageSeconds, lifetimeSeconds }: BulletVisualStepState): void {
      mesh.position.copy(position);
      const fade = clamp(1 - ageSeconds / lifetimeSeconds, 0, 1);
      mesh.setTint(rgbToAbgr(0xffffff, fade)); // opacity = 0.95 · fade
    },
  };
}

export interface MissileVisualStepState {
  position: Vector3;
  direction: Vector3;
  ageSeconds: number;
}

export interface MissileProjectileVisual {
  group: SceneNode;
  mesh: SceneNode;
  flame: SceneNode;
  trail: SceneNode;
  step(state: MissileVisualStepState): void;
}

export function createMissileProjectileVisual(scene: Scene3D): MissileProjectileVisual {
  const group = scene.node();

  const trail = scene.mesh(
    scene.cylinder(1.35, 0.55, 1, 10),
    scene.material(rgbToAbgr(0xffd28a, 0.5), MAT.unlit | MAT.transparent),
    group,
  );
  const mesh = scene.mesh(
    scene.cone(2.8, 13, 16),
    scene.material(rgbToAbgr(0xf4f7ff), 0),
    group,
  );
  const flame = scene.mesh(
    scene.sphere(3.6, 14),
    scene.material(rgbToAbgr(0xff9f2f, 1), MAT.unlit | MAT.transparent),
    group,
  );
  flame.setTint(rgbToAbgr(0xffffff, 0.9)); // pre-first-step opacity 0.9

  return {
    group,
    mesh,
    flame,
    trail,
    step({ position, direction, ageSeconds }: MissileVisualStepState): void {
      mesh.position.copy(position);
      mesh.quaternion.setFromUnitVectors(LOCAL_CONE_FORWARD, direction);
      flame.position.copy(position).addScaledVector(direction, -7.5);
      setCylinderBetween(
        trail,
        position.clone().addScaledVector(direction, -84),
        position.clone().addScaledVector(direction, -9),
      );

      const flicker = 0.78 + Math.sin(ageSeconds * 60) * 0.18;
      flame.setTint(rgbToAbgr(0xffffff, flicker)); // opacity := flicker
      flame.scale.setScalar(0.9 + flicker * 0.22);
    },
  };
}
