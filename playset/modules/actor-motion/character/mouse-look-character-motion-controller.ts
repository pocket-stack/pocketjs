// playset/modules/actor-motion/character/mouse-look-character-motion-controller.ts —
// first/third-person character controller: mouse deltas steer yaw/pitch,
// WASD-style axes move relative to the view heading.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/character/MouseLookCharacterMotionController.js.
// Verbatim semantics.

import {
  BaseCharacterMotionController,
  type BaseCharacterMotionControllerOptions,
  type CharacterMotionConfig,
  type CharacterMotionPlanResult,
} from "./base-character-motion-controller.ts";

export interface MouseLookCharacterMotionControllerOptions
  extends BaseCharacterMotionControllerOptions {
  lookSensitivityX?: number;
  lookSensitivityY?: number;
}

export interface MouseLookPlanOptions {
  forward?: number;
  backward?: number;
  strafeLeft?: number;
  strafeRight?: number;
  sprint?: boolean;
  crouch?: boolean;
  jump?: boolean;
  mouseDeltaX?: number;
  mouseDeltaY?: number;
  deltaSeconds?: number;
  commit?: boolean;
}

export class MouseLookCharacterMotionController extends BaseCharacterMotionController {
  declare cfg: CharacterMotionConfig & { lookSensitivityX: number; lookSensitivityY: number };

  constructor({
    lookSensitivityX = 0.0022,
    lookSensitivityY = 0.0018,
    ...config
  }: MouseLookCharacterMotionControllerOptions) {
    super(config);
    this.cfg.lookSensitivityX = lookSensitivityX;
    this.cfg.lookSensitivityY = lookSensitivityY;
  }

  // forward/backward: 0..1 moves along the local forward/backward directions.
  // strafeLeft/strafeRight: 0..1 moves along the local left/right directions.
  // mouseDeltaX/mouseDeltaY: rotate view yaw/pitch.
  planMovement({
    forward = 0,
    backward = 0,
    strafeLeft = 0,
    strafeRight = 0,
    sprint = false,
    crouch = false,
    jump = false,
    mouseDeltaX = 0,
    mouseDeltaY = 0,
    deltaSeconds = 1 / 60,
    commit = false,
  }: MouseLookPlanOptions): CharacterMotionPlanResult {
    const rightAxis = this.basis.controlSignal("left", strafeLeft) + this.basis.controlSignal("right", strafeRight);
    const forwardAxis = this.basis.controlSignal("backward", backward) + this.basis.controlSignal("forward", forward);
    const clockWiseSign = this.basis.controlSignal("clockWise", true);
    const nextYaw = this.yaw + clockWiseSign * mouseDeltaX * this.cfg.lookSensitivityX;
    const nextPitch = this.pitch + clockWiseSign * mouseDeltaY * this.cfg.lookSensitivityY;
    const inputLength = Math.hypot(rightAxis, forwardAxis);
    const inputScale = inputLength > 1 ? 1 / inputLength : 1;
    const moveFrame = this.basis.yawPitchRollFrame(nextYaw);
    const moveDirection = moveFrame.right
      .multiplyScalar(rightAxis * inputScale)
      .addScaledVector(moveFrame.forward, forwardAxis * inputScale);

    const intent = this._prepareLocomotion({
      moveDirection,
      sprint,
      crouch,
      jump,
      yaw: nextYaw,
      pitch: nextPitch,
      deltaSeconds,
    });

    if (commit) return this.commitMovement(intent);
    return intent;
  }
}
