// playset/modules/world/environment/arena-environment.ts — a walled square
// arena: ground, grid, four walls, eight pillars, three ramps, plus spawn
// sampling and CollisionWorld colliders.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/environment/ArenaEnvironment.js. Deliberate changes
// for the scene3d surface + CollisionWorld:
//   - `scene` is a Scene3D; groups/meshes are SceneNodes. Nodes are in-scene
//     from creation, so create() has no scene.add step and names are gone
//     (no scene3d analog).
//   - Material roughness/metalness have no fixed-function analog — dropped.
//   - scene3d planes are already flat in XZ facing +Y, so the ground uses
//     the OBJECT canonical rotation (identity in the default basis), not
//     three's plane rotation.
//   - GridHelper becomes unlit thin boxes, one per grid line (worldSize
//     divisions; center lines take gridMajorColor, like three's GridHelper).
//   - createPhysicsColliders(world, rapier) → createColliders(world):
//     walls → addCuboid, pillars → addCylinder. The ground cuboid is SKIPPED
//     (CollisionWorld's ground authority is terrain/ground height; floorUp=0
//     matches the default flat ground). Ramp colliders are SKIPPED in v1 —
//     wedge trimesh pending native physics — but the ramp VISUAL keeps the
//     exact 6-corner wedge geometry (host computes normals).
//   - Collider records are handles (`colliders`), not {body, collider}.

import { Vector3, Quaternion } from "../../../math/index.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../../math/world-basis.ts";
import { DEFAULT_PRNG, type RandomGenerator } from "../../math/random-utils.ts";
import { MAT, type Scene3D, type SceneNode } from "../../../scene3d/client.ts";
import type { CollisionWorld, ColliderHandle } from "../../physics/collision-world.ts";

