// tests/pocket-shell-sim.test.ts — Pocket Shell's render layer in the
// headless sim: the same button tape the Azahar golden runs, with the dock
// taps replaced by store calls (the sim has no touch screen; a detached core
// node stands in for the 3DS bottom screen's host root). What this proves is
// that every chord, layout toggle and workspace switch reconciles the two
// Solid trees without a renderer error, in milliseconds rather than an
// emulator boot.

import { describe, expect, test } from "bun:test";
import { NODE_TYPE } from "../contracts/spec/spec.ts";
import { bootWorld } from "../hosts/sim/sim.ts";
import { THREE_DS_GOLDEN_SPECS } from "./golden-specs.ts";
import type { ShellStore } from "../apps/pocket-shell/store.ts";

const spec = THREE_DS_GOLDEN_SPECS.find((s) => s.name === "pocket-shell");
if (!spec) throw new Error("no pocket-shell golden spec");

async function boot(): Promise<{ world: Awaited<ReturnType<typeof bootWorld>>; store: ShellStore }> {
  const world = await bootWorld("pocket-shell-main", 60, undefined, (ops) => {
    const createNode = ops.createNode as (type: number) => number;
    ops.__auxiliarySurface = { root: createNode(NODE_TYPE.view), w: 320, h: 240 };
  });
  const store = (globalThis as { __pocketShell?: ShellStore }).__pocketShell;
  if (!store) throw new Error("the bundle did not publish __pocketShell");
  return { world, store };
}

describe("pocket-shell in the sim", () => {
  test("the golden tape's chords run clean", async () => {
    const { world, store } = await boot();
    // The tape's dock taps land on frames 8, 18 and 28.
    const taps: Record<number, "term" | "notes" | "about"> = { 8: "term", 18: "notes", 28: "about" };
    for (let frame = 0; frame <= spec!.frames; frame++) {
      const app = taps[frame];
      if (app) store.open(app);
      // The tape's minimap hold at 186..222 closes term; the sim has no
      // touch screen, so arm and release the close bar through the store.
      if (frame === 210) store.setClosing({ id: store.order()[1], over: true });
      if (frame === 223) {
        const closing = store.closing();
        if (closing) store.close(closing.id);
        store.setClosing(null);
      }
      world.frame(spec!.input!(frame));
      if (frame === 48) {
        expect(store.order().length).toBe(3);
        expect(store.focusedApp()).toBe("about");
      }
      if (frame === 60) {
        expect(store.layer()).toBe("super");
        expect(store.focusedApp()).toBe("term");
      }
      if (frame === 84) {
        // R + RIGHT swapped term with notes: term now leads nothing, notes leads.
        expect(store.windowOf(store.order()[0])?.app).toBe("notes");
        expect(store.focusedApp()).toBe("term");
      }
      if (frame === 112) expect(store.layoutKind()).toBe("scrolling");
      if (frame === 126) {
        expect(store.active()).toBe(2);
        expect(store.layer()).toBe("ws");
      }
      if (frame === 160) {
        expect(store.active()).toBe(1);
        expect(store.keysOpen()).toBe(true);
      }
      if (frame === 176) {
        expect(store.keysOpen()).toBe(false);
        expect(store.launcherOpen()).toBe(true);
      }
      if (frame === 183) expect(store.launcherOpen()).toBe(false);
      if (frame === 240) expect(store.order().length).toBe(2);
    }
  });

  test("every action runs against an empty and a full workspace", async () => {
    const { world, store } = await boot();
    const actions = [
      "focus.left", "focus.right", "focus.up", "focus.down",
      "swap.left", "swap.right", "swap.up", "swap.down",
      "launcher", "launcher", "close", "fullscreen", "fullscreen", "maximize", "maximize",
      "split", "swapsplit", "layout", "split", "swapsplit", "layout",
      "keys", "keys", "another", "reopen", "wallpaper", "bar", "bar",
      "carry.next", "carry.prev", "ws.next", "ws.prev",
    ] as const;
    world.frame(0);
    for (const action of actions) {
      store.run(action);
      world.frame(0);
    }
    for (const app of ["term", "clock", "notes", "keys", "stats", "about"] as const) store.open(app);
    for (let i = 0; i < 10; i++) world.frame(0);
    for (const action of actions) {
      store.run(action);
      for (let i = 0; i < 3; i++) world.frame(0);
    }
    store.setKbOpen(true);
    store.focusWin(store.order()[0]);
    for (let i = 0; i < 3; i++) world.frame(0);
    store.typeChar("h");
    store.typeChar("e");
    store.typeKey("tab");
    store.typeKey("enter");
    for (let i = 0; i < 3; i++) world.frame(0);
    expect(store.wm.windows.size).toBeGreaterThan(0);
  });
});
