// playset/modules/actor-motion/character/world-cardinal-character-motion-controller.ts —
// character controller driven by world-cardinal move axes (tank/top-down style:
// input moves along world axes regardless of facing).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/character/WorldCardinalCharacterMotionController.js.
// Verbatim semantics.

import { Vector3 } from "../../../math/index.ts";
import {
  BaseCharacterMotionController,
  type BaseCharacterMotionControllerOptions,
  type CharacterMotionConfig,
  type CharacterMotionPlanResult,
} from "./base-character-motion-controller.ts";

export interface WorldCardinalCharacterMotionControllerOptions
  extends BaseCharacterMotionControllerOptions {
  turnRate?: number;
}

export interface WorldCardinalPlanOptions {
  forward?: number;
  backward?: number;
  left?: number;
  right?: number;
  rotateCCW?: number;
  rotateCW?: number;
  sprint?: boolean;
  crouch?: boolean;
  jump?: boolean;
  deltaSeconds?: number;
  commit?: boolean;
}

export class WorldCardinalCharacterMotionController extends BaseCharacterMotionController {
  declare cfg: CharacterMotionConfig & { turnRate: number };

  constructor({
    turnRate = 2.8,
    ...config
  }: WorldCardinalCharacterMotionControllerOptions) {
    super(config);
    this.cfg.turnRate = turnRate;
  }

  // forward/backward: 0..1 moves along the basis forward/backward directions.
  // left/right: 0..1 moves along the basis left/right directions.
  // rotateCCW/rotateCW: 0..1 rotates toward the basis counter-clockwise/clockwise directions.
  planMovement({
    forward = 0,
    backward = 0,
    left = 0,
    right = 0,
    rotateCCW = 0,
    rotateCW = 0,
    sprint = false,
    crouch = false,
    jump = false,
    deltaSeconds = 1 / 60,
    commit = false,
  }: WorldCardinalPlanOptions): CharacterMotionPlanResult {
    const moveRight = this.basis.controlSignal("left", left) + this.basis.controlSignal("right", right);
    const moveForward = this.basis.controlSignal("backward", backward) + this.basis.controlSignal("forward", forward);
    const turnAxis = this.basis.controlSignal("counterClockWise", rotateCCW) + this.basis.controlSignal("clockWise", rotateCW);
    const nextYaw = this.yaw + turnAxis * this.cfg.turnRate * deltaSeconds;
    const moveDirection = Math.hypot(moveRight, moveForward) > 0
      ? this._planarUnit(this.basis.fromBasisComponents(moveRight, 0, moveForward))
      : new Vector3();

    const intent = this._prepareLocomotion({
      moveDirection,
      facingDirection: turnAxis === 0 && moveDirection.lengthSq() > 0 ? moveDirection : null,
      sprint,
      crouch,
      jump,
      yaw: nextYaw,
      deltaSeconds,
    });

    if (commit) return this.commitMovement(intent);
    return intent;
  }
}
