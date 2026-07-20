// playset/modules/gameplay/combat/projectile-weapon-system.ts — fire-control
// state machine: ammo, cooldown, gun heat, missile lock-on, launch vectors.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/gameplay/combat/ProjectileWeaponSystem.js. Verbatim
// semantics; aimMode is typed to the two supported modes, so the original's
// implicit crash on an unknown mode becomes the same TypeError as a zero
// fire direction.

import { DEFAULT_CLOCK, type Clock } from "../../math/time-utils.ts";
import { toVec3 } from "../../math/vector3-utils.ts";
import type { Vector3 } from "../../../math/index.ts";
import type { VecLike } from "../../math/world-basis.ts";

export const WEAPON_DECISIONS = Object.freeze({
  FIRE_GUN: "fire-gun",
  FIRE_MISSILE: "fire-missile",
  BLOCKED: "blocked",
  EMPTY_WARNING: "empty-warning",
} as const);

export const WEAPON_TYPES = Object.freeze({
  GUN: "gun",
  MISSILE: "missile",
} as const);

export const WEAPON_AIM_MODES = Object.freeze({
  BORESIGHT: "boresight",
  CROSSHAIR: "crosshair",
} as const);

export const MISSILE_LOCK_STATUS = Object.freeze({
  NONE: "NONE",
  LOCKING: "LOCKING",
  LOCKED: "LOCKED",
} as const);

export type WeaponAimMode = (typeof WEAPON_AIM_MODES)[keyof typeof WEAPON_AIM_MODES];
export type MissileLockStatus = (typeof MISSILE_LOCK_STATUS)[keyof typeof MISSILE_LOCK_STATUS];

export interface WeaponLaunchOffset {
  right?: number;
  up?: number;
  forward?: number;
}

export interface WeaponState {
  id: string;
  lastFireTime: number;
  ammo: number;
  maxAmmo: number;
  fireRate: number;
  speed?: number;
  launchOffset?: WeaponLaunchOffset;
}

/** Shooter orientation frame — Vector3 axes (BasisFrame fits structurally). */
export interface WeaponBodyFrame {
  right: Vector3;
  up: Vector3;
  forward: Vector3;
}

export interface WeaponTarget {
  position: VecLike;
  destroyed?: boolean;
}

export type WeaponFireDecision =
  | {
      type: typeof WEAPON_DECISIONS.FIRE_GUN;
      weapon: WeaponState;
      overheated: boolean;
      position: Vector3;
      direction: Vector3;
      speed: number | undefined;
    }
  | {
      type: typeof WEAPON_DECISIONS.FIRE_MISSILE;
      weapon: WeaponState;
      target: WeaponTarget | null;
      position: Vector3;
      direction: Vector3;
      speed: number | undefined;
    }
  | { type: typeof WEAPON_DECISIONS.BLOCKED; message: string; weapon?: WeaponState; weaponId?: string }
  | { type: typeof WEAPON_DECISIONS.EMPTY_WARNING; weaponId: string };

export interface ProjectileWeaponSystemOptions {
  lockRequiredSeconds?: number;
  gunHeatPerShot?: number;
  gunCoolRatePerSecond?: number;
  gunOverheatThreshold?: number;
  gunRecoveredThreshold?: number;
  emptyWarningCooldownSeconds?: number;
  aimMode?: WeaponAimMode;
  targetAimDotMin?: number;
  targetMaxDistance?: number;
  clock?: Clock;
}

function calculateDist(sourcePosition: VecLike, targetPosition: VecLike): number {
  return Math.hypot(
    (targetPosition.x ?? 0) - (sourcePosition.x ?? 0),
    (targetPosition.y ?? 0) - (sourcePosition.y ?? 0),
    (targetPosition.z ?? 0) - (sourcePosition.z ?? 0),
  );
}

function calculateDotProduct(sourcePosition: VecLike, targetPosition: VecLike, aimDirection: Vector3): number {
  const dX = (targetPosition.x ?? 0) - (sourcePosition.x ?? 0);
  const dY = (targetPosition.y ?? 0) - (sourcePosition.y ?? 0);
  const dZ = (targetPosition.z ?? 0) - (sourcePosition.z ?? 0);
  const len = Math.hypot(dX, dY, dZ);
  if (len <= 1e-6) return 0;

  return aimDirection.x * (dX / len) + aimDirection.y * (dY / len) + aimDirection.z * (dZ / len);
}

