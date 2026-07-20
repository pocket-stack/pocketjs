// playset/modules/physics/collision-world.ts — the deterministic collision
// core. Playset-native (no GameBlocks counterpart): it replaces the injected
// Rapier `world` in the ported environments and batch resolvers.
//
// Scope is deliberately v1 (what the GameBlocks demo class actually needs):
// static cuboid / y-cylinder / ball colliders, a terrain heightfield sampler
// as the ground authority, planar capsule push-out with wall sliding and
// ground snapping, and raycasts for aiming. Dynamic rigid bodies, wedge
// trimeshes and stacked-shape climbing are the native Rust block follow-up;
// resolution here is planar (walls block, walkable tops carry you), which
// covers arenas, tracks and natural terrain worlds faithfully.
//
// Everything is deterministic: colliders resolve in insertion order, all
// math is plain f64, no wall clock, no Math.random.

import { Vector3 } from "../../math/vector3.ts";
import { Quaternion } from "../../math/quaternion.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis, type VecLike } from "../math/world-basis.ts";
import { clamp } from "../math/scalar-utils.ts";

/** Anything with a heightAt — every terrain sampler qualifies. */
export interface TerrainLike {
  heightAt(right: number, forward: number): number;
}

export interface ColliderCommon {
  /** Walls block planar motion; non-solid shapes only answer raycasts. */
  solid?: boolean;
  /** Walkable shapes contribute their top face to groundHeightAt. */
  walkable?: boolean;
  /** Opaque owner tag returned by queries (entity lookup). */
  tag?: unknown;
}

export interface CuboidDesc extends ColliderCommon {
  position: VecLike;
  /** Yaw-only orientation is the common case; full quaternions accepted. */
  quaternion?: { x: number; y: number; z: number; w: number };
  halfExtents: VecLike;
}

export interface CylinderDesc extends ColliderCommon {
  position: VecLike;
  halfHeight: number;
  radius: number;
}

export interface BallDesc extends ColliderCommon {
  position: VecLike;
  radius: number;
}

export type ColliderHandle = number;

export interface CapsuleOptions {
  radius: number;
  /** Capsule half height (feet at position - halfHeight along up). */
  halfHeight: number;
  /** Max ground-height rise the mover steps onto without being blocked. */
  climb?: number;
  /** Snap-down distance when airborne-but-near-ground (0 disables). */
  snap?: number;
}

export interface CapsuleResult {
  position: Vector3;
  grounded: boolean;
  /** True when a solid collider clipped the planar motion this resolve. */
  hitWall: boolean;
}

export interface RaycastHit {
  distance: number;
  point: Vector3;
  handle: ColliderHandle;
  tag: unknown;
}

interface Shape {
  handle: ColliderHandle;
  kind: "cuboid" | "cylinder" | "ball";
  solid: boolean;
  walkable: boolean;
  tag: unknown;
  // basis-space cache (right/up/forward components)
  right: number;
  up: number;
  forward: number;
  // cuboid
  hRight: number;
  hUp: number;
  hForward: number;
  yaw: number; // planar rotation about up
  // cylinder/ball
  radius: number;
  halfHeight: number;
  /** Circumscribed planar radius (yaw-independent broadphase bound). */
  reach: number;
  /** Last gather() pass that visited this shape (O(1) dedupe, no allocs). */
  stamp: number;
}

const EPS = 1e-9;

// Broadphase: a uniform planar grid over (right, forward). Shapes register
// in every cell their circumscribed circle touches; queries gather the
// cells under the capsule/point plus the world's max shape reach, then
// sort by handle so resolution keeps the exact full-scan insertion order.
// Purely an iteration filter — results are identical to scanning all
// shapes, it just skips the ones that provably cannot interact.
const GRID_CELL = 8;
const GRID_OFF = 32768; // supports ±32k cells (±256k units) per axis
const byHandle = (a: Shape, b: Shape) => a.handle - b.handle;

function cellKey(cr: number, cf: number): number {
  return (cr + GRID_OFF) * 65536 + (cf + GRID_OFF);
}

export class CollisionWorld {
  readonly basis: WorldBasis;
  private terrain: TerrainLike | null = null;
  private shapes: Shape[] = [];
  private nextHandle = 1;
  private grid = new Map<number, Shape[]>();
  private maxReach = 0;
  private gatherStamp = 0;
  private candidates: Shape[] = []; // reused across gathers, never exposed

