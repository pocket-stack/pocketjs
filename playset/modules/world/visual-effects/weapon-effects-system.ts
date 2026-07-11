// playset/modules/world/visual-effects/weapon-effects-system.ts — pooled
// weapon feedback: additive tracer beams + hit-burst particle sprites.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/visual-effects/WeaponEffectsSystem.js. The
// per-slot CPU sim (round-robin allocation, age/ttl, 3 u/s² gravity,
// (1-t) color fade, activeParticles compaction) is verbatim. Deliberate
// changes for the scene3d surface:
//   - LineSegments → BeamPool (capacity maxTracers; TRACER_WIDTH world
//     units stands in for the 1px line), Points → SpritePool (capacity
//     maxParticles, size 0.05). The vertex-color fade becomes per-entry
//     pool colors: fade scales the RGB bytes, the material opacity 0.9
//     rides in each entry's alpha byte.
//   - pools are replace-per-frame: every live set is rebuilt after each
//     spawn/step/clear; scene.flush() (owner's job) ships them.
//   - spawnTracer/emitHitBurst return the pool objects (`.tracerLines` /
//     `.particlePoints` keep their names). `.group` remains as a bare node
//     for API parity; pools are freed with the scene.
//   - constructor options gain `scene: Scene3D`, plus `tracerWidth` /
//     `particleSize` (world units). The original's LineSegments were 1px
//     screen-space and PointsMaterial size was fixed at 0.05 — as world-space
//     quads those constants only suit character-scale worlds, so large-scale
//     games (flight sims) must widen them. Defaults keep the old constants.

import { Vector3 } from "../../../math/vector3.ts";
import type { BeamPool, Scene3D, SceneNode, SpritePool } from "../../../scene3d/client.ts";
import { BEAM_STRIDE, SPRITE_STRIDE } from "../../../scene3d/ops.ts";
import { DEFAULT_PRNG } from "../../math/random-utils.ts";
import { toVec3 } from "../../math/vector3-utils.ts";
import { rgbFloatsToAbgr, rgbToAbgr } from "../color-utils.ts";
import { disposeSceneNode } from "../scene-node-utils.ts";
import type { VecLike } from "../../math/world-basis.ts";

/** World-space stand-in for the original 1px additive line (default). */
const TRACER_WIDTH = 0.05;
/** PointsMaterial size 0.05 (default). */
const PARTICLE_SIZE = 0.05;
/** LineBasicMaterial/PointsMaterial opacity. */
const POOL_OPACITY = 0.9;

interface TracerSlot {
  active: boolean;
  ageSeconds: number;
  ttlSeconds: number;
  /** Base color components, 0..1 (the original's THREE.Color slot). */
  r: number;
  g: number;
  b: number;
  fade: number;
}

export interface WeaponEffectsSystemOptions {
  scene: Scene3D;
  maxEffects?: number;
  prng?: { random(): number };
  /** Tracer beam width in world units (default 0.05 — character scale). */
  tracerWidth?: number;
  /** Burst particle sprite size in world units (default 0.05). */
  particleSize?: number;
}

export class WeaponEffectsSystem {
  readonly group: SceneNode;
  readonly maxEffects: number;
  readonly maxTracers: number;
  readonly maxParticles: number;
  readonly prng: { random(): number };
  readonly tracerWidth: number;
  readonly particleSize: number;
  readonly flashes: unknown[] = [];
  readonly effects: unknown[] = [];

  readonly tracerLines: BeamPool;
  readonly particlePoints: SpritePool;

  private readonly tracerPositions: Float32Array;
  private readonly tracers: TracerSlot[] = [];
  private nextTracer = 0;

  private readonly particlePositions: Float32Array;
  private readonly particleVelocities: Float32Array;
  private readonly particleBaseColors: Float32Array;
  private readonly particleFades: Float32Array;
  private readonly particleAges: Float32Array;
  private readonly particleTtls: Float32Array;
  private readonly particleActive: Uint8Array;
  private readonly activeParticles: number[] = [];
  private nextParticle = 0;

  private readonly _tmpOrigin = new Vector3();
  private readonly _tmpForward = new Vector3();

