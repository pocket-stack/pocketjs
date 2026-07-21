// playset/modules/world/environment/natural-environment.ts — procedural
// natural terrain with prng-placed trees, rocks and grass, plus
// CollisionWorld colliders (terrain ground authority, tree cylinders, rock
// balls).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/environment/NaturalEnvironment.js. Deliberate
// changes for the scene3d surface + CollisionWorld:
//   - `scene` is a Scene3D; the group and prop visuals are SceneNodes (in
//     scene from creation; node names dropped — no scene3d analog).
//   - renderOrder has no scene3d analog: the field and applyRenderOrder are
//     kept for API compatibility, but the traverse is a no-op.
//   - Prop visuals come from the ported PlantVisualFactory /
//     RockVisualFactory (scene-first signatures). The factory modules are
//     injectable (`plantFactory` / `rockFactory` options, defaulting to the
//     real modules), so headless suites can substitute stubs. The prng draw
//     ORDER per prop (tree height, radius, spawn point, factory draws,
//     rotations) is exactly the original's, so a given seed reproduces the
//     original's layout counts.
//   - Tree rotation: the original set Euler x/y/z on the Object3D (order
//     'XYZ'); the port composes the same Euler into the node quaternion.
//   - createPhysicsColliders(world, rapier) → createColliders(world): the
//     terrain trimesh becomes registerTerrainCollider (sampler = ground
//     authority), trees → addCylinder, rocks → addBall. Collider records
//     are handles (`colliders`), not {body, collider}.

import { Euler, Quaternion, Vector3 } from "../../../math/index.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../../math/world-basis.ts";
import { DEFAULT_PRNG, type RandomGenerator } from "../../math/random-utils.ts";
import type { Scene3D, SceneNode } from "../../../scene3d/client.ts";
import type { CollisionWorld, ColliderHandle } from "../../physics/collision-world.ts";
import {
  createTerrainMesh,
  registerTerrainCollider,
  type MeshTerrainSampler,
  type TerrainGrid,
} from "./terrain-mesh-factory.ts";
import * as defaultPlantVisualFactory from "../object/factory/plant-visual-factory.ts";
import * as defaultRockVisualFactory from "../object/factory/rock-visual-factory.ts";
import { NaturalTerrainSampler } from "./terrain-sampler.ts";
import { SpawnAreaSampler, type PlanarBounds, type SpawnRegion } from "./spawn-area-sampler.ts";
import type { PlanarPoint } from "./planar-utils.ts";

/** The sampler contract this environment needs (all three samplers qualify). */
export interface NaturalTerrainSamplerLike extends MeshTerrainSampler {
  heightAt(right: number, forward: number): number;
}

// Materials are opaque tokens minted by a factory and handed back to it
// verbatim; `any` is the honest passthrough type across this injected
// boundary (method syntax keeps the real modules assignable).
/** PlantVisualFactory surface consumed here (same export names as ported). */
export interface PlantVisualFactoryLike {
  createTreeMaterials(scene: Scene3D, options?: object): unknown;
  createTreeVisual(scene: Scene3D, options: {
    height: number;
    radius: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    materials: any;
    prng: RandomGenerator;
  }): SceneNode;
  createGrassMaterial(scene: Scene3D): unknown;
  createGrassBladeVisual(scene: Scene3D, options: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    material: any;
    prng: RandomGenerator;
  }): SceneNode;
}

/** RockVisualFactory surface consumed here (same export names as ported). */
export interface RockVisualFactoryLike {
  createRockMaterial(scene: Scene3D): unknown;
  createGroundRockVisual(scene: Scene3D, options: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    material: any;
    prng: RandomGenerator;
  }): SceneNode;
}

export interface TreeEntry {
  visual: SceneNode;
  radius: number;
  height: number;
}

export interface RockEntry {
  visual: SceneNode;
  radius: number;
}

export interface NaturalEnvironmentOptions {
  scene: Scene3D;
  terrainSize?: number;
  terrainSegments?: number;
  baseHeight?: number;
  undulation?: number;
  hillFrequency?: number;
  terrainSampler?: NaturalTerrainSamplerLike | null;
  treeCount?: number;
  rockCount?: number;
  grassBladeCount?: number;
  propSpawnRegions?: SpawnRegion[];
  propBlockRegions?: SpawnRegion[];
  renderOrder?: number;
  prng?: RandomGenerator;
  /** Forwarded to createTerrainMesh — see TerrainGrid (native sim cores). */
  onTerrainGrid?: (grid: TerrainGrid) => void;
  /** Forwarded to createTerrainMesh — split the ground so it can be culled. */
  terrainTiles?: number;
  basis?: WorldBasis;
  plantFactory?: PlantVisualFactoryLike;
  rockFactory?: RockVisualFactoryLike;
}

