// playset/modules/world/environment — GameBlocks environment ports over the
// scene3d sim host + CollisionWorld: sampler anchor values, heightfield
// baking determinism, arena/board/natural/race-track structure and collider
// behavior. Stub visual factories are injected so this suite does not
// depend on the plant/rock factory ports.
import { describe, expect, test } from "bun:test";
import { GEOM_KIND, MAT } from "../scene3d/ops.ts";
import type { Scene3dOps } from "../scene3d/ops.ts";
import { createScene3dSim } from "../scene3d/sim.ts";
import { Scene3D } from "../scene3d/client.ts";
import { Color, Vector3 } from "../math/index.ts";
import { DEFAULT_WORLD_BASIS } from "../modules/math/world-basis.ts";
import { RandomGenerator } from "../modules/math/random-utils.ts";
import { CollisionWorld } from "../modules/physics/collision-world.ts";
import {
  normalizePlanar2D,
  planarCentroid,
  planarTangentAt,
  terrainHeight,
} from "../modules/world/environment/planar-utils.ts";
import {
  SPAWN_REGION_TYPES,
  SpawnAreaSampler,
} from "../modules/world/environment/spawn-area-sampler.ts";
import {
  ArchipelagoTerrainSampler,
  NaturalTerrainSampler,
  RoadTerrainSampler,
} from "../modules/world/environment/terrain-sampler.ts";
import {
  createTerrainMesh,
  registerTerrainCollider,
} from "../modules/world/environment/terrain-mesh-factory.ts";
import { createWorldBoundsColliders } from "../modules/world/environment/world-bounds-collider-factory.ts";
import {
  ArenaEnvironment,
  defaultPillarLayout,
  defaultRampLayout,
  defaultWallLayout,
} from "../modules/world/environment/arena-environment.ts";
import {
  BoardEnvironment,
  boardCenterOffset,
  defaultBoardOrigin,
  offsetBoardPoint,
} from "../modules/world/environment/board-environment.ts";
import {
  NaturalEnvironment,
  type PlantVisualFactoryLike,
  type RockVisualFactoryLike,
} from "../modules/world/environment/natural-environment.ts";
import { RaceTrackEnvironment } from "../modules/world/environment/race-track-environment.ts";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function makeScene(): { scene: Scene3D; ops: Scene3dOps } {
  const { ops } = createScene3dSim();
  return { scene: new Scene3D(ops), ops };
}

/** Flush the retained client, then serialize the sim's canonical state. */
function serialize(scene: Scene3D, ops: Scene3dOps): string {
  scene.flush();
  return ops.__serialize!(scene.__scene);
}

interface SerializedNode {
  id: number;
  parent: number;
  geom: number;
  mat: number;
  p: number[];
  q: number[];
  s: number[];
}

interface SerializedDoc {
  nodes: SerializedNode[];
  geoms: { id: number; kind: number; params: Record<string, unknown> }[];
  materials: { id: number; color: number; flags: number }[];
  env: {
    sun: { dir: number[]; color: number } | null;
    ambient: { sky: number; ground: number } | null;
  };
}

function parseScene(scene: Scene3D, ops: Scene3dOps): SerializedDoc {
  return JSON.parse(serialize(scene, ops)) as SerializedDoc;
}