/** spec ABGR byte order: (a<<24)|(b<<16)|(g<<8)|r. Local on purpose. */
function rgbToAbgr(hex: number, alpha = 255): number {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return (((alpha & 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

// Grid lines are thin unlit boxes; half-extents of the non-span axes.
const GRID_LINE_HALF_THICKNESS = 0.02;
const GRID_LINE_HALF_HEIGHT = 0.005;

export interface RampLayoutEntry {
  right: number;
  forward: number;
  spanRight: number;
  spanForward: number;
  spanUp: number;
  yaw: number;
  mesh?: SceneNode;
}

export interface PillarLayoutEntry {
  right: number;
  forward: number;
  radius: number;
  spanUp: number;
  mesh?: SceneNode;
}

export interface WallLayoutEntry {
  right: number;
  up: number;
  forward: number;
  spanRight: number;
  spanUp: number;
  spanForward: number;
}

export interface ArenaBounds {
  minRight: number;
  maxRight: number;
  minForward: number;
  maxForward: number;
  left: number;
  right: number;
  back: number;
  front: number;
}

function rampAxes(ramp: RampLayoutEntry): [{ right: number; forward: number }, { right: number; forward: number }] {
  const cos = Math.cos(ramp.yaw);
  const sin = Math.sin(ramp.yaw);
  return [
    { right: cos, forward: sin },
    { right: -sin, forward: cos },
  ];
}

export function defaultRampLayout(scale = 1.0): RampLayoutEntry[] {
  return [
    {
      right: 0.10 * scale,
      forward: -0.24 * scale,
      spanRight: 0.07 * scale,
      spanForward: 0.14 * scale,
      spanUp: 0.032 * scale,
      yaw: 0,
    },
    {
      right: -0.20 * scale,
      forward: -0.08 * scale,
      spanRight: 0.068 * scale,
      spanForward: 0.112 * scale,
      spanUp: 0.04 * scale,
      yaw: Math.PI * 0.5,
    },
    {
      right: 0.30 * scale,
      forward: 0.08 * scale,
      spanRight: 0.084 * scale,
      spanForward: 0.16 * scale,
      spanUp: 0.052 * scale,
      yaw: Math.PI,
    },
  ];
}

export function defaultPillarLayout(scale = 1.0): PillarLayoutEntry[] {
  const pillars: PillarLayoutEntry[] = [];
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    const radiusFromCenter = i % 2 === 0 ? 0.20 : 0.28;
    const height = i % 2 === 0 ? 0.07 : 0.08;
    const radius = i % 2 === 0 ? 0.02 : 0.03;
    pillars.push({
      right: Math.cos(angle) * radiusFromCenter * scale,
      forward: -Math.sin(angle) * radiusFromCenter * scale,
      radius: radius * scale,
      spanUp: height * scale,
    });
  }
  return pillars;
}

export function defaultWallLayout(
  worldSize: number,
  floorUp: number,
  wallHeight: number,
  wallThickness: number,
): WallLayoutEntry[] {
  return [
    {
      right: 0,
      up: floorUp + wallHeight * 0.5,
      forward: worldSize * 0.5,
      spanRight: worldSize,
      spanUp: wallHeight,
      spanForward: wallThickness,
    },
    {
      right: 0,
      up: floorUp + wallHeight * 0.5,
      forward: -worldSize * 0.5,
      spanRight: worldSize,
      spanUp: wallHeight,
      spanForward: wallThickness,
    },
    {
      right: -worldSize * 0.5,
      up: floorUp + wallHeight * 0.5,
      forward: 0,
      spanRight: wallThickness,
      spanUp: wallHeight,
      spanForward: worldSize,
    },
    {
      right: worldSize * 0.5,
      up: floorUp + wallHeight * 0.5,
      forward: 0,
      spanRight: wallThickness,
      spanUp: wallHeight,
      spanForward: worldSize,
    },
  ];
}

export interface ArenaEnvironmentOptions {
  scene: Scene3D;
  worldSize?: number;
  floorUp?: number;
  wallHeight?: number;
  wallThickness?: number;
  groundColor?: number;
  gridMajorColor?: number;
  gridMinorColor?: number;
  wallColor?: number;
  pillarColor?: number;
  rampColor?: number;
  prng?: RandomGenerator;
  basis?: WorldBasis;
}

export class ArenaEnvironment {
  scene: Scene3D;
  worldSize: number;
  floorUp: number;
  wallHeight: number;
  wallThickness: number;
  groundColor: number;
  gridMajorColor: number;
  gridMinorColor: number;
  wallColor: number;
  pillarColor: number;
  rampColor: number;
  prng: RandomGenerator;
  basis: WorldBasis;
  objectRotation: Quaternion;
  group: SceneNode;
  bounds: ArenaBounds;
  wallLayout: WallLayoutEntry[];
  pillarLayout: PillarLayoutEntry[];
  rampLayout: RampLayoutEntry[];
  collisionWorld: CollisionWorld | null;
  colliders: ColliderHandle[];

  constructor({
    scene,
    worldSize = 50,
    floorUp = 0,
    wallHeight = 3,
    wallThickness = 0.7,
    groundColor = 0x58745e,
    gridMajorColor = 0x89a9cc,
    gridMinorColor = 0x5d7593,
    wallColor = 0x3f5261,
    pillarColor = 0x8d6f53,
    rampColor = 0x8d6f53,
    prng = DEFAULT_PRNG,
    basis = DEFAULT_WORLD_BASIS,
  }: ArenaEnvironmentOptions) {
    this.scene = scene;
    this.worldSize = worldSize;
    this.floorUp = floorUp;
    this.wallHeight = wallHeight;
    this.wallThickness = wallThickness;
    this.groundColor = groundColor;
    this.gridMajorColor = gridMajorColor;
    this.gridMinorColor = gridMinorColor;
    this.wallColor = wallColor;
    this.pillarColor = pillarColor;
    this.rampColor = rampColor;
    this.prng = prng;
    this.basis = basis;
    this.objectRotation = this.basis.threeObjectCanonicalToBasisQuaternion();
    this.group = this.scene.node();

    this.bounds = this.createBounds();
    this.wallLayout = defaultWallLayout(this.worldSize, this.floorUp, this.wallHeight, this.wallThickness);
    this.pillarLayout = defaultPillarLayout(this.worldSize);
    this.rampLayout = defaultRampLayout(this.worldSize);

    this.collisionWorld = null;
    this.colliders = [];
  }

  create(): this {
    this.createGround();
    this.createGrid();
    this.createWalls();
    this.createPillars();
    this.createRamps();
    return this;
  }

  createGround(): void {
    const geom = this.scene.plane(this.worldSize, this.worldSize);
    const material = this.scene.material(rgbToAbgr(this.groundColor), 0);
    const ground = this.scene.mesh(geom, material, this.group);
    ground.position.copy(this.basis.fromBasisComponents(0, this.floorUp, 0));
    ground.quaternion.copy(this.objectRotation);
  }

  createGrid(): void {
    const grid = this.scene.node(this.group);
    grid.position.copy(this.basis.fromBasisComponents(0, this.floorUp + 0.01, 0));
    grid.quaternion.copy(this.objectRotation);

    const size = this.worldSize;
    const divisions = this.worldSize;
    const half = size / 2;
    const step = size / divisions;
    const center = divisions / 2;
    const majorMaterial = this.scene.material(rgbToAbgr(this.gridMajorColor), MAT.unlit);
    const minorMaterial = this.scene.material(rgbToAbgr(this.gridMinorColor), MAT.unlit);
    // Grid-local axes are three-canonical (the grid node carries the object
    // rotation): lines along local X at z=k, and along local Z at x=k.
    const lineAlongX = this.scene.box(half, GRID_LINE_HALF_HEIGHT, GRID_LINE_HALF_THICKNESS);
    const lineAlongZ = this.scene.box(GRID_LINE_HALF_THICKNESS, GRID_LINE_HALF_HEIGHT, half);

    for (let i = 0; i <= divisions; i += 1) {
      const k = -half + i * step;
      const material = i === center ? majorMaterial : minorMaterial;
      this.scene.mesh(lineAlongX, material, grid).position.set(0, 0, k);
      this.scene.mesh(lineAlongZ, material, grid).position.set(k, 0, 0);
    }
  }

  createWalls(): void {
    const wallMaterial = this.scene.material(rgbToAbgr(this.wallColor), 0);

    for (const wall of this.wallLayout) {
      const geom = this.scene.box(wall.spanRight * 0.5, wall.spanUp * 0.5, wall.spanForward * 0.5);
      const mesh = this.scene.mesh(geom, wallMaterial, this.group);
      mesh.position.copy(this.basis.fromBasisComponents(wall.right, wall.up, wall.forward));
      mesh.quaternion.copy(this.objectRotation);
    }
  }

  createPillars(): void {
    const pillarMaterial = this.scene.material(rgbToAbgr(this.pillarColor), 0);

    for (const pillar of this.pillarLayout) {
      const geom = this.scene.cylinder(pillar.radius, pillar.radius, pillar.spanUp, 18);
      const mesh = this.scene.mesh(geom, pillarMaterial, this.group);
      const pillarUp = this.floorUp + pillar.spanUp * 0.5;
      mesh.position.copy(this.basis.fromBasisComponents(pillar.right, pillarUp, pillar.forward));
      mesh.quaternion.copy(this.objectRotation);
      pillar.mesh = mesh;
    }
  }

  createRamps(): void {
    const rampMaterial = this.scene.material(rgbToAbgr(this.rampColor), 0);

    for (const ramp of this.rampLayout) {
      const { positions, indices } = this.createRampGeometry(ramp);
      const geom = this.scene.meshGeom(positions, indices, null);
      // Wedge vertices are authored in world space; the node stays identity.
      const mesh = this.scene.mesh(geom, rampMaterial, this.group);
      ramp.mesh = mesh;
    }
  }

  createRampGeometry(ramp: RampLayoutEntry): { positions: Float32Array; indices: Uint32Array } {
    const halfW = ramp.spanRight * 0.5;
    const halfL = ramp.spanForward * 0.5;
    const [rightAxis, forwardAxis] = rampAxes(ramp);
    const localCorners: [number, number, number][] = [
      [-halfW, 0, halfL],
      [halfW, 0, halfL],
      [-halfW, 0, -halfL],
      [halfW, 0, -halfL],
      [-halfW, ramp.spanUp, -halfL],
      [halfW, ramp.spanUp, -halfL],
    ];
    const positions: number[] = [];
    const indices: number[] = [];
    const vertex = new Vector3();

    const addCorner = (cornerIndex: number): number => {
      const [localRight, localUp, localForward] = localCorners[cornerIndex];
      const right = ramp.right + localRight * rightAxis.right + localForward * forwardAxis.right;
      const forward = ramp.forward + localRight * rightAxis.forward + localForward * forwardAxis.forward;
      this.basis.fromBasisComponents(right, this.floorUp + localUp, forward, vertex);
      positions.push(vertex.x, vertex.y, vertex.z);
      return positions.length / 3 - 1;
    };

    const addTriangle = (a: number, b: number, c: number): void => {
      indices.push(addCorner(a), addCorner(b), addCorner(c));
    };

    const addQuad = (a: number, b: number, c: number, d: number): void => {
      addTriangle(a, b, c);
      addTriangle(a, c, d);
    };

    addQuad(0, 1, 3, 2);
    addQuad(0, 4, 5, 1);
    addQuad(2, 3, 5, 4);
    addTriangle(0, 2, 4);
    addTriangle(1, 5, 3);

    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  }

  createBounds(): ArenaBounds {
    const halfSize = this.worldSize * 0.5;
    return {
      minRight: -halfSize + 1.2,
      maxRight: halfSize - 1.2,
      minForward: -halfSize + 1.2,
      maxForward: halfSize - 1.2,
      left: -halfSize + 1.2,
      right: halfSize - 1.2,
      back: -halfSize + 1.2,
      front: halfSize - 1.2,
    };
  }

  isPlanarPointBlockedByGeometry(right: number, forward: number, clearance = 1.2): boolean {
    for (const pillar of this.pillarLayout) {
      const dRight = right - pillar.right;
      const dForward = forward - pillar.forward;
      const minDist = pillar.radius + clearance;
      if (dRight * dRight + dForward * dForward < minDist * minDist) return true;
    }

    for (const ramp of this.rampLayout) {
      const [rightAxis, forwardAxis] = rampAxes(ramp);
      const dRight = right - ramp.right;
      const dForward = forward - ramp.forward;
      const localRight = dRight * rightAxis.right + dForward * rightAxis.forward;
      const localForward = dRight * forwardAxis.right + dForward * forwardAxis.forward;

      if (Math.abs(localRight) <= ramp.spanRight * 0.5 + clearance
        && Math.abs(localForward) <= ramp.spanForward * 0.5 + clearance
      ) {
        return true;
      }
    }

    return false;
  }

  sampleSpawn(
    excludePosition: Vector3 | null = null,
    minDistance = 0,
    attempts = 24,
    clearance = 1.2,
  ): Vector3 {
    const excludePlanar = excludePosition
      ? this.basis.toPlanar(excludePosition)
      : null;
    for (let i = 0; i < attempts; i += 1) {
      const right = this.prng.uniform(this.bounds.minRight, this.bounds.maxRight);
      const forward = this.prng.uniform(this.bounds.minForward, this.bounds.maxForward);

      if (excludePlanar) {
        const dRight = right - excludePlanar.right;
        const dForward = forward - excludePlanar.forward;
        if (dRight * dRight + dForward * dForward < minDistance * minDistance) continue;
      }

      const blocked = this.isPlanarPointBlockedByGeometry(right, forward, clearance);

      if (!blocked) return this.basis.fromBasisComponents(right, this.floorUp, forward);
    }

    return this.basis.fromBasisComponents(0, this.floorUp, 0);
  }

  createColliders(world: CollisionWorld): ColliderHandle[] {
    this.disposeColliders();
    this.collisionWorld = world;
    this.colliders = [];

    // Ground cuboid skipped: CollisionWorld's groundHeightAt is the floor
    // authority (register a flat terrain sampler when floorUp != 0).
    for (const wall of this.wallLayout) {
      this.colliders.push(world.addCuboid({
        position: this.basis.fromBasisComponents(wall.right, wall.up, wall.forward),
        halfExtents: this.basis.fromBasisComponents(
          wall.spanRight * 0.5,
          wall.spanUp * 0.5,
          wall.spanForward * 0.5,
        ),
        quaternion: this.objectRotation,
        solid: true,
      }));
    }

    for (const pillar of this.pillarLayout) {
      this.colliders.push(world.addCylinder({
        position: this.basis.fromBasisComponents(
          pillar.right,
          this.floorUp + pillar.spanUp * 0.5,
          pillar.forward,
        ),
        halfHeight: pillar.spanUp * 0.5,
        radius: pillar.radius,
        solid: true,
      }));
    }

    // Ramp colliders skipped in v1: wedge trimesh pending native physics.
    return this.colliders;
  }

  disposeColliders(): void {
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
    this.group.destroy();
  }
}
