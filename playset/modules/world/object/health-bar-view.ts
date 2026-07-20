// playset/modules/world/object/health-bar-view.ts — camera-billboarded
// segmented health bar floating above an entity.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/object/HealthBarView.js. Deliberate changes for
// the scene3d surface:
//   - THREE.Sprite layers become unlit transparent thin boxes in a group;
//     the original already billboards by copying cameraQuaternion onto the
//     group each step, so the boxes face the camera by exactly that write.
//   - The fill sprite's left anchor (center=(0,0.5)) has no box analog:
//     the fill box is re-centered each step at
//     `-fillWidth/2 + scale.x/2` — same left edge, same width.
//   - Fill color swaps ride nodeSetTint over a white material (materials are
//     shared/cached; the original mutated its own SpriteMaterial color).
//   - Coplanar sprites relied on painter's order; the box layers get a tiny
//     +Z stagger (0.001 per layer) to survive a depth-tested host.

import type { Quaternion } from "../../../math/quaternion.ts";
import { MAT, type Scene3D, type SceneNode } from "../../../scene3d/client.ts";
import { clamp01 } from "../../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis, type VecLike } from "../../math/world-basis.ts";
import { rgbToAbgr } from "../color-utils.ts";

/** Layer separation along local +Z (toward the camera once billboarded). */
const LAYER_Z = 0.001;

export interface HealthBarViewOptions {
  scene: Scene3D;
  upOffset?: number;
  width?: number;
  height?: number;
  fillWidth?: number;
  fillHeight?: number;
  segmentCount?: number;
  backColor?: number;
  frameColor?: number;
  healthyColor?: number;
  warningColor?: number;
  dangerColor?: number;
  basis?: WorldBasis;
}

export interface HealthBarStepState {
  position: VecLike;
  cameraQuaternion: Quaternion;
  current: number;
  max: number;
  visible?: boolean;
}

export class HealthBarView {
  readonly upOffset: number;
  readonly basis: WorldBasis;
  readonly fillWidth: number;
  readonly healthyColor: number;
  readonly warningColor: number;
  readonly dangerColor: number;

  readonly group: SceneNode;
  readonly back: SceneNode;
  readonly fill: SceneNode;
  readonly frame: SceneNode;
  readonly segments: SceneNode[];

  private readonly scene: Scene3D;
  private _fillColor: number;

  constructor({
    scene,
    upOffset = 3.15,
    width = 2.1,
    height = 0.28,
    fillWidth = 1.86,
    fillHeight = 0.14,
    segmentCount = 8,
    backColor = 0x101010,
    frameColor = 0xf2f2f2,
    healthyColor = 0x7dff8a,
    warningColor = 0xffd86b,
    dangerColor = 0xff6767,
    basis = DEFAULT_WORLD_BASIS,
  }: HealthBarViewOptions) {
    this.scene = scene;
    this.upOffset = upOffset;
    this.basis = basis;
    this.fillWidth = fillWidth;
    this.healthyColor = healthyColor;
    this.warningColor = warningColor;
    this.dangerColor = dangerColor;

    this.group = scene.node();
    this.back = this._createSprite(backColor, 0.92, 0);
    this.back.scale.set(width, height, 1);

    // White material + tint carries the threshold color (see header).
    this.fill = this._createSprite(0xffffff, 0.95, 1);
    this.fill.scale.set(fillWidth, fillHeight, 1);
    this.fill.position.x = -fillWidth * 0.5 + fillWidth * 0.5; // left-anchored, full
    this._fillColor = healthyColor;
    this.fill.setTint(rgbToAbgr(healthyColor));

    this.frame = this._createSprite(frameColor, 0.12, 3);
    this.frame.scale.set(width + 0.08, height + 0.08, 1);

    this.segments = [];
    for (let index = 1; index < segmentCount; index += 1) {
      const segment = this._createSprite(0x0f1012, 0.78, 2);
      segment.scale.set(0.03, height - 0.04, 1);
      segment.position.x = -fillWidth * 0.5 + (fillWidth * index) / segmentCount;
      this.segments.push(segment);
    }
  }

  /** A sprite stand-in: unit thin box, scaled like the original sprite. */
  private _createSprite(color: number, opacity: number, layer: number): SceneNode {
    const node = this.scene.mesh(
      this.scene.box(0.5, 0.5, 0.005),
      this.scene.material(rgbToAbgr(color, opacity), MAT.unlit | MAT.transparent),
      this.group,
    );
    node.position.z = layer * LAYER_Z;
    return node;
  }

  step({ position, cameraQuaternion, current, max, visible = true }: HealthBarStepState): void {
    this.group.visible = visible;
    if (!visible) return;

    const ratio = clamp01(current / Math.max(1e-6, max));
    this.group.position.set(position.x ?? 0, position.y ?? 0, position.z ?? 0);
    this.basis.addHeight(this.group.position, this.upOffset);
    this.group.quaternion.copy(cameraQuaternion);
    this.fill.scale.x = Math.max(0.001, this.fillWidth * ratio);
    // Same left edge as sprite center=(0,0.5): position is the box center.
    this.fill.position.x = -this.fillWidth * 0.5 + this.fill.scale.x * 0.5;
    this._setFillColor(ratio);
  }

  private _setFillColor(ratio: number): void {
    const color =
      ratio > 0.6 ? this.healthyColor : ratio > 0.3 ? this.warningColor : this.dangerColor;
    if (color === this._fillColor) return;
    this._fillColor = color;
    this.fill.setTint(rgbToAbgr(color));
  }
}