  constructor({ basis = DEFAULT_WORLD_BASIS }: { basis?: WorldBasis } = {}) {
    this.basis = basis;
  }

  setTerrain(sampler: TerrainLike | null): void {
    this.terrain = sampler;
  }

  addCuboid(desc: CuboidDesc): ColliderHandle {
    const s = this.baseShape("cuboid", desc);
    s.hRight = Math.abs(this.basis.rightComponent(desc.halfExtents));
    s.hUp = Math.abs(this.basis.upComponent(desc.halfExtents));
    s.hForward = Math.abs(this.basis.forwardComponent(desc.halfExtents));
    s.yaw = desc.quaternion ? quatToPlanarYaw(desc.quaternion, this.basis) : 0;
    s.reach = Math.sqrt(s.hRight * s.hRight + s.hForward * s.hForward);
    this.insert(s);
    return s.handle;
  }

  addCylinder(desc: CylinderDesc): ColliderHandle {
    const s = this.baseShape("cylinder", desc);
    s.radius = desc.radius;
    s.halfHeight = desc.halfHeight;
    s.reach = desc.radius;
    this.insert(s);
    return s.handle;
  }

  addBall(desc: BallDesc): ColliderHandle {
    const s = this.baseShape("ball", desc);
    s.radius = desc.radius;
    s.halfHeight = desc.radius;
    s.reach = desc.radius;
    this.insert(s);
    return s.handle;
  }

  remove(handle: ColliderHandle): void {
    const i = this.shapes.findIndex((s) => s.handle === handle);
    if (i < 0) return;
    const s = this.shapes[i];
    this.shapes.splice(i, 1);
    this.forEachCoveredCell(s, (key) => {
      const cell = this.grid.get(key);
      if (!cell) return;
      const j = cell.indexOf(s);
      if (j >= 0) cell.splice(j, 1);
    });
    // maxReach stays a (conservative) upper bound — correctness never
    // depends on it shrinking, only gather sizes do.
  }

  clear(): void {
    this.shapes.length = 0;
    this.grid.clear();
    this.maxReach = 0;
  }

  private insert(s: Shape): void {
    this.shapes.push(s);
    if (s.reach > this.maxReach) this.maxReach = s.reach;
    this.forEachCoveredCell(s, (key) => {
      let cell = this.grid.get(key);
      if (!cell) {
        cell = [];
        this.grid.set(key, cell);
      }
      cell.push(s);
    });
  }

  private forEachCoveredCell(s: Shape, fn: (key: number) => void): void {
    const c0r = Math.floor((s.right - s.reach) / GRID_CELL);
    const c1r = Math.floor((s.right + s.reach) / GRID_CELL);
    const c0f = Math.floor((s.forward - s.reach) / GRID_CELL);
    const c1f = Math.floor((s.forward + s.reach) / GRID_CELL);
    for (let cr = c0r; cr <= c1r; cr += 1) {
      for (let cf = c0f; cf <= c1f; cf += 1) fn(cellKey(cr, cf));
    }
  }

  /**
   * Shapes whose circumscribed circle could reach within `radius` of the
   * planar point, in insertion (handle) order. The returned array is a
   * reused scratch buffer — consume it before the next gather.
   */
  private gather(right: number, forward: number, radius: number): Shape[] {
    const out = this.candidates;
    out.length = 0;
    if (this.shapes.length === 0) return out;
    const reach = radius + this.maxReach;
    const c0r = Math.floor((right - reach) / GRID_CELL);
    const c1r = Math.floor((right + reach) / GRID_CELL);
    const c0f = Math.floor((forward - reach) / GRID_CELL);
    const c1f = Math.floor((forward + reach) / GRID_CELL);
    this.gatherStamp += 1;
    const stamp = this.gatherStamp;
    for (let cr = c0r; cr <= c1r; cr += 1) {
      for (let cf = c0f; cf <= c1f; cf += 1) {
        const cell = this.grid.get(cellKey(cr, cf));
        if (!cell) continue;
        for (const s of cell) {
          if (s.stamp === stamp) continue;
          s.stamp = stamp;
          out.push(s);
        }
      }
    }
    out.sort(byHandle);
    return out;
  }

