// The same one-tick real-pointer click crosses each framework entrypoint.

import { describe, expect, test } from "bun:test";

import { POINTER_EVENT } from "../framework/src/frame-input.ts";
import { bootWorld, type SimWorld } from "../hosts/sim/sim.ts";

function textOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { x?: unknown; k?: unknown[] };
  let text = node.x === undefined ? "" : String(node.x);
  for (const child of node.k ?? []) text += textOf(child);
  return text;
}

async function settle(world: SimWorld): Promise<void> {
  for (let frame = 0; frame < 4; frame++) {
    world.frame(0);
    world.tick();
    await Promise.resolve();
  }
}

describe("pointer frame input framework parity", () => {
  for (const app of [
    "hero-main",
    "hero-vue-vapor-main.vue-vapor",
    "hero-main.octane",
  ]) {
    test(`${app} handles hover + fast click`, async () => {
      const world = await bootWorld(app, 60);
      await settle(world);
      world.frame(0, undefined, undefined, {
        v: 1,
        pointer: [
          [POINTER_EVENT.MOVE, 80, 220],
          [POINTER_EVENT.DOWN, 80, 220],
          [POINTER_EVENT.UP, 80, 220],
        ],
      });
      world.tick();
      await Promise.resolve();
      expect(textOf(world.getTree())).toContain("Count: 1");
    });
  }
});
