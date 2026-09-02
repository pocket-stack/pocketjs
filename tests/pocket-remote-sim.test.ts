// Boots the built Pocket Remote bundle in the headless sim and drives it the
// way the daemon would: hello, theme, a Hyprland snapshot. No svc channel
// exists in the sim, so the app publishes its store as globalThis.__pocketRemote
// and the test feeds host lines straight into the reducer, then touches the
// screen through the real touch path.

import { describe, expect, test } from "bun:test";
import { bootWorld } from "../hosts/sim/sim.ts";
import type { HostState } from "../apps/pocket-remote/protocol.ts";
import { CLICK_KEY, DPAD_KEYS, keyboardKeys, MENU_KEY, TRACKPAD } from "../apps/pocket-remote/keyboard-layout.ts";
import {
  BALL_HOME,
  CC_BUTTON,
  launchCellRect,
  MODE,
  MODE_HALF_W,
  POPUP_PAD,
  POPUP_ROW_H,
  SHEET_LIST,
  sheetRowRect,
  STAGE,
  TAB_W,
  TILE_POPUP_ROWS,
} from "../apps/pocket-remote/layout.ts";
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
    { a: "0x55f90e41dd40", c: "chromium", ti: "ChatGPT", ws: 1, x: 725, y: 38, w: 703, h: 850 },
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

type World = Awaited<ReturnType<typeof bootWorld>>;

const tap = (world: World, x: number, y: number, settle = 20) => {
  world.frame(0, undefined, [pack(x, y)]);
  world.frame(0, undefined, [pack(x, y)]);
  world.frame(0, undefined, []);
  for (let i = 0; i < settle; i += 1) world.frame(0);
};

/** Hold at one point, slide to another, release — the remote's second verb. */
const holdSlide = (world: World, from: { x: number; y: number }, to: { x: number; y: number }, settle = 20) => {
  for (let i = 0; i < 30; i += 1) world.frame(0, undefined, [pack(from.x, from.y)]);
  for (let i = 1; i <= 6; i += 1) {
    world.frame(0, undefined, [
      pack(Math.round(from.x + ((to.x - from.x) * i) / 6), Math.round(from.y + ((to.y - from.y) * i) / 6)),
    ]);
  }
  world.frame(0, undefined, []);
  for (let i = 0; i < settle; i += 1) world.frame(0);
};

/** The brightest run of pixels in a band, as a horizontal centre: the key
 *  bubble is a light chip over dark keys, so this finds where it sits. */