  get colliderCount(): number {
    return this.shapes.length;
  }

  /** Ground authority: terrain height plus any walkable top underfoot. */
  groundHeightAt(right: number, forward: number): number {
    let h = this.terrain ? this.terrain.heightAt(right, forward) : 0;
    for (const s of this.gather(right, forward, EPS)) {
      if (!s.walkable) continue;
      if (!this.planarInside(s, right, forward, 0)) continue;
      const top = s.up + (s.kind === "cuboid" ? s.hUp : s.halfHeight);
      if (top > h) h = top;
    }
    return h;
  }

  /**
   * Move a capsule from `current` toward `desired`: solid shapes push the
   * planar motion out (slide, insertion order), then the mover grounds on
   * groundHeightAt with `climb` step-up and `snap` snap-down semantics.
   * `current` is not mutated; the result vector is freshly allocated.
   */
  resolveCapsule(current: Vector3, desired: Vector3, opts: CapsuleOptions): CapsuleResult {
    const { radius, halfHeight } = opts;
    const climb = opts.climb ?? 0.55;
    const snap = opts.snap ?? 0.3;
    const b = this.basis;

    let right = b.rightComponent(desired);
    let forward = b.forwardComponent(desired);
    let up = b.upComponent(desired);
    const feetOffset = halfHeight;
    let hitWall = false;

    // Planar push-out vs solids whose vertical span overlaps the capsule.
    // Gathered once up front around the desired position: the 2x margins
    // cover push-out chains relocating the capsule mid-loop. (The gather
    // scratch is free again by the time groundHeightAt below re-gathers.)
    for (const s of this.gather(right, forward, radius * 2 + this.maxReach + 1)) {
      if (!s.solid) continue;
      const feet = up - feetOffset;
      const head = up + feetOffset;
      const sBottom = s.up - (s.kind === "cuboid" ? s.hUp : s.halfHeight);
      const sTop = s.up + (s.kind === "cuboid" ? s.hUp : s.halfHeight);
      if (head <= sBottom + EPS || feet >= sTop - EPS) continue;
      // Walkable shapes we can step onto don't wall us when the rise fits.
      if (s.walkable && sTop - feet <= climb) continue;

      if (s.kind === "cuboid") {
        const pushed = pushOutOfBox(s, right, forward, radius);
        if (pushed) {
          right = pushed.right;
          forward = pushed.forward;
          hitWall = true;
        }
      } else {
        const dr = right - s.right;
        const df = forward - s.forward;
        const minDist = s.radius + radius;
        const distSq = dr * dr + df * df;
        if (distSq < minDist * minDist) {
          const dist = Math.sqrt(distSq);
          const nr = dist > EPS ? dr / dist : 1;
          const nf = dist > EPS ? df / dist : 0;
          right = s.right + nr * minDist;
          forward = s.forward + nf * minDist;
          hitWall = true;
        }
      }
    }

    // Ground pass.
    const ground = this.groundHeightAt(right, forward);
    const feet = up - feetOffset;
    let grounded = false;
    if (feet <= ground + EPS) {
      up = ground + feetOffset;
      grounded = true;
    } else if (snap > 0 && feet - ground <= snap) {
      up = ground + feetOffset;
      grounded = true;
    }

    const position = b.fromBasisComponents(right, up, forward);
    return { position, grounded, hitWall };
  }