export class ProjectileWeaponSystem {
  clock: Clock;
  aimMode: WeaponAimMode;
  cfg: {
    lockRequiredSeconds: number;
    gunHeatPerShot: number;
    gunCoolRatePerSecond: number;
    gunOverheatThreshold: number;
    gunRecoveredThreshold: number;
    emptyWarningCooldownSeconds: number;
    targetAimDotMin: number;
    targetMaxDistance: number;
  };
  weapons: Map<string, WeaponState>;
  weaponIds: string[];
  selectedWeaponId: string;
  target: WeaponTarget | null;
  isGunOverheated: boolean;
  gunHeat: number;
  lockTime: number;
  lockStatus: MissileLockStatus;
  lockingTarget: WeaponTarget | null;
  emptyWarningTimers: Record<string, number>;
  lastEmptyWarningAtSeconds: number;

  constructor({
    lockRequiredSeconds = 1.0,
    gunHeatPerShot = 0.02,
    gunCoolRatePerSecond = 0.2,
    gunOverheatThreshold = 1.0,
    gunRecoveredThreshold = 0.3,
    emptyWarningCooldownSeconds = 2.0,
    aimMode = WEAPON_AIM_MODES.CROSSHAIR,
    targetAimDotMin = 0.94,
    targetMaxDistance = 10000,
    clock = DEFAULT_CLOCK,
  }: ProjectileWeaponSystemOptions) {
    this.clock = clock;
    this.aimMode = aimMode;
    this.cfg = {
      lockRequiredSeconds,
      gunHeatPerShot,
      gunCoolRatePerSecond,
      gunOverheatThreshold,
      gunRecoveredThreshold,
      emptyWarningCooldownSeconds,
      targetAimDotMin,
      targetMaxDistance,
    };

    this.weapons = new Map();
    this.weapons.set(WEAPON_TYPES.GUN, {
      id: WEAPON_TYPES.GUN,
      lastFireTime: -Infinity,
      ammo: Infinity,
      maxAmmo: Infinity,
      fireRate: 0.05,
    });
    this.weapons.set(WEAPON_TYPES.MISSILE, {
      id: WEAPON_TYPES.MISSILE,
      lastFireTime: -Infinity,
      ammo: 50,
      maxAmmo: 50,
      fireRate: 1.0,
    });
    this.weaponIds = [WEAPON_TYPES.GUN, WEAPON_TYPES.MISSILE];

    this.selectedWeaponId = WEAPON_TYPES.GUN;
    this.target = null;
    this.isGunOverheated = false;
    this.gunHeat = 0;
    this.lockTime = 0;
    this.lockStatus = MISSILE_LOCK_STATUS.NONE;
    this.lockingTarget = null;
    this.emptyWarningTimers = {
      [WEAPON_TYPES.GUN]: 0,
      [WEAPON_TYPES.MISSILE]: 0,
    };
    this.lastEmptyWarningAtSeconds = 0;
  }

  updateWeaponConfig(
    weaponId: string,
    {
      ammo,
      maxAmmo,
      fireRate,
      speed,
      launchOffset,
    }: { ammo: number; maxAmmo: number; fireRate: number; speed?: number; launchOffset?: WeaponLaunchOffset },
  ): void {
    const weapon = this.weapons.get(weaponId)!;
    weapon.ammo = ammo;
    weapon.maxAmmo = maxAmmo;
    weapon.fireRate = fireRate;
    weapon.speed = speed;
    weapon.launchOffset = launchOffset;
  }

  resetAmmo(): void {
    for (const weaponId of this.weaponIds) {
      const weapon = this.weapons.get(weaponId)!;
      weapon.ammo = weapon.maxAmmo;
      weapon.lastFireTime = -Infinity;
    }
    this.selectedWeaponId = WEAPON_TYPES.GUN;
    this.target = null;
    this.isGunOverheated = false;
    this.gunHeat = 0;
    this.lockTime = 0;
    this.lockStatus = MISSILE_LOCK_STATUS.NONE;
    this.lockingTarget = null;
    this.emptyWarningTimers = {
      [WEAPON_TYPES.GUN]: 0,
      [WEAPON_TYPES.MISSILE]: 0,
    };
    this.lastEmptyWarningAtSeconds = 0;
  }

  getCurrentWeapon(): WeaponState {
    return this.weapons.get(this.selectedWeaponId)!;
  }

  getLaunchPosition(
    shooterPosition: VecLike,
    shooterBodyFrame: WeaponBodyFrame,
    weaponId: string | null = null,
  ): Vector3 | VecLike {
    const weapon = weaponId ? this.weapons.get(weaponId) : this.getCurrentWeapon();
    if (!weapon) return shooterPosition;
    const shooterOrigin = toVec3(shooterPosition);
    const offset = weapon.launchOffset ?? {};
    return shooterBodyFrame.right
      .clone()
      .multiplyScalar(offset.right ?? 0)
      .addScaledVector(shooterBodyFrame.up, offset.up ?? 0)
      .addScaledVector(shooterBodyFrame.forward, offset.forward ?? 0)
      .add(shooterOrigin);
  }

