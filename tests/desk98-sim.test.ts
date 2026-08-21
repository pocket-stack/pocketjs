// tests/desk98-sim.test.ts — desk98 in the sim. Two worlds:
//
//   1. standalone (no desk companion): the app boots a static arrangement —
//      the unmodified-app base case.
//   2. a mock desk companion: svcOpen/svcPoll/svcSend installed before eval
//      (bootWorld mutateOps), so the whole desk dialect journey runs
//      headless — typing, drag selection, ⌘ chords, the notepad context
//      menu, paste-req — with guest intents (copy payloads!) asserted on
//      the wire.
//
// The vue-vapor bundle must be prebuilt (the sim's fallback build cannot
// resolve the framework-suffixed name):
//
//   bun tools/build.ts desk98-main --framework=vue-vapor
//   bun test --conditions=browser tests/desk98-sim.test.ts

import { describe, expect, test } from "bun:test";
import {
  bootWorld,
  runScenario,
  treeHasText,
  type SimWorld,
} from "../hosts/sim/sim.ts";

const APP = "desk98-main.vue-vapor";

describe("desk98-main boots standalone", () => {
  test("desktop, taskbar and the boot windows render", async () => {
    const trace = await runScenario({ app: APP, seconds: 2 });
    expect(treeHasText(trace.tree, "Start")).toBe(true);
    expect(treeHasText(trace.tree, "Minesweeper")).toBe(true);
    expect(treeHasText(trace.tree, "My Computer")).toBe(true);
    expect(treeHasText(trace.tree, "Welcome to PocketJS 98.")).toBe(true);
  }, 30000);
});

// ---------------------------------------------------------------------------
// The desk companion journey
// ---------------------------------------------------------------------------

interface MockSvc {
  push: (line: Record<string, unknown>) => void;
  sent: () => Record<string, unknown>[];
  mutateOps: (ops: Record<string, unknown>) => void;
}

function mockSvc(): MockSvc {
  const toGuest: string[] = [];
  const fromGuest: Record<string, unknown>[] = [];
  return {
    push: (line) => toGuest.push(JSON.stringify(line)),
    sent: () => fromGuest,
    mutateOps: (ops) => {
      // The real desk companion is the native macos-app host. Mark this mock
      // native-shaped so unresolved portal marker images stay transparent in
      // sim; the host registers their texture handles before bundle eval.
      ops.__host = "macos-app";
      ops.svcOpen = (name: string) => name === "desk";
      ops.svcPoll = () => {
        if (toGuest.length === 0) return null;
        const batch = toGuest.join("\n");
        toGuest.length = 0;
        return batch;
      };
      ops.svcSend = (line: string) => {
        fromGuest.push(JSON.parse(line) as Record<string, unknown>);
      };
    },
  };
}

/** One frame + core catch-up + a microtask turn (Vue Vapor flushes
 *  dependent render effects in a microtask). */
async function step(world: SimWorld, frames = 1): Promise<void> {
  for (let f = 0; f < frames; f++) {
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    await Promise.resolve();
  }
}

function mouse(svc: MockSvc, x: number, y: number, d: boolean, b?: number) {
  svc.push(
    b === 2
      ? { t: "mouse", x, y, d, b: 2, sh: false }
      : { t: "mouse", x, y, d, sh: false },
  );
}