  /**
   * Nearest hit along a ray (solid and non-solid shapes both report; terrain
   * is ray-marched at fixed 0.5-unit steps then bisected — deterministic).
   */
  raycast(origin: Vector3, direction: Vector3, maxDistance: number): RaycastHit | null {
    const b = this.basis;
    const o = { r: b.rightComponent(origin), u: b.upComponent(origin), f: b.forwardComponent(origin) };
    const dir = b.toBasisComponents(direction);
    const dLen = Math.sqrt(dir.right ** 2 + dir.up ** 2 + dir.forward ** 2);
    if (dLen <= EPS || !(maxDistance > 0)) return null;
    const d = { r: dir.right / dLen, u: dir.up / dLen, f: dir.forward / dLen };

    let best: { t: number; s: Shape | null } | null = null;

    for (const s of this.shapes) {
      const t =
        s.kind === "cuboid"
          ? rayVsBox(o, d, s, maxDistance)
          : s.kind === "ball"
            ? rayVsSphere(o, d, s.right, s.up, s.forward, s.radius, maxDistance)
            : rayVsCylinder(o, d, s, maxDistance);
      if (t !== null && (best === null || t < best.t)) best = { t, s };
    }

    // Terrain march.
    if (this.terrain) {
      const limit = best ? best.t : maxDistance;
      const t = rayVsTerrain(o, d, this.terrain, limit);
      if (t !== null && (best === null || t < best.t)) best = { t, s: null };
    }

    if (!best) return null;
    const point = b.fromBasisComponents(o.r + d.r * best.t, o.u + d.u * best.t, o.f + d.f * best.t);
    return {
      distance: best.t,
      point,
      handle: best.s ? best.s.handle : 0,
      tag: best.s ? best.s.tag : null,
    };
  }

  private baseShape(kind: Shape["kind"], desc: ColliderCommon & { position: VecLike }): Shape {
    return {
      handle: this.nextHandle++,
      kind,
      solid: desc.solid ?? true,
      walkable: desc.walkable ?? false,
      tag: desc.tag ?? null,
      right: this.basis.rightComponent(desc.position),
      up: this.basis.upComponent(desc.position),
      forward: this.basis.forwardComponent(desc.position),
      hRight: 0,
      hUp: 0,
      hForward: 0,
      yaw: 0,
      radius: 0,
      halfHeight: 0,
      reach: 0,
      stamp: 0,
    };
  }

  private planarInside(s: Shape, right: number, forward: number, inflate: number): boolean {
    if (s.kind === "cuboid") {
      const { lr, lf } = toBoxLocal(s, right, forward);
      return Math.abs(lr) <= s.hRight + inflate && Math.abs(lf) <= s.hForward + inflate;
    }
    const dr = right - s.right;
    const df = forward - s.forward;
    const rad = s.radius + inflate;
    return dr * dr + df * df <= rad * rad;
  }
}

// ---------------------------------------------------------------------------
// Shape math (planar, basis space)
// ---------------------------------------------------------------------------

function quatToPlanarYaw(
  q: { x: number; y: number; z: number; w: number },
  basis: WorldBasis,
): number {
  // Rotate the forward axis, read its planar heading. Yaw-only in v1: any
  // tilt component is dropped (environments only yaw their wall boxes).
  const f = basis.forwardVector();
  const v = new Vector3(f.x, f.y, f.z).applyQuaternion(
    new Quaternion(q.x, q.y, q.z, q.w),
  );
  return basis.forwardToYaw(v);
}

function toBoxLocal(s: Shape, right: number, forward: number): { lr: number; lf: number } {
  const dr = right - s.right;
  const df = forward - s.forward;
  const c = Math.cos(-s.yaw);
  const sn = Math.sin(-s.yaw);
  // planar rotation: +yaw turns forward toward -right (right-hand rule, up axis)
  return { lr: c * dr + sn * df, lf: -sn * dr + c * df };
}

function fromBoxLocal(s: Shape, lr: number, lf: number): { right: number; forward: number } {
  const c = Math.cos(s.yaw);
  const sn = Math.sin(s.yaw);
  return { right: s.right + c * lr + sn * lf, forward: s.forward + -sn * lr + c * lf };
}

function pushOutOfBox(
  s: Shape,
  right: number,
  forward: number,
  radius: number,
): { right: number; forward: number } | null {
  const { lr, lf } = toBoxLocal(s, right, forward);
  // Closest point on the box in local planar space.
  const cr = clamp(lr, -s.hRight, s.hRight);
  const cf = clamp(lf, -s.hForward, s.hForward);
  const dr = lr - cr;
  const df = lf - cf;
  const distSq = dr * dr + df * df;
  if (distSq >= radius * radius) return null;
  let outLr: number;
  let outLf: number;
  if (distSq > EPS * EPS) {
    // Outside the box face: push along the separation direction.
    const dist = Math.sqrt(distSq);
    outLr = cr + (dr / dist) * radius;
    outLf = cf + (df / dist) * radius;
  } else {
    // Center inside the box: exit through the nearest face.
    const exitR = s.hRight + radius - Math.abs(lr);
    const exitF = s.hForward + radius - Math.abs(lf);
    if (exitR <= exitF) {
      outLr = (lr >= 0 ? 1 : -1) * (s.hRight + radius);
      outLf = lf;
    } else {
      outLr = lr;
      outLf = (lf >= 0 ? 1 : -1) * (s.hForward + radius);
    }
  }
  return fromBoxLocal(s, outLr, outLf);
}

