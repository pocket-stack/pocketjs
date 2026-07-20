// playset/modules/camera/base-camera-rig.ts — shared smoothing and
// basis-aware pose plumbing for the concrete camera rigs.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/camera/BaseCameraRig.js. Verbatim semantics, except
// applyToCamera drives a structural CameraLike whose `up`/`lookAt` are
// optional — scene3d's Camera3D has no `up` field — so both it and three-style
// cameras (and test doubles) work unchanged.

import { Matrix4, Vector3, type Quaternion } from "../../math/index.ts";
import { smoothingAlpha } from "../math/scalar-utils.ts";
import { toUnitVec3, toVec3 } from "../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";

const EPS = 1e-12;

export const CAMERA_ROTATION_MODES = Object.freeze({
  lookAt: "lookAt",
  frame: "frame",
} as const);
export type CameraRotationMode =
  (typeof CAMERA_ROTATION_MODES)[keyof typeof CAMERA_ROTATION_MODES];

export const CAMERA_HEIGHT_SOURCES = Object.freeze({
  frameUp: "frameUp",
  basisUp: "basisUp",
} as const);
export type CameraHeightSource =
  (typeof CAMERA_HEIGHT_SOURCES)[keyof typeof CAMERA_HEIGHT_SOURCES];

/** Anything a rig can drive: scene3d Camera3D, a three camera, or a double. */
export interface CameraLike {
  position: Vector3;
  quaternion: Quaternion;
  up?: Vector3;
  lookAt?(target: Vector3): unknown;
}

export interface CameraPose {
  position: Vector3;
  lookAt: Vector3;
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

/** Loose target frame — any subset of axes; missing ones fall back to basis. */
export interface TargetFrameLike {
  forward?: VecLike | null;
  right?: VecLike | null;
  up?: VecLike | null;
}

export interface ResolvedTargetFrame {
  forward: Vector3;
  right: Vector3;
  up: Vector3;
  back: Vector3;
}

export interface BaseCameraRigOptions {
  rotationMode?: CameraRotationMode;
  basis?: WorldBasis;
}

export interface CameraRigState {
  position?: VecLike | null;
  lookAt?: VecLike | null;
  forward?: VecLike | null;
  right?: VecLike | null;
  up?: VecLike | null;
  rotationMode?: CameraRotationMode;
}

export class BaseCameraRig {
  basis: WorldBasis;
  rotationMode: CameraRotationMode;
  position: Vector3;
  lookAt: Vector3;
  forward: Vector3;
  right: Vector3;
  up: Vector3;
  initialized: boolean;

  constructor({
    rotationMode = CAMERA_ROTATION_MODES.lookAt,
    basis = DEFAULT_WORLD_BASIS,
  }: BaseCameraRigOptions) {
    this.basis = basis;
    this.rotationMode = rotationMode;
    this.position = new Vector3();
    this.lookAt = this.basis.forwardVector();
    this.forward = this.basis.forwardVector();
    this.right = this.basis.rightVector();
    this.up = this.basis.upVector();
    this.initialized = false;
  }

  setState({
    position = null,
    lookAt = null,
    forward = null,
    right = null,
    up = null,
    rotationMode = this.rotationMode,
  }: CameraRigState): this {
    if (position) this.position.copy(toVec3(position, this.position));
    if (lookAt) this.lookAt.copy(toVec3(lookAt, this.lookAt));
    if (forward) this.forward.copy(toUnitVec3(forward, this.forward));
    if (right) this.right.copy(toUnitVec3(right, this.right));
    if (up) this.up.copy(toUnitVec3(up, this.up));
    this.rotationMode = rotationMode;
    this.initialized = true;
    return this;
  }

  getPose(): CameraPose {
    return {
      position: this.position.clone(),
      lookAt: this.lookAt.clone(),
      forward: this.forward.clone(),
      right: this.right.clone(),
      up: this.up.clone(),
    };
  }

  applyToCamera(camera: CameraLike | null | undefined, pose: CameraPose = this.getPose()): void {
    if (!camera) return;

    camera.position.copy(pose.position);
    camera.up?.copy(pose.up);

    if (this.rotationMode === CAMERA_ROTATION_MODES.frame) {
      const matrix = new Matrix4().makeBasis(
        pose.right,
        pose.up,
        pose.forward.clone().negate(),
      );
      camera.quaternion.setFromRotationMatrix(matrix);
    } else {
      camera.lookAt?.(pose.lookAt);
    }
  }

  resolveTargetFrame(targetFrame: TargetFrameLike): ResolvedTargetFrame {
    const forward = toUnitVec3(targetFrame.forward, this.basis.forwardVector());
    const up = toUnitVec3(targetFrame.up, this.basis.upVector());
    const fallbackRight = new Vector3().crossVectors(forward, up);
    if (fallbackRight.lengthSq() <= EPS) fallbackRight.copy(this.basis.rightVector());
    const right = toUnitVec3(targetFrame.right, fallbackRight);
    return { forward, right, up, back: forward.clone().negate() };
  }

  vectorFromSource(source: CameraHeightSource, frame: ResolvedTargetFrame): Vector3 {
    return source === CAMERA_HEIGHT_SOURCES.basisUp ? this.basis.upVector() : frame.up.clone();
  }

  smoothVector(
    current: Vector3,
    target: Vector3,
    lag: number,
    deltaSeconds: number,
    snapToTarget = false,
  ): Vector3 {
    if (snapToTarget || !this.initialized || lag <= 0) {
      current.copy(target);
      return current;
    }
    return current.lerp(target, smoothingAlpha(lag, deltaSeconds));
  }

  setLookAtPose({
    position,
    lookAt,
    up,
  }: {
    position: Vector3;
    lookAt: Vector3;
    up?: VecLike | null;
  }): void {
    this.position.copy(position);
    this.lookAt.copy(lookAt);
    this.up.copy(toUnitVec3(up, this.basis.upVector()));
    this.forward.subVectors(this.lookAt, this.position);
    if (this.forward.lengthSq() <= EPS) this.forward.copy(this.basis.forwardVector());
    else this.forward.normalize();
    this.right.crossVectors(this.forward, this.up);
    if (this.right.lengthSq() <= EPS) this.right.copy(this.basis.rightVector());
    else this.right.normalize();
    this.up.crossVectors(this.right, this.forward).normalize();
    this.initialized = true;
  }

  setFramePose({
    position,
    forward,
    right = null,
    up,
  }: {
    position: Vector3;
    forward: VecLike | null;
    right?: VecLike | null;
    up?: VecLike | null;
  }): void {
    this.position.copy(position);
    this.forward.copy(toUnitVec3(forward, this.basis.forwardVector()));
    this.up.copy(toUnitVec3(up, this.basis.upVector()));
    this.right.copy(
      right
        ? toUnitVec3(right, this.basis.rightVector())
        : new Vector3().crossVectors(this.forward, this.up),
    );
    if (this.right.lengthSq() <= EPS) this.right.copy(this.basis.rightVector());
    else this.right.normalize();
    this.up.crossVectors(this.right, this.forward).normalize();
    this.lookAt.copy(this.position.clone().add(this.forward));
    this.initialized = true;
  }
}
