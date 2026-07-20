// playset/test/collision-world.test.ts — the deterministic collision core:
// capsule push-out + slide, climb/snap grounding, groundHeightAt authority,
// raycasts against every shape, and insertion-order determinism.

import { describe, expect, test } from "bun:test";
import { Vector3 } from "../math/vector3.ts";
import { Quaternion } from "../math/quaternion.ts";
import { CollisionWorld } from "../modules/physics/collision-world.ts";

const CAPSULE = { radius: 0.4, halfHeight: 0.9 };

describe("CollisionWorld resolveCapsule vs cuboids", () => {
  test("wall blocks forward motion and slides laterally", () => {
    const world = new CollisionWorld();
    // Wall across the forward axis: spans forward 4.5..5.5, up 0..2.
    world.addCuboid({ position: { x: 0, y: 1, z: -5 }, halfExtents: { x: 5, y: 1, z: 0.5 } });

    const current = new Vector3(0, 0.9, 0);
    const head0n = world.resolveCapsule(current, new Vector3(0, 0.9, -4.3), CAPSULE);
    expect(head0n.hitWall).toBe(true);
    // Pushed back to wall face minus radius: forward 4.5 - 0.4 = 4.1.
    expect(head0n.position.z).toBeCloseTo(-4.1, 12);
    expect(head0n.position.x).toBeCloseTo(0, 12);
    expect(head0n.grounded).toBe(true);

    // Diagonal move: forward clipped, lateral component preserved (slide).
    const slide = world.resolveCapsule(current, new Vector3(1, 0.9, -4.3), CAPSULE);
    expect(slide.hitWall).toBe(true);
    expect(slide.position.x).toBeCloseTo(1, 12);
    expect(slide.position.z).toBeCloseTo(-4.1, 12);
  });

  test("motion clear of the wall is untouched", () => {
    const world = new CollisionWorld();
    world.addCuboid({ position: { x: 0, y: 1, z: -5 }, halfExtents: { x: 5, y: 1, z: 0.5 } });
    const res = world.resolveCapsule(new Vector3(0, 0.9, 0), new Vector3(0, 0.9, -3), CAPSULE);
    expect(res.hitWall).toBe(false);
    expect(res.position.z).toBeCloseTo(-3, 12);
  });

  test("yawed cuboid pushes out along the rotated face normal", () => {
    const world = new CollisionWorld();
    const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
    // Thin wall (hForward 0.2) yawed 45 degrees at the origin.
    world.addCuboid({
      position: { x: 0, y: 1, z: 0 },
      halfExtents: { x: 1, y: 1, z: 0.2 },
      quaternion,
    });

    // Point at box-local (lr=0, lf=0.35): 0.15 inside the face's 0.4 margin.
    const p = 0.35 * Math.SQRT1_2;
    const res = world.resolveCapsule(new Vector3(3, 0.9, -3), new Vector3(p, 0.9, -p), CAPSULE);
    expect(res.hitWall).toBe(true);
    // Pushed to local lf = 0.2 + 0.4 = 0.6 along the rotated (1,1)/sqrt(2) normal.
    const q = 0.6 * Math.SQRT1_2;
    expect(res.position.x).toBeCloseTo(q, 12);
    expect(res.position.z).toBeCloseTo(-q, 12);
  });

  test("steps up onto a walkable box within climb", () => {
    const world = new CollisionWorld();
    world.addCuboid({
      position: { x: 0, y: 0.2, z: -3 },
      halfExtents: { x: 1, y: 0.2, z: 1 },
      walkable: true,
    });
    // Box top 0.4 <= default climb 0.55: not a wall, feet land on top.
    const res = world.resolveCapsule(new Vector3(0, 0.9, 0), new Vector3(0, 0.9, -3), CAPSULE);
    expect(res.hitWall).toBe(false);
    expect(res.grounded).toBe(true);
    expect(res.position.y).toBeCloseTo(0.4 + CAPSULE.halfHeight, 12);
  });

  test("walkable box taller than climb walls the mover", () => {
    const world = new CollisionWorld();
    world.addCuboid({
      position: { x: 0, y: 0.4, z: -3 },
      halfExtents: { x: 1, y: 0.4, z: 1 },
      walkable: true,
    });
    // Box top 0.8 > climb 0.55: pushed back out through the near face.
    const res = world.resolveCapsule(new Vector3(0, 0.9, 0), new Vector3(0, 0.9, -2.2), CAPSULE);
    expect(res.hitWall).toBe(true);
    expect(res.position.z).toBeCloseTo(-1.6, 12); // face 2 - (1 + 0.4)
    expect(res.position.y).toBeCloseTo(0.9, 12); // still on the ground
  });
});

