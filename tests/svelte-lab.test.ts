import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText, type SimWorld } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

async function step(world: SimWorld, buttons: number): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  await Promise.resolve();
}

describe("Svelte feature lab", () => {
  test("renders runes, snippets, keyed lists and shared module state", async () => {
    const world = await bootWorld("svelte-lab-main.svelte", 60);
    for (let frame = 0; frame < 4; frame++) await step(world, 0);

    const initial = world.getTree();
    expect(treeHasText(initial, "Svelte Feature Lab")).toBe(true);
    // $derived over a $state array.
    expect(treeHasText(initial, "3/3 ON")).toBe(true);
    // Keyed {#each} over the feature list.
    for (const label of ["RUNES", "EACH", "SNIPPETS"]) {
      expect(treeHasText(initial, label)).toBe(true);
    }
    // A {#snippet} rendered into a child component's {@render}.
    expect(treeHasText(initial, "$bindable()")).toBe(true);
    expect(treeHasText(initial, "bound: 0")).toBe(true);
    expect(treeHasText(initial, "Reactive through runes.")).toBe(true);
    expect(treeHasText(initial, "module presses: 0")).toBe(true);

    // FocusScope autoFocus put the first toggle under CIRCLE.
    await step(world, BTN.CIRCLE);
    await step(world, 0);

    const toggled = world.getTree();
    expect(treeHasText(toggled, "2/3 ON")).toBe(true);
    // State that lives in a .svelte.ts module, not in the component.
    expect(treeHasText(toggled, "module presses: 1")).toBe(true);
  });

  test("TRIANGLE rotates the keyed list without losing a row", async () => {
    const world = await bootWorld("svelte-lab-main.svelte", 60);
    for (let frame = 0; frame < 4; frame++) await step(world, 0);

    await step(world, BTN.TRIANGLE);
    await step(world, 0);

    const rotated = world.getTree();
    for (const label of ["RUNES", "EACH", "SNIPPETS"]) {
      expect(treeHasText(rotated, label)).toBe(true);
    }
  });
});
