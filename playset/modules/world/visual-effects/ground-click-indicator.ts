// playset/modules/world/visual-effects/ground-click-indicator.ts — the
// expanding, fading ring-and-disk decal that marks a move/click command.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/visual-effects/GroundClickIndicator.js. Step math
// (420 ms fade, 0.42→1.4 scale, 0.06→0.1 rise) is verbatim. Deliberate
// changes for the scene3d surface:
//   - constructor options gain `scene: Scene3D`.
//   - scene3d has no Circle/Ring geometry: the disk is a thin flat cylinder
//     and the ring a thin torus (inner 1.0 / outer 1.18 in plan view), both
//     already ground-planar (+Y up), so the group keeps an identity
//     quaternion instead of the three plane-canonical rotation — visually
//     identical in the fixed +Y-up scene3d space. The ring's local-normal
//     offset becomes a +up offset.
//   - per-frame material.opacity = ratio·baseOpacity becomes nodeSetTint
//     with alpha = ratio over materials that carry their baseOpacity;
//     `.materials` holds the two material handles.

import { MAT, type Scene3D, type SceneNode } from "../../../scene3d/client.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis, type VecLike } from "../../math/world-basis.ts";
import { rgbToAbgr } from "../color-utils.ts";
import { disposeSceneNode } from "../scene-node-utils.ts";

export interface GroundClickIndicatorOptions {
  scene: Scene3D;
  position: VecLike;
  durationMs?: number;
  color?: number;
  accentColor?: number;
  startScale?: number;
  endScale?: number;
  startUpOffset?: number;
  endUpOffset?: number;
  ringLocalNormalOffset?: number;
  basis?: WorldBasis;
}

export class GroundClickIndicator {
  readonly kind = "command";
  readonly basis: WorldBasis;
  remainingMs: number;
  readonly maxMs: number;
  readonly startScale: number;
  readonly endScale: number;
  readonly startUpOffset: number;
  readonly endUpOffset: number;

  readonly group: SceneNode;
  readonly disk: SceneNode;
  readonly ring: SceneNode;
  /** Material handles, disk then ring (see header). */
  readonly materials: number[];

  constructor({
    scene,
    position,
    durationMs = 420,
    color = 0x76f0c9,
    accentColor = 0xbaf8ec,
    startScale = 0.42,
    endScale = 1.4,
    startUpOffset = 0.06,
    endUpOffset = 0.1,
    ringLocalNormalOffset = 0.01,
    basis = DEFAULT_WORLD_BASIS,
  }: GroundClickIndicatorOptions) {
    this.basis = basis;
    this.remainingMs = durationMs;
    this.maxMs = durationMs;
    this.startScale = startScale;
    this.endScale = endScale;
    this.startUpOffset = startUpOffset;
    this.endUpOffset = endUpOffset;

    const planar = this.basis.toPlanar(position);
    this.group = scene.node();
    this.basis.fromBasisComponents(planar.right, startUpOffset, planar.forward, this.group.position);
    this.group.scale.setScalar(startScale);

    const decalFlags = MAT.unlit | MAT.transparent | MAT.doubleSided;
    const diskMaterial = scene.material(rgbToAbgr(color, 0.28), decalFlags);
    // CircleGeometry(1.02, 40) → thin ground-planar cylinder (see header).
    this.disk = scene.mesh(scene.cylinder(1.02, 1.02, 0.004, 40), diskMaterial, this.group);

    const ringMaterial = scene.material(rgbToAbgr(accentColor, 0.96), decalFlags);
    // RingGeometry(1.0, 1.18, 48) → torus, ring radius 1.09, tube 0.09.
    this.ring = scene.mesh(scene.torus(1.09, 0.09, 48, 6), ringMaterial, this.group);
    this.ring.scale.y = 0.04; // flatten the tube toward an annulus decal
    this.ring.position.y = ringLocalNormalOffset;

    this.materials = [diskMaterial, ringMaterial];
  }

  step(deltaSeconds = 1 / 60): boolean {
    this.remainingMs -= deltaSeconds * 1000;
    const ratio = Math.max(0, this.remainingMs / this.maxMs);
    const progress = 1 - ratio;

    // opacity = ratio · baseOpacity: the base rides in the material alpha,
    // the ratio in the tint alpha (tint multiplies).
    const fade = rgbToAbgr(0xffffff, ratio);
    this.disk.setTint(fade);
    this.ring.setTint(fade);

    this.group.scale.setScalar(this.startScale + (this.endScale - this.startScale) * progress);
    this.basis.setHeight(
      this.group.position,
      this.startUpOffset + (this.endUpOffset - this.startUpOffset) * progress,
    );

    return this.remainingMs > 0;
  }

  dispose(): void {
    disposeSceneNode(this.group);
  }
}
