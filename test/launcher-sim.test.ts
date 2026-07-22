// test/launcher-sim.test.ts — the launcher + app-switch protocol on the
// deterministic sim host (LAUNCHER.md; host-sim/launcher.ts).
//
// Prereq (the `test` script runs it): bun scripts/launcher.ts covers
//   -> dist/launcher-registry.{json,tsv}, demos/launcher/covers/*,
//      dist/launcher-main.* and every admitted app's dist bundle.
//
// Deliberately NO pixel goldens here: covers are live sim renders of the
// other demos, so a committed launcher PNG would break on ANY demo's visual
// change — cross-demo coupling for zero coverage. Determinism is asserted
// the sim way instead: two identical journeys must hash identically frame
// by frame.

import { describe, expect, test } from "bun:test";
import { BTN } from "../spec/spec.ts";
import { scanRegistry } from "../scripts/launcher.ts";
import { bootLauncherWorld, type LauncherWorld } from "../host-sim/launcher.ts";
import { bootWorld, treeHasText } from "../host-sim/sim.ts";

const settle = async (w: LauncherWorld, frames: number) => {
  for (let i = 0; i < frames; i++) await w.step(0);
};

const registry = scanRegistry(new Set());

describe("launcher registry admission", () => {
  test("admits every PSP-compatible demo, excludes the rest", () => {
    const outputs = registry.apps.map((a) => a.output);
    // The two structurally incompatible demos (LAUNCHER.md "Admission").
    expect(outputs).not.toContain("ipod-nano-main");
    expect(outputs).not.toContain("note-main");
    // The launcher never lists itself.
    expect(outputs).not.toContain("launcher-main");
    // Spot-check the shape of what IS admitted.
    expect(outputs).toContain("hero-main");
    expect(outputs).toContain("cafe-main");
    expect(outputs).toContain("im-main");
    expect(registry.apps.length).toBeGreaterThanOrEqual(15);
    // One entry per output (the root manifest duplicates demos/hero).
    expect(new Set(outputs).size).toBe(outputs.length);
  });

  test("every entry carries id + title for the deck", () => {
    for (const app of registry.apps) {
      expect(app.id).toMatch(/^dev\.pocket-stack\./);
      expect(app.title.length).toBeGreaterThan(0);
    }
  });

  test("committed registry.generated.ts is fresh (re-run scripts/launcher.ts scan)", async () => {
    const { REGISTRY } = await import("../demos/launcher/registry.generated.ts");
    expect(REGISTRY.map((r) => ({ output: r.output, id: r.id, title: r.title }))).toEqual(
      registry.apps.map((a) => ({ output: a.output, id: a.id, title: a.title })),
    );
  });
});

