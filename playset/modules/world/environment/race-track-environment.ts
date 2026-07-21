// playset/modules/world/environment/race-track-environment.ts — a closed(!)
// race track composed over NaturalEnvironment: road-flattened terrain,
// checkpoint gates, inner/outer barrier fences, spawn poses and
// CollisionWorld colliders.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/environment/RaceTrackEnvironment.js. Deliberate
// changes for the scene3d surface + CollisionWorld:
//   - `scene` is a Scene3D; groups/gates/posts/rails are SceneNodes (in
//     scene from creation; node names dropped — no scene3d analog).
//   - Material metalness/roughness dropped (no fixed-function analog).
//   - castShadow/receiveShadow dropped: shadows → blob decals, see
//     world/blob-shadow.ts (addShadowMesh keeps its name for fidelity).
//   - createPhysicsColliders(world, rapier) → createColliders(world):
//     delegates to naturalEnvironment.createColliders (terrain sampler as
//     ground authority + tree/rock shapes), barrier posts → addCylinder,
//     rails → addCuboid (yaw-only orientation — CollisionWorld v1 drops the
//     rails' terrain-following tilt, faithful for the planar resolver).
//     Collider records are handles (`colliders`), not {body, collider}.
//   - naturalEnvironmentConfig may carry `prng` / `plantFactory` /
//     `rockFactory` (injection flows through to the composed environment).

import { Matrix4, Vector3 } from "../../../math/index.ts";
import { clamp } from "../../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../../math/world-basis.ts";
import {
  PLANAR_EPS,
  normalizePlanar2D,
  planarCentroid,
  planarTangentAt,
  type PlanarPoint,
} from "./planar-utils.ts";
import { NaturalEnvironment, type NaturalEnvironmentOptions } from "./natural-environment.ts";
import { RoadTerrainSampler } from "./terrain-sampler.ts";
import { SPAWN_REGION_TYPES, type SpawnRegion } from "./spawn-area-sampler.ts";
import type { PlanarSegment } from "./spawn-area-sampler.ts";
import type { Scene3D, SceneNode } from "../../../scene3d/client.ts";
import type { CollisionWorld, ColliderHandle } from "../../physics/collision-world.ts";

