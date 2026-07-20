// playset/modules/world/visual-effects/vehicle-tire-mark-renderer.ts —
// terrain-snapped tire-mark ribbons behind a vehicle's front/rear axles.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/visual-effects/VehicleTireMarkRenderer.js.
// Segment logic (minDistance/minSpeed gates, reset-on-airborne ribbon
// breaks, ring-buffer eviction, two tracks with per-track color/opacity) is
// verbatim. Deliberate changes for the scene3d surface:
//   - the dynamic ring-buffer BufferGeometry (18 floats/segment quad)
//     becomes a BeamPool per track: one beam per segment (a→b centerline,
//     `width`, per-entry track color) — the host owns quad expansion, so
//     the original's direction×up edge math is gone. polygonOffset has no
//     analog; the terrain `lift` (0.026) is what keeps marks above ground.
//   - pool capacities are fixed at creation: maxSegments is capped at 256
//     per track (pool sanity; the original default 1200 was sized for a
//     desktop dynamic buffer).
//   - constructor options gain `scene: Scene3D`. `.group` remains as a bare
//     node for API parity (pools are not nodes). dispose() empties the
//     pools and destroys the group; the pools themselves are freed with the
//     scene.

import { Vector3 } from "../../../math/vector3.ts";
import {
  MAT,
  type BeamPool,
  type Scene3D,
  type SceneNode,
} from "../../../scene3d/client.ts";
import { BEAM_STRIDE } from "../../../scene3d/ops.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../../math/world-basis.ts";
import { rgbToAbgr } from "../color-utils.ts";
import { disposeSceneNode } from "../scene-node-utils.ts";

const MAX_POOL_SEGMENTS = 256;

export interface TireTerrainSampler {
  heightAt(right: number, forward: number): number;
}

export interface TireMarkVehicleState {
  grounded: boolean;
  horizontalSpeed: number;
  position: Vector3;
  bodyFrame: { right: Vector3; forward: Vector3 };
}

interface Track {
  pool: BeamPool;
  color: number;
  /** Ring buffer of segment centerlines, 6 floats (ax,ay,az,bx,by,bz) each. */
  segments: number[];
  last: [Vector3 | null, Vector3 | null];
  segmentCount: number;
}

export interface VehicleTireMarkRendererOptions {
  scene: Scene3D;
  terrainSampler: TireTerrainSampler;
  maxSegments?: number;
  minDistance?: number;
  width?: number;
  lift?: number;
  halfTrack?: number;
  frontForwardOffset?: number;
  rearForwardOffset?: number;
  frontColor?: number;
  rearColor?: number;
  frontOpacity?: number;
  rearOpacity?: number;
  minSpeed?: number;
  basis?: WorldBasis;
}

export class VehicleTireMarkRenderer {
  readonly group: SceneNode;
  readonly basis: WorldBasis;
  terrainSampler: TireTerrainSampler;
  readonly maxSegments: number;
  readonly minDistance: number;
  readonly width: number;
  readonly lift: number;
  readonly halfTrack: number;
  readonly frontForwardOffset: number;
  readonly rearForwardOffset: number;
  readonly minSpeed: number;
  readonly front: Track;
  readonly rear: Track;

  constructor({
    scene,
    terrainSampler,
    maxSegments = 1200,
    minDistance = 0.16,
    width = 0.18,
    lift = 0.026,
    halfTrack = 0.84,
    frontForwardOffset = 1.07,
    rearForwardOffset = -1.07,
    frontColor = 0x161719,
    rearColor = 0x8d2119,
    frontOpacity = 0.42,
    rearOpacity = 0.58,
    minSpeed = 0.6,
    basis = DEFAULT_WORLD_BASIS,
  }: VehicleTireMarkRendererOptions) {
    this.group = scene.node();
    this.basis = basis;
    this.terrainSampler = terrainSampler;
    this.maxSegments = Math.max(1, Math.min(MAX_POOL_SEGMENTS, Math.floor(maxSegments)));
    this.minDistance = minDistance;
    this.width = width;
    this.lift = lift;
    this.halfTrack = halfTrack;
    this.frontForwardOffset = frontForwardOffset;
    this.rearForwardOffset = rearForwardOffset;
    this.minSpeed = minSpeed;
    this.front = this.createTrack(scene, frontColor, frontOpacity);
    this.rear = this.createTrack(scene, rearColor, rearOpacity);
  }

