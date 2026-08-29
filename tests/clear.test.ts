// Pocket Clear journeys on the deterministic sim: every gesture the app is
// built from, driven through the real vue-vapor entry (touch latching, the
// gesture pump, hit facts) at the iPod touch 4 viewport. Vue Vapor flushes
// dependent render effects on the microtask queue, so every frame awaits one
// promise turn before the tree is inspected (the vue-sfc-lab pattern).

import { beforeAll, describe, expect, test } from "bun:test";
import { bootWorld, treeHasText, type SimWorld } from "../hosts/sim/sim.ts";
import { __packTouch } from "../framework/src/touch.ts";
import { KB_GAP, KB_H, KB_PAD, KB_ROW_H } from "../apps/clear/keyboard-metrics.ts";
import { layoutRows, OSK_LAYERS, type OskKeyDef } from "../framework/src/osk-layout.ts";

const W = 320;
const H = 480;
const HEADER_H = 48;
const ROW_H = 44;

let world: SimWorld;

async function step(touches?: readonly number[]): Promise<void> {
  world.frame(0, undefined, touches);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  await Promise.resolve();
}

async function idle(frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) await step();
}

async function tap(x: number, y: number): Promise<void> {
  await step([__packTouch(0, x, y)]);
  await step([__packTouch(0, x, y)]);
  await step();
}

async function glide(x0: number, y0: number, x1: number, y1: number, frames: number): Promise<void> {
  for (let f = 0; f <= frames; f++) {
    const t = f / frames;
    await step([__packTouch(0, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t))]);
  }
  await step();
}

/** Screen center of a key on the LOWER layer, from the app's own geometry. */
function keyCenter(match: (key: OskKeyDef) => boolean): [number, number] {
  const rows = layoutRows(OSK_LAYERS.lower, W - 2 * KB_PAD, KB_GAP);
  for (let r = 0; r < rows.length; r++) {
    for (const rect of rows[r]) {
      if (match(rect.key)) {
        return [
          Math.round(KB_PAD + rect.x + rect.w / 2),
          Math.round(H - KB_H + KB_PAD + r * (KB_ROW_H + KB_GAP) + KB_ROW_H / 2),
        ];
      }
    }
  }
  throw new Error("clear test: key not found");
}

const rowCenterY = (index: number) => HEADER_H + index * ROW_H + ROW_H / 2;

describe("Pocket Clear on the sim", () => {
  beforeAll(async () => {
    world = await bootWorld("clear-main.vue-vapor", 60, undefined, undefined, {
      width: W,
      height: H,
      rasterDensity: 2,
    });
    await idle(5);
  });

  test("boots to the lists screen", () => {
    const tree = world.getTree();
    expect(treeHasText(tree, "Pocket Clear")).toBe(true);
    expect(treeHasText(tree, "How to use")).toBe(true);
    expect(treeHasText(tree, "Groceries")).toBe(true);
  });

  test("tap opens a list", async () => {
    await tap(160, HEADER_H + 29);
    await idle(20);
    const tree = world.getTree();
    expect(treeHasText(tree, "Swipe right to complete")).toBe(true);
    expect(treeHasText(tree, "9 to do")).toBe(true);
  });

  test("swipe right completes the row under the finger", async () => {
    await glide(30, rowCenterY(0), 260, rowCenterY(0), 12);
    await idle(30);
    const tree = world.getTree();
    expect(treeHasText(tree, "✓ Swipe right to complete")).toBe(true);
    expect(treeHasText(tree, "8 to do")).toBe(true);
  });

  test("swipe left deletes", async () => {
    // After the complete, row 0 is "Swipe left to delete".
    await glide(280, rowCenterY(0), 30, rowCenterY(0), 12);
    await idle(30);
    const tree = world.getTree();
    expect(treeHasText(tree, "Swipe left to delete")).toBe(false);
    expect(treeHasText(tree, "7 to do")).toBe(true);
  });

  test("long-press picks a row up and reorders it", async () => {
    // Hold row 0 ("Tap a row to edit it") past the long-press deadline...
    for (let i = 0; i < 32; i++) await step([__packTouch(0, 160, rowCenterY(0))]);
    // ...then carry it down two rows and release.
    await glide(160, rowCenterY(0), 160, rowCenterY(2), 10);
    await idle(30);
    // The row that was below it is now on top: completing the new row 0
    // proves the order, not just the survival, of the move.
    await glide(30, rowCenterY(0), 260, rowCenterY(0), 12);
    await idle(30);
    const tree = world.getTree();
    expect(treeHasText(tree, "✓ Hold a row to reorder")).toBe(true);
    expect(treeHasText(tree, "6 to do")).toBe(true);
  });

  test("pull down creates a row and typing commits it", async () => {
    await glide(160, 100, 160, 240, 12);
    await idle(20);
    // The editor is open on a fresh empty row: the caret renders alone.
    expect(treeHasText(world.getTree(), "|")).toBe(true);
    const [qx, qy] = keyCenter((key) => key.ch === "q");
    await tap(qx, qy);
    await idle(5);
    expect(treeHasText(world.getTree(), "q|")).toBe(true);
    const [ex, ey] = keyCenter((key) => key.action === "enter");
    await tap(ex, ey);
    await idle(20);
    const tree = world.getTree();
    expect(treeHasText(tree, "q")).toBe(true);
    expect(treeHasText(tree, "7 to do")).toBe(true);
  });

  test("pinch two rows apart inserts between them", async () => {
    const before = "6 to do"; // committing the empty edit below leaves 6
    // Two fingers on rows 1 and 3, diverging vertically.
    for (let f = 0; f <= 14; f++) {
      const spread = f * 4;
      await step([
        __packTouch(0, 160, rowCenterY(1) - Math.min(spread, 26)),
        __packTouch(1, 160, rowCenterY(2) + spread),
      ]);
    }
    await step();
    await idle(10);
    // The insert opened the editor on the fresh row; cancel via the hide key.
    expect(treeHasText(world.getTree(), "|")).toBe(true);
    const [hx, hy] = keyCenter((key) => key.action === "hide");
    await tap(hx, hy);
    await idle(20);
    expect(treeHasText(world.getTree(), before)).toBe(false);
    expect(treeHasText(world.getTree(), "7 to do")).toBe(true);
  });

  test("pull up past the end clears the done pile", async () => {
    // Two completed rows exist ("Swipe right…", "Hold a row…"). Drag the
    // content up far past the end of the range.
    await glide(160, 420, 160, 60, 16);
    await idle(40);
    const tree = world.getTree();
    expect(treeHasText(tree, "✓ Swipe right to complete")).toBe(false);
    expect(treeHasText(tree, "✓ Hold a row to reorder")).toBe(false);
    expect(treeHasText(tree, "7 to do")).toBe(true);
  });

  test("pulling down further navigates back to the lists", async () => {
    await glide(160, 70, 160, 460, 24);
    await idle(30);
    expect(treeHasText(world.getTree(), "Tap a list to open it")).toBe(true);
  });
});