  constructor({
    scene,
    maxEffects = 16,
    prng = DEFAULT_PRNG,
    tracerWidth = TRACER_WIDTH,
    particleSize = PARTICLE_SIZE,
  }: WeaponEffectsSystemOptions) {
    this.group = scene.node();
    this.maxEffects = Math.max(8, Math.floor(maxEffects));
    this.maxTracers = this.maxEffects;
    this.maxParticles = Math.max(128, this.maxEffects * 8);
    this.prng = prng;
    this.tracerWidth = tracerWidth;
    this.particleSize = particleSize;

    const poolMat = scene.additiveMaterial(rgbToAbgr(0xffffff));
    this.tracerLines = scene.beamPool(this.maxTracers, poolMat);
    this.particlePoints = scene.spritePool(this.maxParticles, poolMat);

    this.tracerPositions = new Float32Array(this.maxTracers * 6);
    for (let i = 0; i < this.maxTracers; i += 1) {
      this.tracers.push({ active: false, ageSeconds: 0, ttlSeconds: 0, r: 0, g: 0, b: 0, fade: 0 });
    }

    this.particlePositions = new Float32Array(this.maxParticles * 3);
    this.particleVelocities = new Float32Array(this.maxParticles * 3);
    this.particleBaseColors = new Float32Array(this.maxParticles * 3);
    this.particleFades = new Float32Array(this.maxParticles);
    this.particleAges = new Float32Array(this.maxParticles);
    this.particleTtls = new Float32Array(this.maxParticles);
    this.particleActive = new Uint8Array(this.maxParticles);
  }

  spawnTracer(
    from: VecLike | null | undefined,
    to: VecLike | null | undefined,
    color = 0xffe7ad,
    ttlSeconds = 0.08,
  ): BeamPool | null {
    if (!from || !to) return null;

    const index = this.nextTracer;
    this.nextTracer = (this.nextTracer + 1) % this.maxTracers;

    const a = toVec3(from);
    const b = toVec3(to);
    const offset = index * 6;
    this.tracerPositions[offset] = a.x;
    this.tracerPositions[offset + 1] = a.y;
    this.tracerPositions[offset + 2] = a.z;
    this.tracerPositions[offset + 3] = b.x;
    this.tracerPositions[offset + 4] = b.y;
    this.tracerPositions[offset + 5] = b.z;

    const tracer = this.tracers[index];
    tracer.r = ((color >> 16) & 255) / 255;
    tracer.g = ((color >> 8) & 255) / 255;
    tracer.b = (color & 255) / 255;
    tracer.active = true;
    tracer.ageSeconds = 0;
    tracer.ttlSeconds = Math.max(0.001, ttlSeconds);
    tracer.fade = 1;

    this._rebuildTracers();
    return this.tracerLines;
  }

  emitHitBurst(
    position: VecLike | null | undefined,
    direction: VecLike = new Vector3(0, 1, 0),
    color = 0xff5533,
    count = 10,
    speed = 1.5,
    spread = 0.8,
    lifetimeMs = 300,
  ): SpritePool | null {
    if (!position) return null;

    const particleCount = Math.max(0, Math.floor(count));
    const ttlSeconds = Math.max(0.02, lifetimeMs / 1000);
    this._tmpOrigin.copy(toVec3(position));
    this._tmpForward.copy(toVec3(direction));
    if (this._tmpForward.lengthSq() <= 1e-6) this._tmpForward.set(0, 1, 0);
    this._tmpForward.normalize();
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;

    for (let i = 0; i < particleCount; i += 1) {
      const index = this.nextParticle;
      const offset = index * 3;
      this.nextParticle = (this.nextParticle + 1) % this.maxParticles;

      const vx = ((this.prng.random() - 0.5) * spread + this._tmpForward.x) * speed;
      const vy = ((this.prng.random() - 0.5) * spread + this._tmpForward.y) * speed;
      const vz = ((this.prng.random() - 0.5) * spread + this._tmpForward.z) * speed;

      this.particlePositions[offset] = this._tmpOrigin.x;
      this.particlePositions[offset + 1] = this._tmpOrigin.y;
      this.particlePositions[offset + 2] = this._tmpOrigin.z;
      this.particleVelocities[offset] = vx;
      this.particleVelocities[offset + 1] = vy;
      this.particleVelocities[offset + 2] = vz;
      this.particleBaseColors[offset] = r;
      this.particleBaseColors[offset + 1] = g;
      this.particleBaseColors[offset + 2] = b;
      this.particleFades[index] = 1;
      this.particleAges[index] = 0;
      this.particleTtls[index] = ttlSeconds;
      if (!this.particleActive[index]) {
        this.activeParticles.push(index);
      }
      this.particleActive[index] = 1;
    }

    this._rebuildParticles();
    return this.particlePoints;
  }