export class NaturalEnvironment {
  scene: Scene3D;
  basis: WorldBasis;
  prng: RandomGenerator;
  terrainSize: number;
  terrainSegments: number;
  terrainSampler: NaturalTerrainSamplerLike;
  treeCount: number;
  rockCount: number;
  grassBladeCount: number;
  propSpawnAreaSampler: SpawnAreaSampler;
  renderOrder: number;
  onTerrainGrid: ((grid: TerrainGrid) => void) | undefined;
  terrainTiles: number;
  placementBounds: PlanarBounds;
  group: SceneNode;
  terrainMesh: SceneNode | null;
  trees: TreeEntry[];
  rocks: RockEntry[];
  planarScratch: PlanarPoint;
  propBasisQuaternion: Quaternion;
  collisionWorld: CollisionWorld | null;
  colliders: ColliderHandle[];
  private plantFactory: PlantVisualFactoryLike;
  private rockFactory: RockVisualFactoryLike;
  private terrainRegistered: boolean;

  constructor({
    scene,
    terrainSize = 180,
    terrainSegments = 128,
    baseHeight = 0,
    undulation = 3.6,
    hillFrequency = 1,
    terrainSampler = null,
    treeCount = 155,
    rockCount = 36,
    grassBladeCount = 260,
    propSpawnRegions = [],
    propBlockRegions = [],
    renderOrder = 0,
    prng = DEFAULT_PRNG,
    basis = DEFAULT_WORLD_BASIS,
    onTerrainGrid,
    terrainTiles = 1,
    plantFactory = defaultPlantVisualFactory,
    rockFactory = defaultRockVisualFactory,
  }: NaturalEnvironmentOptions) {
    const resolvedTerrainSampler = terrainSampler ?? new NaturalTerrainSampler({
      baseHeight,
      undulation,
      hillFrequency,
      basis,
    });

    this.placementBounds = {
      rightMin: -0.48 * terrainSize, rightMax: 0.48 * terrainSize, forwardMin: -0.48 * terrainSize, forwardMax: 0.48 * terrainSize,
    };

    this.scene = scene;
    this.basis = basis;
    this.prng = prng;
    this.terrainSize = terrainSize;
    this.terrainSegments = terrainSegments;
    this.terrainSampler = resolvedTerrainSampler;
    this.treeCount = treeCount;
    this.rockCount = rockCount;
    this.grassBladeCount = grassBladeCount;
    this.propSpawnAreaSampler = new SpawnAreaSampler({
      bounds: this.placementBounds,
      spawnRegions: propSpawnRegions,
      blockRegions: propBlockRegions,
    });
    this.renderOrder = renderOrder;
    this.onTerrainGrid = onTerrainGrid;
    this.terrainTiles = terrainTiles;
    this.group = this.scene.node();
    this.terrainMesh = null;
    this.trees = [];
    this.rocks = [];
    this.planarScratch = { right: 0, forward: 0 };
    this.propBasisQuaternion = this.basis.threeObjectCanonicalToBasisQuaternion(new Quaternion());
    this.plantFactory = plantFactory;
    this.rockFactory = rockFactory;

    this.collisionWorld = null;
    this.colliders = [];
    this.terrainRegistered = false;
  }

  create(): this {
    this.createTerrain();
    this.createForest();
    // Terrain, trees, rocks and grass are placed once and never move, so tell
    // the host it may merge them. PLAYSET ADDITION (no GameBlocks
    // counterpart): scenery is where the draw calls are, and declaring it here
    // means a game inherits the batching from the environment it composes
    // rather than hand-optimizing its own scene. See Scene3D.freeze.
    this.scene.freeze(this.group);
    return this;
  }

  terrainHeightAt(position: Vector3): number {
    const p = this.basis.toPlanar(position, this.planarScratch);
    return this.terrainHeightAtPlanar(p.right, p.forward);
  }

  terrainHeightAtPlanar(right: number, forward: number): number {
    return this.terrainSampler.sample(right, forward)?.height ?? 0;
  }

  placeOnGround(object: SceneNode, rightValue: number, forwardValue: number, extraHeight = 0): Vector3 {
    const position = this.basis.fromBasisComponents(rightValue, 0, forwardValue);
    this.basis.setHeight(position, this.terrainHeightAt(position) + extraHeight);
    object.position.copy(position);
    return position;
  }

  /** renderOrder has no scene3d analog; kept for API compatibility. */
  applyRenderOrder<T>(object: T): T {
    return object;
  }

  samplePropPlanarPoint(radius = 0): PlanarPoint | null {
    return this.propSpawnAreaSampler.sample(this.prng, radius);
  }

  orientPropVisual(object: SceneNode): SceneNode {
    object.quaternion.premultiply(this.propBasisQuaternion);
    return object;
  }

