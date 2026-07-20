// playset/modules/world/object/projectile-object.ts — linear/homing
// projectile simulation that drives a factory-built visual.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/object/ProjectileObject.js. Verbatim semantics;
// zero scene coupling — the visual is driven structurally through its
// optional step() callback.

import { clamp } from "../../math/scalar-utils.ts";
import { toUnitVec3, toVec3 } from "../../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis, type VecLike } from "../../math/world-basis.ts";
import type { Vector3 } from "../../../math/vector3.ts";
import { disposeSceneNode, type DisposableNode } from "../scene-node-utils.ts";

export interface ProjectileTargetLike {
  position: VecLike;
  destroyed?: boolean;
}

export interface ProjectileVisualStepState {
  position: Vector3;
  direction: Vector3;
  velocity: Vector3;
  ageSeconds: number;
  lifetimeSeconds: number;
}

export interface ProjectileVisualLike {
  group: DisposableNode;
  step?(state: ProjectileVisualStepState): void;
}

export interface ProjectileObjectOptions {
  visual: ProjectileVisualLike;
  position: VecLike;
  direction: VecLike | null | undefined;
  speed: number;
  target?: ProjectileTargetLike | null;
  lifetimeSeconds: number;
  hitRadius: number;
  turnResponse?: number;
  basis?: WorldBasis;
}

export interface ProjectileStepResult {
  position: Vector3;
  target: ProjectileTargetLike | null;
  hittedTarget: ProjectileTargetLike | null;
}

export class ProjectileObject {
  target: ProjectileTargetLike | null;
  speed: number;
  lifetimeSeconds: number;
  hitRadius: number;
  turnResponse: number;
  active: boolean;
  ageSeconds: number;
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly visual: ProjectileVisualLike;
  readonly group: DisposableNode;

  constructor({
    visual,
    position,
    direction,
    speed,
    target = null,
    lifetimeSeconds,
    hitRadius,
    turnResponse = 0,
    basis = DEFAULT_WORLD_BASIS,
  }: ProjectileObjectOptions) {
    this.target = target;
    this.speed = speed;
    this.lifetimeSeconds = lifetimeSeconds;
    this.hitRadius = hitRadius;
    this.turnResponse = turnResponse;
    this.active = true;
    this.ageSeconds = 0;

    this.position = toVec3(position);
    const launchDirection = toUnitVec3(direction, basis.forwardVector());
    this.velocity = launchDirection.multiplyScalar(this.speed);

    this.visual = visual;
    this.group = this.visual.group;
    this._syncVisual();
  }

  step(targets: ProjectileTargetLike[] = [], deltaSeconds = 1 / 60): ProjectileStepResult {
    if (!this.active) return this._result();

    this.ageSeconds += deltaSeconds;

    const result = this.target
      ? this._stepHomingMotion(targets, deltaSeconds)
      : this._stepLinearMotion(targets, deltaSeconds);

    if (this.active && this.ageSeconds >= this.lifetimeSeconds) this.active = false;
    return result;
  }

  private _stepLinearMotion(
    targets: ProjectileTargetLike[],
    deltaSeconds: number,
  ): ProjectileStepResult {
    this.position.addScaledVector(this.velocity, deltaSeconds);
    this._syncVisual();

    const hitTarget = this._findHitTarget(targets);
    if (hitTarget) {
      this.active = false;
    }

    return this._result(null, hitTarget);
  }

  private _stepHomingMotion(
    targets: ProjectileTargetLike[],
    deltaSeconds: number,
  ): ProjectileStepResult {
    const target = this.target && !this.target.destroyed ? this.target : null;
    if (target) {
      const desired = toVec3(target.position).sub(this.position);
      if (desired.lengthSq() > 1e-6) {
        desired.normalize().multiplyScalar(this.speed);
        this.velocity.lerp(desired, clamp(deltaSeconds * this.turnResponse, 0, 1));
      }
    }

    this.position.addScaledVector(this.velocity, deltaSeconds);
    this._syncVisual();

    const hitTarget = this._findHitTarget(targets, 1.2);
    if (hitTarget) {
      this.active = false;
    }
    return this._result(target, hitTarget);
  }

  private _findHitTarget(
    targets: ProjectileTargetLike[],
    radiusScale = 1,
  ): ProjectileTargetLike | null {
    const hitRadius = this.hitRadius * radiusScale;
    for (const target of targets) {
      if (target.destroyed) continue;
      const targetPosition = toVec3(target.position);
      if (this.position.distanceTo(targetPosition) <= hitRadius) return target;
    }
    return null;
  }

  private _direction(): Vector3 {
    if (this.velocity.lengthSq() <= 1e-6) return this.velocity.clone();
    return this.velocity.clone().normalize();
  }

  private _syncVisual(): void {
    this.visual.step?.({
      position: this.position,
      direction: this._direction(),
      velocity: this.velocity,
      ageSeconds: this.ageSeconds,
      lifetimeSeconds: this.lifetimeSeconds,
    });
  }

  private _result(
    target: ProjectileTargetLike | null = null,
    hittedTarget: ProjectileTargetLike | null = null,
  ): ProjectileStepResult {
    return {
      position: this.position,
      target,
      hittedTarget,
    };
  }

  dispose(): void {
    disposeSceneNode(this.group);
  }
}
