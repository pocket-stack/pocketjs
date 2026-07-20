// playset/modules/world/environment/terrain-sampler.ts — the procedural
// terrain height/normal/color samplers (natural hills, road-flattened
// terrain, archipelago islands). Pure math; no scene graph.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/environment/TerrainSampler.js. Verbatim semantics.
// NaturalTerrainSampler.colorAt returns a playset/math Color (offsetHSL
// tinting, like the original's THREE.Color); the other two return plain
// {r,g,b} objects exactly as the original.

import { Color, Vector3 } from "../../../math/index.ts";
import { clamp, fract, lerp } from "../../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../../math/world-basis.ts";
import type { PlanarSegment } from "./spawn-area-sampler.ts";

export interface RGBTriplet {
  r: number;
  g: number;
  b: number;
}

export interface NaturalTerrainSamplerOptions {
  baseHeight?: number;
  undulation?: number;
  hillFrequency?: number;
  colorHeightThreshold?: number;
  normalStep?: number;
  basis?: WorldBasis;
}

export class NaturalTerrainSampler {
  baseHeight: number;
  undulation: number;
  hillFrequency: number;
  colorHeightThreshold: number;
  normalStep: number;
  basis: WorldBasis;

  constructor({
    baseHeight = 0,
    undulation = 3.6,
    hillFrequency = 1,
    colorHeightThreshold = 2.1,
    normalStep = 0.2,
    basis = DEFAULT_WORLD_BASIS,
  }: NaturalTerrainSamplerOptions) {
    this.baseHeight = baseHeight;
    this.undulation = undulation;
    this.hillFrequency = hillFrequency;
    this.colorHeightThreshold = colorHeightThreshold;
    this.normalStep = normalStep;
    this.basis = basis;
  }

  heightAt(right: number, forward: number): number {
    const baseHeight = this.baseHeight;
    const undulation = this.undulation;
    const hillFrequency = this.hillFrequency;
    const hillA = Math.sin(right * 0.055 * hillFrequency)
      * Math.cos(forward * 0.047 * hillFrequency)
      * (2.2 / 3.6);
    const hillB = Math.sin((right + forward) * 0.022 * hillFrequency)
      * (1.4 / 3.6);
    return baseHeight + (hillA + hillB) * undulation;
  }

  normalAt(right: number, forward: number, step = this.normalStep): Vector3 {
    const epsilon = Math.max(0.0001, step);
    const rightHigh = this.heightAt(right + epsilon, forward);
    const rightLow = this.heightAt(right - epsilon, forward);
    const forwardHigh = this.heightAt(right, forward + epsilon);
    const forwardLow = this.heightAt(right, forward - epsilon);

    return this.basis.surfaceNormalFromSlopes(
      (rightHigh - rightLow) / (2 * epsilon),
      (forwardHigh - forwardLow) / (2 * epsilon),
    );
  }

  colorAt(right: number, forward: number): Color {
    const height = this.heightAt(right, forward);
    const color = new Color(height > this.colorHeightThreshold ? 0x8fa55f : 0x639b4f);
    const tint = Math.sin(right * 12.9898 + forward * 78.233) * 43758.5453;
    const noise = tint - Math.floor(tint);
    color.offsetHSL((noise - 0.5) * 0.03, (noise - 0.45) * 0.035, (noise - 0.5) * 0.05);
    return color;
  }

  sample(right: number, forward: number): { height: number; normal: Vector3; color: Color } {
    const height = this.heightAt(right, forward);
    return {
      height,
      normal: this.normalAt(right, forward),
      color: this.colorAt(right, forward),
    };
  }
}

interface CachedRoadSegment {
  start: { right: number; forward: number };
  end: { right: number; forward: number };
  deltaRight: number;
  deltaForward: number;
  lengthSq: number;
}

export interface RoadTerrainSamplerOptions {
  seed?: number;
  roadHalfWidth?: number;
  roadSegments?: PlanarSegment[];
  roadHeight?: number;
  roadFlatnessAtHalfWidth?: number;
  largeWaveScale?: number;
  largeWaveAmp?: number;
  midNoiseScale?: number;
  midNoiseAmp?: number;
  normalStep?: number;
  basis?: WorldBasis;
}