/** spec ABGR byte order: (a<<24)|(b<<16)|(g<<8)|r. Local on purpose. */
function rgbToAbgr(hex: number, alpha = 255): number {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return (((alpha & 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const SIDE_SIGN = Object.freeze({ outer: 1, inner: -1 });

export interface RaceTrackNaturalEnvironmentConfig
  extends Omit<NaturalEnvironmentOptions, "scene" | "basis" | "terrainSampler" | "propBlockRegions"> {}

export const DEFAULT_NATURAL_ENVIRONMENT_CONFIG: Readonly<RaceTrackNaturalEnvironmentConfig> = Object.freeze({
  terrainSize: 180,
  terrainSegments: 128,
  treeCount: 155,
  rockCount: 36,
  grassBladeCount: 260,
  renderOrder: 0,
});

export interface RoadTerrainSamplerConfig {
  seed?: number;
  roadHalfWidth?: number;
  roadHeight?: number;
  roadFlatnessAtHalfWidth?: number;
  largeWaveScale?: number;
  largeWaveAmp?: number;
  midNoiseScale?: number;
  midNoiseAmp?: number;
  normalStep?: number;
}

export const DEFAULT_ROAD_TERRAIN_SAMPLER_CONFIG: Readonly<RoadTerrainSamplerConfig> = Object.freeze({
  seed: 2026,
  roadHalfWidth: 6,
  roadHeight: 0,
  roadFlatnessAtHalfWidth: 0.8,
  largeWaveScale: 0.05,
  largeWaveAmp: 1.45,
  midNoiseScale: 0.12,
  midNoiseAmp: 1.15,
  normalStep: 0.2,
});

const DEFAULT_CHECKPOINT_RADIUS = 7.5;

export interface CheckpointMarkerConfig {
  width: number;
  height: number;
  postRadius: number;
  postSegments: number;
  crossbarThickness: number;
  flagWidth: number;
  flagHeight: number;
  flagThickness: number;
  upOffset: number;
  colors: Readonly<{ post: number; crossbar: number; flagA: number; flagB: number }>;
  /** Accepted for API compatibility; ignored (no fixed-function analog). */
  materialOptions: Readonly<Record<string, unknown>>;
}

export const DEFAULT_CHECKPOINT_MARKER_CONFIG: Readonly<CheckpointMarkerConfig> = Object.freeze({
  width: 12,
  height: 4,
  postRadius: 0.08,
  postSegments: 12,
  crossbarThickness: 0.08,
  flagWidth: 2,
  flagHeight: 1,
  flagThickness: 0.03,
  upOffset: 0.02,
  colors: Object.freeze({
    post: 0x3a3026,
    crossbar: 0x4a3b2d,
    flagA: 0xf9d66f,
    flagB: 0x2f3e55,
  }),
  materialOptions: Object.freeze({}),
});

export interface BarrierConfig {
  sideOffset: number;
  postSpacing: number;
  height: number;
  postRadiusRatio: number;
  postSegments: number;
  railHeightRatio: number;
  railThicknessRatio: number;
  upOffset: number;
  colors: Readonly<{ post: number; rail: number }>;
  /** Accepted for API compatibility; ignored (no fixed-function analog). */
  materialOptions: Readonly<Record<string, unknown>>;
  friction: number;
  restitution: number;
}

export const DEFAULT_BARRIER_CONFIG: Readonly<BarrierConfig> = Object.freeze({
  sideOffset: 7,
  postSpacing: 2.5,
  height: 1.2,
  postRadiusRatio: 0.35,
  postSegments: 10,
  railHeightRatio: 0.72,
  railThicknessRatio: 0.16,
  upOffset: 0.02,
  colors: Object.freeze({
    post: 0xe4edf9,
    rail: 0x76849a,
  }),
  materialOptions: Object.freeze({}),
  friction: 1,
  restitution: 0,
});

export interface Checkpoint {
  id: string;
  right: number;
  forward: number;
  position: Vector3;
  radius: number;
}

export interface BarrierPost {
  visual: SceneNode;
  radius: number;
  height: number;
}

export interface BarrierRail {
  visual: SceneNode;
  spanRight: number;
  spanUp: number;
  spanForward: number;
}

export interface Barriers {
  group: SceneNode;
  posts: BarrierPost[];
  rails: BarrierRail[];
}

export interface SpawnPose {
  startIndex: number;
  prevIndex: number;
  nextIndex: number;
  prevCheckpointId: string;
  startCheckpointId: string;
  nextCheckpointId: string;
  clockwise: boolean;
  forward: { x: number; y: number; z: number };
  right: { x: number; y: number; z: number };
  position: Vector3;
  yaw: number;
}

function terrainHeight(terrainSampler: { heightAt(right: number, forward: number): number }, point: PlanarPoint): number {
  return terrainSampler.heightAt(point.right, point.forward);
}

function offsetPath(
  path: readonly PlanarPoint[],
  closed: boolean,
  offset: number,
  sideSign = 1,
): PlanarPoint[] {
  const center = planarCentroid(path);
  const offsetPoints: PlanarPoint[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const point = path[index];
    const tangent = planarTangentAt(path, index, closed, { retryFromCurrent: true });
    const side = { right: tangent.forward, forward: -tangent.right };
    const radial = normalizePlanar2D(point.right - center.right, point.forward - center.forward);
    const outwardSign = side.right * radial.right + side.forward * radial.forward >= 0 ? 1 : -1;
    offsetPoints.push({
      right: point.right + side.right * offset * sideSign * outwardSign,
      forward: point.forward + side.forward * offset * sideSign * outwardSign,
    });
  }
  return offsetPoints;
}

export interface RaceTrackEnvironmentOptions {
  scene: Scene3D;
  trackPlanarPoints: PlanarPoint[];
  closed?: boolean;
  checkpointRadius?: number;
  naturalEnvironmentConfig?: RaceTrackNaturalEnvironmentConfig;
  roadTerrainSamplerConfig?: RoadTerrainSamplerConfig;
  roadPropClearance?: number;
  checkpointMarkerConfig?: CheckpointMarkerConfig | null;
  barrierConfig?: BarrierConfig | null;
  basis?: WorldBasis;
}

export class RaceTrackEnvironment {
  scene: Scene3D;
  closed: boolean;
  basis: WorldBasis;
  group: SceneNode;
  trackPlanarPoints: PlanarPoint[];
  roadSegments: PlanarSegment[];
  checkpoints: Checkpoint[];
  roadPropClearance: number;
  naturalEnvironment: NaturalEnvironment;
  terrainSampler: RoadTerrainSampler;
  checkpointMarkers: SceneNode | null;
  barriers: Barriers | null;
  checkpointMarkerConfig: CheckpointMarkerConfig | null;
  barrierConfig: BarrierConfig | null;
  collisionWorld: CollisionWorld | null;
  colliders: ColliderHandle[];

  constructor({
    scene,
    trackPlanarPoints,
    closed = true,
    checkpointRadius = DEFAULT_CHECKPOINT_RADIUS,
    naturalEnvironmentConfig = DEFAULT_NATURAL_ENVIRONMENT_CONFIG,
    roadTerrainSamplerConfig = DEFAULT_ROAD_TERRAIN_SAMPLER_CONFIG,
    roadPropClearance = 1.5,
    checkpointMarkerConfig = DEFAULT_CHECKPOINT_MARKER_CONFIG,
    barrierConfig = DEFAULT_BARRIER_CONFIG,
    basis = DEFAULT_WORLD_BASIS,
  }: RaceTrackEnvironmentOptions) {
    this.scene = scene;
    this.closed = closed;
    this.basis = basis;
    this.group = scene.node();
    this.trackPlanarPoints = trackPlanarPoints;
    this.roadSegments = [];
    this.checkpoints = [];
    this.roadPropClearance = roadPropClearance;

    this.buildRoadSegments();
    this.naturalEnvironment = this.buildNaturalEnvironment(naturalEnvironmentConfig, roadTerrainSamplerConfig);
    this.terrainSampler = this.naturalEnvironment.terrainSampler as RoadTerrainSampler;
    this.checkpointMarkers = null;
    this.barriers = null;
    this.checkpointMarkerConfig = checkpointMarkerConfig;
    this.barrierConfig = barrierConfig;
    this.buildCheckpoints(checkpointRadius);

    this.collisionWorld = null;
    this.colliders = [];
  }

  create(): this {
    this.naturalEnvironment.create();
    this.createCheckpointMarkers();
    this.createBarriers();
    // Gates, posts and rails are placed once and never move. The fence alone
    // is ~540 nodes sharing two geometries — exactly what the host's static
    // batching exists for (Scene3D.freeze).
    this.scene.freeze(this.group);
    return this;
  }

  buildNaturalEnvironment(
    naturalEnvironmentConfig: RaceTrackNaturalEnvironmentConfig,
    roadTerrainSamplerConfig: RoadTerrainSamplerConfig,
  ): NaturalEnvironment {
    const terrainSampler = new RoadTerrainSampler({
      ...roadTerrainSamplerConfig,
      roadSegments: this.roadSegments,
      basis: this.basis,
    });
    const propBlockRegions: SpawnRegion[] = [];
    if (this.roadPropClearance >= 0) {
      propBlockRegions.push({
        type: SPAWN_REGION_TYPES.SEGMENT_CORRIDOR,
        segments: this.roadSegments,
        halfWidth: terrainSampler.roadHalfWidth,
        clearance: this.roadPropClearance,
      });
    }

    return new NaturalEnvironment({
      ...naturalEnvironmentConfig,
      scene: this.scene,
      basis: this.basis,
      terrainSampler,
      propBlockRegions,
    });
  }

  buildRoadSegments(): PlanarSegment[] {
    const count = this.trackPlanarPoints.length;
    this.roadSegments = [];
    const segmentCount = this.closed ? count : count - 1;
    for (let i = 0; i < segmentCount; i += 1) {
      this.roadSegments.push({
        start: this.trackPlanarPoints[i],
        end: this.trackPlanarPoints[(i + 1) % count],
      });
    }
    return this.roadSegments;
  }

  buildCheckpoints(radius: number): Checkpoint[] {
    this.checkpoints = [];
    for (let index = 0; index < this.trackPlanarPoints.length; index += 1) {
      const point = this.trackPlanarPoints[index];
      const height = terrainHeight(this.terrainSampler, point);
      const position = this.basis.fromBasisComponents(point.right, height, point.forward);
      this.checkpoints.push({
        id: `cp_${index + 1}`,
        right: point.right,
        forward: point.forward,
        position,
        radius,
      });
    }
    return this.checkpoints;
  }

  /** Flat-color stand-in for the original's MeshStandardMaterial builder. */
  private standardMaterial(color: number): number {
    return this.scene.material(rgbToAbgr(color), 0);
  }

  /** castShadow/receiveShadow dropped — shadows → blob decals (see header). */
  private addShadowMesh(parent: SceneNode, geometry: number, material: number, x: number, y: number, z: number): SceneNode {
    const mesh = this.scene.mesh(geometry, material, parent);
    mesh.position.set(x, y, z);
    return mesh;
  }

  createCheckpointMarkers(): SceneNode | null {
    if (!this.checkpointMarkerConfig) return null;
    const config = this.checkpointMarkerConfig;

    const group = this.scene.node(this.group);
    const postMaterial = this.standardMaterial(config.colors.post);
    const crossbarMaterial = this.standardMaterial(config.colors.crossbar);
    const flagMaterialA = this.standardMaterial(config.colors.flagA);
    const flagMaterialB = this.standardMaterial(config.colors.flagB);
    const postGeometry = this.scene.cylinder(
      config.postRadius,
      config.postRadius,
      config.height,
      config.postSegments,
    );
    const crossbarGeometry = this.scene.box(
      (config.width + config.postRadius * 2.4) * 0.5,
      config.crossbarThickness * 0.5,
      config.crossbarThickness * 0.5,
    );
    const flagGeometry = this.scene.box(
      config.flagWidth * 0.5,
      config.flagHeight * 0.5,
      config.flagThickness * 0.5,
    );

    for (let index = 0; index < this.checkpoints.length; index += 1) {
      const checkpoint = this.checkpoints[index];
      const prev = this.checkpoints[(index - 1 + this.checkpoints.length) % this.checkpoints.length];
      const next = this.checkpoints[(index + 1) % this.checkpoints.length];
      const tangent = normalizePlanar2D(next.right - prev.right, next.forward - prev.forward);
      const gate = this.scene.node(group);
      gate.position.copy(this.basis.fromBasisComponents(
        checkpoint.right,
        terrainHeight(this.terrainSampler, checkpoint) + config.upOffset,
        checkpoint.forward,
      ));
      gate.quaternion.setFromRotationMatrix(this.getPlanarTangentFrame(tangent));

      for (const side of [-1, 1]) {
        this.addShadowMesh(
          gate,
          postGeometry,
          postMaterial,
          side * config.width * 0.5,
          config.height * 0.5,
          0,
        );
      }
      this.addShadowMesh(gate, crossbarGeometry, crossbarMaterial, 0, config.height, 0);

      const flagMaterials = index % 2 === 0
        ? [flagMaterialA, flagMaterialB]
        : [flagMaterialB, flagMaterialA];
      const flagOffsets = [
        -config.width * 0.5 + config.flagWidth * 0.5,
        config.width * 0.5 - config.flagWidth * 0.5,
      ];
      for (let flag = 0; flag < 2; flag += 1) {
        this.addShadowMesh(
          gate,
          flagGeometry,
          flagMaterials[flag],
          flagOffsets[flag],
          config.height - config.flagHeight * 0.65,
          0,
        );
      }
    }

    this.checkpointMarkers = group;
    return group;
  }

  getPlanarTangentFrame(tangentPlanar: PlanarPoint): Matrix4 {
    const up = this.basis.upVector();
    const tangent = this.basis.fromBasisComponents(tangentPlanar.right, 0, tangentPlanar.forward).normalize();
    const side = new Vector3().crossVectors(up, tangent).normalize();
    return new Matrix4().makeBasis(side, up, tangent);
  }

  createBarriers(): Barriers | null {
    if (!this.barrierConfig) return null;
    const config = this.barrierConfig;

    const outerPath = offsetPath(this.trackPlanarPoints, this.closed, config.sideOffset, SIDE_SIGN.outer);
    const innerPath = offsetPath(this.trackPlanarPoints, this.closed, config.sideOffset, SIDE_SIGN.inner);
    const group = this.scene.node(this.group);
    const rails: BarrierRail[] = [];
    const postMaterial = this.scene.material(rgbToAbgr(config.colors.post), 0);
    const railMaterial = this.scene.material(rgbToAbgr(config.colors.rail), 0);
    const postGeometry = this.scene.cylinder(
      config.height * config.postRadiusRatio,
      config.height * config.postRadiusRatio,
      config.height,
      config.postSegments,
    );
    const outerPosts = this.barrierPostsFromPath(outerPath, postGeometry, postMaterial);
    const innerPosts = this.barrierPostsFromPath(innerPath, postGeometry, postMaterial);
    const posts = [...outerPosts, ...innerPosts];

    for (const post of posts) {
      group.add(post.visual);
    }

    for (const sidePosts of [outerPosts, innerPosts]) {
      const sideRails = this.railsFromPosts(sidePosts, railMaterial);
      for (const rail of sideRails) {
        group.add(rail.visual);
        rails.push(rail);
      }
    }

    this.barriers = {
      group,
      posts,
      rails,
    };
    return this.barriers;
  }

  barrierPostsFromPath(path: readonly PlanarPoint[], geometry: number, material: number): BarrierPost[] {
    const config = this.barrierConfig!;
    const posts: BarrierPost[] = [];
    const count = this.closed ? path.length : path.length - 1;
    const radius = config.height * config.postRadiusRatio;
    const height = config.height;
    const rotation = this.basis.threeObjectCanonicalToBasisQuaternion();
    for (let i = 0; i < count; i += 1) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      const dRight = b.right - a.right;
      const dForward = b.forward - a.forward;
      const length = Math.hypot(dRight, dForward);
      if (length < PLANAR_EPS) continue;

      const postCount = Math.max(1, Math.floor(length / config.postSpacing));
      for (let j = 0; j < postCount; j += 1) {
        const t = (j * config.postSpacing) / length;
        const point = {
          right: a.right + dRight * t,
          forward: a.forward + dForward * t,
        };
        const position = this.basis.fromBasisComponents(
          point.right,
          terrainHeight(this.terrainSampler, point)
            + config.height * 0.5
            + config.upOffset,
          point.forward,
        );
        const visual = this.scene.mesh(geometry, material);
        visual.position.copy(position);
        visual.quaternion.copy(rotation);
        posts.push({
          visual,
          radius,
          height,
        });
      }
    }
    return posts;
  }

  railsFromPosts(posts: readonly BarrierPost[], material: number): BarrierRail[] {
    const config = this.barrierConfig!;
    const rails: BarrierRail[] = [];
    const count = this.closed ? posts.length : posts.length - 1;
    const up = this.basis.upVector();
    const tangent = new Vector3();
    const side = new Vector3();
    const matrix = new Matrix4();
    const midpointWorld = new Vector3();
    const aPlanar = { right: 0, forward: 0 };
    const bPlanar = { right: 0, forward: 0 };

    for (let i = 0; i < count; i += 1) {
      const a = posts[i];
      const b = posts[(i + 1) % posts.length];
      this.basis.toPlanar(a.visual.position, aPlanar);
      this.basis.toPlanar(b.visual.position, bPlanar);
      const dRight = bPlanar.right - aPlanar.right;
      const dForward = bPlanar.forward - aPlanar.forward;
      const length = Math.hypot(dRight, dForward);
      if (length < PLANAR_EPS) continue;

      const midpoint = {
        right: (aPlanar.right + bPlanar.right) * 0.5,
        forward: (aPlanar.forward + bPlanar.forward) * 0.5,
      };
      const spanRight = config.height * config.railThicknessRatio;
      const spanUp = config.height * config.railThicknessRatio;
      const spanForward = length;
      const geometry = this.scene.box(spanRight * 0.5, spanUp * 0.5, spanForward * 0.5);
      const visual = this.scene.mesh(geometry, material);

      this.basis.fromBasisComponents(
        midpoint.right,
        terrainHeight(this.terrainSampler, midpoint)
          + config.height * config.railHeightRatio
          + config.upOffset,
        midpoint.forward,
        midpointWorld,
      );
      this.basis.fromBasisComponents(dRight / length, 0, dForward / length, tangent).normalize();
      side.crossVectors(up, tangent).normalize();
      matrix.makeBasis(side, up, tangent);

      visual.position.copy(midpointWorld);
      visual.quaternion.setFromRotationMatrix(matrix);
      rails.push({
        visual,
        spanRight,
        spanUp,
        spanForward,
      });
    }
    return rails;
  }

  createBarrierColliders(world: CollisionWorld): ColliderHandle[] {
    const posts = this.barriers!.posts;
    const rails = this.barriers!.rails;
    const entries: ColliderHandle[] = [];

    for (let index = 0; index < posts.length; index += 1) {
      const post = posts[index];
      const visual = post.visual;
      entries.push(world.addCylinder({
        position: visual.position,
        halfHeight: post.height * 0.5,
        radius: post.radius,
        solid: true,
      }));
    }

    for (const rail of rails) {
      const visual = rail.visual;
      entries.push(world.addCuboid({
        position: visual.position,
        quaternion: visual.quaternion,
        halfExtents: this.basis.fromBasisComponents(
          rail.spanRight * 0.5,
          rail.spanUp * 0.5,
          rail.spanForward * 0.5,
        ),
        solid: true,
      }));
    }
    return entries;
  }

  createColliders(world: CollisionWorld): ColliderHandle[] {
    this.disposeColliders();
    this.collisionWorld = world;
    this.colliders = [];

    this.naturalEnvironment.createColliders(world);

    if (this.barriers) {
      const barrierColliders = this.createBarrierColliders(world);
      this.colliders.push(...barrierColliders);
    }
    return this.colliders;
  }

  disposeColliders(): void {
    this.naturalEnvironment.disposeColliders();

    if (this.collisionWorld) {
      for (const handle of this.colliders) {
        this.collisionWorld.remove(handle);
      }
    }
    this.colliders = [];
    this.collisionWorld = null;
  }

  dispose(): void {
    this.disposeColliders();
    this.naturalEnvironment.dispose();
    this.group.destroy();
    this.checkpointMarkers = null;
    this.barriers = null;
  }

  spawnPose(
    startIndex: number,
    clockwise: boolean,
    spawnDistance: number,
    lateralOffset: number,
    upOffset: number,
  ): SpawnPose {
    const count = this.checkpoints.length;
    const index = ((startIndex % count) + count) % count;
    const prevIndex = this.closed ? (index - 1 + count) % count : clamp(index - 1, 0, count - 1);
    const nextIndex = this.closed ? (index + 1) % count : clamp(index + 1, 0, count - 1);
    const current = this.checkpoints[index].position;
    const previous = this.checkpoints[prevIndex].position;
    const forward = this.basis.planarDelta(current, previous);
    const length = Math.hypot(forward.right, forward.forward);
    const forwardWorld = this.basis.fromBasisComponents(forward.right / length, 0, forward.forward / length);
    const yaw = this.basis.forwardToYaw(forwardWorld);
    const frame = this.basis.yawPitchRollFrame(yaw);
    const position = current.clone()
      .addScaledVector(frame.forward, -spawnDistance)
      .addScaledVector(frame.right, lateralOffset);
    this.basis.addHeight(position, upOffset);

    return {
      startIndex: index,
      prevIndex,
      nextIndex,
      prevCheckpointId: this.checkpoints[prevIndex].id,
      startCheckpointId: this.checkpoints[index].id,
      nextCheckpointId: this.checkpoints[nextIndex].id,
      clockwise,
      forward: { x: frame.forward.x, y: frame.forward.y, z: frame.forward.z },
      right: { x: frame.right.x, y: frame.right.y, z: frame.right.z },
      position,
      yaw,
    };
  }
}