describe("desk98 desk companion journey", () => {
  test("typing, selection, ⌘ chords, context menu and paste-req", async () => {
    const svc = mockSvc();
    const world = await bootWorld(APP, 60, undefined, svc.mutateOps);
    const EPOCH = 1755650000000;
    svc.push({ t: "hello", w: 800, h: 600, epoch: EPOCH });
    await step(world, 3);

    // With the companion connected only the welcome notepad boots (the
    // standalone extras — the My Computer folder with its status bar — stay
    // closed); the taskbar clock ticks from the hello epoch.
    let tree = world.getTree();
    expect(treeHasText(tree, "welcome.txt - Notepad")).toBe(true);
    expect(treeHasText(tree, "object(s)")).toBe(false);
    const d = new Date(EPOCH);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(treeHasText(tree, hhmm)).toBe(true);

    // Typing: ch lines land at the caret (doc origin), one char per line.
    for (const ch of ["H", "i"]) svc.push({ t: "ch", s: ch });
    await step(world, 2);
    tree = world.getTree();
    expect(treeHasText(tree, "HiWelcome to PocketJS 98.")).toBe(true);

    // Double-click selects the word under the pointer; ⌘C ships it as a
    // copy intent (the welcome window sits at 64,28; content text origin
    // 70,71; row 0 centers at y≈79).
    mouse(svc, 75, 79, true);
    mouse(svc, 75, 79, false);
    await step(world);
    mouse(svc, 75, 79, true);
    mouse(svc, 75, 79, false);
    await step(world, 2);
    svc.push({ t: "key", k: "c", cmd: true });
    await step(world, 2);
    const copies = svc.sent().filter((l) => l.t === "copy");
    expect(copies.length).toBe(1);
    expect(copies[0].text).toBe("HiWelcome");

    // Drag selection: down at the line start, drag right, release; ⌘C
    // copies a prefix of the row and the selected run renders as its own
    // navy segment (its text splits out of the full-line node).
    mouse(svc, 70, 79, true);
    await step(world);
    mouse(svc, 140, 79, false);
    await step(world);
    mouse(svc, 140, 79, false);
    await step(world);
    svc.push({ t: "key", k: "c", cmd: true });
    await step(world, 2);
    const copy2 = svc.sent().filter((l) => l.t === "copy")[1];
    expect(typeof copy2.text).toBe("string");
    const dragged = copy2.text as string;
    expect(dragged.length).toBeGreaterThan(0);
    expect("HiWelcome to PocketJS 98.".startsWith(dragged)).toBe(true);
    tree = world.getTree();
    expect(treeHasText(tree, dragged)).toBe(true);

    // Right-click in the content opens the edit context menu; the Paste row
    // sends paste-req; the host's paste line lands at the caret.
    mouse(svc, 75, 100, true, 2);
    mouse(svc, 75, 100, false, 2);
    await step(world, 2);
    tree = world.getTree();
    expect(treeHasText(tree, "Select All")).toBe(true);
    expect(treeHasText(tree, "Paste")).toBe(true);
    // Popup at (75,100): 1px border, 18px rows — Cut, Copy, Paste.
    mouse(svc, 100, 101 + 18 + 18 + 9, true);
    mouse(svc, 100, 101 + 18 + 18 + 9, false);
    await step(world, 2);
    expect(svc.sent().some((l) => l.t === "paste-req")).toBe(true);
    svc.push({ t: "paste", text: "[PASTED]" });
    await step(world, 2);
    expect(treeHasText(world.getTree(), "[PASTED]")).toBe(true);

    // ⌘Esc toggles the Start menu.
    svc.push({ t: "key", k: "escape", cmd: true });
    await step(world, 2);
    tree = world.getTree();
    expect(treeHasText(tree, "Programs")).toBe(true);
    expect(treeHasText(tree, "Shut Down...")).toBe(true);
    svc.push({ t: "key", k: "Escape" });
    await step(world, 2);
    expect(treeHasText(world.getTree(), "Shut Down...")).toBe(false);

    // ⌘N opens a fresh Notepad, ⌘W closes it again.
    svc.push({ t: "key", k: "n", cmd: true });
    await step(world, 2);
    expect(treeHasText(world.getTree(), "Untitled - Notepad")).toBe(true);
    svc.push({ t: "key", k: "w", cmd: true });
    await step(world, 2);
    expect(treeHasText(world.getTree(), "Untitled - Notepad")).toBe(false);

    // Undo/redo: a typing run coalesces into ONE unit — ⌘Z pulls both
    // characters back out at once, ⌘⇧Z replays them.
    for (const ch of ["Q", "Q"]) svc.push({ t: "ch", s: ch });
    await step(world, 2);
    expect(treeHasText(world.getTree(), "[PASTED]QQ")).toBe(true);
    svc.push({ t: "key", k: "z", cmd: true });
    await step(world, 2);
    const afterUndo = world.getTree();
    expect(treeHasText(afterUndo, "[PASTED]QQ")).toBe(false);
    expect(treeHasText(afterUndo, "[PASTED]")).toBe(true);
    svc.push({ t: "key", k: "z", cmd: true, sh: true });
    await step(world, 2);
    expect(treeHasText(world.getTree(), "[PASTED]QQ")).toBe(true);
  }, 30000);

  test("desktop icons open independent Pocket app windows and route focused input", async () => {
    const svc = mockSvc();
    const world = await bootWorld(APP, 60, undefined, svc.mutateOps);
    svc.push({ t: "hello", w: 800, h: 600, epoch: 1755650000000 });
    await step(world, 3);

    const doubleClick = async (x: number, y: number) => {
      mouse(svc, x, y, true);
      mouse(svc, x, y, false);
      await step(world);
      mouse(svc, x, y, true);
      mouse(svc, x, y, false);
      await step(world, 2);
    };

    // Five system icons precede Hero and Settings. At 800x600 the grid has
    // nine rows, so both remain in the first column at y=298 and y=356.
    await doubleClick(45, 320);
    expect(treeHasText(world.getTree(), "PocketJS: Hero")).toBe(true);
    expect(
      svc
        .sent()
        .some((line) => line.t === "pocket-open" && line.app === "hero-main"),
    ).toBe(true);

    await doubleClick(45, 378);
    let tree = world.getTree();
    expect(treeHasText(tree, "PocketJS: Hero")).toBe(true);
    expect(treeHasText(tree, "PocketJS: Settings")).toBe(true);
    expect(
      svc
        .sent()
        .some(
          (line) => line.t === "pocket-open" && line.app === "settings-main",
        ),
    ).toBe(true);

    // Settings is focused: named and character input become button pulses
    // for that realm only. The host maps these to one guest frame.
    svc.push({ t: "key", k: "Right" });
    svc.push({ t: "ch", s: "z" });
    await step(world, 2);
    const inputs = svc.sent().filter((line) => line.t === "pocket-input");
    expect(inputs.slice(-2)).toEqual([
      { t: "pocket-input", app: "settings-main", buttons: 0x0020 },
      { t: "pocket-input", app: "settings-main", buttons: 0x4000 },
    ]);

    svc.push({ t: "key", k: "w", cmd: true });
    await step(world, 2);
    tree = world.getTree();
    expect(treeHasText(tree, "PocketJS: Settings")).toBe(false);
    expect(treeHasText(tree, "PocketJS: Hero")).toBe(true);
    expect(
      svc
        .sent()
        .some(
          (line) => line.t === "pocket-close" && line.app === "settings-main",
        ),
    ).toBe(true);
  }, 30000);
});
