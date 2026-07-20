// playset/test/world-objects.test.ts — world object/factory/visual-effects
// ports against the scene3d sim host: structure numbers straight from the
// GameBlocks porting cards, stepped behavior with hand-checked math, and
// determinism goldens for the prng-driven builders.

import { describe, expect, test } from "bun:test";
import { Color, SRGBColorSpace } from "../math/color.ts";
import { Euler } from "../math/euler.ts";
import { Quaternion } from "../math/quaternion.ts";
import { Vector3 } from "../math/vector3.ts";
import { MAT, Scene3D } from "../scene3d/client.ts";
import { createScene3dSim } from "../scene3d/sim.ts";
import { RandomGenerator } from "../modules/math/random-utils.ts";
import { smoothingAlpha } from "../modules/math/scalar-utils.ts";
import { fadeRgbToAbgr, rgbFloatsToAbgr, rgbToAbgr } from "../modules/world/color-utils.ts";
import { disposeObject3D, disposeSceneNode } from "../modules/world/scene-node-utils.ts";
import { createBlobShadow, updateBlobShadow } from "../modules/world/blob-shadow.ts";
import { PickupObject } from "../modules/world/object/pickup-object.ts";
import { ProjectileObject } from "../modules/world/object/projectile-object.ts";
import { FpsWeaponViewModel } from "../modules/world/object/fps-weapon-view-model.ts";
import { HealthBarView } from "../modules/world/object/health-bar-view.ts";
import { createAirplaneVisual } from "../modules/world/object/factory/airplane-visual-factory.ts";
import { createCarVisual } from "../modules/world/object/factory/car-visual-factory.ts";
import {
  buildAmmoPickupVisual,
  buildArmorPickupVisual,
  buildHealthPickupVisual,
  createPickupVisual,
} from "../modules/world/object/factory/pickup-visual-factory.ts";
import {
  createGrassBladeVisual,
  createTreeMaterials,
  createTreeVisual,
} from "../modules/world/object/factory/plant-visual-factory.ts";
import {
  createBulletProjectileVisual,
  createMissileProjectileVisual,
} from "../modules/world/object/factory/projectile-visual-factory.ts";
import {
  createGroundRockVisual,
  createIrregularRockVisual,
} from "../modules/world/object/factory/rock-visual-factory.ts";
import { GroundClickIndicator } from "../modules/world/visual-effects/ground-click-indicator.ts";
import { JetFlameLocalVisual } from "../modules/world/visual-effects/jet-flame.ts";
import { VehicleTireMarkRenderer } from "../modules/world/visual-effects/vehicle-tire-mark-renderer.ts";
import { WeaponEffectsSystem } from "../modules/world/visual-effects/weapon-effects-system.ts";
import type { SimScene } from "../scene3d/sim.ts";

function makeScene(): { scene: Scene3D; world: () => SimScene; serialize: () => string } {
  const sim = createScene3dSim();
  const scene = new Scene3D(sim.ops);
  return {
    scene,
    world: () => sim.worldOf(scene.__scene),
    serialize: () => sim.ops.__serialize!(scene.__scene),
  };
}

type SerializedDoc = {
  nodes: { id: number; geom: number; mat: number }[];
  geoms: { id: number; kind: number; params: Record<string, number> }[];
  materials: { id: number; color: number; flags: number }[];
};

// ---------------------------------------------------------------------------
// scene-node-utils
// ---------------------------------------------------------------------------

describe("scene-node-utils", () => {
  test("disposeSceneNode destroys the subtree; alias + null tolerated", () => {
    const { scene, world } = makeScene();
    const root = scene.node();
    scene.node(root);
    scene.node(root);
    expect(world().nodes.size).toBe(3);
    disposeSceneNode(root);
    expect(world().nodes.size).toBe(0);
    disposeSceneNode(null); // no throw
    expect(disposeObject3D).toBe(disposeSceneNode);
  });
});

// ---------------------------------------------------------------------------
// blob shadow (new helper)
// ---------------------------------------------------------------------------

