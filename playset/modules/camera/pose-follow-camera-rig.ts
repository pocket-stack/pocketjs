// playset/modules/camera/pose-follow-camera-rig.ts — follows a target
// position and frame with pose-relative camera/look offsets so the view moves
// and turns with the target (third-person chase camera).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/camera/PoseFollowCameraRig.js. Verbatim semantics.

import { toVec3 } from "../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";
import {
  BaseCameraRig,
  CAMERA_HEIGHT_SOURCES,
  CAMERA_ROTATION_MODES,
  type CameraHeightSource,
  type CameraLike,
  type CameraPose,
  type CameraRotationMode,
  type TargetFrameLike,
} from "./base-camera-rig.ts";

export interface PoseOffset {
  forward: number;
  up: number;
  right: number;
}

export interface PoseFollowCameraRigOptions {
  cameraOffset: PoseOffset;
  lookAtOffset?: PoseOffset;
  speedCameraOffset?: PoseOffset;
  speedLookAtOffset?: PoseOffset;
  heightVectorSource?: CameraHeightSource;
  lookHeightVectorSource?: CameraHeightSource;
  positionLag?: number;
  lookLag?: number;
  frameLag?: number;
  rotationMode?: CameraRotationMode;
  basis?: WorldBasis;
}

export interface PoseFollowCameraStepInput {
  targetPosition: VecLike;
  targetFrame: TargetFrameLike;
  targetSpeed?: number | null;
  snapToTarget?: boolean;
  deltaSeconds?: number;
  camera?: CameraLike | null;
}

export class PoseFollowCameraRig extends BaseCameraRig {
  cameraOffset: PoseOffset;
  lookAtOffset: PoseOffset;
  speedCameraOffset: PoseOffset;
  speedLookAtOffset: PoseOffset;
  heightVectorSource: CameraHeightSource;
  lookHeightVectorSource: CameraHeightSource;
  positionLag: number;
  lookLag: number;
  frameLag: number;

  constructor({
    cameraOffset,
    lookAtOffset = { forward: 1, up: 0, right: 0 },
    speedCameraOffset = { forward: 0, up: 0, right: 0 },
    speedLookAtOffset = { forward: 0, up: 0, right: 0 },
    heightVectorSource = CAMERA_HEIGHT_SOURCES.frameUp,
    lookHeightVectorSource = CAMERA_HEIGHT_SOURCES.frameUp,
    positionLag = 0,
    lookLag = 0,
    frameLag = 0,
    rotationMode = CAMERA_ROTATION_MODES.lookAt,
    basis = DEFAULT_WORLD_BASIS,
  }: PoseFollowCameraRigOptions) {
    super({ basis, rotationMode });
    this.cameraOffset = cameraOffset;
    this.lookAtOffset = lookAtOffset;
    this.speedCameraOffset = speedCameraOffset;
    this.speedLookAtOffset = speedLookAtOffset;
    this.heightVectorSource = heightVectorSource;
    this.lookHeightVectorSource = lookHeightVectorSource;
    this.positionLag = positionLag;
    this.lookLag = lookLag;
    this.frameLag = frameLag;
  }

  step({
    targetPosition,
    targetFrame,
    targetSpeed = 0,
    snapToTarget = false,
    deltaSeconds = 1 / 60,
    camera = null,
  }: PoseFollowCameraStepInput): CameraPose {
    const frame = this.resolveTargetFrame(targetFrame);
    const focusPosition = toVec3(targetPosition);
    const speed = Math.max(0, targetSpeed ?? 0);
    const heightVector = this.vectorFromSource(this.heightVectorSource, frame);
    const lookHeightVector = this.vectorFromSource(this.lookHeightVectorSource, frame);

    const cameraOffset = this.offsetForSpeed(this.cameraOffset, this.speedCameraOffset, speed);
    const lookAtOffset = this.offsetForSpeed(this.lookAtOffset, this.speedLookAtOffset, speed);

    const desiredPosition = focusPosition
      .clone()
      .addScaledVector(frame.forward, cameraOffset.forward)
      .addScaledVector(frame.right, cameraOffset.right)
      .addScaledVector(heightVector, cameraOffset.up);
    const desiredLookAt = focusPosition
      .clone()
      .addScaledVector(frame.forward, lookAtOffset.forward)
      .addScaledVector(frame.right, lookAtOffset.right)
      .addScaledVector(lookHeightVector, lookAtOffset.up);

    this.smoothVector(this.position, desiredPosition, this.positionLag, deltaSeconds, snapToTarget);
    this.smoothVector(this.lookAt, desiredLookAt, this.lookLag, deltaSeconds, snapToTarget);

    const desiredForward = frame.forward.clone();
    const desiredUp = frame.up.clone();
    this.smoothVector(this.forward, desiredForward, this.frameLag, deltaSeconds, snapToTarget).normalize();
    this.smoothVector(this.up, desiredUp, this.frameLag, deltaSeconds, snapToTarget).normalize();

    if (this.rotationMode === CAMERA_ROTATION_MODES.frame) {
      this.setFramePose({
        position: this.position,
        forward: this.forward,
        up: this.up,
      });
    } else if (this.rotationMode === CAMERA_ROTATION_MODES.lookAt) {
      this.setLookAtPose({
        position: this.position,
        lookAt: this.lookAt,
        up: frame.up,
      });
    }

    const pose = this.getPose();
    this.applyToCamera(camera, pose);
    return pose;
  }

  offsetForSpeed(offset: PoseOffset, speedOffset: PoseOffset, speed: number): PoseOffset {
    return {
      forward: offset.forward + speedOffset.forward * speed,
      up: offset.up + speedOffset.up * speed,
      right: offset.right + speedOffset.right * speed,
    };
  }
}
