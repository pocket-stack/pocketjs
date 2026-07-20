// playset/modules/actor-motion/plate-tilt-controller.ts — smoothed two-axis
// plate tilt (labyrinth/marble-board style) plus the downhill slope signal
// gameplay reads for acceleration.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/PlateTiltController.js. Verbatim semantics.

import { clamp, smoothToward } from "../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../math/world-basis.ts";

export interface PlateTiltControllerOptions {
  maxTiltRadians?: number;
  tiltLag?: number;
  basis?: WorldBasis;
}

export interface PlateTiltMoveOptions {
  forward?: number;
  backward?: number;
  left?: number;
  right?: number;
  deltaSeconds?: number;
}

export interface PlateSlopeSignal {
  right: number;
  forward: number;
}

export interface PlateTiltSnapshot {
  rightTiltRadians: number;
  forwardTiltRadians: number;
  slope: PlateSlopeSignal;
}

export class PlateTiltController {
  maxTiltRadians: number;
  tiltLag: number;
  rightTiltRadians: number;
  forwardTiltRadians: number;
  basis: WorldBasis;

  constructor({
    maxTiltRadians = 0.13,
    tiltLag = 0.10,
    basis = DEFAULT_WORLD_BASIS,
  }: PlateTiltControllerOptions) {
    this.maxTiltRadians = Math.max(1e-6, maxTiltRadians);
    this.tiltLag = Math.max(0, tiltLag);
    this.rightTiltRadians = 0;
    this.forwardTiltRadians = 0;
    this.basis = basis;
  }

  reset(rightTiltRadians = 0, forwardTiltRadians = 0): PlateTiltSnapshot {
    this.rightTiltRadians = rightTiltRadians;
    this.forwardTiltRadians = forwardTiltRadians;
    return this.snapshot();
  }

  // forward/backward: 0..1 tilts toward the local forward/backward directions.
  // left/right: 0..1 tilts toward the local left/right directions.
  move({
    forward = 0,
    backward = 0,
    left = 0,
    right = 0,
    deltaSeconds = 1 / 60,
  }: PlateTiltMoveOptions): PlateTiltSnapshot {
    const targetForward = this.basis.controlSignal("clockWise", forward) + this.basis.controlSignal("counterClockWise", backward);
    const targetRight = this.basis.controlSignal("clockWise", right) + this.basis.controlSignal("counterClockWise", left);

    this.forwardTiltRadians = smoothToward(
      this.forwardTiltRadians,
      targetForward * this.maxTiltRadians,
      this.tiltLag,
      deltaSeconds,
    );
    this.rightTiltRadians = smoothToward(
      this.rightTiltRadians,
      targetRight * this.maxTiltRadians,
      this.tiltLag,
      deltaSeconds,
    );

    return this.snapshot();
  }

  slopeSignal(): PlateSlopeSignal {
    // Gameplay acceleration follows the downhill slope, which is opposite the
    // signed rotation angle for positive forward/right tilt.
    return {
      right: clamp(-this.rightTiltRadians / this.maxTiltRadians, -1, 1),
      forward: clamp(-this.forwardTiltRadians / this.maxTiltRadians, -1, 1),
    };
  }

  snapshot(): PlateTiltSnapshot {
    return {
      rightTiltRadians: this.rightTiltRadians,
      forwardTiltRadians: this.forwardTiltRadians,
      slope: this.slopeSignal(),
    };
  }
}
