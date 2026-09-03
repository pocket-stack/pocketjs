import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText, type SimWorld } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

async function step(world: SimWorld, buttons: number): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  await Promise.resolve();
}

/** Focus starts unset; one d-pad press lands on the first focusable. */
async function focusNext(world: SimWorld): Promise<void> {
  await step(world, BTN.DOWN);
  await step(world, 0);
}

async function press(world: SimWorld): Promise<void> {
  await step(world, BTN.CIRCLE);
  await step(world, 0);
}

describe("Svelte feature lab", () => {
  test("renders the same feature matrix as the Vue SFC lab", async () => {
    const world = await bootWorld("svelte-lab-main.svelte", 60);
    for (let frame = 0; frame < 4; frame++) await step(world, 0);

    const initial = world.getTree();
    expect(treeHasText(initial, "Svelte Feature Lab")).toBe(true);
    // $derived over a $state array.
    expect(treeHasText(initial, "3/3 ON")).toBe(true);
    // Snippets standing in for Vue's named slots: badge and footer.
    expect(treeHasText(initial, "$bindable()")).toBe(true);
    expect(treeHasText(initial, "props + callbacks + snippets")).toBe(true);
    expect(treeHasText(initial, "$state + $derived")).toBe(true);
    // The first arm of the if / else-if / else chain, and the else block.
    expect(treeHasText(initial, "if: idle")).toBe(true);
    expect(treeHasText(initial, "block else: press → then ○")).toBe(true);
    // Keyed {#each}, twice over the same list.
    for (const label of ["RUNES", "EACH", "SNIPPETS"]) {
      expect(treeHasText(initial, label)).toBe(true);
    }
    expect(treeHasText(initial, "1.RUNES")).toBe(true);
    expect(treeHasText(initial, "module presses: 0")).toBe(true);
  });

  test("$bindable writes through to the parent and drives the branches", async () => {
    const world = await bootWorld("svelte-lab-main.svelte", 60);
    for (let frame = 0; frame < 4; frame++) await step(world, 0);

    await focusNext(world);
    await press(world);

    const once = world.getTree();
    expect(treeHasText(once, "parent value: 1")).toBe(true);
    expect(treeHasText(once, "else if: active")).toBe(true);
    // The multi-root {#if} block replaced its {:else} arm.
    expect(treeHasText(once, "block: fragment")).toBe(true);
    expect(treeHasText(once, "block else: press → then ○")).toBe(false);

    for (let extra = 0; extra < 3; extra++) await press(world);

    const complete = world.getTree();
    expect(treeHasText(complete, "parent value: 4")).toBe(true);
    expect(treeHasText(complete, "else: complete")).toBe(true);
    expect(treeHasText(complete, "else if: active")).toBe(false);
  });

  test("a callback prop toggles a keyed row and records module state", async () => {
    const world = await bootWorld("svelte-lab-main.svelte", 60);
    for (let frame = 0; frame < 4; frame++) await step(world, 0);

    await focusNext(world); // the bindable button
    await focusNext(world); // the first toggle
    await press(world);

    const toggled = world.getTree();
    expect(treeHasText(toggled, "2/3 ON")).toBe(true);
    expect(treeHasText(toggled, "OFF")).toBe(true);
    // State that lives in a .svelte.ts module, not in any component.
    expect(treeHasText(toggled, "module presses: 1")).toBe(true);
  });
});
