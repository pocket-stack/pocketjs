// playset/modules/actor-motion/character/world-target-character-motion-controller.ts —
// character controller that walks toward / faces world-space target points
// (click-to-move, AI destinations).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/character/WorldTargetCharacterMotionController.js.
// Verbatim semantics.

import { Vector3 } from "../../../math/index.ts";
import type { MutableVec } from "../../math/world-basis.ts";
import {
  BaseCharacterMotionController,
  type BaseCharacterMotionControllerOptions,
  type CharacterMotionConfig,
  type CharacterMotionPlanResult,
} from "./base-character-motion-controller.ts";

export interface WorldTargetCharacterMotionControllerOptions
  extends BaseCharacterMotionControllerOptions {
  stopRadius?: number;
}

export interface WorldTargetPlanOptions {
  moveTarget?: MutableVec | null;
  faceTarget?: MutableVec | null;
  sprint?: boolean;
  crouch?: boolean;
  jump?: boolean;
  deltaSeconds?: number;
  commit?: boolean;
}

export class WorldTargetCharacterMotionController extends BaseCharacterMotionController {
  declare cfg: CharacterMotionConfig & { stopRadius: number };

  constructor({
    stopRadius = 0.35,
    ...config
  }: WorldTargetCharacterMotionControllerOptions) {
    super(config);
    this.cfg.stopRadius = stopRadius;
  }

  // moveTarget: move toward a world position.
  // faceTarget: face toward a world position when no move target is active.
  planMovement({
    moveTarget = null,
    faceTarget = null,
    sprint = false,
    crouch = false,
    jump = false,
    deltaSeconds = 1 / 60,
    commit = false,
  }: WorldTargetPlanOptions): CharacterMotionPlanResult {
    const activeMoveTarget = moveTarget ? new Vector3(moveTarget.x, moveTarget.y, moveTarget.z) : null;
    const activeFaceTarget = faceTarget ? new Vector3(faceTarget.x, faceTarget.y, faceTarget.z) : null;
    const targetDistance = activeMoveTarget
      ? Math.sqrt(this.basis.distanceSqPlanar(activeMoveTarget, this.position))
      : Infinity;
    const targetReached = targetDistance <= this.cfg.stopRadius;

    const moveDirection = activeMoveTarget && !targetReached
      ? this._directionTo(activeMoveTarget)
      : new Vector3();
    const facingDirection = activeMoveTarget && !targetReached
      ? moveDirection
      : activeFaceTarget
      ? this._directionTo(activeFaceTarget)
      : null;

    const intent = this._prepareLocomotion({
      moveDirection,
      facingDirection,
      sprint,
      crouch,
      jump,
      deltaSeconds,
    });

    if (commit) return this.commitMovement(intent);
    return intent;
  }
}
