// playset/modules/actor-motion/aircraft/airplane-model-controller.ts — writes
// airplane motion state (position + yaw/pitch/roll frame) onto a scene model
// and drives jet-flame effects.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/aircraft/AirplaneModelController.js.
// Verbatim semantics; the model is typed structurally (position + quaternion)
// instead of a three.js Object3D.

import { Matrix4, type Quaternion, type Vector3 } from "../../../math/index.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis, type VecLike } from "../../math/world-basis.ts";

export interface PlaneModelLike {
  position: Vector3;
  quaternion: Quaternion;
}

export interface JetFlameLike {
  step(frame: {
    throttle: number;
    isBoosting: boolean;
    timeSeconds: number;
    deltaSeconds: number;
  }): void;
}

export interface AirplaneModelStepInput {
  position: VecLike;
  yaw: number;
  pitch: number;
  roll: number;
  throttle: number;
  isBoosting: boolean;
  elapsedTimeSeconds: number;
  deltaSeconds?: number;
}

export class AirplaneModelController {
  planeModel: PlaneModelLike | null;
  jetFlames: JetFlameLike[];
  basis: WorldBasis;
  modelMatrix: Matrix4;

  constructor(
    planeModel: PlaneModelLike | null = null,
    jetFlames: JetFlameLike[] = [],
    basis: WorldBasis = DEFAULT_WORLD_BASIS,
  ) {
    this.planeModel = planeModel;
    this.jetFlames = jetFlames;
    this.basis = basis;

    this.modelMatrix = new Matrix4();
  }

  reset(): void {
    if (!this.planeModel) return;
    this.planeModel.position.set(0, 0, 0);
    this.planeModel.quaternion.identity();
  }

  step({
    position,
    yaw,
    pitch,
    roll,
    throttle,
    isBoosting,
    elapsedTimeSeconds,
    deltaSeconds = 1 / 60,
  }: AirplaneModelStepInput): void {
    if (!this.planeModel) return;

    this.planeModel.position.set(position.x ?? 0, position.y ?? 0, position.z ?? 0);

    const frame = this.basis.yawPitchRollFrame(yaw, pitch, roll);
    this.modelMatrix.makeBasis(frame.right, frame.up, frame.back ?? frame.forward.clone().negate());
    this.planeModel.quaternion.setFromRotationMatrix(this.modelMatrix);

    for (const flame of this.jetFlames) {
      flame.step({
        throttle,
        isBoosting,
        timeSeconds: elapsedTimeSeconds,
        deltaSeconds,
      });
    }
  }
}