describe("switch protocol (sim host policy)", () => {
  test("launch, summon with frozen shot + resume, relaunch", async () => {
    const w = await bootLauncherWorld({ hz: 60 });
    expect(w.current()).toBe("launcher-main");
    await settle(w, 30);

    // CIRCLE launches the front card (registry order: Café first).
    await w.step(BTN.CIRCLE);
    expect(w.current()).toBe("cafe-main");
    expect(w.resume()).toBeNull();
    await settle(w, 30);

    // SELECT summons the launcher; the interrupted app is the resume target
    // and its frozen frame was captured.
    await w.step(BTN.SELECT);
    expect(w.current()).toBe("launcher-main");
    expect(w.resume()).toBe("cafe-main");
    await settle(w, 20);
    expect(treeHasText(w.getTree(), "SELECT / CROSS RESUMES")).toBe(true);

    // SELECT again (release first — latched) resumes = relaunches.
    await w.step(0);
    await w.step(BTN.SELECT);
    expect(w.current()).toBe("cafe-main");
    expect(w.resume()).toBeNull();

    expect(w.switches.map((s) => s.reason)).toEqual(["boot", "launch", "summon", "launch"]);
  }, 120_000);

  test("guests never see SELECT; the launcher does", async () => {
    const w = await bootLauncherWorld({ hz: 60 });
    await settle(w, 10);
    // Browse one card right, launch Chrome, then hold SELECT for several
    // frames: exactly ONE summon (host edge, not level).
    await w.step(BTN.RIGHT);
    await settle(w, 20);
    await w.step(BTN.CIRCLE);
    const chrome = w.current();
    expect(chrome).not.toBe("launcher-main");
    await settle(w, 20);
    for (let i = 0; i < 5; i++) await w.step(BTN.SELECT);
    expect(w.current()).toBe("launcher-main");
    expect(w.switches.filter((s) => s.reason === "summon").length).toBe(1);
    // Held SELECT arrived latched: the launcher must NOT have resumed while
    // the chord stayed down.
    expect(w.resume()).toBe(chrome);
  }, 120_000);

  test("holding RTRIGGER flows the deck at 18 cards/s", async () => {
    const w = await bootLauncherWorld({ hz: 60 });
    await settle(w, 20);
    const motionIndex = registry.apps.findIndex((app) => app.title.includes("Motion Lab"));
    expect(motionIndex).toBeGreaterThan(0);
    // Move far enough to reach Motion Lab at 18 cards/s. Derive its index
    // from the registry so adding an earlier demo does not stale the test.
    const heldFrames = Math.ceil((motionIndex * 60) / 18);
    for (let i = 0; i < heldFrames; i++) await w.step(BTN.RTRIGGER);
    await settle(w, 20);
    expect(treeHasText(w.getTree(), "Motion Lab")).toBe(true);
    expect(w.current()).toBe("launcher-main");
  }, 120_000);

  test("a single-frame trigger tap moves exactly one card, never snaps back", async () => {
    const w = await bootLauncherWorld({ hz: 60 });
    await settle(w, 20);
    // One held frame advances pos by only 18/60 of a card — the release
    // rule must still land it one card over, not round home.
    await w.step(BTN.RTRIGGER);
    await settle(w, 20);
    expect(treeHasText(w.getTree(), "Chrome")).toBe(true);
    await w.step(BTN.LTRIGGER);
    await settle(w, 20);
    expect(treeHasText(w.getTree(), "Café")).toBe(true);
    // At the deck wall the tap has nowhere to go: Café stays.
    await w.step(BTN.LTRIGGER);
    await settle(w, 20);
    expect(treeHasText(w.getTree(), "Café")).toBe(true);
  }, 120_000);

  test("after a summon, CIRCLE launches the BROWSED card, never the resume app", async () => {
    // The real-hardware report behind the CIRCLE-confirm mapping: users
    // confirmed with O (then bound to resume) and every pick landed back in
    // the interrupted app. Guard the mapping: summon out of Café, browse two
    // cards right, confirm — must enter Cursor, not Café.
    const w = await bootLauncherWorld({ hz: 60 });
    await settle(w, 10);
    await w.step(BTN.CIRCLE); // launch Café (front card)
    expect(w.current()).toBe("cafe-main");
    await settle(w, 20);
    await w.step(BTN.SELECT); // summon
    expect(w.resume()).toBe("cafe-main");
    await settle(w, 10);
    await w.step(BTN.RIGHT);
    await settle(w, 15);
    await w.step(BTN.RIGHT);
    await settle(w, 15);
    await w.step(BTN.CIRCLE);
    expect(w.current()).toBe("cursor-main");
    expect(w.resume()).toBeNull();
  }, 120_000);

  test("two identical journeys produce identical frame hashes", async () => {
    const journey = async (): Promise<string[]> => {
      const w = await bootLauncherWorld({ hz: 60 });
      const hashes: string[] = [];
      const record = async (mask: number) => {
        await w.step(mask);
        hashes.push(w.hash());
      };
      for (let i = 0; i < 20; i++) await record(0);
      await record(BTN.RIGHT);
      for (let i = 0; i < 15; i++) await record(0);
      await record(BTN.CIRCLE);
      for (let i = 0; i < 20; i++) await record(0);
      await record(BTN.SELECT);
      for (let i = 0; i < 15; i++) await record(0);
      return hashes;
    };
    const a = await journey();
    const b = await journey();
    expect(b).toEqual(a);
  }, 240_000);
});

describe("degraded mode (hosts without the app* ops)", () => {
  test("plain bootWorld: deck browses, footer says why", async () => {
    const world = await bootWorld("launcher-main", 60);
    for (let f = 0; f < 30; f++) {
      world.frame(0);
      world.tick();
    }
    expect(treeHasText(world.getTree(), "browse only")).toBe(true);
  }, 120_000);
});