interface BasisPoint {
  r: number;
  u: number;
  f: number;
}

function rayVsSphere(
  o: BasisPoint,
  d: BasisPoint,
  cr: number,
  cu: number,
  cf: number,
  radius: number,
  maxT: number,
): number | null {
  const or = o.r - cr;
  const ou = o.u - cu;
  const of_ = o.f - cf;
  const b = or * d.r + ou * d.u + of_ * d.f;
  const c = or * or + ou * ou + of_ * of_ - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= maxT ? t : null;
}

function rayVsCylinder(o: BasisPoint, d: BasisPoint, s: Shape, maxT: number): number | null {
  // Infinite y-cylinder intersection clipped to the shape's vertical span.
  const or = o.r - s.right;
  const of_ = o.f - s.forward;
  const a = d.r * d.r + d.f * d.f;
  let tSide: number | null = null;
  if (a > EPS) {
    const b = or * d.r + of_ * d.f;
    const c = or * or + of_ * of_ - s.radius * s.radius;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      if (t >= 0 && t <= maxT) {
        const u = o.u + d.u * t;
        if (Math.abs(u - s.up) <= s.halfHeight) tSide = t;
      }
    }
  }
  // Caps.
  let tCap: number | null = null;
  if (Math.abs(d.u) > EPS) {
    for (const capU of [s.up + s.halfHeight, s.up - s.halfHeight]) {
      const t = (capU - o.u) / d.u;
      if (t < 0 || t > maxT) continue;
      const rr = o.r + d.r * t - s.right;
      const ff = o.f + d.f * t - s.forward;
      if (rr * rr + ff * ff <= s.radius * s.radius) {
        if (tCap === null || t < tCap) tCap = t;
      }
    }
  }
  if (tSide === null) return tCap;
  if (tCap === null) return tSide;
  return Math.min(tSide, tCap);
}

function rayVsBox(o: BasisPoint, d: BasisPoint, s: Shape, maxT: number): number | null {
  // Rotate the ray into box-local planar space (up axis unchanged), then slab.
  const c = Math.cos(-s.yaw);
  const sn = Math.sin(-s.yaw);
  const olr = c * (o.r - s.right) + sn * (o.f - s.forward);
  const olf = -sn * (o.r - s.right) + c * (o.f - s.forward);
  const dlr = c * d.r + sn * d.f;
  const dlf = -sn * d.r + c * d.f;
  const ou = o.u - s.up;

  let tMin = 0;
  let tMax = maxT;
  for (const [oc, dc, h] of [
    [olr, dlr, s.hRight],
    [ou, d.u, s.hUp],
    [olf, dlf, s.hForward],
  ] as const) {
    if (Math.abs(dc) < EPS) {
      if (Math.abs(oc) > h) return null;
      continue;
    }
    let t1 = (-h - oc) / dc;
    let t2 = (h - oc) / dc;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}

function rayVsTerrain(o: BasisPoint, d: BasisPoint, terrain: TerrainLike, maxT: number): number | null {
  const STEP = 0.5;
  let prevT = 0;
  let prevAbove = o.u - terrain.heightAt(o.r, o.f);
  if (prevAbove <= 0) return 0;
  for (let t = STEP; t <= maxT + EPS; t += STEP) {
    const tt = Math.min(t, maxT);
    const above = o.u + d.u * tt - terrain.heightAt(o.r + d.r * tt, o.f + d.f * tt);
    if (above <= 0) {
      // Bisect the crossing for a stable hit point.
      let lo = prevT;
      let hi = tt;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        const a = o.u + d.u * mid - terrain.heightAt(o.r + d.r * mid, o.f + d.f * mid);
        if (a > 0) lo = mid;
        else hi = mid;
      }
      return hi;
    }
    prevT = tt;
    prevAbove = above;
    if (tt >= maxT) break;
  }
  return null;
}