  get frontSegments(): number {
    return this.front.segmentCount;
  }

  get rearSegments(): number {
    return this.rear.segmentCount;
  }

  get totalSegments(): number {
    return this.frontSegments + this.rearSegments;
  }

  setTerrainSampler(terrainSampler: TireTerrainSampler): void {
    this.terrainSampler = terrainSampler;
  }

  private createTrack(scene: Scene3D, color: number, opacity: number): Track {
    const mat = scene.material(
      rgbToAbgr(0xffffff, opacity),
      MAT.unlit | MAT.transparent | MAT.doubleSided,
    );
    return {
      pool: scene.beamPool(this.maxSegments, mat),
      color: rgbToAbgr(color, opacity),
      segments: [],
      last: [null, null],
      segmentCount: 0,
    };
  }

  clear(): void {
    for (const track of [this.front, this.rear]) {
      track.segments.length = 0;
      track.last[0] = null;
      track.last[1] = null;
      track.segmentCount = 0;
      this.refresh(track);
    }
  }

  resetLast(): void {
    for (const track of [this.front, this.rear]) {
      track.last[0] = null;
      track.last[1] = null;
    }
  }

  step(vehicleState: TireMarkVehicleState): void {
    if (!vehicleState.grounded || vehicleState.horizontalSpeed < this.minSpeed) {
      this.resetLast();
      return;
    }

    this.stepTrack(vehicleState, this.front, this.frontForwardOffset);
    this.stepTrack(vehicleState, this.rear, this.rearForwardOffset);
  }

  private stepTrack(vehicleState: TireMarkVehicleState, track: Track, forwardOffset: number): void {
    let changed = false;
    const points = [
      this.tirePoint(vehicleState, forwardOffset, -1),
      this.tirePoint(vehicleState, forwardOffset, 1),
    ];

    for (let i = 0; i < points.length; i += 1) {
      const last = track.last[i];
      if (last) changed = this.appendSegment(track, last, points[i]) || changed;
      track.last[i] = points[i].clone();
    }
    if (changed) this.refresh(track);
  }

  private tirePoint(vehicleState: TireMarkVehicleState, forwardOffset: number, side: number): Vector3 {
    const point = vehicleState.position
      .clone()
      .addScaledVector(vehicleState.bodyFrame.right, side * this.halfTrack)
      .addScaledVector(vehicleState.bodyFrame.forward, forwardOffset);
    const planar = this.basis.toPlanar(point);
    const up = this.terrainSampler.heightAt(planar.right, planar.forward) + this.lift;
    return this.basis.fromBasisComponents(planar.right, up, planar.forward, point);
  }

  private appendSegment(track: Track, from: Vector3, to: Vector3): boolean {
    if (to.clone().sub(from).length() < this.minDistance) return false;

    track.segments.push(from.x, from.y, from.z, to.x, to.y, to.z);
    track.segmentCount += 1;

    while (track.segmentCount > this.maxSegments) {
      track.segments.splice(0, 6); // drop the oldest segment
      track.segmentCount -= 1;
    }
    return true;
  }

  /** Rewrite the track's pool from its segment ring (pools are
   *  replace-per-frame; scene.flush() ships the buffer). */
  private refresh(track: Track): void {
    const { pool } = track;
    for (let i = 0; i < track.segmentCount; i += 1) {
      const s = i * 6;
      const b = i * BEAM_STRIDE;
      pool.buf[b] = track.segments[s];
      pool.buf[b + 1] = track.segments[s + 1];
      pool.buf[b + 2] = track.segments[s + 2];
      pool.buf[b + 3] = track.segments[s + 3];
      pool.buf[b + 4] = track.segments[s + 4];
      pool.buf[b + 5] = track.segments[s + 5];
      pool.buf[b + 6] = this.width;
      pool.colors[i] = track.color;
    }
    pool.count = track.segmentCount;
  }

  dispose(): void {
    this.clear();
    disposeSceneNode(this.group);
  }
}
