// playset/modules/gameplay/combat/projectile-manager.ts — owns the live
// projectile list: spawn bookkeeping, per-step advancement, hit-event
// collection, removal and disposal of spent projectiles.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/gameplay/combat/ProjectileManager.js. One deliberate
// deviation: the original constructed `new ProjectileObject(...)` from
// world/object/ProjectileObject.js; playset gameplay modules stay decoupled
// from world/object, so the constructor takes a required `createProjectile`
// factory and entries are typed structurally (active flag, step, optional
// dispose). Spawn options and defaults, the reverse-iteration step loop,
// hit-event shape, and clear/dispose semantics are otherwise verbatim.

import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../../math/world-basis.ts";

export interface ProjectileTargetLike {
  position: VecLike;
  destroyed?: boolean;
}

export interface ProjectileStepResult {
  position: VecLike;
  target: ProjectileTargetLike | null;
  hittedTarget: ProjectileTargetLike | null;
}

/** What the manager needs from a projectile (ProjectileObject fits). */
export interface ProjectileLike {
  active: boolean;
  step(targets: ProjectileTargetLike[], deltaSeconds: number): ProjectileStepResult;
  dispose?(): void;
}

export interface ProjectileVisualLike {
  group: unknown;
}

/** Resolved spawn options handed to the injected factory. */
export interface ProjectileSpawnConfig {
  visual: ProjectileVisualLike;
  position: VecLike;
  direction: VecLike;
  speed: number;
  target: ProjectileTargetLike | null;
  lifetimeSeconds: number;
  hitRadius: number;
  turnResponse: number;
  basis: WorldBasis;
}

export type ProjectileFactory = (config: ProjectileSpawnConfig) => ProjectileLike;

export interface SpawnProjectileOptions {
  visual: ProjectileVisualLike;
  metadata?: unknown;
  position: VecLike;
  direction: VecLike;
  speed: number;
  target?: ProjectileTargetLike | null;
  lifetimeSeconds: number;
  hitRadius: number;
  turnResponse?: number;
  basis?: WorldBasis;
}

export interface ProjectileHitEvent {
  projectile: ProjectileLike;
  position: VecLike;
  target: ProjectileTargetLike | null;
  hittedTarget: ProjectileTargetLike;
  metadata: unknown;
}

export interface ProjectileManagerOptions {
  basis?: WorldBasis;
  createProjectile: ProjectileFactory;
}

export class ProjectileManager {
  basis: WorldBasis;
  createProjectile: ProjectileFactory;
  projectiles: ProjectileLike[];
  projectileMetadata: Map<ProjectileLike, unknown>;

  constructor({ basis = DEFAULT_WORLD_BASIS, createProjectile }: ProjectileManagerOptions) {
    this.basis = basis;
    this.createProjectile = createProjectile;
    this.projectiles = [];
    this.projectileMetadata = new Map();
  }

  spawnProjectile({
    visual,
    metadata = null,
    position,
    direction,
    speed,
    target = null,
    lifetimeSeconds,
    hitRadius,
    turnResponse = 0,
    basis = this.basis,
  }: SpawnProjectileOptions): ProjectileLike {
    if (!visual?.group) {
      throw new Error("ProjectileManager: projectile visual with group is required");
    }

    const projectile = this.createProjectile({
      visual,
      position,
      direction,
      speed,
      target,
      lifetimeSeconds,
      hitRadius,
      turnResponse,
      basis,
    });

    this.projectiles.push(projectile);
    if (metadata !== null) this.projectileMetadata.set(projectile, metadata);
    return projectile;
  }

  step(targets: ProjectileTargetLike[] = [], deltaSeconds = 1 / 60): ProjectileHitEvent[] {
    const hitEvents: ProjectileHitEvent[] = [];

    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const projectile = this.projectiles[i];
      const result = projectile.step(targets, deltaSeconds);

      const hittedTarget = result.hittedTarget;
      if (hittedTarget) {
        hitEvents.push({
          projectile,
          position: result.position,
          target: result.target,
          hittedTarget,
          metadata: this.projectileMetadata.get(projectile) ?? null,
        });
      }

      if (!projectile.active) {
        projectile.dispose?.();
        this.projectileMetadata.delete(projectile);
        this.projectiles.splice(i, 1);
      }
    }

    return hitEvents;
  }

  clear(): void {
    for (const projectile of this.projectiles) projectile.dispose?.();
    this.projectiles.length = 0;
    this.projectileMetadata.clear();
  }

  dispose(): void {
    this.clear();
  }
}
