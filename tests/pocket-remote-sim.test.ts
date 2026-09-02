// Boots the built Pocket Remote bundle in the headless sim and drives it the
// way the daemon would: hello, theme, a Hyprland snapshot. No svc channel
// exists in the sim, so the app publishes its store as globalThis.__pocketRemote
// and the test feeds host lines straight into the reducer, then taps the
// screen through the real touch path.

import { describe, expect, test } from "bun:test";
import { bootWorld } from "../hosts/sim/sim.ts";
import type { HostState } from "../apps/pocket-remote/protocol.ts";
import { STAGE, TAB_W } from "../apps/pocket-remote/layout.ts";
import type { RemoteStore } from "../apps/pocket-remote/store.ts";

const HZ = 60;

function pack(x: number, y: number, id = 0): number {
  return x > 511 || y > 511 ? (0x80000000 | (id << 20) | (y << 10) | x) >>> 0 : (id << 18) | (y << 9) | x;
}

const SNAPSHOT: HostState = {
  t: "state",
  mon: { w: 1440, h: 900 },
  ws: [{ id: 1, n: 2 }, { id: 2, n: 0 }],
  active: 1,
  focus: "0x55f90cb39300",
  layout: "dwindle",
  win: [
    { a: "0x55f90cb39300", c: "foot", ti: "evan@x1nano-omarchy:~", ws: 1, x: 12, y: 38, w: 701, h: 850 },
    { a: "0x55f90e41dd40", c: "chromium", ti: "ChatGPT - Chromium", ws: 1, x: 725, y: 38, w: 703, h: 850 },
  ],
};

/** The devtools tree: `{ i, t, c?, x?, k? }` — id, tag, class, text, kids. */
function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  visit(record);
  const kids = record.k;
  if (Array.isArray(kids)) for (const child of kids) walk(child, visit);
}

function texts(tree: unknown): string[] {
  const out: string[] = [];
  walk(tree, (n) => {
    if (n.t === "#text" && typeof n.x === "string") out.push(n.x);
  });
  return out;
}

describe("pocket-remote in the sim", () => {
  test("connects, mirrors a snapshot into tiles, and switches workspace from the strip", async () => {
    const world = await bootWorld("pocket-remote-main", HZ, undefined, undefined, { width: 480, height: 320 });
    const store = (globalThis as { __pocketRemote?: RemoteStore }).__pocketRemote;
    expect(store).toBeDefined();
    if (!store) return;

    world.frame(0);
    expect(store.link()).toBe("off");
    expect(texts(world.getTree()).join(" ")).toContain("Pocket Remote");

    store.applyLine({ t: "hello", proto: 1, name: "x1nano-omarchy", omarchy: "4.0.1-1", auth: "ok" });
    store.applyLine({
      t: "theme",
      name: "tokyo-night",
      list: ["tokyo-night", "nord"],
      colors: {
        bg: "#1a1b26", bgDark: "#13141c", fg: "#a9b1d6", fgDim: "#565f89", accent: "#7aa2f7",
        red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#449dab", muted: "#414868",
      },
    });
    store.applyLine({ t: "levels", vol: 0.4, bri: 0.33 });
    store.applyLine(SNAPSHOT);
    for (let i = 0; i < 30; i += 1) world.frame(0);

    expect(store.link()).toBe("up");
    expect(store.vol()).toBeCloseTo(0.4);
    expect(store.slots.filter((slot) => slot.a !== null).map((slot) => slot.label())).toEqual(["foot", "chromium"]);
    const shown = texts(world.getTree());
    expect(shown).toContain("foot");
    expect(shown).toContain("chromium");
    expect(shown).toContain("dwindle");
    expect(store.tabs().map((t) => t.id)).toEqual([1, 2]);

    // The tile pool settled: geometry landed inside the stage.
    for (const slot of store.slots) {
      if (slot.a === null) continue;
      expect(slot.cur.x).toBeGreaterThanOrEqual(STAGE.x);
      expect(slot.cur.x + slot.cur.w).toBeLessThanOrEqual(STAGE.x + STAGE.w + 1);
      expect(slot.cur.alpha).toBe(1);
    }

    // Tap workspace tab 2 on the strip: optimistic switch, tiles of ws 1 fade.
    const x = store.tabs()[1]!.x + TAB_W / 2;
    const y = 14;
    world.frame(0, undefined, [pack(x, y)]);
    world.frame(0, undefined, [pack(x, y)]);
    world.frame(0, undefined, []);
    for (let i = 0; i < 20; i += 1) world.frame(0);
    expect(store.state()?.active).toBe(2);
    expect(store.slots.filter((slot) => slot.a !== null).length).toBe(0);
    expect(texts(world.getTree()).join(" ")).toContain("empty workspace");

    // Render a frame: the panel is 480x320 logical.
    const pixels = world.render();
    expect(pixels.length).toBe(480 * 320 * 4);
  });

  test("a hello that is still pending shows the approval screen", async () => {
    const world = await bootWorld("pocket-remote-main", HZ, undefined, undefined, { width: 480, height: 320 });
    const store = (globalThis as { __pocketRemote?: RemoteStore }).__pocketRemote!;
    store.applyLine({ t: "hello", proto: 1, name: "x1nano-omarchy", omarchy: "4.0.1-1", auth: "pending" });
    world.frame(0);
    expect(store.link()).toBe("pending");
    expect(texts(world.getTree()).join(" ")).toContain("approve this remote on x1nano-omarchy");
    store.applyLine({ t: "auth", auth: "ok" });
    world.frame(0);
    expect(store.link()).toBe("up");
  });
});