  toggleWeapon(): void {
    const currentIndex = Math.max(0, this.weaponIds.indexOf(this.selectedWeaponId));
    const nextIndex = (currentIndex + 1) % this.weaponIds.length;
    this.selectedWeaponId = this.weaponIds[nextIndex];
  }

  selectWeapon(weaponId: string): null | undefined {
    if (!this.weapons.has(weaponId)) return null;
    this.selectedWeaponId = weaponId;
    return undefined;
  }

  // In crosshair mode, aimPosition is the world-space point the launched shot
  // should travel toward from its launch position; it can come from
  // AimResolver's getAimFromCamera(...).hitPosition or getAimFromAimRay(...).
  requestFire({
    shooterPosition,
    shooterBodyFrame,
    aimPosition = null,
    weaponId = null,
  }: {
    shooterPosition: VecLike;
    shooterBodyFrame: WeaponBodyFrame;
    aimPosition?: VecLike | null;
    weaponId?: string | null;
  }): WeaponFireDecision | null {
    const weapon = weaponId ? this.weapons.get(weaponId) : this.getCurrentWeapon();
    if (!weapon) return null;

    if (this.aimMode === WEAPON_AIM_MODES.CROSSHAIR && !aimPosition) {
      throw new TypeError("ProjectileWeaponSystem: crosshair fire requires aimPosition");
    }

    const now = this.clock.nowSeconds();
    if (weapon.ammo <= 0) return this._emptyWarning(weapon.id, now);
    if (weapon.id === WEAPON_TYPES.GUN && this.isGunOverheated) {
      return { type: WEAPON_DECISIONS.BLOCKED, message: "Weapon overheated", weapon };
    }
    if (now - weapon.lastFireTime < weapon.fireRate) {
      return { type: WEAPON_DECISIONS.BLOCKED, message: "Weapon cooldown", weapon };
    }
    if (weapon.id === WEAPON_TYPES.MISSILE && this.lockStatus !== MISSILE_LOCK_STATUS.LOCKED) {
      return { type: WEAPON_DECISIONS.BLOCKED, message: "Missile needs lock", weapon };
    }

    const motionState = this._computeLaunchMotionState(weapon, shooterPosition, shooterBodyFrame, aimPosition);

    weapon.lastFireTime = now;
    if (weapon.ammo !== Infinity) weapon.ammo -= 1;

    if (weapon.id === WEAPON_TYPES.GUN) {
      this.gunHeat += this.cfg.gunHeatPerShot;
      const overheated = this.gunHeat >= this.cfg.gunOverheatThreshold;
      if (overheated) this.isGunOverheated = true;
      return {
        type: WEAPON_DECISIONS.FIRE_GUN,
        weapon,
        overheated,
        ...motionState,
      };
    }

    if (weapon.id === WEAPON_TYPES.MISSILE) {
      return {
        type: WEAPON_DECISIONS.FIRE_MISSILE,
        weapon,
        target: this.target,
        ...motionState,
      };
    }

    return { type: WEAPON_DECISIONS.BLOCKED, message: "Unsupported weapon", weapon };
  }

  // In crosshair mode, aimDirection is the world-space direction the shooter
  // is currently aiming; it can come from AimResolver's getAimDirection().
  step({
    shooterPosition,
    shooterBodyFrame,
    aimDirection = null,
    targets = [],
    deltaSeconds = 1 / 60,
  }: {
    shooterPosition: VecLike;
    shooterBodyFrame: WeaponBodyFrame;
    aimDirection?: VecLike | null;
    targets?: WeaponTarget[];
    deltaSeconds?: number;
  }): void {
    const currentWeapon = this.getCurrentWeapon();

    if (currentWeapon.id === WEAPON_TYPES.MISSILE) {
      this._stepMissileLock({
        shooterPosition,
        shooterBodyFrame,
        aimDirection,
        targets,
        deltaSeconds,
      });
    } else {
      this.lockingTarget = null;
      this.lockTime = 0;
      this.lockStatus = MISSILE_LOCK_STATUS.NONE;
      this.target = null;
    }

    this._stepGunHeat(deltaSeconds);
    this._stepEmptyWarningCooldowns(deltaSeconds);
  }

