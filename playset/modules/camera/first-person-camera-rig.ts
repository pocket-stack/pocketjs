// playset/modules/camera/first-person-camera-rig.ts — locks the camera to a
// target's eye position and forward direction for first-person view.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/camera/FirstPersonCameraRig.js. Verbatim semantics.

import { toVec3 } from "../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";
import {
  BaseCameraRig,
  CAMERA_HEIGHT_SOURCES,
  CAMERA_ROTATION_MODES,
  type CameraHeightSource,
  type CameraLike,
  type CameraPose,
  type TargetFrameLike,
} from "./base-camera-rig.ts";

export interface FirstPersonCameraRigOptions {
  eyeHeight?: number;
  lookDistance?: number;
  heightVectorSource?: CameraHeightSource;
  basis?: WorldBasis;
}

export interface FirstPersonCameraStepInput {
  targetPosition: VecLike;
  targetFrame: TargetFrameLike;
  camera?: CameraLike | null;
}

export class FirstPersonCameraRig extends BaseCameraRig {
  eyeHeight: number;
  lookDistance: number;
  heightVectorSource: CameraHeightSource;

  constructor({
    eyeHeight = 1.72,
    lookDistance = 1,
    heightVectorSource = CAMERA_HEIGHT_SOURCES.frameUp,
    basis = DEFAULT_WORLD_BASIS,
  }: FirstPersonCameraRigOptions) {
    super({ basis, rotationMode: CAMERA_ROTATION_MODES.lookAt });
    this.eyeHeight = eyeHeight;
    this.lookDistance = lookDistance;
    this.heightVectorSource = heightVectorSource;
  }

  step({ targetPosition, targetFrame, camera = null }: FirstPersonCameraStepInput): CameraPose {
    const frame = this.resolveTargetFrame(targetFrame);
    const heightVector = this.vectorFromSource(this.heightVectorSource, frame);
    const position = toVec3(targetPosition).addScaledVector(heightVector, this.eyeHeight);

    this.setLookAtPose({
      position,
      lookAt: position.clone().addScaledVector(frame.forward, this.lookDistance),
      up: frame.up,
    });

    const pose = this.getPose();
    this.applyToCamera(camera, pose);
    return pose;
  }
}