function brightCentre(pixels: Uint8Array, top: number, bottom: number): number | null {
  let sum = 0;
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < 480; x += 1) {
      const at = (y * 480 + x) * 4;
      if (pixels[at]! > 180 && pixels[at + 1]! > 180 && pixels[at + 2]! > 180) {
        sum += x;
        count += 1;
      }
    }
  }
  return count > 40 ? sum / count : null;
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
    // A tile leads with the window's title and names its program under it:
    // four terminals used to read "foot" four times.
    expect(store.slots.filter((slot) => slot.a !== null).map((slot) => slot.label())).toEqual([
      "evan@x1nano-omarchy:~",
      "ChatGPT",
    ]);
    expect(store.slots.filter((slot) => slot.a !== null).map((slot) => slot.title())).toEqual(["Foot", "Chromium"]);
    const shown = texts(world.getTree());
    expect(shown).toContain("evan@x1nano-omarchy:~");
    expect(shown).toContain("Chromium");
    expect(shown).toContain("dwindle");
    // Tabs are the fixed set Omarchy binds, not the two Hyprland reports.
    expect(store.tabs().map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);

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
    const onEmpty = texts(world.getTree()).join(" ");
    expect(onEmpty).toContain("empty workspace");
    // The launch bar is fixed: it was already there with the windows up.
    expect(onEmpty).toContain("Terminal");

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

  test("holding a tile opens its popup and the same finger picks a row", async () => {
    const { world, store, sent } = await connected();
    const fit = store.fit()!;
    // The right-hand window's tile, held in its middle.
    const tile = store.slots.find((slot) => slot.a === "0x55f90e41dd40")!;
    const from = { x: Math.round(tile.cur.x + tile.cur.w / 2), y: Math.round(tile.cur.y + tile.cur.h / 2) };
    expect(fit.rect.w).toBeGreaterThan(0);
    for (let i = 0; i < 30; i += 1) world.frame(0, undefined, [pack(from.x, from.y)]);
    const popup = store.popup();
    expect(popup?.a).toBe("0x55f90e41dd40");
    expect(popup!.place.h).toBe(TILE_POPUP_ROWS * POPUP_ROW_H + 2 * POPUP_PAD);
    // No tree probe while a finger is down: the probe advances the world by
    // one touchless frame, which would end the hold being tested.
    // Slide onto the second row and release: one gesture, no second tap.
    const row = { x: popup!.place.x + 40, y: popup!.place.y + POPUP_PAD + POPUP_ROW_H + POPUP_ROW_H / 2 };
    for (let i = 1; i <= 6; i += 1) {
      world.frame(0, undefined, [pack(Math.round(from.x + ((row.x - from.x) * i) / 6), Math.round(from.y + ((row.y - from.y) * i) / 6))]);
    }
    expect(store.popup()?.hot).toBe(1);
    world.frame(0, undefined, []);
    for (let i = 0; i < 10; i += 1) world.frame(0);
    expect(store.popup()).toBeNull();
    expect(sent).toContainEqual({ t: "win", op: "full", a: "0x55f90e41dd40" });

    // Lifting without sliding leaves the popup up (whatever it covers), and
    // a later tap acts.
    for (let i = 0; i < 30; i += 1) world.frame(0, undefined, [pack(from.x, from.y)]);
    world.frame(0, undefined, []);
    for (let i = 0; i < 10; i += 1) world.frame(0);
    expect(store.popup()).not.toBeNull();
    expect(texts(world.getTree()).join(" ")).toContain("Full screen");
    const place = store.popup()!.place;
    tap(world, place.x + 40, place.y + POPUP_PAD + POPUP_ROW_H / 2);
    expect(store.popup()).toBeNull();
    expect(sent).toContainEqual({ t: "win", op: "float", a: "0x55f90e41dd40" });
  });

  test("the launch bar starts an app from anywhere on the stage", async () => {
    const { world, store, sent } = await connected();
    expect(texts(world.getTree()).join(" ")).toContain("Browser");
    const cell = launchCellRect(1, 3);
    tap(world, cell.x + cell.w / 2, cell.y + cell.h / 2);
    expect(sent).toContainEqual({ t: "act", id: "browser" });
    // The bar belongs to the stage: the deck's bottom half is the trackpad.
    tap(world, MODE.x + MODE_HALF_W + 17, MODE.y + 11);
    expect(texts(world.getTree()).join(" ")).not.toContain("Files");
  });

  test("the sheet is one column, scrolls, and lists the machine's applications", async () => {
    const { world, store, sent } = await connected();
    store.applyLine({ t: "apps", seq: 0, more: 1, a: [{ i: "foot", n: "Foot" }, { i: "chromium", n: "Chromium" }] });
    store.applyLine({ t: "apps", seq: 1, a: [{ i: "org.gnome.Nautilus", n: "Files" }] });
    expect(store.apps().length).toBe(3);

    tap(world, BALL_HOME.x + 22, BALL_HOME.y + 22);
    const root = store.sheetRows();
    expect(root.length).toBe(10);
    // One column: every row shares an x and steps by one row height.
    expect(sheetRowRect(1).x).toBe(sheetRowRect(0).x);
    expect(sheetRowRect(1).y - sheetRowRect(0).y).toBe(sheetRowRect(0).h);
    // A finger that lands to fling must not flash a row's highlight; one
    // that stays put does highlight. (A release on a row navigates, so the
    // sheet is reopened at the root afterwards.)
    const onRow = { x: SHEET_LIST.x + 100, y: SHEET_LIST.y + 150 };
    world.frame(0, undefined, [pack(onRow.x, onRow.y)]);
    world.frame(0, undefined, [pack(onRow.x, onRow.y)]);
    expect(store.sheet()!.hot).toBeNull();
    for (let i = 0; i < 12; i += 1) world.frame(0, undefined, [pack(onRow.x, onRow.y)]);
    expect(store.sheet()!.hot).toBe(3);
    world.frame(0, undefined, []);
    for (let i = 0; i < 12; i += 1) world.frame(0);
    store.openSheet();
    for (let i = 0; i < 12; i += 1) world.frame(0);
    expect(store.sheet()!.hot).toBeNull();

    // Ten rows do not fit: a fling scrolls the list.
    const listMid = { x: SHEET_LIST.x + 100, y: SHEET_LIST.y + 150 };
    world.frame(0, undefined, [pack(listMid.x, listMid.y)]);
    for (let i = 1; i <= 8; i += 1) world.frame(0, undefined, [pack(listMid.x, listMid.y - i * 12)]);
    world.frame(0, undefined, []);
    for (let i = 0; i < 40; i += 1) world.frame(0);
    expect(store.sheetScroller.offset()).toBeGreaterThan(20);
    expect(store.sheet()).not.toBeNull();

    // Apps opens on the device, not the laptop.
    store.sheetScroller.scrollTo(0, { immediate: true });
    world.frame(0);
    const appsAt = store.sheetRows().findIndex((row) => row.id === "apps");
    const r = sheetRowRect(appsAt);
    tap(world, SHEET_LIST.x + r.x + 60, SHEET_LIST.y + r.y + 20);
    expect(store.sheet()?.at).toBe("apps");
    expect(store.sheetRows().map((row) => row.label)).toEqual(["Foot", "Chromium", "Files"]);
    expect(texts(world.getTree()).join(" ")).toContain("Chromium");
    // Tapping one launches it and closes the sheet.
    const first = sheetRowRect(0);
    tap(world, SHEET_LIST.x + first.x + 60, SHEET_LIST.y + first.y + 20);
    expect(store.sheet()).toBeNull();
    expect(sent).toContainEqual({ t: "launch", app: "foot" });
  });

  test("a tile's corner resizes the window, and its popup opens another", async () => {
    const { world, store, sent } = await connected();
    const tile = store.slots.find((slot) => slot.a === "0x55f90e41dd40")!;
    const grip = { x: Math.round(tile.cur.x + tile.cur.w - 6), y: Math.round(tile.cur.y + tile.cur.h - 6) };
    expect(store.gripAt(grip.x, grip.y)).toBe("0x55f90e41dd40");
    // Drag the corner left: the window is asked to shrink by monitor px.
    world.frame(0, undefined, [pack(grip.x, grip.y)]);
    for (let i = 1; i <= 8; i += 1) world.frame(0, undefined, [pack(grip.x - i * 6, grip.y)]);
    world.frame(0, undefined, []);
    for (let i = 0; i < 6; i += 1) world.frame(0);
    const resizes = sent.filter((line) => (line as { op?: string }).op === "resize") as { dx: number; dy: number }[];
    expect(resizes.length).toBeGreaterThan(0);
    expect(resizes.reduce((sum, r) => sum + r.dx, 0)).toBeLessThan(-100);
    // The focus follows the corner being grabbed, the way a resize does.
    expect(sent).toContainEqual({ t: "win", op: "focus", a: "0x55f90e41dd40" });

    // Its popup's third row opens another window of the same program.
    const mid = { x: Math.round(tile.cur.x + tile.cur.w / 2), y: Math.round(tile.cur.y + tile.cur.h / 2) };
    for (let i = 0; i < 30; i += 1) world.frame(0, undefined, [pack(mid.x, mid.y)]);
    world.frame(0, undefined, []);
    for (let i = 0; i < 10; i += 1) world.frame(0);
    const place = store.popup()!.place;
    expect(texts(world.getTree()).join(" ")).toContain("Open another");
    tap(world, place.x + 40, place.y + POPUP_PAD + POPUP_ROW_H * 2 + POPUP_ROW_H / 2);
    expect(sent).toContainEqual({ t: "win", op: "same", a: "0x55f90e41dd40" });
  });

  test("floating windows are stacked above the tiled ones", async () => {
    const { store } = await connected();
    store.applyLine({
      t: "state",
      mon: { w: 1440, h: 900, x: 0, y: 0 },
      ws: [{ id: 1, n: 3 }],
      active: 1,
      focus: "0xT1",
      layout: "dwindle",
      win: [
        { a: "0xT1", c: "foot", ti: "one", ws: 1, x: 0, y: 0, w: 720, h: 900 },
        { a: "0xF1", c: "mpv", ti: "float", ws: 1, x: 300, y: 300, w: 400, h: 300, f: 1 },
        { a: "0xT2", c: "foot", ti: "two", ws: 1, x: 720, y: 0, w: 720, h: 900 },
      ],
    });
    const z = (a: string) => store.slots.find((slot) => slot.a === a)!.z;
    expect(z("0xF1")).toBeGreaterThan(z("0xT1"));
    expect(z("0xF1")).toBeGreaterThan(z("0xT2"));
    // Within a group, the more recently focused sits higher.
    expect(z("0xT1")).toBeGreaterThan(z("0xT2"));
  });

  test("the ball is on the stage only: the deck's own controls own that space", async () => {
    const { world, store } = await connected();
    tap(world, MODE.x + MODE_HALF_W + 17, MODE.y + 11);
    expect(store.mode()).toBe("deck");
    // A drag where the ball would be belongs to the deck: the ball itself
    // does not move, because it is not on this screen.
    const before = store.ball();
    for (let i = 0; i < 8; i += 1) {
      world.frame(0, undefined, [pack(before.x + 22, Math.round(before.y + 22 - i * 6))]);
    }
    world.frame(0, undefined, []);
    for (let i = 0; i < 6; i += 1) world.frame(0);
    expect(store.ball()).toEqual(before);
    expect(store.ballDragging()).toBe(false);
  });

  test("the d-pad fires at once and repeats while held, with the modifier riding along", async () => {
    const { world, store, sent } = await connected();
    tap(world, MODE.x + MODE_HALF_W + 17, MODE.y + 11);
    const right = DPAD_KEYS.r;
    const at = { x: right.x + right.w / 2, y: right.y + right.h / 2 };

    // A tap: exactly one Right, on the press.
    world.frame(0, undefined, [pack(at.x, at.y)]);
    expect(store.dpad()?.dir).toBe("r");
    expect(sent.filter((line) => (line as { t: string }).t === "key")).toEqual([{ t: "key", k: "Right" }]);
    world.frame(0, undefined, []);
    for (let i = 0; i < 4; i += 1) world.frame(0);
    expect(store.dpad()).toBeNull();
    expect(sent.filter((line) => (line as { t: string }).t === "key").length).toBe(1);

    // Held: the first press, then repeats.
    sent.length = 0;
    const up = DPAD_KEYS.u;
    for (let i = 0; i < 70; i += 1) world.frame(0, undefined, [pack(up.x + up.w / 2, up.y + up.h / 2)]);
    const ups = sent.filter((line) => (line as { k?: string }).k === "Up");
    expect(ups.length).toBeGreaterThan(4);
    expect(ups.length).toBeLessThan(14);
    world.frame(0, undefined, []);
    for (let i = 0; i < 4; i += 1) world.frame(0);

    // A sticky modifier rides along: ctrl then left is ctrl+Left.
    sent.length = 0;
    const ctrl = keyboardKeys("lower").find((k) => k.def.label === "ctrl")!;
    tap(world, ctrl.x + ctrl.w / 2, ctrl.y + ctrl.h / 2, 5);
    const left = DPAD_KEYS.l;
    tap(world, left.x + left.w / 2, left.y + left.h / 2, 5);
    expect(sent).toContainEqual({ t: "key", k: "Left", mods: ["ctrl"] });
    expect(store.kbMods()).toEqual([]);
  });

  test("the deck's menu key opens the sheet, and ctrl reaches the pointer", async () => {
    const { world, store, sent } = await connected();
    tap(world, MODE.x + MODE_HALF_W + 17, MODE.y + 11);
    expect(store.mode()).toBe("deck");

    // ctrl then a tap on the pad: the click carries the modifier, because a
    // virtual pointer cannot hold one itself.
    const ctrl = keyboardKeys("lower").find((k) => k.def.label === "ctrl")!;
    tap(world, ctrl.x + ctrl.w / 2, ctrl.y + ctrl.h / 2, 5);
    expect(store.kbMods()).toEqual(["ctrl"]);
    tap(world, TRACKPAD.x + 60, TRACKPAD.y + 50, 6);
    expect(sent).toContainEqual({ t: "click", b: "l", mods: ["ctrl"] });
    expect(store.kbMods()).toEqual([]);

    // The click key holds the button down: the other finger drags a
    // selection, and lifting the key ends it.
    sent.length = 0;
    world.frame(0, undefined, [pack(CLICK_KEY.x + 30, CLICK_KEY.y + 20)]);
    for (let i = 0; i < 6; i += 1) world.frame(0, undefined, [pack(CLICK_KEY.x + 30, CLICK_KEY.y + 20)]);
    expect(store.clickHeld()).toBe(true);
    expect(sent).toContainEqual({ t: "drag", on: 1 });
    // A second finger on the pad moves the pointer while the button is down.
    for (let i = 1; i <= 8; i += 1) {
      world.frame(0, undefined, [
        pack(CLICK_KEY.x + 30, CLICK_KEY.y + 20),
        pack(TRACKPAD.x + 40 + i * 8, TRACKPAD.y + 40, 1),
      ]);
    }
    expect(sent.some((line) => (line as { t: string }).t === "ptr")).toBe(true);
    // Lifting the pad finger must not click while the button is held.
    world.frame(0, undefined, [pack(CLICK_KEY.x + 30, CLICK_KEY.y + 20)]);
    for (let i = 0; i < 3; i += 1) world.frame(0);
    expect(sent.filter((line) => (line as { t: string }).t === "click").length).toBe(0);
    world.frame(0, undefined, []);
    for (let i = 0; i < 4; i += 1) world.frame(0);
    expect(store.clickHeld()).toBe(false);
    expect(sent).toContainEqual({ t: "drag", on: 0 });

    // The menu key opens Omarchy's sheet from the deck.
    tap(world, MENU_KEY.x + 30, MENU_KEY.y + 20);
    expect(store.sheet()?.at).toBe("root");
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