  findPotentialTarget({
    shooterPosition,
    shooterBodyFrame,
    aimDirection = null,
    targets = [],
  }: {
    shooterPosition: VecLike;
    shooterBodyFrame: WeaponBodyFrame;
    aimDirection?: VecLike | null;
    targets?: WeaponTarget[];
  }): WeaponTarget | null {
    const position = toVec3(shooterPosition);
    let resolvedAimDirection: Vector3;
    if (this.aimMode === WEAPON_AIM_MODES.BORESIGHT) {
      resolvedAimDirection = shooterBodyFrame.forward.clone();
    } else {
      resolvedAimDirection = toVec3(aimDirection);
    }
    resolvedAimDirection.normalize();

    let bestTarget: WeaponTarget | null = null;
    let maxDot = this.cfg.targetAimDotMin;

    for (const target of targets) {
      if (target.destroyed) continue;

      const dot = calculateDotProduct(position, target.position, resolvedAimDirection);
      if (dot <= maxDot) continue;

      const dist = calculateDist(position, target.position);
      if (dist >= this.cfg.targetMaxDistance) continue;

      bestTarget = target;
      maxDot = dot;
    }

    return bestTarget;
  }

  private _stepMissileLock({
    shooterPosition,
    shooterBodyFrame,
    aimDirection,
    targets,
    deltaSeconds,
  }: {
    shooterPosition: VecLike;
    shooterBodyFrame: WeaponBodyFrame;
    aimDirection: VecLike | null;
    targets: WeaponTarget[];
    deltaSeconds: number;
  }): void {
    const potentialTarget = this.findPotentialTarget({
      shooterPosition,
      shooterBodyFrame,
      aimDirection,
      targets,
    });

    if (!potentialTarget) {
      this.lockingTarget = null;
      this.lockTime = 0;
      this.lockStatus = MISSILE_LOCK_STATUS.NONE;
      this.target = null;
      return;
    }

    if (this.lockingTarget !== potentialTarget) {
      this.lockingTarget = potentialTarget;
      this.lockTime = 0;
      this.lockStatus = MISSILE_LOCK_STATUS.LOCKING;
      this.target = null;
      return;
    }

    this.lockTime += deltaSeconds;
    if (this.lockTime >= this.cfg.lockRequiredSeconds) {
      this.lockStatus = MISSILE_LOCK_STATUS.LOCKED;
      this.target = potentialTarget;
      return;
    }

    this.lockStatus = MISSILE_LOCK_STATUS.LOCKING;
  }

  private _computeLaunchMotionState(
    weapon: WeaponState,
    shooterPosition: VecLike,
    shooterBodyFrame: WeaponBodyFrame,
    aimPosition: VecLike | null = null,
  ): { position: Vector3; direction: Vector3; speed: number | undefined } {
    const position = this.getLaunchPosition(shooterPosition, shooterBodyFrame, weapon.id) as Vector3;
    let direction: Vector3;
    if (this.aimMode === WEAPON_AIM_MODES.BORESIGHT) {
      direction = shooterBodyFrame.forward.clone();
    } else {
      direction = toVec3(aimPosition).sub(position);
    }
    if (direction.lengthSq() <= 1e-12) {
      throw new TypeError("ProjectileWeaponSystem: fire direction must be non-zero");
    }
    direction.normalize();

    return {
      position: position,
      direction,
      speed: weapon.speed,
    };
  }

  private _stepGunHeat(deltaSeconds: number): void {
    if (this.gunHeat <= 0) return;

    this.gunHeat -= deltaSeconds * this.cfg.gunCoolRatePerSecond;
    if (this.gunHeat <= 0) {
      this.gunHeat = 0;
      this.isGunOverheated = false;
    }
    if (this.isGunOverheated && this.gunHeat < this.cfg.gunRecoveredThreshold) {
      this.isGunOverheated = false;
    }
  }

  private _stepEmptyWarningCooldowns(deltaSeconds: number): void {
    for (const key in this.emptyWarningTimers) {
      if (this.emptyWarningTimers[key] <= 0) continue;
      this.emptyWarningTimers[key] -= deltaSeconds;
      if (this.emptyWarningTimers[key] < 0) this.emptyWarningTimers[key] = 0;
    }
  }

  private _emptyWarning(weaponId: string, now: number): WeaponFireDecision {
    if (now - this.lastEmptyWarningAtSeconds <= this.cfg.emptyWarningCooldownSeconds) {
      return { type: WEAPON_DECISIONS.BLOCKED, message: "Weapon empty", weaponId };
    }

    this.emptyWarningTimers[weaponId] = 1.0;
    this.lastEmptyWarningAtSeconds = now;
    return { type: WEAPON_DECISIONS.EMPTY_WARNING, weaponId };
  }
}
