// playset/modules/camera/look-offset-camera-rig.ts — temporary free-look
// rotation around a target that recenters when look input stops.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/camera/LookOffsetCameraRig.js. Verbatim semantics (an
// unused three Quaternion import in the original was dropped).

import { clamp, smoothingAlpha } from "../math/scalar-utils.ts";
import { toVec3 } from "../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";
import { BaseCameraRig, type CameraLike, type CameraPose } from "./base-camera-rig.ts";

export interface LookOffsetCameraRigOptions {
  distance?: number;
  lookSensitivity?: number;
  returnLag?: number;
  pitchMin?: number;
  pitchMax?: number;
  basis?: WorldBasis;
}

export interface LookOffsetCameraStepInput {
  targetPosition: VecLike;
  targetYaw?: number;
  targetPitch?: number;
  targetRoll?: number;
  lookActive?: boolean;
  lookDeltaX?: number;
  lookDeltaY?: number;
  deltaSeconds?: number;
  camera?: CameraLike | null;
}

export class LookOffsetCameraRig extends BaseCameraRig {
  distance: number;
  lookSensitivity: number;
  returnLag: number;
  cameraYaw: number;
  cameraPitch: number;
  pitchMin: number;
  pitchMax: number;

  constructor({
    distance = 20,
    lookSensitivity = 0.0035, // 0.2 deg per input unit
    returnLag = 0.17,
    pitchMin = -1.4835, // -85 deg
    pitchMax = 1.4835, // 85 deg
    basis = DEFAULT_WORLD_BASIS,
  }: LookOffsetCameraRigOptions) {
    super({ basis });
    this.distance = distance;
    this.lookSensitivity = lookSensitivity;
    this.returnLag = returnLag;
    this.cameraYaw = 0;
    this.cameraPitch = 0;
    this.pitchMin = pitchMin;
    this.pitchMax = pitchMax;
  }

  setSensitivity(value: number): this {
    this.lookSensitivity = value;
    return this;
  }

  setLook(cameraYaw = 0, cameraPitch = 0): this {
    this.cameraYaw = cameraYaw;
    this.cameraPitch = clamp(cameraPitch, this.pitchMin, this.pitchMax);
    return this;
  }

  step({
    targetPosition,
    targetYaw = 0,
    targetPitch = 0,
    targetRoll = 0,
    lookActive = false,
    lookDeltaX = 0,
    lookDeltaY = 0,
    deltaSeconds = 1 / 60,
    camera = null,
  }: LookOffsetCameraStepInput): CameraPose {
    if (lookActive) {
      this.cameraYaw += lookDeltaX * this.lookSensitivity;
      this.cameraPitch += lookDeltaY * this.lookSensitivity;
      this.cameraPitch = clamp(this.cameraPitch, this.pitchMin, this.pitchMax);
    } else {
      const blend = smoothingAlpha(this.returnLag, deltaSeconds);
      this.cameraYaw += (0 - this.cameraYaw) * blend;
      this.cameraPitch += (0 - this.cameraPitch) * blend;
    }

    const lookAtPosition = toVec3(targetPosition);

    const frame = this.basis.yawPitchRollFrame(
      targetYaw + this.cameraYaw,
      targetPitch + this.cameraPitch,
      targetRoll,
    );
    const cameraPosition = frame.back.clone().multiplyScalar(this.distance).add(lookAtPosition);

    this.setLookAtPose({
      position: cameraPosition,
      lookAt: lookAtPosition,
      up: frame.up,
    });

    const pose = this.getPose();
    this.applyToCamera(camera, pose);
    return pose;
  }
}
