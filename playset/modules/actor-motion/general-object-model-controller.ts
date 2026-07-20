// playset/modules/actor-motion/general-object-model-controller.ts — pushes a
// motion controller's position + direction frame onto a scene object's
// position/quaternion (with optional basis-up levelling).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/GeneralObjectModelController.js. Verbatim
// semantics; `model` is typed structurally (position + quaternion) so a
// scene3d SceneNode or any test double fits without importing scene3d.

import { Matrix4, Vector3 } from "../../math/index.ts";
import type { Quaternion } from "../../math/index.ts";
import { DEFAULT_WORLD_BASIS, type MutableVec, type WorldBasis } from "../math/world-basis.ts";

/** Minimal writable pose — satisfied by scene3d SceneNode and test doubles. */
export interface ObjectModelLike {
  position: Vector3;
  quaternion: Quaternion;
}

export interface ObjectFrameInput {
  forward: MutableVec;
  right?: MutableVec | null;
  up?: MutableVec | null;
}

export interface GeneralObjectModelControllerOptions {
  model?: ObjectModelLike | null;
  localForward?: "+z" | "-z";
  basis?: WorldBasis;
  keepBasisUp?: boolean;
}

export class GeneralObjectModelController {
  model: ObjectModelLike | null;
  basis: WorldBasis;
  localForwardSign: 1 | -1;
  keepBasisUp: boolean;
  modelMatrix: Matrix4;
  xAxis: Vector3;
  yAxis: Vector3;
  zAxis: Vector3;
  right: Vector3;
  up: Vector3;
  forward: Vector3;

  constructor({
    model = null,
    localForward = "-z",
    basis = DEFAULT_WORLD_BASIS,
    keepBasisUp = false,
  }: GeneralObjectModelControllerOptions) {
    this.model = model;
    this.basis = basis;
    this.localForwardSign = localForward === "+z" ? 1 : -1;
    this.keepBasisUp = keepBasisUp;

    this.modelMatrix = new Matrix4();
    this.xAxis = new Vector3();
    this.yAxis = new Vector3();
    this.zAxis = new Vector3();
    this.right = this.xAxis;
    this.up = this.yAxis;
    this.forward = this.zAxis;
  }

  reset(position: Vector3 | null = null): ObjectModelLike | null {
    if (!this.model) return this.model;

    if (position) this.model.position.copy(position);
    this.model.quaternion.identity();
    return this.model;
  }

  step(position: Vector3 | null, objectFrame: ObjectFrameInput | null = null): ObjectModelLike | null {
    if (!this.model) return this.model;

    if (position) this.model.position.copy(position);
    if (objectFrame) this.updateObjectFrame(objectFrame);

    return this.model;
  }

  updateObjectFrame(objectFrame: ObjectFrameInput): void {
    this.zAxis
      .set(objectFrame.forward.x, objectFrame.forward.y, objectFrame.forward.z);

    if (this.keepBasisUp) {
      this.basis.flatten(this.zAxis);
    }

    this.zAxis.normalize().multiplyScalar(this.localForwardSign);

    if (!this.keepBasisUp && objectFrame.right && objectFrame.up) {
      this.xAxis
        .set(objectFrame.right.x, objectFrame.right.y, objectFrame.right.z)
        .normalize()
        .multiplyScalar(-this.localForwardSign);
      this.yAxis
        .set(objectFrame.up.x, objectFrame.up.y, objectFrame.up.z)
        .normalize();
    } else {
      this.basis.upVector(this.yAxis);
      this.xAxis.crossVectors(this.yAxis, this.zAxis).normalize();
    }

    this.modelMatrix.makeBasis(this.xAxis, this.yAxis, this.zAxis);
    // Matches the original: calling this directly with a null model throws.
    this.model!.quaternion.setFromRotationMatrix(this.modelMatrix);
  }
}
