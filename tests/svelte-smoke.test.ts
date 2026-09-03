import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText, type SimWorld } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

async function step(world: SimWorld, buttons: number): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  // The frame handler flushes Svelte synchronously, but a component's own async
  // work would still land on the promise queue the host drains after frame().
  await Promise.resolve();
}

describe("Svelte hero demo", () => {
  test("boots, renders and reacts to CIRCLE presses", async () => {
    const world = await bootWorld("hero-main.svelte", 60);
    for (let frame = 0; frame < 4; frame++) await step(world, 0);

    const initial = world.getTree();
    expect(treeHasText(initial, "PocketJS")).toBe(true);
    expect(treeHasText(initial, "Svelte + RUST + SCEGU")).toBe(true);
    expect(treeHasText(initial, "ONE RUST CORE - ONE SVELTE APP")).toBe(true);
    expect(treeHasText(initial, "Runes at 60 FPS.")).toBe(true);
    expect(treeHasText(initial, "Count: 0")).toBe(true);
    expect(treeHasText(initial, "Reactive on real hardware.")).toBe(false);

    await step(world, BTN.DOWN);
    await step(world, 0);
    for (let press = 0; press < 4; press++) {
      await step(world, BTN.CIRCLE);
      await step(world, 0);
    }

    const pressed = world.getTree();
    // A state write in a press handler commits in the same frame: index-svelte
    // flushes between handleFrame() and the sweep.
    expect(treeHasText(pressed, "Count: 4")).toBe(true);
    expect(treeHasText(pressed, "Reactive on real hardware.")).toBe(true);
  });

  test("runs with no DOM globals, the way the QuickJS guest does", async () => {
    const globals = globalThis as Record<string, unknown>;
    const saved = {
      document: globals.document,
      window: globals.window,
      performance: globals.performance,
      requestAnimationFrame: globals.requestAnimationFrame,
      navigator: globals.navigator,
    };
    for (const name of Object.keys(saved)) delete globals[name];
    try {
      const world = await bootWorld("hero-main.svelte", 60);
      for (let frame = 0; frame < 4; frame++) await step(world, 0);
      expect(treeHasText(world.getTree(), "PocketJS")).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value !== undefined) globals[name] = value;
      }
    }
  });
});