describe("CollisionWorld resolveCapsule grounding", () => {
  test("snap-down within snap distance, airborne beyond it", () => {
    const world = new CollisionWorld();
    // Feet 0.2 above ground, default snap 0.3: snapped down and grounded.
    const near = world.resolveCapsule(new Vector3(0, 1.1, 0), new Vector3(0, 1.1, 0), CAPSULE);
    expect(near.grounded).toBe(true);
    expect(near.position.y).toBeCloseTo(0.9, 12);

    // Feet 0.5 above ground: beyond snap, stays airborne.
    const far = world.resolveCapsule(new Vector3(0, 1.4, 0), new Vector3(0, 1.4, 0), CAPSULE);
    expect(far.grounded).toBe(false);
    expect(far.position.y).toBeCloseTo(1.4, 12);

    // snap: 0 disables snapping entirely.
    const off = world.resolveCapsule(new Vector3(0, 1.1, 0), new Vector3(0, 1.1, 0), {
      ...CAPSULE,
      snap: 0,
    });
    expect(off.grounded).toBe(false);
    expect(off.position.y).toBeCloseTo(1.1, 12);
  });

  test("cylinder pushes the capsule out radially", () => {
    const world = new CollisionWorld();
    world.addCylinder({ position: { x: 0, y: 1, z: 0 }, halfHeight: 1, radius: 1 });
    const res = world.resolveCapsule(new Vector3(3, 0.9, 0), new Vector3(0.5, 0.9, 0), CAPSULE);
    expect(res.hitWall).toBe(true);
    expect(res.position.x).toBeCloseTo(1.4, 12); // radius 1 + capsule 0.4
    expect(res.position.z).toBeCloseTo(0, 12);
    expect(res.grounded).toBe(true);
  });

  test("ball pushes the capsule out radially", () => {
    const world = new CollisionWorld();
    world.addBall({ position: { x: 0, y: 0.5, z: 0 }, radius: 1 });
    const res = world.resolveCapsule(new Vector3(0, 0.9, 3), new Vector3(0, 0.9, -0.5), CAPSULE);
    expect(res.hitWall).toBe(true);
    expect(res.position.z).toBeCloseTo(-1.4, 12);
    expect(res.position.x).toBeCloseTo(0, 12);
  });
});

describe("CollisionWorld groundHeightAt", () => {
  test("max of terrain and walkable tops; solids don't contribute", () => {
    const world = new CollisionWorld();
    world.setTerrain({ heightAt: (_r, f) => 0.1 * f });
    world.addCuboid({
      position: { x: 0, y: 0.5, z: -3 },
      halfExtents: { x: 1, y: 0.5, z: 1 },
      walkable: true,
    });
    world.addCuboid({ position: { x: 5, y: 2, z: -3 }, halfExtents: { x: 1, y: 2, z: 1 } }); // solid, not walkable

    expect(world.groundHeightAt(0, 3)).toBeCloseTo(1, 12); // box top 1 > terrain 0.3
    expect(world.groundHeightAt(0.5, 2.5)).toBeCloseTo(1, 12); // still inside the box
    expect(world.groundHeightAt(0, 30)).toBeCloseTo(3, 12); // terrain only
    expect(world.groundHeightAt(5, 3)).toBeCloseTo(0.3, 12); // solid box ignored
  });
});

