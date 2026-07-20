// playset/modules/camera/position-follow-camera-rig.ts — follows a target
// position with a fixed world-basis offset and viewing angle, always looking
// at the target.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/camera/PositionFollowCameraRig.js. Verbatim semantics.

import { toVec3 } from "../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";
import {
  BaseCameraRig,
  CAMERA_ROTATION_MODES,
  type CameraLike,
  type CameraPose,
} from "./base-camera-rig.ts";

export interface PositionFollowCameraRigOptions {
  azimuth?: number;
  distance?: number;
  height?: number;
  lookHeight?: number;
  positionLag?: number;
  lookLag?: number;
  basis?: WorldBasis;
}

export interface PositionFollowCameraStepInput {
  targetPosition: VecLike;
  snapToTarget?: boolean;
  deltaSeconds?: number;
  camera?: CameraLike | null;
}

export class PositionFollowCameraRig extends BaseCameraRig {
  azimuth: number;
  distance: number;
  height: number;
  lookHeight: number;
  positionLag: number;
  lookLag: number;

  constructor({
    azimuth = 0,
    distance = 18,
    height = 16,
    lookHeight = 0,
    positionLag = 0.0,
    lookLag = 0.0,
    basis = DEFAULT_WORLD_BASIS,
  }: PositionFollowCameraRigOptions) {
    super({ basis, rotationMode: CAMERA_ROTATION_MODES.lookAt });
    this.azimuth = azimuth;
    this.distance = distance;
    this.height = height;
    this.lookHeight = lookHeight;
    this.positionLag = positionLag;
    this.lookLag = lookLag;
  }

  step({
    targetPosition,
    snapToTarget = false,
    deltaSeconds = 1 / 60,
    camera = null,
  }: PositionFollowCameraStepInput): CameraPose {
    const focus = toVec3(targetPosition);

    const viewDirection = this.basis
      .fromBasisComponents(Math.sin(this.azimuth), 0, Math.cos(this.azimuth))
      .normalize();
    const cameraPosition = focus.clone().addScaledVector(viewDirection, -this.distance);
    const cameraLookAt = focus.clone();
    const baseHeight = this.basis.upComponent(focus);

    this.basis.setHeight(cameraPosition, baseHeight + this.height);
    this.basis.setHeight(cameraLookAt, baseHeight + this.lookHeight);
    this.smoothVector(this.position, cameraPosition, this.positionLag, deltaSeconds, snapToTarget);
    this.smoothVector(this.lookAt, cameraLookAt, this.lookLag, deltaSeconds, snapToTarget);

    this.setLookAtPose({
      position: this.position,
      lookAt: this.lookAt,
      up: this.basis.upVector(),
    });

    const pose = this.getPose();
    this.applyToCamera(camera, pose);
    return pose;
  }
}