describe("blob-shadow", () => {
  test("flattened dark unlit-transparent disc, positioned at ground height", () => {
    const { scene, world, serialize } = makeScene();
    const shadow = createBlobShadow(scene, { radius: 1.5, opacity: 0.5 });
    updateBlobShadow(shadow, 2.5, { x: 3, z: -4 });
    scene.flush();

    const n = world().nodes.get(shadow.__id)!;
    expect(n.p).toEqual([3, Math.fround(2.52), -4]);
    expect(n.s).toEqual([1, Math.fround(0.02), 1]);

    const doc = JSON.parse(serialize()) as SerializedDoc;
    const mat = doc.materials.find((m) => m.id === n.matId)!;
    expect(mat.color).toBe(rgbToAbgr(0x000000, 0.5));
    expect(mat.flags).toBe(MAT.unlit | MAT.transparent);
    const geom = doc.geoms.find((g) => g.id === n.geomId)!;
    expect(geom.params.radiusTop).toBe(1.5);
    expect(geom.params.radiusBottom).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// PickupObject + PickupVisualFactory
// ---------------------------------------------------------------------------

describe("PickupVisualFactory", () => {
  test("variant node counts, radii and card colors", () => {
    const { scene, world, serialize } = makeScene();
    const ammo = buildAmmoPickupVisual(scene);
    const health = buildHealthPickupVisual(scene);
    const armor = buildArmorPickupVisual(scene);
    scene.flush();

    const w = world();
    expect(ammo.radius).toBe(0.85);
    expect(health.radius).toBe(0.8);
    expect(armor.radius).toBe(0.82);
    expect(w.nodes.get(ammo.mesh.__id)!.children).toHaveLength(2);
    expect(w.nodes.get(health.mesh.__id)!.children).toHaveLength(3);
    expect(w.nodes.get(armor.mesh.__id)!.children).toHaveLength(2);

    // belt sits at y=0.16; cross parts at z=0.3825; armor ring lies flat.
    const belt = w.nodes.get(w.nodes.get(ammo.mesh.__id)!.children[1])!;
    expect(belt.p[1]).toBeCloseTo(0.16, 6); // poses ride as f32
    const cross = w.nodes.get(w.nodes.get(health.mesh.__id)!.children[1])!;
    expect(cross.p[2]).toBeCloseTo(0.3825, 6);
    const ring = w.nodes.get(w.nodes.get(armor.mesh.__id)!.children[1])!;
    expect(ring.q[0]).toBeCloseTo(Math.sin(Math.PI / 4), 6);

    const doc = JSON.parse(serialize()) as SerializedDoc;
    const colors = doc.materials.map((m) => m.color);
    for (const hex of [0x4b7b51, 0xd9e56a, 0xaa1f24, 0xffffff, 0x2d66ff, 0x77a3ff]) {
      expect(colors).toContain(rgbToAbgr(hex));
    }
  });

  test("createPickupVisual dispatches on type ('armor' fallback)", () => {
    const { scene } = makeScene();
    expect(createPickupVisual(scene, { type: "ammo" }).radius).toBe(0.85);
    expect(createPickupVisual(scene, { type: "health" }).radius).toBe(0.8);
    expect(createPickupVisual(scene, { type: "anything-else" }).radius).toBe(0.82);
  });
});

describe("PickupObject", () => {
  test("placement, bob height and world-axis spin math", () => {
    const { scene, world } = makeScene();
    const visual = buildArmorPickupVisual(scene);
    const pickup = new PickupObject({
      pickupVisual: visual,
      position: { x: 3, y: 9, z: -2 },
      scale: 2,
    });
    expect(pickup.radius).toBeCloseTo(1.64, 12);
    expect(pickup.group.position.y).toBe(0.5); // floorUp 0 + 0.5
    expect(pickup.baseHeight).toBe(0.5);

    pickup.animate(1 / 60);
    const phase = 3.2 / 60;
    expect(pickup.group.position.y).toBeCloseTo(0.5 + Math.sin(phase) * 0.12, 12);
    const halfSpin = (1.8 / 60) / 2;
    expect(pickup.group.quaternion.y).toBeCloseTo(Math.sin(halfSpin), 12);
    expect(pickup.group.quaternion.w).toBeCloseTo(Math.cos(halfSpin), 12);

    pickup.animate(1 / 60); // same-axis spins accumulate
    expect(pickup.group.quaternion.y).toBeCloseTo(Math.sin(2 * halfSpin), 12);

    pickup.dispose();
    expect(world().nodes.has(visual.mesh.__id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProjectileObject
// ---------------------------------------------------------------------------

describe("ProjectileObject", () => {
  const makeVisual = () => {
    const states: { z: number; age: number }[] = [];
    return {
      states,
      visual: {
        group: { destroy(): void {} },
        step(s: { position: Vector3; ageSeconds: number }): void {
          states.push({ z: s.position.z, age: s.ageSeconds });
        },
      },
    };
  };

  test("linear motion integrates velocity, expires at lifetime", () => {
    const { states, visual } = makeVisual();
    const p = new ProjectileObject({
      visual,
      position: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      speed: 10,
      lifetimeSeconds: 0.25,
      hitRadius: 0.5,
    });
    expect(states).toHaveLength(1); // constructor sync
    p.step([], 0.1);
    expect(p.position.z).toBeCloseTo(-1, 12);
    p.step([], 0.1);
    expect(p.position.z).toBeCloseTo(-2, 12);
    expect(p.active).toBe(true);
    p.step([], 0.1); // age 0.3 >= 0.25
    expect(p.active).toBe(false);
    expect(states[states.length - 1].age).toBeCloseTo(0.3, 12);
  });

  test("hit detection deactivates and reports the target", () => {
    const { visual } = makeVisual();
    const p = new ProjectileObject({
      visual,
      position: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      speed: 10,
      lifetimeSeconds: 5,
      hitRadius: 0.5,
    });
    const target = { position: { x: 0, y: 0, z: -1.2 }, destroyed: false };
    const r = p.step([target], 0.1); // lands at z=-1, within 0.5 of -1.2
    expect(r.hittedTarget).toBe(target);
    expect(p.active).toBe(false);
  });

  test("homing turns velocity toward the target (turnResponse·dt clamped)", () => {
    const { visual } = makeVisual();
    const target = { position: { x: 10, y: 0, z: 0 }, destroyed: false };
    const p = new ProjectileObject({
      visual,
      position: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      speed: 5,
      target,
      lifetimeSeconds: 5,
      hitRadius: 0.1,
      turnResponse: 10,
    });
    p.step([], 0.1); // alpha = clamp(1) → velocity snaps to desired (5,0,0)
    expect(p.velocity.x).toBeCloseTo(5, 12);
    expect(p.velocity.z).toBeCloseTo(0, 12);
    expect(p.position.x).toBeCloseTo(0.5, 12);
  });
});

// ---------------------------------------------------------------------------
// FpsWeaponViewModel
// ---------------------------------------------------------------------------

describe("FpsWeaponViewModel", () => {
  test("builds the 3-part viewmodel and follows the camera at rest", () => {
    const { scene, world } = makeScene();
    const vm = new FpsWeaponViewModel({ scene });
    expect(world().nodes.size).toBe(4); // group + body + slide + barrel

    const camera = { position: new Vector3(1, 2, 3), quaternion: new Quaternion() };
    const out = vm.step(camera, 1 / 60);
    // currentOffset starts AT normalOffset (0.25, -0.4, -0.25):
    // world = camera + (x, y, -z) = (1.25, 1.6, 3.25).
    expect(out.position.x).toBeCloseTo(1.25, 12);
    expect(out.position.y).toBeCloseTo(1.6, 12);
    expect(out.position.z).toBeCloseTo(3.25, 12);
    expect(out.quaternion.w).toBeCloseTo(1, 12);
    expect(vm.group.position.x).toBeCloseTo(1.25, 12);
  });

  test("kick + recovery lerp and scoped offset lag are exact", () => {
    const { scene } = makeScene();
    const vm = new FpsWeaponViewModel({ scene, prng: { random: () => 0.5 } });
    const camera = { position: new Vector3(), quaternion: new Quaternion() };

    vm.kick(); // pitch 0.03, yaw 0 (random 0.5), kick 0.035
    expect(vm.recoil.pitch).toBeCloseTo(0.03, 12);
    expect(vm.recoil.yaw).toBe(0);
    expect(vm.recoil.kick).toBeCloseTo(0.035, 12);

    const dt = 1 / 60;
    const out = vm.step(camera, dt);
    const pitch = 0.03 * (1 - smoothingAlpha(0.08, dt));
    const kick = 0.035 * (1 - smoothingAlpha(0.06, dt));
    expect(out.recoil.pitch).toBeCloseTo(pitch, 12);
    expect(out.recoil.kick).toBeCloseTo(kick, 12);
    // kickback pushes the viewmodel backward: z = -(offsetZ - kick) = 0.25 + kick
    expect(out.position.z).toBeCloseTo(0.25 + kick, 12);
    // recoil pitch is a local rotation after the camera quaternion
    expect(out.quaternion.x).toBeCloseTo(Math.sin(-pitch / 2), 12);

    vm.setState(false, false, false, true, true); // scoping
    const out2 = vm.step(camera, dt);
    const a = smoothingAlpha(0.10, dt);
    expect(out2.position.x).toBeCloseTo(0.25 + (0 - 0.25) * a, 12);
  });
});

// ---------------------------------------------------------------------------
// HealthBarView
// ---------------------------------------------------------------------------

describe("HealthBarView", () => {
  test("fill scale/anchor and threshold colors at ratios 1.0 / 0.5 / 0.2", () => {
    const { scene, world } = makeScene();
    const hb = new HealthBarView({ scene });
    expect(hb.segments).toHaveLength(7);
    expect(world().nodes.size).toBe(11); // group + back + fill + frame + 7

    const cam = new Quaternion();
    const at = (current: number) =>
      hb.step({ position: { x: 1, y: 0, z: 2 }, cameraQuaternion: cam, current, max: 100 });

    at(100);
    expect(hb.group.position.y).toBeCloseTo(3.15, 12);
    expect(hb.fill.scale.x).toBeCloseTo(1.86, 12);
    expect(hb.fill.position.x).toBeCloseTo(0, 12); // full bar centered
    expect(world().nodes.get(hb.fill.__id)!.tint).toBe(rgbToAbgr(0x7dff8a));

    at(50);
    expect(hb.fill.scale.x).toBeCloseTo(0.93, 12);
    expect(hb.fill.position.x).toBeCloseTo(-0.93 + 0.465, 12); // left-anchored
    expect(world().nodes.get(hb.fill.__id)!.tint).toBe(rgbToAbgr(0xffd86b));

    at(20);
    expect(hb.fill.scale.x).toBeCloseTo(0.372, 12);
    expect(world().nodes.get(hb.fill.__id)!.tint).toBe(rgbToAbgr(0xff6767));

    // billboard = copying the camera quaternion each step
    const q = new Quaternion().setFromEuler(new Euler(0, 0.7, 0));
    hb.step({ position: { x: 0, y: 0, z: 0 }, cameraQuaternion: q, current: 100, max: 100 });
    expect(hb.group.quaternion.y).toBeCloseTo(q.y, 12);

    hb.step({ position: { x: 0, y: 0, z: 0 }, cameraQuaternion: q, current: 1, max: 100, visible: false });
    expect(world().nodes.get(hb.group.__id)!.visible).toBe(false);
  });

  test("segment dividers sit at fillWidth·i/segmentCount from the left edge", () => {
    const { scene } = makeScene();
    const hb = new HealthBarView({ scene });
    for (let i = 1; i <= 7; i += 1) {
      expect(hb.segments[i - 1].position.x).toBeCloseTo(-0.93 + (1.86 * i) / 8, 12);
    }
  });
});

// ---------------------------------------------------------------------------
// CarVisualFactory
// ---------------------------------------------------------------------------

describe("CarVisualFactory", () => {
  test("4 wheel pivots at card offsets; spin/steer via mirror writes", () => {
    const { scene, world } = makeScene();
    const car = createCarVisual(scene);
    expect(car.wheels).toHaveLength(4);
    expect(car.wheelPivots).toHaveLength(4);
    expect(car.forwardArrow).toBeNull();
    expect(car.wheelPivots.map((p) => [p.position.x, p.position.y, p.position.z])).toEqual([
      [-0.84, 0.26, -1.07],
      [0.84, 0.26, -1.07],
      [-0.84, 0.26, 1.07],
      [0.84, 0.26, 1.07],
    ]);

    // CarModelController-shaped writes: spin about X, steer about Y.
    car.wheels[0].quaternion.setFromEuler(new Euler(0.4, 0, 0));
    car.wheelPivots[0].quaternion.setFromEuler(new Euler(0, 0.3, 0));
    scene.flush();

    const w = world();
    const spin = w.nodes.get(car.wheels[0].__id)!;
    expect(spin.q[0]).toBeCloseTo(Math.sin(0.2), 6);
    expect(spin.q[3]).toBeCloseTo(Math.cos(0.2), 6);
    const steer = w.nodes.get(car.wheelPivots[0].__id)!;
    expect(steer.q[1]).toBeCloseTo(Math.sin(0.15), 6);

    // wheel spin node carries a rotateZ(π/2)-baked cylinder child (axle // X)
    const axle = w.nodes.get(spin.children[0])!;
    expect(axle.q[2]).toBeCloseTo(Math.sin(Math.PI / 4), 6);
    expect(axle.q[3]).toBeCloseTo(Math.cos(Math.PI / 4), 6);

    // body at y 0.42, cabin at (0, 0.83, -0.1)
    const group = w.nodes.get(car.group.__id)!;
    const body = w.nodes.get(group.children[0])!;
    const cabin = w.nodes.get(group.children[1])!;
    expect(body.p[1]).toBeCloseTo(0.42, 6);
    expect(cabin.p).toEqual([0, Math.fround(0.83), Math.fround(-0.1)]);
  });

  test("forwardArrow debug aid appears only when arrowColor is set", () => {
    const { scene, world } = makeScene();
    const car = createCarVisual(scene, { arrowColor: 0x00ff00 });
    expect(car.forwardArrow).not.toBeNull();
    expect(world().nodes.get(car.forwardArrow!.__id)!.children).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AirplaneVisualFactory
// ---------------------------------------------------------------------------

describe("AirplaneVisualFactory", () => {
  test("default part counts, scale 8, analytic recenter, 2 jet flames", () => {
    const { scene, world } = makeScene();
    const plane = createAirplaneVisual(scene);
    scene.flush();

    // group + airframe + 9 parts + 2 flames × 4 nodes = 19
    expect(world().nodes.size).toBe(19);
    expect(plane.jetFlames).toHaveLength(2);
    expect(plane.targetRing).toBeNull();

    const w = world();
    expect(w.nodes.get(plane.group.__id)!.s).toEqual([8, 8, 8]);
    const airframe = w.nodes.get(plane.airframe.__id)!;
    expect(airframe.p[0]).toBeCloseTo(0, 6);
    expect(airframe.p[1]).toBeCloseTo(-0.315, 6);
    expect(airframe.p[2]).toBeCloseTo(0.4525, 6);

    const flames = plane.jetFlames.map((f) => w.nodes.get(f.group.__id)!);
    expect(flames[0].p).toEqual([Math.fround(-0.34), Math.fround(-0.1), Math.fround(1.78)]);
    expect(flames[1].p).toEqual([Math.fround(0.34), Math.fround(-0.1), Math.fround(1.78)]);
  });

  test("optional canopy/centroid/target ring toggle node structure", () => {
    const { scene, world, serialize } = makeScene();
    const plane = createAirplaneVisual(scene, {
      showCanopy: false,
      showJetFlames: false,
      showCentroid: true,
      showTargetRing: true,
    });
    scene.flush();
    // group + airframe + 8 parts (no canopy) + centroid + ring = 12
    expect(world().nodes.size).toBe(12);
    expect(plane.targetRing).not.toBeNull();

    const doc = JSON.parse(serialize()) as SerializedDoc;
    const ringNode = doc.nodes.find((n) => n.id === plane.targetRing!.__id)!;
    const torus = doc.geoms.find((g) => g.id === ringNode.geom)!;
    expect(torus.params.radius).toBeCloseTo(2.15, 6);
    expect(torus.params.tube).toBeCloseTo(0.035, 6);
  });
});

// ---------------------------------------------------------------------------
// PlantVisualFactory
// ---------------------------------------------------------------------------

describe("PlantVisualFactory", () => {
  test("seed 42 → identical serialized tree twice (determinism golden)", () => {
    const run = (): string => {
      const { scene, serialize } = makeScene();
      createTreeVisual(scene, {
        height: 8,
        radius: 0.4,
        materials: createTreeMaterials(scene),
        prng: new RandomGenerator(42),
      });
      scene.flush();
      return serialize();
    };
    const a = run();
    expect(run()).toBe(a);

    // A different seed changes the structure.
    const other = (() => {
      const { scene, serialize } = makeScene();
      createTreeVisual(scene, {
        height: 8,
        radius: 0.4,
        materials: createTreeMaterials(scene),
        prng: new RandomGenerator(43),
      });
      scene.flush();
      return serialize();
    })();
    expect(other).not.toBe(a);
  });

  test("tree trunk/root-flare dimensions follow the card formulas", () => {
    const { scene, world, serialize } = makeScene();
    const tree = createTreeVisual(scene, {
      height: 8,
      radius: 0.4,
      materials: createTreeMaterials(scene),
      prng: new RandomGenerator(42),
    });
    scene.flush();
    const w = world();
    const kids = w.nodes.get(tree.__id)!.children;
    expect(kids.length).toBeGreaterThanOrEqual(5); // trunk + flare + ≥3 canopy
    const trunk = w.nodes.get(kids[0])!;
    expect(trunk.p[1]).toBeCloseTo(4, 6); // height·0.5
    const doc = JSON.parse(serialize()) as SerializedDoc;
    const trunkGeom = doc.geoms.find(
      (g) => g.id === (doc.nodes.find((n) => n.id === trunk.id)!.geom),
    )!;
    expect(trunkGeom.params.radiusTop).toBeCloseTo(0.4 * 0.58, 6);
    expect(trunkGeom.params.radiusBottom).toBeCloseTo(0.4 * 1.03, 6);
    expect(trunkGeom.params.height).toBe(8);
  });

  test("grass blade: prng-driven cone height and yaw", () => {
    const { scene, serialize } = makeScene();
    const expected = new RandomGenerator(9);
    const height = expected.uniform(0.45, 1.2);
    const yaw = expected.uniform(0, Math.PI * 2);

    const blade = createGrassBladeVisual(scene, { prng: new RandomGenerator(9) });
    expect(blade.quaternion.y).toBeCloseTo(Math.sin(yaw / 2), 12);
    const doc = JSON.parse(serialize()) as SerializedDoc;
    const geom = doc.geoms.find((g) => g.id === doc.nodes[0].geom)!;
    expect(geom.params.radius).toBeCloseTo(0.08, 6);
    expect(geom.params.height).toBeCloseTo(height, 5);
  });
});

// ---------------------------------------------------------------------------
// ProjectileVisualFactory
// ---------------------------------------------------------------------------

describe("ProjectileVisualFactory", () => {
  test("bullet: opacity fade rides the tint alpha (0.95 in the material)", () => {
    const { scene, world, serialize } = makeScene();
    const bullet = createBulletProjectileVisual(scene);
    bullet.step({ position: new Vector3(1, 2, 3), ageSeconds: 0.5, lifetimeSeconds: 1 });
    scene.flush();

    const mesh = world().nodes.get(bullet.mesh.__id)!;
    expect(mesh.p).toEqual([1, 2, 3]);
    expect(mesh.tint).toBe(rgbToAbgr(0xffffff, 0.5)); // fade = 0.5
    const doc = JSON.parse(serialize()) as SerializedDoc;
    const mat = doc.materials.find((m) => m.id === mesh.matId)!;
    expect(mat.color).toBe(rgbToAbgr(0xfff3a1, 0.95));
    expect(mat.flags).toBe(MAT.unlit | MAT.transparent);

    bullet.step({ position: new Vector3(1, 2, 3), ageSeconds: 2, lifetimeSeconds: 1 });
    expect(world().nodes.get(bullet.mesh.__id)!.tint).toBe(rgbToAbgr(0xffffff, 0)); // clamped
  });

  test("missile: cone aim, flame offset, trail stretch midpoint/length", () => {
    const { scene, world } = makeScene();
    const missile = createMissileProjectileVisual(scene);
    const dir = new Vector3(0, 0, -1);
    missile.step({ position: new Vector3(0, 0, 0), direction: dir, ageSeconds: 0 });
    scene.flush();
    const w = world();

    // mesh quaternion from (0,1,0) → (0,0,-1): axis (-1,0,0), 90°
    const mesh = w.nodes.get(missile.mesh.__id)!;
    expect(mesh.q[0]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(mesh.q[3]).toBeCloseTo(Math.SQRT1_2, 6);

    // flame at position + dir·(-7.5)
    const flame = w.nodes.get(missile.flame.__id)!;
    expect(flame.p).toEqual([0, 0, 7.5]);
    // flicker(0) = 0.78: tint alpha replaces opacity; scale 0.9 + 0.78·0.22
    expect(flame.tint).toBe(rgbToAbgr(0xffffff, 0.78));
    expect(flame.s[0]).toBeCloseTo(0.9 + 0.78 * 0.22, 6);

    // trail: setCylinderBetween(p+dir·-84, p+dir·-9) → mid (0,0,46.5), len 75
    const trail = w.nodes.get(missile.trail.__id)!;
    expect(trail.p).toEqual([0, 0, 46.5]);
    expect(trail.s).toEqual([1, 75, 1]);
    expect(trail.q[0]).toBeCloseTo(-Math.SQRT1_2, 6);
  });
});

// ---------------------------------------------------------------------------
// RockVisualFactory
// ---------------------------------------------------------------------------

describe("RockVisualFactory", () => {
  test("ground rock: prng radius/squash/rotation in original draw order", () => {
    const { scene, serialize } = makeScene();
    const expected = new RandomGenerator(11);
    const radius = expected.uniform(0.7, 2.0);
    const squash = expected.uniform(0.35, 0.8);

    const rock = createGroundRockVisual(scene, { prng: new RandomGenerator(11) });
    expect(rock.scale.y).toBeCloseTo(squash, 12);
    expect(rock.quaternion.w).not.toBe(1); // randomly rotated
    const doc = JSON.parse(serialize()) as SerializedDoc;
    const geom = doc.geoms.find((g) => g.id === doc.nodes[0].geom)!;
    expect(geom.params.radius).toBeCloseTo(radius, 5);
  });

  test("irregular rock: safe radius + per-axis scale variance", () => {
    const { scene } = makeScene();
    const { mesh, radius } = createIrregularRockVisual(scene, {
      radius: 0.01, // below the 0.05 floor
      scaleVariance: 0.12,
      prng: new RandomGenerator(3),
    });
    expect(radius).toBe(0.05);
    for (const s of [mesh.scale.x, mesh.scale.y, mesh.scale.z]) {
      expect(s).toBeGreaterThanOrEqual(0.88);
      expect(s).toBeLessThanOrEqual(1.12);
    }
  });
});

// ---------------------------------------------------------------------------
// GroundClickIndicator
// ---------------------------------------------------------------------------

describe("GroundClickIndicator", () => {
  test("expands 0.42→1.4, rises 0.06→0.1, fades via tint alpha, expires", () => {
    const { scene, world } = makeScene();
    const indicator = new GroundClickIndicator({ scene, position: { x: 2, y: 5, z: -3 } });
    scene.flush();
    let g = world().nodes.get(indicator.group.__id)!;
    expect(g.p).toEqual([2, Math.fround(0.06), -3]); // planar + startUpOffset
    expect(g.s[0]).toBeCloseTo(0.42, 6);

    expect(indicator.step(0.21)).toBe(true); // 210 ms left → ratio 0.5
    scene.flush();
    g = world().nodes.get(indicator.group.__id)!;
    expect(g.s[0]).toBeCloseTo(0.91, 6); // 0.42 + 0.98·0.5
    expect(g.p[1]).toBeCloseTo(0.08, 6); // 0.06 + 0.04·0.5
    expect(world().nodes.get(indicator.disk.__id)!.tint).toBe(rgbToAbgr(0xffffff, 0.5));
    expect(world().nodes.get(indicator.ring.__id)!.tint).toBe(rgbToAbgr(0xffffff, 0.5));

    expect(indicator.step(0.21)).toBe(false); // dead
    expect(world().nodes.get(indicator.disk.__id)!.tint).toBe(rgbToAbgr(0xffffff, 0));

    indicator.dispose();
    expect(world().nodes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// JetFlame
// ---------------------------------------------------------------------------

describe("JetFlameLocalVisual", () => {
  const expectedTint = (boost: number, flicker: number): number => {
    const rgb = new Color(0xff7722)
      .lerp(new Color(0x9999ff), boost)
      .getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace);
    return rgbFloatsToAbgr(rgb.r * flicker, rgb.g * flicker, rgb.b * flicker);
  };

  test("exact s/width formulas at throttle 0.5, no boost", () => {
    const { scene } = makeScene();
    const jf = new JetFlameLocalVisual(scene);
    jf.step({ throttle: 0.5, isBoosting: false, timeSeconds: 0 });
    expect(jf.boostFactor).toBe(0);
    expect(jf.flame.scale.x).toBeCloseTo(1.3, 12); // 1.1 + 0.5·0.4
    expect(jf.flame.scale.y).toBeCloseTo(1.3, 12);
    expect(jf.flame.scale.z).toBeCloseTo(1.2, 12); // 0.6 + 0.5·1.2
  });

  test("boostFactor smoothing (dt·5 clamp) drives s → 2.2 and blue shift", () => {
    const { scene, world } = makeScene();
    const jf = new JetFlameLocalVisual(scene);
    const outerId = world().nodes.get(jf.flame.__id)!.children[0];
    expect(world().nodes.get(outerId)!.tint).toBe(rgbToAbgr(0xff7722)); // at rest

    let boost = 0;
    for (let i = 0; i < 30; i += 1) {
      jf.step({ throttle: 0.5, isBoosting: true, timeSeconds: 0, deltaSeconds: 1 / 60 });
      boost += (1 - boost) * Math.min((1 / 60) * 5, 1);
    }
    expect(jf.boostFactor).toBeCloseTo(boost, 12);
    const s = (1 - boost) * (0.6 + 0.5 * 1.2) + boost * 2.2;
    const width = 1.1 + Math.max(0.5, boost) * 0.4;
    expect(jf.flame.scale.z).toBeCloseTo(s, 12);
    expect(jf.flame.scale.x).toBeCloseTo(width, 12);

    const tint = world().nodes.get(outerId)!.tint;
    expect(tint).toBe(expectedTint(boost, 1)); // timeSeconds 0 → flicker 1
    expect((tint >> 16) & 255).toBeGreaterThan(0x80); // blue byte shifted up
  });

  test("flicker is a deterministic ±18% sine of timeSeconds", () => {
    const { scene, world } = makeScene();
    const jf = new JetFlameLocalVisual(scene);
    const outerId = world().nodes.get(jf.flame.__id)!.children[0];
    const t = 0.4;
    jf.step({ throttle: 1, isBoosting: false, timeSeconds: t });
    expect(world().nodes.get(outerId)!.tint).toBe(expectedTint(0, 1 + 0.18 * Math.sin(t * 20)));
  });
});

// ---------------------------------------------------------------------------
// VehicleTireMarkRenderer
// ---------------------------------------------------------------------------

describe("VehicleTireMarkRenderer", () => {
  const flatGround = { heightAt: () => 0 };
  const state = (x: number, grounded = true, speed = 5) => ({
    grounded,
    horizontalSpeed: speed,
    position: new Vector3(x, 0.4, 0),
    bodyFrame: { right: new Vector3(1, 0, 0), forward: new Vector3(0, 0, -1) },
  });

  test("appends on distance threshold; beams carry card colors + width", () => {
    const { scene, world } = makeScene();
    const marks = new VehicleTireMarkRenderer({ scene, terrainSampler: flatGround });
    marks.step(state(0)); // seeds `last`, no segments yet
    expect(marks.totalSegments).toBe(0);
    // Below minDistance 0.16: no segment, but `last` still advances
    // (original semantics — the gate is on the per-step delta).
    marks.step(state(0.1));
    expect(marks.totalSegments).toBe(0);
    marks.step(state(0.3)); // 0.2 ≥ 0.16 from the x=0.1 points
    expect(marks.frontSegments).toBe(2); // both tire sides
    expect(marks.rearSegments).toBe(2);

    scene.flush();
    const front = world().pools.get(marks.front.pool.__id)!;
    expect(front.live).toHaveLength(2);
    // side -1 front tire: position + right·(-0.84) + forward·1.07, height+lift
    const [ax, ay, az, bx, , bz, width] = front.live[0];
    expect(ax).toBeCloseTo(0.1 - 0.84, 5);
    expect(ay).toBeCloseTo(0.026, 5);
    expect(az).toBeCloseTo(-1.07, 5);
    expect(bx).toBeCloseTo(0.3 - 0.84, 5);
    expect(bz).toBeCloseTo(-1.07, 5);
    expect(width).toBeCloseTo(0.18, 5);
    expect(front.colors[0]).toBe(rgbToAbgr(0x161719, 0.42));
    const rear = world().pools.get(marks.rear.pool.__id)!;
    expect(rear.colors[0]).toBe(rgbToAbgr(0x8d2119, 0.58));
  });

  test("airborne / slow breaks the ribbon; ring buffer caps segments", () => {
    const { scene, world } = makeScene();
    const marks = new VehicleTireMarkRenderer({
      scene,
      terrainSampler: flatGround,
      maxSegments: 2,
    });
    marks.step(state(0));
    marks.step(state(0.3));
    expect(marks.frontSegments).toBe(2);

    marks.step(state(0.6, false)); // airborne → resetLast, keeps segments
    expect(marks.frontSegments).toBe(2);
    marks.step(state(1.2)); // re-seeds last, must NOT bridge the gap
    expect(marks.frontSegments).toBe(2);

    marks.step(state(1.5)); // appends 2 more → ring buffer holds at cap 2
    expect(marks.frontSegments).toBe(2);
    scene.flush();
    const front = world().pools.get(marks.front.pool.__id)!;
    expect(front.live).toHaveLength(2);
    // oldest segments were evicted: the survivors are the 1.2 → 1.5 pair
    expect(front.live[0][0]).toBeCloseTo(1.2 - 0.84, 5);
    expect(front.live[0][3]).toBeCloseTo(1.5 - 0.84, 5);

    // slow (< minSpeed 0.6) also breaks the ribbon
    marks.step(state(1.8, true, 0.1));
    marks.step(state(2.4));
    expect(marks.frontSegments).toBe(2); // still only re-seeded

    marks.clear();
    expect(marks.totalSegments).toBe(0);
    scene.flush();
    expect(world().pools.get(marks.front.pool.__id)!.live).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WeaponEffectsSystem
// ---------------------------------------------------------------------------

describe("WeaponEffectsSystem", () => {
  test("tracer: spawn full-bright, (1-t) fade, expiry at ttl", () => {
    const { scene, world } = makeScene();
    const fx = new WeaponEffectsSystem({ scene, prng: new RandomGenerator(1) });
    expect(fx.maxTracers).toBe(16);
    expect(fx.maxParticles).toBe(128);

    fx.spawnTracer({ x: 0, y: 1, z: 0 }, { x: 4, y: 1, z: -3 });
    scene.flush();
    let pool = world().pools.get(fx.tracerLines.__id)!;
    expect(pool.live).toHaveLength(1);
    expect(pool.live[0].slice(0, 6)).toEqual([0, 1, 0, 4, 1, -3]);
    expect(pool.colors[0]).toBe(fadeRgbToAbgr(0xffe7ad, 1, 0.9));

    fx.step(0.05); // t = 0.625 → fade 0.375
    scene.flush();
    pool = world().pools.get(fx.tracerLines.__id)!;
    expect(pool.colors[0]).toBe(fadeRgbToAbgr(0xffe7ad, 1 - 0.05 / 0.08, 0.9));

    fx.step(0.05); // age 0.1 ≥ ttl 0.08 → slot cleared
    scene.flush();
    expect(world().pools.get(fx.tracerLines.__id)!.live).toHaveLength(0);
  });

  test("particles: velocity kick, gravity 3 u/s² integration, fade", () => {
    const { scene, world } = makeScene();
    const fx = new WeaponEffectsSystem({ scene, prng: new RandomGenerator(2) });
    // spread 0 → velocity is exactly direction·speed = (0,1,0)
    fx.emitHitBurst({ x: 1, y: 2, z: 3 }, { x: 0, y: 1, z: 0 }, 0xff5533, 1, 1, 0, 1000);
    scene.flush();
    let pool = world().pools.get(fx.particlePoints.__id)!;
    expect(pool.live).toHaveLength(1);
    expect(pool.live[0]).toEqual([1, 2, 3, Math.fround(0.05)]);

    fx.step(0.1); // vy = 1 - 0.3 = 0.7 → y += 0.07
    fx.step(0.1); // vy = 0.4 → y += 0.04
    scene.flush();
    pool = world().pools.get(fx.particlePoints.__id)!;
    expect(pool.live[0][1]).toBeCloseTo(2.11, 5);
    expect(pool.colors[0]).toBe(fadeRgbToAbgr(0xff5533, 0.8, 0.9)); // t = 0.2

    fx.step(1); // past ttl 1 s → compacted away
    scene.flush();
    expect(world().pools.get(fx.particlePoints.__id)!.live).toHaveLength(0);
  });

  test("round-robin reuses the oldest slot beyond capacity", () => {
    const { scene, world } = makeScene();
    const fx = new WeaponEffectsSystem({ scene, maxEffects: 8, prng: new RandomGenerator(3) });
    for (let i = 0; i < 9; i += 1) {
      fx.spawnTracer({ x: i, y: 0, z: 0 }, { x: i, y: 1, z: 0 });
    }
    scene.flush();
    const pool = world().pools.get(fx.tracerLines.__id)!;
    expect(pool.live).toHaveLength(8); // slot 0 was overwritten by spawn #9
    expect(pool.live[0][0]).toBe(8);

    fx.clear();
    scene.flush();
    expect(world().pools.get(fx.tracerLines.__id)!.live).toHaveLength(0);
  });

  test("determinism golden: seeded run serializes identically twice", () => {
    const run = (): string => {
      const { scene, serialize } = makeScene();
      const fx = new WeaponEffectsSystem({ scene, maxEffects: 8, prng: new RandomGenerator(7) });
      const frames: string[] = [];
      for (let f = 0; f < 12; f += 1) {
        if (f % 3 === 0) fx.spawnTracer({ x: 0, y: 1, z: 0 }, { x: f, y: 1, z: -4 });
        if (f % 4 === 0) {
          fx.emitHitBurst({ x: f * 0.5, y: 0.5, z: -2 }, { x: 0, y: 1, z: 0 }, 0xff5533, 5);
        }
        fx.step(1 / 60);
        scene.flush();
        frames.push(serialize());
      }
      return frames.join("\n");
    };
    expect(run()).toBe(run());
  });
});