describe("CollisionWorld raycast", () => {
  test("sphere: hand-computed distance", () => {
    const world = new CollisionWorld();
    const handle = world.addBall({ position: { x: 0, y: 0, z: -5 }, radius: 1, tag: "ball" });
    const hit = world.raycast(new Vector3(0, 0, 0), new Vector3(0, 0, -1), 100);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(4, 12);
    expect(hit!.point.z).toBeCloseTo(-4, 12);
    expect(hit!.handle).toBe(handle);
    expect(hit!.tag).toBe("ball");
  });

  test("cylinder: side and cap hits", () => {
    const world = new CollisionWorld();
    world.addCylinder({ position: { x: 0, y: 1, z: -5 }, halfHeight: 1, radius: 0.5 });

    const side = world.raycast(new Vector3(0, 1, 0), new Vector3(0, 0, -1), 100);
    expect(side!.distance).toBeCloseTo(4.5, 12);

    const cap = world.raycast(new Vector3(0, 5, -5), new Vector3(0, -1, 0), 100);
    expect(cap!.distance).toBeCloseTo(3, 12); // top cap at y=2
  });

  test("axis-aligned and yawed boxes", () => {
    const world = new CollisionWorld();
    world.addCuboid({ position: { x: 0, y: 1, z: -5 }, halfExtents: { x: 1, y: 1, z: 1 } });
    const straight = world.raycast(new Vector3(0, 1, 0), new Vector3(0, 0, -1), 100);
    expect(straight!.distance).toBeCloseTo(4, 12);

    const yawed = new CollisionWorld();
    yawed.addCuboid({
      position: { x: 0, y: 0, z: -5 },
      halfExtents: { x: 1, y: 1, z: 1 },
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4),
    });
    // 45-degree unit cube presents its corner: first hit at 5 - sqrt(2).
    const corner = yawed.raycast(new Vector3(0, 0, 0), new Vector3(0, 0, -1), 100);
    expect(corner!.distance).toBeCloseTo(5 - Math.SQRT2, 10);
  });

  test("terrain march hit within bisection tolerance; nearest hit wins", () => {
    const world = new CollisionWorld();
    world.setTerrain({ heightAt: () => 0 });
    const hit = world.raycast(new Vector3(0, 4, 0), new Vector3(0, -1, -1), 100);
    expect(hit).not.toBeNull();
    // Crossing at t = 4*sqrt(2); bisection tolerance 0.5 / 2^16.
    expect(Math.abs(hit!.distance - 4 * Math.SQRT2)).toBeLessThan(1e-4);
    expect(Math.abs(hit!.point.y)).toBeLessThan(1e-4);
    expect(hit!.handle).toBe(0); // terrain has no collider handle
    expect(hit!.tag).toBeNull();

    world.addBall({ position: { x: 0, y: 2, z: -2 }, radius: 0.5, tag: "near" });
    const near = world.raycast(new Vector3(0, 4, 0), new Vector3(0, -1, -1), 100);
    expect(near!.tag).toBe("near"); // sphere in front of the terrain crossing
  });

  test("misses: wrong direction and short maxDistance", () => {
    const world = new CollisionWorld();
    world.setTerrain({ heightAt: () => 0 });
    world.addBall({ position: { x: 0, y: 0, z: -5 }, radius: 1 });

    expect(world.raycast(new Vector3(0, 0.1, 0), new Vector3(0, 1, 0), 50)).toBeNull();

    // Horizontal ray above the terrain: ball hit at 5 - sqrt(0.75), but a
    // shorter maxDistance turns it into a miss.
    const long = world.raycast(new Vector3(0, 0.5, 0), new Vector3(0, 0, -1), 100);
    expect(long!.distance).toBeCloseTo(5 - Math.sqrt(0.75), 12);
    expect(world.raycast(new Vector3(0, 0.5, 0), new Vector3(0, 0, -1), 3)).toBeNull();

    // A ray starting at/below the terrain surface is an immediate hit.
    const onSurface = world.raycast(new Vector3(0, 0, 0), new Vector3(0, 0, -1), 3);
    expect(onSurface!.distance).toBe(0);
  });
});

describe("CollisionWorld determinism", () => {
  test("two worlds built identically produce identical results", () => {
    const build = () => {
      const world = new CollisionWorld();
      world.setTerrain({ heightAt: (r, f) => 0.35 * Math.sin(r * 0.7) + 0.2 * Math.cos(f * 0.4) });
      world.addCuboid({ position: { x: 2, y: 1, z: -4 }, halfExtents: { x: 1.5, y: 1, z: 0.5 } });
      world.addCuboid({
        position: { x: -3, y: 0.3, z: -2 },
        halfExtents: { x: 1, y: 0.3, z: 1 },
        walkable: true,
        quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6),
      });
      world.addCylinder({ position: { x: 0, y: 1, z: -6 }, halfHeight: 1, radius: 0.8 });
      world.addBall({ position: { x: 4, y: 0.5, z: -7 }, radius: 1.2 });
      return world;
    };

    const probe = (world: CollisionWorld) => {
      const out: unknown[] = [];
      let position = new Vector3(0, 0.9, 0);
      for (let i = 0; i < 40; i += 1) {
        const desired = position
          .clone()
          .add(new Vector3(Math.sin(i * 0.3) * 0.4, 0, -0.35));
        const res = world.resolveCapsule(position, desired, CAPSULE);
        position = res.position;
        out.push([res.position.toArray(), res.grounded, res.hitWall]);
      }
      for (const dir of [new Vector3(0, -0.2, -1), new Vector3(1, -0.1, -1), new Vector3(-1, 0, -1)]) {
        const hit = world.raycast(new Vector3(0, 2, 2), dir, 30);
        out.push(hit ? [hit.distance, hit.point.toArray(), hit.handle] : null);
      }
      for (let r = -5; r <= 5; r += 1) out.push(world.groundHeightAt(r, -r * 0.5));
      return JSON.stringify(out);
    };

    expect(probe(build())).toBe(probe(build()));
  });
});
