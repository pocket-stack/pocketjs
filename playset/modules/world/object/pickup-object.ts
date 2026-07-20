// playset/modules/world/object/pickup-object.ts — a bobbing, spinning pickup
// entity that drives a factory-built visual.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/object/PickupObject.js. Verbatim semantics; zero
// scene coupling — the visual is driven structurally (position/quaternion/
// scale mirrors), and three's rotateOnWorldAxis is inlined as its quaternion
// premultiply identity.

import { Quaternion } from "../../../math/quaternion.ts";
import type { Vector3 } from "../../../math/vector3.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis, type VecLike } from "../../math/world-basis.ts";
import { disposeSceneNode, type DisposableNode } from "../scene-node-utils.ts";

/** What PickupObject drives — SceneNode qualifies (PickupVisualFactory). */
export interface PickupGroupLike extends DisposableNode {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
}

export interface PickupVisualLike {
  mesh: PickupGroupLike;
  radius: number;
}

export interface PickupObjectOptions {
  id?: string | number | null;
  type?: string | null;
  pickupVisual: PickupVisualLike;
  position: VecLike;
  floorUp?: number;
  scale?: number;
  basis?: WorldBasis;
}

export class PickupObject {
  readonly id: string | number | null;
  readonly type: string | null;
  readonly basis: WorldBasis;
  readonly up: Vector3;
  readonly group: PickupGroupLike;
  readonly position: Vector3;
  readonly radius: number;
  phase: number;
  baseHeight: number;

  private readonly _spin = new Quaternion();

  constructor({
    id = null,
    type = null,
    pickupVisual,
    position,
    floorUp = 0,
    scale = 1,
    basis = DEFAULT_WORLD_BASIS,
  }: PickupObjectOptions) {
    if (!position) throw new Error("PickupObject: position is required");

    this.id = id;
    this.type = type;
    this.basis = basis;
    this.up = this.basis.upVector();

    this.group = pickupVisual.mesh;
    this.group.position.set(position.x ?? 0, position.y ?? 0, position.z ?? 0);
    this.basis.setHeight(this.group.position, floorUp + 0.5);
    this.group.scale.setScalar(scale);

    this.position = this.group.position;
    this.radius = pickupVisual.radius * scale;
    this.phase = 0;
    this.baseHeight = this.basis.upComponent(this.group.position);
  }

  animate(deltaSeconds: number, bobSpeed = 3.2, bobHeight = 0.12, spinSpeed = 1.8): void {
    this.phase += Math.max(0, deltaSeconds) * bobSpeed;
    this.basis.setHeight(
      this.group.position,
      this.baseHeight + Math.sin(this.phase) * bobHeight,
    );
    // three rotateOnWorldAxis(axis, angle) ≡ quaternion.premultiply(axis-angle)
    this._spin.setFromAxisAngle(this.up, Math.max(0, deltaSeconds) * spinSpeed);
    this.group.quaternion.premultiply(this._spin);
  }

  dispose(): void {
    disposeSceneNode(this.group);
  }
}