function abgr(r: number, g: number, b: number, a = 255): number {
  return (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
}

/** Single-box stub visuals: keeps this suite decoupled from the factory ports. */
const stubPlantFactory: PlantVisualFactoryLike = {
  createTreeMaterials: () => ({ tag: "tree-mats" }),
  createTreeVisual: (scene, { height, radius }) =>
    scene.mesh(scene.box(radius, height / 2, radius), scene.material(abgr(47, 143, 47), 0)),
  createGrassMaterial: () => "grass-mat",
  createGrassBladeVisual: (scene) =>
    scene.mesh(scene.box(0.04, 0.3, 0.04), scene.material(abgr(85, 204, 102), 0)),
};

const stubRockFactory: RockVisualFactoryLike = {
  createRockMaterial: () => "rock-mat",
  createGroundRockVisual: (scene) =>
    scene.mesh(scene.box(0.6, 0.6, 0.6), scene.material(abgr(136, 136, 136), 0)),
};

// ---------------------------------------------------------------------------
// planar-utils
// ---------------------------------------------------------------------------

describe("planar-utils", () => {
  test("normalizePlanar2D normalizes and falls back on degenerate input", () => {
    expect(normalizePlanar2D(3, 4)).toEqual({ right: 0.6, forward: 0.8 });
    const fallback = { right: 0, forward: 1 };
    const out = normalizePlanar2D(0, 1e-9, fallback);
    expect(out).toEqual({ right: 0, forward: 1 });
    expect(out).not.toBe(fallback); // spread copy, not the caller's object
  });

  test("planarCentroid averages points; empty input is the origin", () => {
    expect(planarCentroid([
      { right: -20, forward: -20 },
      { right: 20, forward: -20 },
      { right: 20, forward: 20 },
      { right: -20, forward: 20 },
    ])).toEqual({ right: 0, forward: 0 });
    expect(planarCentroid([])).toEqual({ right: 0, forward: 0 });
  });

  test("planarTangentAt: closed wraps neighbors, open clamps", () => {
    const square = [
      { right: -20, forward: -20 },
      { right: 20, forward: -20 },
      { right: 20, forward: 20 },
      { right: -20, forward: 20 },
    ];
    const closed = planarTangentAt(square, 0, true);
    expect(closed.right).toBeCloseTo(Math.SQRT1_2, 12);
    expect(closed.forward).toBeCloseTo(-Math.SQRT1_2, 12);
    const open = planarTangentAt(square, 0, false);
    expect(open).toEqual({ right: 1, forward: 0 });
  });

  test("terrainHeight duck-types heightAt, sample, and absent samplers", () => {
    const point = { right: 3, forward: -4 };
    expect(terrainHeight({ heightAt: (r, f) => r + f }, point)).toBe(-1);
    expect(terrainHeight({ sample: (r, f) => ({ height: r * f }) }, point)).toBe(-12);
    expect(terrainHeight(null, point)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// spawn-area-sampler
// ---------------------------------------------------------------------------

describe("spawn-area-sampler", () => {
  const bounds = { rightMin: -10, rightMax: 10, forwardMin: -10, forwardMax: 10 };

  test("rejects points inside block regions (radius-inflated)", () => {
    const sampler = new SpawnAreaSampler({
      bounds,
      blockRegions: [{ type: SPAWN_REGION_TYPES.CIRCLE, center: { right: 0, forward: 0 }, radius: 3 }],
    });
    expect(sampler.allows({ right: 0, forward: 0 })).toBe(false);
    expect(sampler.allows({ right: 3.2, forward: 0 }, 0.5)).toBe(false); // 3.2 <= 3 + 0.5
    expect(sampler.allows({ right: 4, forward: 0 }, 0.5)).toBe(true);

    const prng = new RandomGenerator(7);
    for (let i = 0; i < 100; i += 1) {
      const point = sampler.sample(prng, 0.5)!;
      expect(point).not.toBeNull();
      expect(Math.hypot(point.right, point.forward)).toBeGreaterThan(3.5);
    }
  });

  test("returns null when every attempt lands in a block region", () => {
    const sampler = new SpawnAreaSampler({
      bounds,
      blockRegions: [{
        type: SPAWN_REGION_TYPES.RECT,
        center: { right: 0, forward: 0 },
        size: { right: 40, forward: 40 },
      }],
    });
    expect(sampler.sample(new RandomGenerator(1))).toBeNull();
  });

  test("spawn regions narrow the sample bounds and constrain results", () => {
    const sampler = new SpawnAreaSampler({
      bounds,
      spawnRegions: [{
        type: SPAWN_REGION_TYPES.RECT,
        center: { right: 5, forward: 5 },
        size: { right: 4, forward: 4 },
      }],
    });
    expect(sampler.sampleBounds).toEqual({ rightMin: 3, rightMax: 7, forwardMin: 3, forwardMax: 7 });
    const prng = new RandomGenerator(11);
    for (let i = 0; i < 50; i += 1) {
      const point = sampler.sample(prng)!;
      expect(Math.abs(point.right - 5)).toBeLessThanOrEqual(2);
      expect(Math.abs(point.forward - 5)).toBeLessThanOrEqual(2);
    }
  });

  test("segment corridors block with halfWidth + clearance + radius", () => {
    const sampler = new SpawnAreaSampler({
      bounds,
      blockRegions: [{
        type: SPAWN_REGION_TYPES.SEGMENT_CORRIDOR,
        segments: [{ start: { right: -5, forward: 0 }, end: { right: 5, forward: 0 } }],
        halfWidth: 2,
        clearance: 1,
      }],
    });
    expect(sampler.allows({ right: 0, forward: 0 })).toBe(false);
    expect(sampler.allows({ right: 0, forward: 2.9 })).toBe(false); // 2.9 <= 2 + 1
    expect(sampler.allows({ right: 0, forward: 3.5 })).toBe(true);
    expect(sampler.allows({ right: 0, forward: 3.5 }, 1)).toBe(false); // radius inflates
  });
});

// ---------------------------------------------------------------------------
// terrain-sampler (anchor values hand-derived from the formulas)
// ---------------------------------------------------------------------------

describe("terrain-sampler", () => {
  test("NaturalTerrainSampler heightAt anchors", () => {
    const sampler = new NaturalTerrainSampler({});
    // sin(0)*cos(0)*(2.2/3.6) + sin(0)*(1.4/3.6) = 0 exactly.
    expect(sampler.heightAt(0, 0)).toBe(0);
    // By hand: sin(10*0.055)*cos(5*0.047)*2.2 + sin(15*0.022)*1.4.
    const hand =
      Math.sin(10 * 0.055) * Math.cos(5 * 0.047) * (2.2 / 3.6) * 3.6 +
      Math.sin(15 * 0.022) * (1.4 / 3.6) * 3.6;
    expect(sampler.heightAt(10, 5)).toBeCloseTo(hand, 12);
    expect(sampler.heightAt(10, 5)).toBeCloseTo(1.5719660573190815, 12);
    expect(sampler.heightAt(-25, 40)).toBeCloseTo(1.1103292748486233, 12);
    // baseHeight/undulation scale linearly.
    const scaled = new NaturalTerrainSampler({ baseHeight: 2, undulation: 7.2 });
    expect(scaled.heightAt(10, 5)).toBeCloseTo(2 + 2 * 1.5719660573190815, 12);
  });

  test("NaturalTerrainSampler colorAt returns an offsetHSL-tinted Color", () => {
    const sampler = new NaturalTerrainSampler({});
    const low = sampler.colorAt(10, 5); // height 1.572 < 2.1 → 0x639b4f base
    expect(low).toBeInstanceOf(Color);
    expect(low.getHexString()).toBe("5fa251");
    expect(low.r).toBeCloseTo(0.11548020139824311, 12);
    expect(low.g).toBeCloseTo(0.3610609862040595, 12);
    expect(low.b).toBeCloseTo(0.08207616985502475, 12);
    // height 3.043 > 2.1 → 0x8fa55f base.
    expect(sampler.heightAt(-30, 62)).toBeCloseTo(3.0427288366276977, 12);
    expect(sampler.colorAt(-30, 62).getHexString()).toBe("8d9e5c");
  });

  test("NaturalTerrainSampler normalAt is the unit surface normal", () => {
    const normal = new NaturalTerrainSampler({}).normalAt(0, 0);
    expect(normal.length()).toBeCloseTo(1, 12);
    expect(normal.x).toBeCloseTo(-0.15000868859122365, 12);
    expect(normal.y).toBeCloseTo(0.9882160619147771, 12);
    expect(normal.z).toBeCloseTo(0.030436956496840344, 12);
  });

  test("RoadTerrainSampler flattens exactly to roadHeight on the road", () => {
    const sampler = new RoadTerrainSampler({
      roadSegments: [{ start: { right: 0, forward: -10 }, end: { right: 0, forward: 10 } }],
    });
    expect(sampler.distanceToRoad(3, 0)).toBe(3);
    expect(sampler.heightAt(0, 0)).toBe(0); // flatness 0.8^0 = 1 → roadHeight
    expect(sampler.heightAt(30, 0)).toBeCloseTo(3.309562447425413, 12);
  });

  test("RoadTerrainSampler colorAt is a plain {r,g,b}; seeded noise repeats", () => {
    const a = new RoadTerrainSampler({});
    const b = new RoadTerrainSampler({});
    expect(a.heightAt(10, 5)).toBeCloseTo(1.935934491820908, 12);
    expect(a.heightAt(10, 5)).toBe(b.heightAt(10, 5));
    const color = a.colorAt(10, 5);
    expect(color).not.toBeInstanceOf(Color);
    expect(Object.keys(color).sort()).toEqual(["b", "g", "r"]);
    expect(color.r).toBeCloseTo(0.14759134941739704, 12);
    expect(color.g).toBeCloseTo(0.2685548096504382, 12);
    expect(color.b).toBeCloseTo(0.13165697229608897, 12);
  });

  test("ArchipelagoTerrainSampler islands, underwater drop, color bands", () => {
    const sampler = new ArchipelagoTerrainSampler({});
    expect(sampler.heightAt(115, 90)).toBeCloseTo(139.75567504941617, 11);
    // Far offshore: submerged beyond shorelineBlend → full 18-unit floor drop.
    expect(sampler.rawHeightAt(-500, 500)).toBeCloseTo(-21.33276829669173, 11);
    expect(sampler.heightAt(-500, 500)).toBeCloseTo(sampler.rawHeightAt(-500, 500) - 18, 11);
    const peak = sampler.colorAt(115, 90); // height >= 118 band
    expect(peak).not.toBeInstanceOf(Color);
    expect(peak.r).toBeCloseTo(0.6549858115380977, 12);
    expect(peak.g).toBeCloseTo(0.6749858115380977, 12);
    expect(peak.b).toBeCloseTo(0.7149858115380976, 12);
  });
});

// ---------------------------------------------------------------------------
// terrain-mesh-factory
// ---------------------------------------------------------------------------

describe("terrain-mesh-factory", () => {
  test("throws without a sample()-capable sampler", () => {
    const { scene } = makeScene();
    expect(() =>
      createTerrainMesh({ scene, terrainSampler: {} as never }),
    ).toThrow("terrainSampler.sample");
  });

  test("splits into cullable patches when asked, one mesh otherwise", () => {
    // WHY splitting matters: an unsplit terrain's bounds span the whole map, so
    // no frustum test can reject it and it draws in full every frame — on real
    // hardware that was 72% of everything still reaching the PSP's GE.
    const auto = makeScene();
    const autoRoot = createTerrainMesh({
      scene: auto.scene,
      terrainSampler: new NaturalTerrainSampler({}),
      size: 40,
      segments: 16,
      tiles: 4,
    });
    const autoDoc = parseScene(auto.scene, auto.ops);
    const patches = autoDoc.nodes.filter((n) => n.parent === autoRoot.__id && n.geom > 0);
    expect(patches.length).toBeGreaterThan(1);
    // Patches tile the extent: every one sits inside the terrain's footprint.
    for (const p of patches) {
      expect(Math.abs(p.p[0])).toBeLessThanOrEqual(20);
      expect(Math.abs(p.p[2])).toBeLessThanOrEqual(20);
    }

    const single = makeScene();
    const singleRoot = createTerrainMesh({
      scene: single.scene,
      terrainSampler: new NaturalTerrainSampler({}),
      size: 40,
      segments: 16,
      tiles: 1,
    });
    const singleDoc = parseScene(single.scene, single.ops);
    expect(singleDoc.nodes.find((n) => n.id === singleRoot.__id)!.geom).toBeGreaterThan(0);
  });

  test("bakes a (segments+1)² heightfield with vertex colors", () => {
    const { scene, ops } = makeScene();
    const sampler = new NaturalTerrainSampler({});
    // tiles: 1 keeps the single-mesh shape this test is about; the default is
    // now an automatic split (see createTerrainMesh) and gets its own test.
    const mesh = createTerrainMesh({ scene, terrainSampler: sampler, size: 40, segments: 8, tiles: 1 });
    const doc = parseScene(scene, ops);

    const node = doc.nodes.find((n) => n.id === mesh.__id)!;
    expect(node.geom).toBeGreaterThan(0);
    const geom = doc.geoms.find((g) => g.id === node.geom)!;
    expect(geom.kind).toBe(GEOM_KIND.heightfield);
    expect(geom.params.cols).toBe(9);
    expect(geom.params.rows).toBe(9);
    expect(geom.params.w).toBe(40);
    expect(geom.params.d).toBe(40);
    expect((geom.params.heights as { len: number }).len).toBe(81);
    expect((geom.params.colors as { len: number }).len).toBe(243);
    const material = doc.materials.find((m) => m.id === node.mat)!;
    expect(material.flags).toBe(MAT.vertexColors);
  });

  test("heights/colors match a hand-built row-major bake (digest equality)", () => {
    const sampler = new NaturalTerrainSampler({});
    const { scene, ops } = makeScene();
    const mesh = createTerrainMesh({ scene, terrainSampler: sampler, size: 40, segments: 8, tiles: 1 });
    const doc = parseScene(scene, ops);
    const baked = doc.geoms.find((g) => g.id === doc.nodes.find((n) => n.id === mesh.__id)!.geom)!;

    // Expected arrays straight from the formulas, row-major (forward rows).
    const heights = new Float32Array(81);
    const colors = new Float32Array(243);
    for (let row = 0; row <= 8; row += 1) {
      for (let col = 0; col <= 8; col += 1) {
        const i = row * 9 + col;
        const right = -20 + col * 5;
        const forward = -20 + row * 5;
        const sample = sampler.sample(right, forward);
        heights[i] = sample.height;
        colors[i * 3 + 0] = sample.color.r;
        colors[i * 3 + 1] = sample.color.g;
        colors[i * 3 + 2] = sample.color.b;
      }
    }
    const ref = createScene3dSim();
    const refScene = ref.ops.sceneCreate();
    const refGeom = ref.ops.geomHeightfield(40, 40, 9, 9, heights, colors);
    const refNode = ref.ops.nodeCreate(refScene, 0);
    ref.ops.meshSet(refNode, refGeom, ref.ops.material(0, 0));
    const refDoc = JSON.parse(ref.ops.__serialize!(refScene)) as SerializedDoc;
    const expected = refDoc.geoms.find((g) => g.id === refGeom)!;

    expect(baked.params.heights).toEqual(expected.params.heights);
    expect(baked.params.colors).toEqual(expected.params.colors);
  });

  test("two runs serialize identically (determinism)", () => {
    const run = (): string => {
      const { scene, ops } = makeScene();
      createTerrainMesh({
        scene,
        terrainSampler: new NaturalTerrainSampler({}),
        size: 40,
        segments: 8,
      });
      return serialize(scene, ops);
    };
    expect(run()).toBe(run());
  });

  test("registerTerrainCollider makes the sampler the ground authority", () => {
    const world = new CollisionWorld();
    const sampler = new NaturalTerrainSampler({});
    registerTerrainCollider(world, sampler);
    expect(world.groundHeightAt(3.2, -7.5)).toBe(sampler.heightAt(3.2, -7.5));
    expect(() => registerTerrainCollider(null as never, sampler)).toThrow();
    expect(() => registerTerrainCollider(world, {} as never)).toThrow("heightAt");
  });
});

// ---------------------------------------------------------------------------
// world-bounds-collider-factory
// ---------------------------------------------------------------------------

describe("world-bounds-collider-factory", () => {
  test("adds four solid walls that block a capsule at the bounds", () => {
    const world = new CollisionWorld();
    const handles = createWorldBoundsColliders({
      world,
      minRight: -10,
      maxRight: 10,
      minForward: -10,
      maxForward: 10,
    });
    expect(handles).toHaveLength(4);
    expect(world.colliderCount).toBe(4);

    // maxRight wall spans right 10.0..11.6; capsule radius 0.5 → face at 9.5.
    const basis = DEFAULT_WORLD_BASIS;
    const out = world.resolveCapsule(
      basis.fromBasisComponents(9, 1, 0),
      basis.fromBasisComponents(10.4, 1, 0),
      { radius: 0.5, halfHeight: 1 },
    );
    expect(out.hitWall).toBe(true);
    expect(basis.rightComponent(out.position)).toBeCloseTo(9.5, 12);

    const fwd = world.resolveCapsule(
      basis.fromBasisComponents(0, 1, 9),
      basis.fromBasisComponents(0, 1, 10.4),
      { radius: 0.5, halfHeight: 1 },
    );
    expect(fwd.hitWall).toBe(true);
    expect(basis.forwardComponent(fwd.position)).toBeCloseTo(9.5, 12);
  });

  test("throws when min bounds are not below max bounds", () => {
    const world = new CollisionWorld();
    expect(() =>
      createWorldBoundsColliders({ world, minRight: 5, maxRight: 5 }),
    ).toThrow("min bounds");
  });
});

// ---------------------------------------------------------------------------
// arena-environment
// ---------------------------------------------------------------------------

describe("arena-environment", () => {
  test("default layouts carry the card-exact dimensions (worldSize 50)", () => {
    const walls = defaultWallLayout(50, 0, 3, 0.7);
    expect(walls[0]).toEqual({
      right: 0, up: 1.5, forward: 25, spanRight: 50, spanUp: 3, spanForward: 0.7,
    });
    expect(walls[2]).toEqual({
      right: -25, up: 1.5, forward: 0, spanRight: 0.7, spanUp: 3, spanForward: 50,
    });

    const pillars = defaultPillarLayout(50);
    expect(pillars).toHaveLength(8);
    expect(pillars[0].right).toBeCloseTo(10, 12);
    expect(Math.abs(pillars[0].forward)).toBeCloseTo(0, 12);
    expect(pillars[0].radius).toBeCloseTo(1, 12);
    expect(pillars[0].spanUp).toBeCloseTo(3.5, 12);
    expect(pillars[1].right).toBeCloseTo(Math.cos(Math.PI / 4) * 14, 12);
    expect(pillars[1].forward).toBeCloseTo(-Math.sin(Math.PI / 4) * 14, 12);
    expect(pillars[1].radius).toBeCloseTo(1.5, 12);
    expect(pillars[1].spanUp).toBeCloseTo(4, 12);

    const ramps = defaultRampLayout(50);
    expect(ramps[0].right).toBeCloseTo(5, 12);
    expect(ramps[0].forward).toBeCloseTo(-12, 12);
    expect(ramps[0].spanRight).toBeCloseTo(3.5, 12);
    expect(ramps[0].spanForward).toBeCloseTo(7, 12);
    expect(ramps[0].spanUp).toBeCloseTo(1.6, 12);
    expect(ramps[0].yaw).toBe(0);
    expect(ramps[1].yaw).toBe(Math.PI * 0.5);
    expect(ramps[2].yaw).toBe(Math.PI);
  });

  test("create() builds ground + grid + walls + pillars + ramps", () => {
    const { scene, ops } = makeScene();
    const env = new ArenaEnvironment({ scene, prng: new RandomGenerator(1) }).create();
    const doc = parseScene(scene, ops);

    const groupChildren = doc.nodes.filter((n) => n.parent === env.group.__id);
    expect(groupChildren).toHaveLength(1 + 1 + 4 + 8 + 3);

    // Grid: 51 lines per direction (divisions=50), thin unlit boxes.
    const gridNode = groupChildren.find(
      (n) => n.geom === 0 && doc.nodes.some((c) => c.parent === n.id),
    )!;
    const gridLines = doc.nodes.filter((n) => n.parent === gridNode.id);
    expect(gridLines).toHaveLength(102);
    const lineMats = new Set(gridLines.map((n) => n.mat));
    expect(lineMats.size).toBe(2); // major + minor
    for (const id of lineMats) {
      expect(doc.materials.find((m) => m.id === id)!.flags).toBe(MAT.unlit);
    }

    // Pillar 0 sits at (10, spanUp/2, 0) with an 18-segment cylinder geom.
    const pillar0 = env.pillarLayout[0].mesh!;
    const pillarNode = doc.nodes.find((n) => n.id === pillar0.__id)!;
    expect(pillarNode.p[0]).toBeCloseTo(10, 6);
    expect(pillarNode.p[1]).toBeCloseTo(1.75, 6);
    expect(Math.abs(pillarNode.p[2])).toBeCloseTo(0, 6);
    const pillarGeom = doc.geoms.find((g) => g.id === pillarNode.geom)!;
    expect(pillarGeom.kind).toBe(GEOM_KIND.cylinder);
    expect(pillarGeom.params).toEqual({ height: 3.5, radiusBottom: 1, radiusTop: 1, segments: 18 });

    // Ground is a worldSize² plane.
    const groundNode = groupChildren.find((n) => {
      const g = doc.geoms.find((gg) => gg.id === n.geom);
      return g?.kind === GEOM_KIND.plane;
    })!;
    expect(doc.geoms.find((g) => g.id === groundNode.geom)!.params).toEqual({ d: 50, w: 50 });
  });

  test("ramp wedge geometry: 24 duplicated corners, 8 triangles, exact verts", () => {
    const { scene } = makeScene();
    const env = new ArenaEnvironment({ scene, prng: new RandomGenerator(1) });
    const { positions, indices } = env.createRampGeometry(env.rampLayout[0]);
    expect(positions).toHaveLength(72); // 24 vertices × 3
    expect(indices).toHaveLength(24); // 8 triangles
    // Corner 0 of ramp 0 (yaw 0): right 5-1.75, up 0, forward -12+3.5 → z=8.5.
    expect(positions[0]).toBeCloseTo(3.25, 6);
    expect(positions[1]).toBeCloseTo(0, 6);
    expect(positions[2]).toBeCloseTo(8.5, 6);
    // Vertex 7 is corner 4 (top edge): up spanUp=1.6, forward -15.5 → z=15.5.
    expect(positions[21]).toBeCloseTo(3.25, 6);
    expect(positions[22]).toBeCloseTo(1.6, 6);
    expect(positions[23]).toBeCloseTo(15.5, 6);
  });

  test("createColliders: 4 walls + 8 pillars; capsule blocked by both", () => {
    const { scene } = makeScene();
    const env = new ArenaEnvironment({ scene, prng: new RandomGenerator(1) }).create();
    const world = new CollisionWorld();
    env.createColliders(world);
    expect(env.colliders).toHaveLength(12); // ground + ramps skipped (v1)
    expect(world.colliderCount).toBe(12);

    const basis = DEFAULT_WORLD_BASIS;
    // Front wall inner face at forward 24.65; capsule radius 0.4 → 24.25.
    const wallHit = world.resolveCapsule(
      basis.fromBasisComponents(0, 1, 20),
      basis.fromBasisComponents(0, 1, 24.8),
      { radius: 0.4, halfHeight: 1 },
    );
    expect(wallHit.hitWall).toBe(true);
    expect(basis.forwardComponent(wallHit.position)).toBeCloseTo(24.25, 12);
    expect(wallHit.grounded).toBe(true);
    expect(basis.upComponent(wallHit.position)).toBeCloseTo(1, 12); // feet on floor

    // Pillar 0 at (10, 0), radius 1: pushed to radius + capsule = 1.4.
    const pillarHit = world.resolveCapsule(
      basis.fromBasisComponents(12, 1, 0),
      basis.fromBasisComponents(10.2, 1, 0.3),
      { radius: 0.4, halfHeight: 1 },
    );
    expect(pillarHit.hitWall).toBe(true);
    const planar = basis.toPlanar(pillarHit.position);
    expect(Math.hypot(planar.right - 10, planar.forward - 0)).toBeCloseTo(1.4, 12);

    env.disposeColliders();
    expect(world.colliderCount).toBe(0);
    expect(env.colliders).toHaveLength(0);
  });

  test("sampleSpawn avoids pillars/ramps and lands inside the bounds", () => {
    const { scene } = makeScene();
    const env = new ArenaEnvironment({ scene, prng: new RandomGenerator(3) });
    for (let i = 0; i < 20; i += 1) {
      const spawn = env.sampleSpawn();
      const planar = env.basis.toPlanar(spawn);
      expect(planar.right).toBeGreaterThanOrEqual(env.bounds.minRight);
      expect(planar.right).toBeLessThanOrEqual(env.bounds.maxRight);
      expect(planar.forward).toBeGreaterThanOrEqual(env.bounds.minForward);
      expect(planar.forward).toBeLessThanOrEqual(env.bounds.maxForward);
      expect(env.isPlanarPointBlockedByGeometry(planar.right, planar.forward)).toBe(false);
      expect(env.basis.upComponent(spawn)).toBe(0);
    }
    // Exclusion radius rejects candidates near the excluded position.
    const exclude = env.basis.fromBasisComponents(0, 0, 0);
    for (let i = 0; i < 20; i += 1) {
      const spawn = env.sampleSpawn(exclude, 8);
      const planar = env.basis.toPlanar(spawn);
      const isFallback = planar.right === 0 && planar.forward === 0;
      if (!isFallback) {
        expect(Math.hypot(planar.right, planar.forward)).toBeGreaterThanOrEqual(8);
      }
    }
  });

  test("dispose() destroys the whole node tree and clears colliders", () => {
    const { scene, ops } = makeScene();
    const env = new ArenaEnvironment({ scene, prng: new RandomGenerator(1) }).create();
    const world = new CollisionWorld();
    env.createColliders(world);
    env.dispose();
    expect(world.colliderCount).toBe(0);
    expect(parseScene(scene, ops).nodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// board-environment
// ---------------------------------------------------------------------------

describe("board-environment", () => {
  test("board math helpers", () => {
    expect(boardCenterOffset(20, 20, 1)).toEqual({ right: 9.5, forward: 9.5 });
    const origin = defaultBoardOrigin(20, 1);
    expect([origin.x, origin.y, origin.z]).toEqual([0, 0, 19]);
    const moved = offsetBoardPoint(origin, 2, 1, 3);
    expect([moved.x, moved.y, moved.z]).toEqual([2, 1, 16]);
  });

  test("cellToWorldPoint round-trips through planar space", () => {
    const env = new BoardEnvironment({}); // scene-less: board math only
    expect(env.group).toBeNull();
    const basis = env.basis;
    const originPlanar = basis.toPlanar(env.origin);
    for (const cell of [
      { right: 0, forward: 0 },
      { right: 3, forward: 5 },
      { right: 19, forward: 19 },
      { right: 7, forward: 12 },
    ]) {
      const point = env.cellToWorldPoint(cell, 0.25);
      const planar = basis.toPlanar(point);
      expect((planar.right - originPlanar.right) / env.cellSize).toBeCloseTo(cell.right, 12);
      expect((planar.forward - originPlanar.forward) / env.cellSize).toBeCloseTo(cell.forward, 12);
      expect(basis.upComponent(point)).toBeCloseTo(0.25, 12);
    }
  });

  test("sanitizes sizes and freezes bounds", () => {
    const env = new BoardEnvironment({ columns: 1.9, rows: 0, cellSize: 0.001, backgroundScale: 0.5 });
    expect(env.columns).toBe(2);
    expect(env.rows).toBe(2);
    expect(env.cellSize).toBe(0.01);
    expect(env.backgroundScale).toBe(1);
    expect(Object.isFrozen(env.bounds)).toBe(true);
    expect(env.bounds).toEqual({ minRight: 0, maxRight: 1, minForward: 0, maxForward: 1 });
  });

  test("create() bakes ground plane, scaled translucent grid, and lights", () => {
    const { scene, ops } = makeScene();
    const env = new BoardEnvironment({ scene, columns: 20, rows: 10 }).create();
    expect(env.create()).toBe(env); // idempotent
    const doc = parseScene(scene, ops);

    const groupChildren = doc.nodes.filter((n) => n.parent === env.group!.__id);
    expect(groupChildren).toHaveLength(2); // ground + grid

    const ground = doc.nodes.find((n) => n.id === env.boardMesh!.__id)!;
    expect(doc.geoms.find((g) => g.id === ground.geom)!.params).toEqual({ d: 25, w: 50 });
    expect(ground.p[1]).toBeCloseTo(-0.5, 6);

    // Grid: 21 lines per direction under a (1, 1, 0.5)-scaled node.
    const grid = doc.nodes.find((n) => n.id === env.gridHelper!.__id)!;
    expect(grid.s).toEqual([1, 1, 0.5]);
    expect(grid.p[1]).toBeCloseTo(-0.49, 6);
    const lines = doc.nodes.filter((n) => n.parent === grid.id);
    expect(lines).toHaveLength(42);
    const lineMat = doc.materials.find((m) => m.id === lines[0].mat)!;
    expect(lineMat.flags).toBe(MAT.unlit | MAT.transparent);
    expect(lineMat.color).toBe(abgr(255, 255, 255, 77)); // gridOpacity 0.3

    // Lights: intensity-scaled colors; sun aims from the key light at center.
    expect(doc.env.ambient).toEqual({ sky: abgr(153, 153, 153), ground: abgr(153, 153, 153) });
    expect(doc.env.sun!.color).toBe(abgr(179, 179, 179));
    // origin (0,0,9); light = origin+(20,18,-20); center = origin+(9.5,0,-4.5).
    const dir = new Vector3(-10.5, -18, 15.5).normalize();
    expect(doc.env.sun!.dir[0]).toBeCloseTo(dir.x, 4);
    expect(doc.env.sun!.dir[1]).toBeCloseTo(dir.y, 4);
    expect(doc.env.sun!.dir[2]).toBeCloseTo(dir.z, 4);
    expect(env.keyLight!.direction!.length()).toBeCloseTo(1, 12);
  });

  test("lighting: false emits no sun/ambient", () => {
    const { scene, ops } = makeScene();
    new BoardEnvironment({ scene, lighting: false }).create();
    const doc = parseScene(scene, ops);
    expect(doc.env.sun).toBeNull();
    expect(doc.env.ambient).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// natural-environment (stub factories: no dependency on the factory ports)
// ---------------------------------------------------------------------------

describe("natural-environment", () => {
  function buildNatural(): { scene: Scene3D; ops: Scene3dOps; env: NaturalEnvironment } {
    const { scene, ops } = makeScene();
    const env = new NaturalEnvironment({
      scene,
      prng: new RandomGenerator(42),
      plantFactory: stubPlantFactory,
      rockFactory: stubRockFactory,
    }).create();
    return { scene, ops, env };
  }

  test("seed 42 produces the default prop counts (155/36/260)", () => {
    const { scene, ops, env } = buildNatural();
    expect(env.trees).toHaveLength(155);
    expect(env.rocks).toHaveLength(36);
    const doc = parseScene(scene, ops);
    const children = doc.nodes.filter((n) => n.parent === env.group.__id);
    expect(children).toHaveLength(1 + 155 + 36 + 260); // terrain + props

    // Props stand on the terrain: up == sampler height (+extra for rocks).
    const tree = env.trees[0];
    const treePlanar = env.basis.toPlanar(tree.visual.position);
    expect(env.basis.upComponent(tree.visual.position)).toBeCloseTo(
      env.terrainSampler.heightAt(treePlanar.right, treePlanar.forward),
      12,
    );
    const rock = env.rocks[0];
    const rockPlanar = env.basis.toPlanar(rock.visual.position);
    expect(env.basis.upComponent(rock.visual.position)).toBeCloseTo(
      env.terrainSampler.heightAt(rockPlanar.right, rockPlanar.forward) + 0.35,
      12,
    );
    expect(rock.radius).toBe(1.2);

    // Placement stays inside ±0.48·terrainSize.
    for (const entry of env.trees) {
      const p = env.basis.toPlanar(entry.visual.position);
      expect(Math.abs(p.right)).toBeLessThanOrEqual(0.48 * 180);
      expect(Math.abs(p.forward)).toBeLessThanOrEqual(0.48 * 180);
    }
  });

  test("identical seeds serialize identically twice (determinism golden)", () => {
    const a = buildNatural();
    const b = buildNatural();
    expect(serialize(a.scene, a.ops)).toBe(serialize(b.scene, b.ops));
  });

  test("createColliders: terrain authority + tree cylinders + rock balls", () => {
    const { env } = buildNatural();
    const world = new CollisionWorld();
    env.createColliders(world);
    expect(env.colliders).toHaveLength(155 + 36);
    expect(world.colliderCount).toBe(191);
    expect(world.groundHeightAt(4, -9)).toBe(env.terrainSampler.heightAt(4, -9));

    env.disposeColliders();
    expect(world.colliderCount).toBe(0);
    expect(world.groundHeightAt(4, -9)).toBe(0); // terrain authority cleared
  });

  test("block regions veto placement (spawn sampler rejection end-to-end)", () => {
    const { scene, ops } = makeScene();
    const env = new NaturalEnvironment({
      scene,
      prng: new RandomGenerator(42),
      plantFactory: stubPlantFactory,
      rockFactory: stubRockFactory,
      propBlockRegions: [{
        type: SPAWN_REGION_TYPES.RECT,
        center: { right: 0, forward: 0 },
        size: { right: 400, forward: 400 },
      }],
    }).create();
    expect(env.trees).toHaveLength(0);
    expect(env.rocks).toHaveLength(0);
    const doc = parseScene(scene, ops);
    expect(doc.nodes.filter((n) => n.parent === env.group.__id)).toHaveLength(1); // terrain only
  });

  test("dispose() tears down nodes, collider handles and terrain authority", () => {
    const { scene, ops, env } = buildNatural();
    const world = new CollisionWorld();
    env.createColliders(world);
    env.dispose();
    expect(world.colliderCount).toBe(0);
    expect(parseScene(scene, ops).nodes).toHaveLength(0);
    expect(env.trees).toHaveLength(0);
    expect(env.terrainMesh).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// race-track-environment
// ---------------------------------------------------------------------------

describe("race-track-environment", () => {
  const square = [
    { right: -20, forward: -20 },
    { right: 20, forward: -20 },
    { right: 20, forward: 20 },
    { right: -20, forward: 20 },
  ];
  const lightNatural = {
    terrainSize: 180,
    terrainSegments: 8,
    treeCount: 0,
    rockCount: 0,
    grassBladeCount: 0,
    renderOrder: 0,
    prng: new RandomGenerator(42),
    plantFactory: stubPlantFactory,
    rockFactory: stubRockFactory,
  };

  function buildTrack(): { scene: Scene3D; ops: Scene3dOps; env: RaceTrackEnvironment } {
    const { scene, ops } = makeScene();
    const env = new RaceTrackEnvironment({
      scene,
      trackPlanarPoints: square,
      naturalEnvironmentConfig: { ...lightNatural, prng: new RandomGenerator(42) },
    }).create();
    return { scene, ops, env };
  }

  test("checkpoints ride the road-flattened terrain", () => {
    const { env } = buildTrack();
    expect(env.roadSegments).toHaveLength(4);
    expect(env.checkpoints.map((c) => c.id)).toEqual(["cp_1", "cp_2", "cp_3", "cp_4"]);
    for (const cp of env.checkpoints) {
      expect(cp.radius).toBe(7.5);
      // Track points sit ON the road: flatness 1 → height == roadHeight (0).
      expect(env.terrainSampler.heightAt(cp.right, cp.forward)).toBe(0);
      expect(env.basis.upComponent(cp.position)).toBe(0);
    }
    // Road prop clearance becomes a segment-corridor block region.
    const sampler = env.naturalEnvironment.propSpawnAreaSampler;
    expect(sampler.blockRegions).toHaveLength(1);
    expect(sampler.allows({ right: -20, forward: -20 })).toBe(false); // on the road
    expect(sampler.allows({ right: 0, forward: 0 })).toBe(true); // square center
  });

  test("gates: one per checkpoint, 2 posts + crossbar + 2 flags each", () => {
    const { scene, ops, env } = buildTrack();
    const doc = parseScene(scene, ops);
    const gates = doc.nodes.filter((n) => n.parent === env.checkpointMarkers!.__id);
    expect(gates).toHaveLength(4);
    for (const gate of gates) {
      expect(doc.nodes.filter((n) => n.parent === gate.id)).toHaveLength(5);
    }
    // Post geometry is the card's cylinder(0.08, 0.08, 4, 12).
    const gateChild = doc.nodes.filter((n) => n.parent === gates[0].id);
    const postGeoms = gateChild
      .map((n) => doc.geoms.find((g) => g.id === n.geom)!)
      .filter((g) => g.kind === GEOM_KIND.cylinder);
    expect(postGeoms).toHaveLength(2);
    expect(postGeoms[0].params).toEqual({ height: 4, radiusBottom: 0.08, radiusTop: 0.08, segments: 12 });
  });

  test("barrier posts/rails follow the postSpacing math (76 outer + 48 inner)", () => {
    const { env } = buildTrack();
    // Outer path: corners pushed 7 diagonally outward → side 40 + 14/√2 =
    // 49.899…; floor(/2.5) = 19 posts per segment × 4. Inner: 30.100… → 12.
    expect(env.barriers!.posts).toHaveLength(76 + 48);
    expect(env.barriers!.rails).toHaveLength(76 + 48); // closed loop wraps
    const post = env.barriers!.posts[0];
    expect(post.radius).toBeCloseTo(0.42, 12);
    expect(post.height).toBe(1.2);
    const rail = env.barriers!.rails[0];
    expect(rail.spanRight).toBeCloseTo(0.192, 12);
    expect(rail.spanUp).toBeCloseTo(0.192, 12);
    expect(rail.spanForward).toBeCloseTo(2.5, 6); // one postSpacing apart

    const world = new CollisionWorld();
    env.createColliders(world);
    expect(env.colliders).toHaveLength(124 + 124);
    expect(world.colliderCount).toBe(248);
    // Terrain authority delegated through the composed NaturalEnvironment.
    expect(world.groundHeightAt(-20, -20)).toBe(0);

    env.disposeColliders();
    expect(world.colliderCount).toBe(0);
  });

  test("spawnPose: indices wrap, frame faces the previous→current tangent", () => {
    const { env } = buildTrack();
    const pose = env.spawnPose(0, true, 5, 1, 0.5);
    expect(pose.startIndex).toBe(0);
    expect(pose.prevIndex).toBe(3);
    expect(pose.nextIndex).toBe(1);
    expect(pose.prevCheckpointId).toBe("cp_4");
    expect(pose.startCheckpointId).toBe("cp_1");
    expect(pose.nextCheckpointId).toBe("cp_2");
    expect(pose.clockwise).toBe(true);
    // cp_4 (-20,20) → cp_1 (-20,-20): forward is -forward planar → world +Z.
    expect(Math.abs(pose.yaw)).toBeCloseTo(Math.PI, 12);
    expect(pose.forward.z).toBeCloseTo(1, 12);
    expect(pose.right.x).toBeCloseTo(-1, 12);
    // 5 back along forward, 1 along right, 0.5 up from the (flat) road.
    expect(pose.position.x).toBeCloseTo(-21, 12);
    expect(pose.position.z).toBeCloseTo(15, 12);
    expect(pose.position.y).toBeCloseTo(0.5, 12);
    // Wrapping start index.
    expect(env.spawnPose(5, false, 0, 0, 0).startIndex).toBe(1);
  });

  test("dispose() removes the composed environment and all track nodes", () => {
    const { scene, ops, env } = buildTrack();
    const world = new CollisionWorld();
    env.createColliders(world);
    env.dispose();
    expect(world.colliderCount).toBe(0);
    expect(parseScene(scene, ops).nodes).toHaveLength(0);
    expect(env.barriers).toBeNull();
    expect(env.checkpointMarkers).toBeNull();
  });
});