  createTerrain(): void {
    const mesh = createTerrainMesh({
      scene: this.scene,
      terrainSampler: this.terrainSampler,
      size: this.terrainSize,
      segments: this.terrainSegments,
      materialOptions: {
        roughness: 0.9,
        metalness: 0.02,
      },
      onGrid: this.onTerrainGrid,
      tiles: this.terrainTiles,
    });
    this.applyRenderOrder(mesh);
    this.group.add(mesh);
    this.terrainMesh = mesh;
  }

  createForest(): void {
    if (this.treeCount > 0) this.createTrees(this.plantFactory.createTreeMaterials(this.scene, {}));
    if (this.rockCount > 0) this.createRocks(this.rockFactory.createRockMaterial(this.scene));
    if (this.grassBladeCount > 0) this.createGrass(this.plantFactory.createGrassMaterial(this.scene));
  }

  createTrees(materials: unknown): void {
    for (let i = 0; i < this.treeCount; i += 1) {
      const height = this.prng.uniform(5, 10.5);
      const radius = this.prng.uniform(0.24, 0.55);
      const colliderRadius = radius + 0.35;
      const point = this.samplePropPlanarPoint(colliderRadius);
      if (!point) continue;

      const tree = this.plantFactory.createTreeVisual(this.scene, { height, radius, materials, prng: this.prng });
      const rotationY = this.prng.uniform(0, Math.PI * 2);
      const rotationX = this.prng.uniform(-0.025, 0.025);
      const rotationZ = this.prng.uniform(-0.035, 0.035);
      tree.quaternion.setFromEuler(new Euler(rotationX, rotationY, rotationZ, "XYZ"));
      this.orientPropVisual(tree);
      this.placeOnGround(tree, point.right, point.forward);
      this.applyRenderOrder(tree);
      this.group.add(tree);
      this.trees.push({ visual: tree, radius: colliderRadius, height });
    }
  }

  createRocks(material: unknown): void {
    for (let i = 0; i < this.rockCount; i += 1) {
      const radius = 1.2;
      const point = this.samplePropPlanarPoint(radius);
      if (!point) continue;

      const rockVisual = this.rockFactory.createGroundRockVisual(this.scene, { material, prng: this.prng });
      this.orientPropVisual(rockVisual);
      this.placeOnGround(rockVisual, point.right, point.forward, 0.35);
      this.applyRenderOrder(rockVisual);
      this.group.add(rockVisual);
      this.rocks.push({ visual: rockVisual, radius });
    }
  }

  createGrass(material: unknown): void {
    for (let i = 0; i < this.grassBladeCount; i += 1) {
      const point = this.samplePropPlanarPoint(0.1);
      if (!point) continue;

      const blade = this.plantFactory.createGrassBladeVisual(this.scene, { material, prng: this.prng });
      this.orientPropVisual(blade);
      this.placeOnGround(blade, point.right, point.forward, 0.25);
      this.applyRenderOrder(blade);
      this.group.add(blade);
    }
  }

  createTreeColliders(world: CollisionWorld): ColliderHandle[] {
    const center = new Vector3();
    const entries: ColliderHandle[] = [];

    for (let index = 0; index < this.trees.length; index += 1) {
      const { radius, height, visual } = this.trees[index];
      center.copy(visual.position);
      this.basis.addHeight(center, height * 0.5);
      entries.push(world.addCylinder({
        position: { x: center.x, y: center.y, z: center.z },
        halfHeight: height * 0.5,
        radius,
        solid: true,
      }));
    }

    return entries;
  }

  createRockColliders(world: CollisionWorld): ColliderHandle[] {
    const entries: ColliderHandle[] = [];

    for (let index = 0; index < this.rocks.length; index += 1) {
      const { radius, visual } = this.rocks[index];
      entries.push(world.addBall({
        position: visual.position,
        radius,
        solid: true,
      }));
    }

    return entries;
  }

  createColliders(world: CollisionWorld): ColliderHandle[] {
    this.disposeColliders();
    this.collisionWorld = world;
    this.colliders = [];

    registerTerrainCollider(world, this.terrainSampler);
    this.terrainRegistered = true;

    this.colliders.push(
      ...this.createTreeColliders(world),
      ...this.createRockColliders(world),
    );

    return this.colliders;
  }

  disposeColliders(): void {
    if (this.collisionWorld) {
      for (const handle of this.colliders) {
        this.collisionWorld.remove(handle);
      }
      if (this.terrainRegistered) this.collisionWorld.setTerrain(null);
    }
    this.colliders = [];
    this.collisionWorld = null;
    this.terrainRegistered = false;
  }

  dispose(): void {
    this.disposeColliders();
    this.group.destroy();
    this.terrainMesh = null;
    this.trees.length = 0;
    this.rocks.length = 0;
  }
}
