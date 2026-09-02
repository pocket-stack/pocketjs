// Boots the built Pocket Remote bundle in the headless sim and drives it the
// way the daemon would: hello, theme, a Hyprland snapshot. No svc channel
// exists in the sim, so the app publishes its store as globalThis.__pocketRemote
// and the test feeds host lines straight into the reducer, then touches the
// screen through the real touch path.

import { describe, expect, test } from "bun:test";
import { bootWorld } from "../hosts/sim/sim.ts";
import type { HostState } from "../apps/pocket-remote/protocol.ts";
import { keyboardKeys, TRACKPAD } from "../apps/pocket-remote/keyboard-layout.ts";
import { BALL_HOME, CC_BUTTON, MODE, MODE_HALF_W, SHEET_LIST, sheetRowRect, STAGE, TAB_W } from "../apps/pocket-remote/layout.ts";
import type { RemoteStore } from "../apps/pocket-remote/store.ts";

const HZ = 60;

function pack(x: number, y: number, id = 0): number {
  return x > 511 || y > 511 ? (0x80000000 | (id << 20) | (y << 10) | x) >>> 0 : (id << 18) | (y << 9) | x;
}

const SNAPSHOT: HostState = {
  t: "state",
  mon: { w: 1440, h: 900, x: 0, y: 0 },
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

/** A connected remote over a fake svc channel: `sent` is what it asked
 *  the laptop for, in order. */
async function connected(): Promise<{ world: Awaited<ReturnType<typeof bootWorld>>; store: RemoteStore; sent: unknown[] }> {
  const sent: unknown[] = [];
  const svc = { open: () => true, poll: () => [], send: (line: unknown) => sent.push(line) };
  const world = await bootWorld("pocket-remote-main", HZ, { __pocketRemoteSvc: svc }, undefined, { width: 480, height: 320 });
  const store = (globalThis as { __pocketRemote?: RemoteStore }).__pocketRemote;
  if (!store) throw new Error("the bundle did not publish its store");
  world.frame(0);
  store.applyLine({ t: "hello", proto: 2, name: "x1nano-omarchy", omarchy: "4.0.1-1", auth: "ok" });
  store.applyLine({ t: "levels", vol: 0.4, bri: 0.33 });
  store.applyLine(SNAPSHOT);
  for (let i = 0; i < 30; i += 1) world.frame(0);
  sent.length = 0;
  return { world, store, sent };
}

const tap = (world: Awaited<ReturnType<typeof bootWorld>>, x: number, y: number, settle = 20) => {
  world.frame(0, undefined, [pack(x, y)]);
  world.frame(0, undefined, [pack(x, y)]);
  world.frame(0, undefined, []);
  for (let i = 0; i < settle; i += 1) world.frame(0);
};

describe("pocket-remote in the sim", () => {
  test("connects, mirrors a snapshot into tiles, and switches workspace from the strip", async () => {
    const world = await bootWorld("pocket-remote-main", HZ, undefined, undefined, { width: 480, height: 320 });
    const store = (globalThis as { __pocketRemote?: RemoteStore }).__pocketRemote;
    expect(store).toBeDefined();
    if (!store) return;

    world.frame(0);
    expect(store.link()).toBe("off");
    expect(texts(world.getTree()).join(" ")).toContain("Pocket Remote");

    store.applyLine({ t: "hello", proto: 2, name: "x1nano-omarchy", omarchy: "4.0.1-1", auth: "ok" });
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
    store.applyLine({ t: "cc", wifi: { on: 1, ssid: "Petite Auberge", sig: 54 }, media: { st: "paused", title: "Blue in Green", artist: "Miles Davis" } });
    store.applyLine(SNAPSHOT);
    for (let i = 0; i < 30; i += 1) world.frame(0);

    expect(store.link()).toBe("up");
    expect(store.vol()).toBeCloseTo(0.4);
    expect(store.wifi().ssid).toBe("Petite Auberge");
    expect(store.media().st).toBe("paused");
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
    tap(world, x, 14);
    expect(store.state()?.active).toBe(2);
    expect(store.slots.filter((slot) => slot.a !== null).length).toBe(0);
    expect(texts(world.getTree()).join(" ")).toContain("empty workspace");
    expect(texts(world.getTree()).join(" ")).toContain("Terminal");

    // Render a frame: the panel is 480x320 logical.
    const pixels = world.render();
    expect(pixels.length).toBe(480 * 320 * 4);
  });

  test("the ball opens Omarchy's menu as a sheet, a submenu opens in place, back returns", async () => {
    const { world, store, sent } = await connected();
    tap(world, BALL_HOME.x + 22, BALL_HOME.y + 22);
    expect(store.sheet()?.at).toBe("root");
    let shown = texts(world.getTree()).join(" ");
    expect(shown).toContain("Go");
    expect(shown).toContain("Trigger");
    expect(shown).toContain("System");
    // Trigger is the third root row: second column, second row.
    const trigger = sheetRowRect(2);
    tap(world, SHEET_LIST.x + trigger.x + 60, SHEET_LIST.y + trigger.y + 19);
    expect(store.sheet()?.at).toBe("trigger");
    shown = texts(world.getTree()).join(" ");
    expect(shown).toContain("Capture");
    expect(shown).not.toContain("Install");
    // A row with an action runs on the laptop and closes the sheet.
    const rows = store.sheetRows();
    const emoji = rows.findIndex((row) => row.id === "trigger.emoji");
    expect(emoji).toBeGreaterThanOrEqual(0);
    const r = sheetRowRect(emoji);
    tap(world, SHEET_LIST.x + r.x + 60, SHEET_LIST.y + r.y + 19);
    expect(store.sheet()).toBeNull();
    expect(sent).toContainEqual({ t: "menu", id: "trigger.emoji" });
    // Hidden rows vanish from the sheet.
    store.applyLine({ t: "menu", hide: ["trigger.emoji"], check: [] });
    store.openSheet();
    store.sheetPush("trigger");
    world.frame(0);
    expect(store.sheetRows().map((row) => row.id)).not.toContain("trigger.emoji");
    store.sheetBack();
    expect(store.sheet()?.at).toBe("root");
    store.sheetBack();
    expect(store.sheet()).toBeNull();
  });

  test("the control centre opens from the strip and a tap outside closes it", async () => {
    const { world, store, sent } = await connected();
    tap(world, CC_BUTTON.x + CC_BUTTON.w / 2, CC_BUTTON.y + CC_BUTTON.h / 2);
    expect(store.cc()?.mode).toBe("sticky");
    expect(texts(world.getTree()).join(" ")).toContain("Wi-Fi");
    // The volume icon mutes.
    store.applyLine({ t: "levels", vol: 0.4, bri: 0.33 });
    tap(world, 204 + 28, 32 + 166 + 18);
    expect(sent).toContainEqual({ t: "mute" });
    tap(world, 40, 300);
    expect(store.cc()).toBeNull();
  });

  test("the deck types through the wire and the trackpad moves the pointer", async () => {
    const { world, store, sent } = await connected();
    tap(world, MODE.x + MODE_HALF_W + 17, MODE.y + 11);
    expect(store.mode()).toBe("deck");
    expect(texts(world.getTree()).join(" ")).toContain("space");
    const f = keyboardKeys("lower").find((k) => k.def.label === "f")!;
    tap(world, f.x + f.w / 2, f.y + f.h / 2);
    expect(sent).toContainEqual({ t: "type", text: "f" });
    // ctrl then c: a chord.
    const ctrl = keyboardKeys("lower").find((k) => k.def.label === "ctrl")!;
    tap(world, ctrl.x + ctrl.w / 2, ctrl.y + ctrl.h / 2, 5);
    const c = keyboardKeys("lower").find((k) => k.def.label === "c")!;
    tap(world, c.x + c.w / 2, c.y + c.h / 2);
    expect(sent).toContainEqual({ t: "key", k: "c", mods: ["ctrl"] });
    // A stroke across the trackpad.
    const y = TRACKPAD.y + 50;
    for (let i = 0; i < 12; i += 1) world.frame(0, undefined, [pack(100 + i * 6, y)]);
    world.frame(0, undefined, []);
    for (let i = 0; i < 5; i += 1) world.frame(0);
    const moves = sent.filter((line) => (line as { t: string }).t === "ptr") as { dx: number; dy: number }[];
    expect(moves.length).toBeGreaterThan(3);
    expect(moves.reduce((sum, m) => sum + m.dx, 0)).toBeGreaterThan(60);
    expect(sent).not.toContainEqual({ t: "click", b: "l" });
    // A tap on the trackpad clicks.
    tap(world, 200, y);
    expect(sent).toContainEqual({ t: "click", b: "l" });
  });

  test("a hello that is still pending shows the approval screen", async () => {
    const world = await bootWorld("pocket-remote-main", HZ, undefined, undefined, { width: 480, height: 320 });
    const store = (globalThis as { __pocketRemote?: RemoteStore }).__pocketRemote!;
    store.applyLine({ t: "hello", proto: 2, name: "x1nano-omarchy", omarchy: "4.0.1-1", auth: "pending" });
    world.frame(0);
    expect(store.link()).toBe("pending");
    expect(texts(world.getTree()).join(" ")).toContain("approve this remote on x1nano-omarchy");
    store.applyLine({ t: "auth", auth: "ok" });
    world.frame(0);
    expect(store.link()).toBe("up");
  });
});