export class RoadTerrainSampler {
  seed: number;
  roadHalfWidth: number;
  roadHeight: number;
  roadFlatnessAtHalfWidth: number;
  roadSegmentCache: CachedRoadSegment[];
  largeWaveScale: number;
  largeWaveAmp: number;
  midNoiseScale: number;
  midNoiseAmp: number;
  normalStep: number;
  basis: WorldBasis;

  constructor({
    seed = 2026,
    roadHalfWidth = 6,
    roadSegments = [],
    roadHeight = 0,
    roadFlatnessAtHalfWidth = 0.8,
    largeWaveScale = 0.05,
    largeWaveAmp = 1.45,
    midNoiseScale = 0.12,
    midNoiseAmp = 1.15,
    normalStep = 0.2,
    basis = DEFAULT_WORLD_BASIS,
  }: RoadTerrainSamplerOptions) {
    this.seed = seed;
    this.roadHalfWidth = roadHalfWidth;
    this.roadHeight = roadHeight;
    this.roadFlatnessAtHalfWidth = roadFlatnessAtHalfWidth;
    this.roadSegmentCache = [];

    const sourceSegments = Array.isArray(roadSegments) ? roadSegments : [];
    for (const segment of sourceSegments) {
      const start = segment.start;
      const end = segment.end;
      const deltaRight = end.right - start.right;
      const deltaForward = end.forward - start.forward;
      const lengthSq = deltaRight * deltaRight + deltaForward * deltaForward;
      if (lengthSq <= 1e-8) continue;

      this.roadSegmentCache.push({
        start: { right: start.right, forward: start.forward },
        end: { right: end.right, forward: end.forward },
        deltaRight,
        deltaForward,
        lengthSq,
      });
    }

    this.largeWaveScale = largeWaveScale;
    this.largeWaveAmp = largeWaveAmp;

    this.midNoiseScale = midNoiseScale;
    this.midNoiseAmp = midNoiseAmp;

    this.normalStep = normalStep;
    this.basis = basis;
  }

  hash2D(right: number, forward: number, seedOffset = 0): number {
    const seed = this.seed + seedOffset;
    return fract(Math.sin(right * 127.1 + forward * 311.7 + seed * 101.3) * 43758.5453123);
  }

  noise2D(right: number, forward: number, seedOffset = 0): number {
    const rightIndex = Math.floor(right);
    const forwardIndex = Math.floor(forward);
    const rightFrac = right - rightIndex;
    const forwardFrac = forward - forwardIndex;

    const rightBlend = rightFrac * rightFrac * (3 - 2 * rightFrac);
    const forwardBlend = forwardFrac * forwardFrac * (3 - 2 * forwardFrac);

    const a = this.hash2D(rightIndex, forwardIndex, seedOffset);
    const b = this.hash2D(rightIndex + 1, forwardIndex, seedOffset);
    const c = this.hash2D(rightIndex, forwardIndex + 1, seedOffset);
    const d = this.hash2D(rightIndex + 1, forwardIndex + 1, seedOffset);

    const rightLow = a + (b - a) * rightBlend;
    const rightHigh = c + (d - c) * rightBlend;
    return (rightLow + (rightHigh - rightLow) * forwardBlend) * 2 - 1;
  }

  distanceToRoad(right: number, forward: number): number {
    let nearestSq = Infinity;
    for (const segment of this.roadSegmentCache) {
      const relativeRight = right - segment.start.right;
      const relativeForward = forward - segment.start.forward;
      const t = clamp(
        (relativeRight * segment.deltaRight + relativeForward * segment.deltaForward) / segment.lengthSq,
        0,
        1,
      );
      const nearestRight = segment.start.right + segment.deltaRight * t;
      const nearestForward = segment.start.forward + segment.deltaForward * t;
      const distRight = right - nearestRight;
      const distForward = forward - nearestForward;
      nearestSq = Math.min(nearestSq, distRight * distRight + distForward * distForward);
    }
    return Math.sqrt(nearestSq);
  }

  roadFlatnessAt(right: number, forward: number): number {
    const distanceRatio = this.distanceToRoad(right, forward) / this.roadHalfWidth;
    return this.roadFlatnessAtHalfWidth ** (distanceRatio * distanceRatio);
  }