  step(deltaSeconds = 1 / 60): void {
    let tracersChanged = false;
    let particlesChanged = false;

    for (let i = 0; i < this.tracers.length; i += 1) {
      const tracer = this.tracers[i];
      if (!tracer.active) continue;

      tracer.ageSeconds += deltaSeconds;
      const t = Math.min(1, tracer.ageSeconds / tracer.ttlSeconds);
      tracer.fade = 1 - t;
      tracersChanged = true;

      if (tracer.ageSeconds >= tracer.ttlSeconds) {
        tracer.active = false;
        tracer.ageSeconds = 0;
        tracer.ttlSeconds = 0;
        tracer.fade = 0;
      }
    }

    let writeParticle = 0;
    for (let i = 0; i < this.activeParticles.length; i += 1) {
      const index = this.activeParticles[i];
      if (!this.particleActive[index]) continue;

      const offset = index * 3;
      this.particleAges[index] += deltaSeconds;
      const t = Math.min(1, this.particleAges[index] / this.particleTtls[index]);
      this.particleFades[index] = 1 - t;
      this.particleVelocities[offset + 1] -= 3 * deltaSeconds; // gravity 3 u/s²
      this.particlePositions[offset] += this.particleVelocities[offset] * deltaSeconds;
      this.particlePositions[offset + 1] += this.particleVelocities[offset + 1] * deltaSeconds;
      this.particlePositions[offset + 2] += this.particleVelocities[offset + 2] * deltaSeconds;
      particlesChanged = true;

      if (this.particleAges[index] >= this.particleTtls[index]) {
        this.particleActive[index] = 0;
        this.particleFades[index] = 0;
      } else {
        this.activeParticles[writeParticle] = index;
        writeParticle += 1;
      }
    }
    this.activeParticles.length = writeParticle;

    if (tracersChanged) this._rebuildTracers();
    if (particlesChanged) this._rebuildParticles();
  }

  clear(): void {
    for (const tracer of this.tracers) {
      tracer.active = false;
      tracer.ageSeconds = 0;
      tracer.ttlSeconds = 0;
      tracer.fade = 0;
    }
    this.tracerPositions.fill(0);

    this.particlePositions.fill(0);
    this.particleVelocities.fill(0);
    this.particleBaseColors.fill(0);
    this.particleFades.fill(0);
    this.particleAges.fill(0);
    this.particleTtls.fill(0);
    this.particleActive.fill(0);
    this.activeParticles.length = 0;

    this._rebuildTracers();
    this._rebuildParticles();

    this.effects.length = 0;
  }

  /** Repack live tracers into the beam pool, slot order (deterministic). */
  private _rebuildTracers(): void {
    const pool = this.tracerLines;
    let n = 0;
    for (let i = 0; i < this.tracers.length; i += 1) {
      const tracer = this.tracers[i];
      if (!tracer.active) continue;
      const s = i * 6;
      const b = n * BEAM_STRIDE;
      pool.buf[b] = this.tracerPositions[s];
      pool.buf[b + 1] = this.tracerPositions[s + 1];
      pool.buf[b + 2] = this.tracerPositions[s + 2];
      pool.buf[b + 3] = this.tracerPositions[s + 3];
      pool.buf[b + 4] = this.tracerPositions[s + 4];
      pool.buf[b + 5] = this.tracerPositions[s + 5];
      pool.buf[b + 6] = this.tracerWidth;
      pool.colors[n] = rgbFloatsToAbgr(
        tracer.r * tracer.fade,
        tracer.g * tracer.fade,
        tracer.b * tracer.fade,
        POOL_OPACITY,
      );
      n += 1;
    }
    pool.count = n;
  }

  /** Repack live particles into the sprite pool, activeParticles order. */
  private _rebuildParticles(): void {
    const pool = this.particlePoints;
    let n = 0;
    for (let i = 0; i < this.activeParticles.length; i += 1) {
      const index = this.activeParticles[i];
      if (!this.particleActive[index]) continue;
      const offset = index * 3;
      const b = n * SPRITE_STRIDE;
      pool.buf[b] = this.particlePositions[offset];
      pool.buf[b + 1] = this.particlePositions[offset + 1];
      pool.buf[b + 2] = this.particlePositions[offset + 2];
      pool.buf[b + 3] = this.particleSize;
      const fade = this.particleFades[index];
      pool.colors[n] = rgbFloatsToAbgr(
        this.particleBaseColors[offset] * fade,
        this.particleBaseColors[offset + 1] * fade,
        this.particleBaseColors[offset + 2] * fade,
        POOL_OPACITY,
      );
      n += 1;
    }
    pool.count = n;
  }

  dispose(): void {
    this.clear();
    disposeSceneNode(this.group);
  }
}