  heightAt(right: number, forward: number): number {
    const roadFlatness = this.roadFlatnessAt(right, forward);
    const largeWave =
      Math.sin(right * this.largeWaveScale) * this.largeWaveAmp
      + Math.cos(forward * this.largeWaveScale) * this.largeWaveAmp;
    const midNoise = this.noise2D(right * this.midNoiseScale, forward * this.midNoiseScale, 31) * this.midNoiseAmp;
    const terrainHeight = largeWave + midNoise;
    return lerp(terrainHeight, this.roadHeight, roadFlatness);
  }

  normalAt(right: number, forward: number, step = this.normalStep): Vector3 {
    const e = Math.max(0.0001, step);
    const rightHigh = this.heightAt(right + e, forward);
    const rightLow = this.heightAt(right - e, forward);
    const forwardHigh = this.heightAt(right, forward + e);
    const forwardLow = this.heightAt(right, forward - e);

    return this.basis.surfaceNormalFromSlopes(
      (rightHigh - rightLow) / (2 * e),
      (forwardHigh - forwardLow) / (2 * e),
    );
  }

  colorAt(right: number, forward: number): RGBTriplet {
    const roadFlatness = this.roadFlatnessAt(right, forward);
    const colorNoise = this.noise2D(right * 0.21 + 13, forward * 0.21 - 5, 103) * 0.08;
    return {
      r: 0.2 + roadFlatness * 0.25 + colorNoise,
      g: 0.3 + roadFlatness * 0.18 + colorNoise * 0.6,
      b: 0.15 + roadFlatness * 0.2 + colorNoise * 0.35,
    };
  }

  sample(right: number, forward: number): { height: number; normal: Vector3; color: RGBTriplet } {
    const height = this.heightAt(right, forward);
    return {
      height,
      normal: this.normalAt(right, forward),
      color: this.colorAt(right, forward),
    };
  }
}

export interface ArchipelagoIsland {
  right: number;
  forward: number;
  radiusRight: number;
  radiusForward: number;
  height: number;
}

export interface ArchipelagoTerrainSamplerOptions {
  seed?: number;
  normalStep?: number;
  seaLevel?: number;
  underwaterFloorDrop?: number;
  shorelineBlend?: number;
  islands?: ArchipelagoIsland[] | null;
  basis?: WorldBasis;
}

export class ArchipelagoTerrainSampler {
  seed: number;
  normalStep: number;
  seaLevel: number;
  underwaterFloorDrop: number;
  shorelineBlend: number;
  basis: WorldBasis;
  islands: ArchipelagoIsland[];

  constructor({
    seed = 20260424,
    normalStep = 1.2,
    seaLevel = 0,
    underwaterFloorDrop = 18,
    shorelineBlend = 10,
    islands = null,
    basis = DEFAULT_WORLD_BASIS,
  }: ArchipelagoTerrainSamplerOptions) {
    this.seed = seed;
    this.normalStep = normalStep;
    this.seaLevel = seaLevel;
    this.underwaterFloorDrop = underwaterFloorDrop;
    this.shorelineBlend = Math.max(0.001, shorelineBlend);
    this.basis = basis;
    this.islands = islands ?? [
      { right: -285, forward: -250, radiusRight: 180, radiusForward: 170, height: 64 },
      { right: -110, forward: -70, radiusRight: 240, radiusForward: 225, height: 94 },
      { right: 115, forward: 90, radiusRight: 255, radiusForward: 205, height: 112 },
      { right: 245, forward: -165, radiusRight: 200, radiusForward: 185, height: 82 },
      { right: 15, forward: -280, radiusRight: 200, radiusForward: 150, height: 56 },
    ];
  }

  hash2D(right: number, forward: number, seedOffset = 0): number {
    const seed = this.seed + seedOffset;
    return fract(Math.sin(right * 127.1 + forward * 311.7 + seed * 0.017) * 43758.5453123);
  }

  noise2D(right: number, forward: number, seedOffset = 0): number {
    const rightIndex = Math.floor(right);
    const forwardIndex = Math.floor(forward);
    const rightFrac = right - rightIndex;
    const forwardFrac = forward - forwardIndex;
    const rightBlend = rightFrac * rightFrac * (3 - 2 * rightFrac);
    const forwardBlend = forwardFrac * forwardFrac * (3 - 2 * forwardFrac);

    const a = this.hash2D(rightIndex, forwardIndex, seedOffset);
    const b = this.hash2D(rightIndex + 1, forwardIndex, seedOffset);
    const c = this.hash2D(rightIndex, forwardIndex + 1, seedOffset);
    const d = this.hash2D(rightIndex + 1, forwardIndex + 1, seedOffset);

    const rightLow = lerp(a, b, rightBlend);
    const rightHigh = lerp(c, d, rightBlend);
    return lerp(rightLow, rightHigh, forwardBlend) * 2 - 1;
  }

  fbm(right: number, forward: number, octaves = 4, lacunarity = 2, gain = 0.5, seedOffset = 0): number {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let normalization = 0;

    for (let index = 0; index < octaves; index += 1) {
      sum += this.noise2D(right * frequency, forward * frequency, seedOffset + index * 37) * amplitude;
      normalization += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }

    return normalization > 0 ? sum / normalization : 0;
  }

  islandContribution(right: number, forward: number, island: ArchipelagoIsland): number {
    const dRight = (right - island.right) / island.radiusRight;
    const dForward = (forward - island.forward) / island.radiusForward;
    const falloff = Math.exp(-(dRight * dRight + dForward * dForward) * 2.4);
    return island.height * falloff;
  }

  rawHeightAt(right: number, forward: number): number {
    let landMass = -22;
    for (const island of this.islands) {
      landMass += this.islandContribution(right, forward, island);
    }

    const spineMask = Math.exp(-(((right - 28) * (right - 28)) / 32000 + ((forward + 12) * (forward + 12)) / 92000));
    const spineNoise = this.fbm(right * 0.016, forward * 0.012, 5, 2, 0.55, 91);
    landMass += spineMask * (58 + spineNoise * 28);

    const coastalNoise = this.fbm(right * 0.0052, forward * 0.0052, 4, 2, 0.55, 23) * 12;
    const ruggedMask = clamp((landMass + 12) / 90, 0, 1);
    const ruggedDetail = this.fbm(right * 0.021, forward * 0.021, 4, 2.1, 0.52, 147) * 10;

    return landMass + coastalNoise + ruggedDetail * ruggedMask;
  }

  heightAt(right: number, forward: number): number {
    const rawHeight = this.rawHeightAt(right, forward);
    if (rawHeight >= this.seaLevel) return rawHeight;

    const submergedDepth = this.seaLevel - rawHeight;
    const floorDrop = this.underwaterFloorDrop * clamp(submergedDepth / this.shorelineBlend, 0, 1);
    return rawHeight - floorDrop;
  }

  normalAt(right: number, forward: number, step = this.normalStep): Vector3 {
    const epsilon = Math.max(0.2, step);
    const rightHigh = this.heightAt(right + epsilon, forward);
    const rightLow = this.heightAt(right - epsilon, forward);
    const forwardHigh = this.heightAt(right, forward + epsilon);
    const forwardLow = this.heightAt(right, forward - epsilon);
    return this.basis.surfaceNormalFromSlopes(
      (rightHigh - rightLow) / (2 * epsilon),
      (forwardHigh - forwardLow) / (2 * epsilon),
    );
  }

  colorAt(right: number, forward: number): RGBTriplet {
    const height = this.heightAt(right, forward);
    const colorNoise = this.fbm(right * 0.03 + 5.2, forward * 0.03 - 1.7, 2, 2, 0.5, 211) * 0.05;

    if (height < 5) {
      return { r: 0.64 + colorNoise, g: 0.59 + colorNoise * 0.8, b: 0.37 + colorNoise * 0.5 };
    }
    if (height < 26) {
      return { r: 0.28 + colorNoise * 0.7, g: 0.43 + colorNoise, b: 0.19 + colorNoise * 0.4 };
    }
    if (height < 72) {
      return { r: 0.21 + colorNoise * 0.6, g: 0.34 + colorNoise * 0.7, b: 0.24 + colorNoise * 0.4 };
    }
    if (height < 118) {
      return { r: 0.38 + colorNoise * 0.4, g: 0.37 + colorNoise * 0.35, b: 0.35 + colorNoise * 0.25 };
    }
    return { r: 0.66 + colorNoise * 0.2, g: 0.68 + colorNoise * 0.2, b: 0.72 + colorNoise * 0.2 };
  }

  sample(right: number, forward: number): { height: number; normal: Vector3; color: RGBTriplet } {
    const height = this.heightAt(right, forward);
    return {
      height,
      normal: this.normalAt(right, forward),
      color: this.colorAt(right, forward),
    };
  }
}
