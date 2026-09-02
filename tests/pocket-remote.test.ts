import { describe, expect, test } from "bun:test";
import {
  SVC_POLL_BUF,
  WIRE_BEACON_MAGIC,
  WIRE_BEACON_PORT,
  WIRE_HEADER_SIZE,
  WIRE_MAGIC,
  WIRE_MAX_PAYLOAD,
  WIRE_MSG,
  WIRE_PORT,
  WIRE_VERSION,
} from "../contracts/spec/spec.ts";
import { ACTIONS, actionById, actionsOf, DOCK, MENU_ROUTES, PAD_PAGES } from "../apps/pocket-remote/actions.ts";
import * as wire from "../apps/pocket-remote/host/wire.ts";
import { buildState, luaWindow, luaWorkspace, parseEvent, type HyprClient, type HyprMonitor, type HyprWorkspace } from "../apps/pocket-remote/host/hypr.ts";
import { paletteFrom, parseBrightnessctl, parseColorsToml, parsePactlVolume, wtypeArgs } from "../apps/pocket-remote/host/omarchy.ts";
import { chipAt, chipRects, keyAt, keyboardKeys, keysymFor, keyToLine } from "../apps/pocket-remote/keyboard-layout.ts";
import {
  approach,
  CARD,
  CARD_TRACK_W,
  cardHit,
  cardRowAt,
  DOCK as DOCK_RECT,
  DOCK_SLOTS,
  DOCK_SLOT_W,
  DOCK_X0,
  dockSlotAt,
  dockSlotX,
  easeProgress,
  fitMonitor,
  FLY_BOTTOM,
  FLY_W,
  FLY_X,
  flyItemAt,
  flyItemY,
  SCREEN_H,
  SCREEN_W,
  STAGE,
  stageWindows,
  stagger,
  STRIP,
  stripTabs,
  swapDirection,
  tabAt,
  tileRect,
  trackDelta,
  trackFill,
  windowAt,
} from "../apps/pocket-remote/layout.ts";
import { clipTitle, parseLines, TITLE_MAX, WINDOWS_MAX, type HostState } from "../apps/pocket-remote/protocol.ts";
import { isThemeColors, themeTitle, TOKYO_NIGHT } from "../apps/pocket-remote/theme.ts";

describe("pocket-remote wire", () => {
  test("the daemon's copy of the PKNT constants matches spec.ts", () => {
    expect(wire.WIRE_MAGIC).toBe(WIRE_MAGIC);
    expect(wire.WIRE_BEACON_MAGIC).toBe(WIRE_BEACON_MAGIC);
    expect(wire.WIRE_VERSION).toBe(WIRE_VERSION);
    expect(wire.WIRE_HEADER_SIZE).toBe(WIRE_HEADER_SIZE);
    expect(wire.WIRE_MAX_PAYLOAD).toBe(WIRE_MAX_PAYLOAD);
    expect(wire.WIRE_BEACON_PORT).toBe(WIRE_BEACON_PORT);
    expect(wire.WIRE_PORT).toBe(WIRE_PORT);
    expect(wire.WIRE_MSG.ping).toBe(WIRE_MSG.ping);
    expect(wire.WIRE_MSG.pong).toBe(WIRE_MSG.pong);
    expect(wire.WIRE_MSG.ctrl).toBe(WIRE_MSG.ctrl);
    expect(wire.SVC_POLL_BUF).toBe(SVC_POLL_BUF);
  });

  test("frames round-trip through the parser, hello parses incrementally", () => {
    const parser = new wire.FrameParser();
    const a = wire.encodeCtrl('{"t":"hello"}');
    const b = wire.encodeFrame(wire.WIRE_MSG.ping, new Uint8Array([1, 2, 3, 4]));
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    expect(parser.push(joined.subarray(0, 5))).toEqual([]);
    const frames = parser.push(joined.subarray(5));
    expect(frames.map((f) => f.type)).toEqual([wire.WIRE_MSG.ctrl, wire.WIRE_MSG.ping]);
    expect(new TextDecoder().decode(frames[0]!.payload)).toBe('{"t":"hello"}');

    const app = new TextEncoder().encode("pocket-remote");
    const hello = new Uint8Array(7 + app.length);
    new DataView(hello.buffer).setUint32(0, WIRE_MAGIC, true);
    hello[4] = WIRE_VERSION;
    hello[6] = app.length;
    hello.set(app, 7);
    expect(wire.parseHello(hello.subarray(0, 10))).toBeNull();
    expect(wire.parseHello(hello)).toEqual({ app: "pocket-remote", consumed: hello.length });
    expect(() => wire.parseHello(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toThrow("bad hello magic");
    expect(wire.encodeHelloAck().length).toBe(8);
  });

  test("beacon layout: magic, version, port, app, name", () => {
    const beacon = wire.encodeBeacon("pocket-remote", "x1nano", 8622);
    const view = new DataView(beacon.buffer);
    expect(view.getUint32(0, true)).toBe(WIRE_BEACON_MAGIC);
    expect(beacon[4]).toBe(WIRE_VERSION);
    expect(view.getUint16(6, true)).toBe(8622);
    expect(beacon[8]).toBe("pocket-remote".length);
    expect(new TextDecoder().decode(beacon.subarray(9, 9 + 13))).toBe("pocket-remote");
    expect(beacon[9 + 13]).toBe(6);
  });
});

describe("pocket-remote protocol", () => {
  test("parseLines skips torn or foreign lines", () => {
    expect(parseLines('{"t":"toast","text":"a"}\n{bad\n\n{"x":1}\n{"t":"auth","auth":"ok"}')).toEqual([
      { t: "toast", text: "a" },
      { t: "auth", auth: "ok" },
    ]);
  });

  test("titles clip to TITLE_MAX code points with an ellipsis", () => {
    expect(clipTitle("evan@x1nano-omarchy:~")).toBe("evan@x1nano-omarchy:~");
    const long = "ChatGPT - Chromium - a very long window title indeed";
    expect(Array.from(clipTitle(long)).length).toBe(TITLE_MAX);
    expect(clipTitle(long).endsWith("…")).toBe(true);
    expect(clipTitle("  spaced   out  ")).toBe("spaced out");
  });

  test("a full snapshot of WINDOWS_MAX windows fits one poll batch", () => {
    const win = Array.from({ length: WINDOWS_MAX }, (_, i) => ({
      a: `0x55f90cb${(39300 + i).toString(16)}`,
      c: "chromium",
      ti: clipTitle("ChatGPT - Chromium - a very long window title indeed"),
      ws: (i % 9) + 1,
      x: 712,
      y: 38,
      w: 1416,
      h: 850,
      f: 1 as const,
      fs: 1 as const,
      p: 1 as const,
    }));
    const state: HostState = {
      t: "state",
      mon: { w: 1440, h: 900 },
      ws: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, n: 3 })),
      active: 2,
      focus: win[0]!.a,
      win,
      layout: "scrolling",
      special: 1,
    };
    expect(JSON.stringify(state).length).toBeLessThan(SVC_POLL_BUF);
  });
});

describe("pocket-remote actions", () => {
  test("ids are unique, every dock and pad entry exists, holds are the destructive ones", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of DOCK) expect(actionById(id)).toBeDefined();
    for (const page of PAD_PAGES) for (const id of page.actions) expect(actionById(id)).toBeDefined();
    expect(ACTIONS.filter((a) => a.hold).map((a) => a.id).sort()).toEqual(["close", "closeAll", "suspend"]);
    expect(actionById("nope")).toBeUndefined();
    // The menu cascade: every route and leaf is a real action, no leaf takes
    // a hold (a slide-and-release cannot express one), six leaves at most.
    for (const route of MENU_ROUTES) {
      expect(actionById(route.id)?.group).toBe("launch");
      expect(route.leaves.length).toBeLessThanOrEqual(6);
      for (const leaf of route.leaves) {
        const def = actionById(leaf);
        expect(def).toBeDefined();
        expect(def!.hold).toBeUndefined();
      }
    }
  });

  test("actions run the command Omarchy binds, never a shell string", () => {
    for (const action of ACTIONS) {
      if ("exec" in action.run) {
        expect(action.run.exec.length).toBeGreaterThan(0);
        for (const word of action.run.exec) expect(word).not.toMatch(/[|;&$`]/);
      } else {
        // Hyprland 0.5x's socket evaluates `hl.dispatch(<lua>)`: every
        // dispatcher is a constructor call under hl.dsp, balanced.
        expect(action.run.dispatch).toMatch(/^hl\.dsp\.[a-z_.]+\(.*\)$/);
        expect((action.run.dispatch.match(/\(/g) ?? []).length).toBe((action.run.dispatch.match(/\)/g) ?? []).length);
      }
    }
    expect(actionById("terminal")!.run).toEqual({ exec: ["omarchy-launch-terminal"] });
    expect(actionById("close")!.run).toEqual({ dispatch: "hl.dsp.window.close()" });
    expect(actionById("wsNext")!.run).toEqual({ dispatch: 'hl.dsp.focus({ workspace = "e+1" })' });
    expect(actionById("layout")!.run).toEqual({ exec: ["omarchy-hyprland-workspace-layout-toggle"] });
    expect(actionById("play")!.run).toEqual({ exec: ["omarchy-shell", "media", "playPause"] });
    expect(actionsOf("media").length).toBe(4);
  });
});

describe("pocket-remote layout", () => {
  const mon = { w: 1440, h: 900 };

  test("a 16:10 monitor fits the stage centred, preserving aspect", () => {
    const fit = fitMonitor(mon);
    expect(fit.rect.w).toBeLessThanOrEqual(STAGE.w);
    expect(fit.rect.h).toBeLessThanOrEqual(STAGE.h);
    expect(Math.abs(fit.rect.w / fit.rect.h - 1.6)).toBeLessThan(0.02);
    expect(fit.rect.x + fit.rect.w / 2).toBeCloseTo(STAGE.x + STAGE.w / 2, -1);
    expect(fit.rect.y + fit.rect.h / 2).toBeCloseTo(STAGE.y + STAGE.h / 2, -1);
  });

  test("tiles map window geometry to stage pixels and stay hit-testable", () => {
    const fit = fitMonitor(mon);
    const foot = { a: "0xa", c: "foot", ti: "", ws: 1, x: 12, y: 38, w: 701, h: 850 };
    const chrome = { a: "0xb", c: "chromium", ti: "", ws: 1, x: 725, y: 38, w: 703, h: 850 };
    const ra = tileRect(foot, fit);
    const rb = tileRect(chrome, fit);
    expect(ra.x).toBeLessThan(rb.x);
    expect(ra.x + ra.w).toBeLessThanOrEqual(rb.x);
    const tiles = [
      { a: "0xa", rect: ra },
      { a: "0xb", rect: rb },
    ];
    expect(windowAt(ra.x + 2, ra.y + 2, tiles)).toBe("0xa");
    expect(windowAt(rb.x + rb.w - 2, rb.y + 2, tiles)).toBe("0xb");
    expect(windowAt(STAGE.x + 1, STAGE.y + 1, tiles)).toBeNull();
    expect(swapDirection(ra, rb)).toBe("r");
    expect(swapDirection(rb, ra)).toBe("l");
    expect(swapDirection({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 20, w: 10, h: 10 })).toBe("d");
  });

  test("floating windows paint after tiled ones on the active workspace only", () => {
    const state: HostState = {
      t: "state",
      mon,
      ws: [{ id: 1, n: 2 }, { id: 2, n: 1 }],
      active: 1,
      focus: null,
      layout: "dwindle",
      win: [
        { a: "0x1", c: "a", ti: "", ws: 1, x: 0, y: 0, w: 10, h: 10, f: 1 },
        { a: "0x2", c: "b", ti: "", ws: 1, x: 0, y: 0, w: 10, h: 10 },
        { a: "0x3", c: "c", ti: "", ws: 2, x: 0, y: 0, w: 10, h: 10 },
      ],
    };
    expect(stageWindows(state).map((w) => w.a)).toEqual(["0x2", "0x1"]);
  });

  test("the strip lists every workspace, the active one, and one empty tab after", () => {
    expect(stripTabs([{ id: 1, n: 2 }], 1).map((t) => t.id)).toEqual([1, 2]);
    expect(stripTabs([{ id: 1, n: 2 }, { id: 2, n: 0 }], 2).map((t) => t.id)).toEqual([1, 2]);
    expect(stripTabs([{ id: 1, n: 2 }, { id: 3, n: 1 }], 1).map((t) => t.id)).toEqual([1, 3, 4]);
    expect(stripTabs([{ id: 1, n: 1 }], 5).map((t) => t.id)).toEqual([1, 5]);
    const ten = stripTabs(Array.from({ length: 10 }, (_, i) => ({ id: i + 1, n: 1 })), 10);
    expect(ten.length).toBe(10);
    const tabs = stripTabs([{ id: 1, n: 2 }, { id: 2, n: 1 }], 1);
    expect(tabAt(tabs[1]!.x + 3, tabs)?.id).toBe(2);
    expect(tabAt(tabs[0]!.x - 1, tabs)).toBeNull();
  });

  test("the three bands cover the screen exactly and the dock fits eleven slots", () => {
    expect(STRIP.y).toBe(0);
    expect(STAGE.y).toBe(STRIP.h);
    expect(DOCK_RECT.y).toBe(STAGE.y + STAGE.h);
    expect(DOCK_RECT.y + DOCK_RECT.h).toBe(SCREEN_H);
    expect(DOCK_SLOTS).toBe(11);
    expect(dockSlotX(DOCK_SLOTS - 1) + DOCK_SLOT_W).toBeLessThanOrEqual(SCREEN_W);
    expect(dockSlotAt(DOCK_X0 - 1)).toBeNull();
    expect(dockSlotAt(DOCK_X0)).toBe(0);
    expect(dockSlotAt(dockSlotX(DOCK_SLOTS - 1) + DOCK_SLOT_W - 1)).toBe(DOCK_SLOTS - 1);
    expect(dockSlotAt(dockSlotX(DOCK_SLOTS))).toBeNull();
  });

  test("levels card: rows, tracks and toggles hit-test; drags are relative", () => {
    expect(cardHit(CARD.x - 1, CARD.y + 20)).toBeNull();
    expect(cardHit(CARD.x + 20, CARD.y + 30)).toEqual({ kind: "icon", row: 0 });
    expect(cardHit(CARD.x + 150, CARD.y + 30)).toEqual({ kind: "track", row: 0 });
    expect(cardHit(CARD.x + 150, CARD.y + 90)).toEqual({ kind: "track", row: 1 });
    expect(cardHit(CARD.x + 20, CARD.y + 90)).toEqual({ kind: "icon", row: 1 });
    expect(cardHit(CARD.x + 150, CARD.y + 125)).toEqual({ kind: "card" });
    expect(cardRowAt(CARD.y + 20)).toBe(0);
    expect(cardRowAt(CARD.y + 100)).toBe(1);
    expect(trackDelta(CARD_TRACK_W)).toBeCloseTo(1);
    expect(trackDelta(-CARD_TRACK_W / 4)).toBeCloseTo(-0.25);
    expect(trackFill(0.4)).toBe(Math.round(0.4 * CARD_TRACK_W));
    expect(trackFill(2)).toBe(CARD_TRACK_W);
  });

  test("menu cascade: six routes stack up from the dock and stay under the strip", () => {
    const top = flyItemY(MENU_ROUTES.length - 1);
    expect(top).toBeGreaterThanOrEqual(STRIP.h);
    expect(flyItemY(0) + 34).toBeLessThanOrEqual(FLY_BOTTOM);
    expect(flyItemAt(FLY_X + 10, flyItemY(0) + 10, FLY_X, FLY_W, MENU_ROUTES.length)).toBe(0);
    expect(flyItemAt(FLY_X + 10, flyItemY(3) + 10, FLY_X, FLY_W, MENU_ROUTES.length)).toBe(3);
    expect(flyItemAt(FLY_X + FLY_W + 40, flyItemY(0) + 10, FLY_X, FLY_W, MENU_ROUTES.length)).toBeNull();
    expect(flyItemAt(FLY_X + 10, 5, FLY_X, FLY_W, MENU_ROUTES.length)).toBeNull();
  });

  test("entrance progress eases to one and staggers by index", () => {
    let t = 0;
    let frames = 0;
    while (t < 1 && frames < 60) {
      t = easeProgress(t);
      frames += 1;
    }
    expect(t).toBe(1);
    expect(frames).toBeLessThan(30);
    expect(stagger(0, 0, 6)).toBe(0);
    expect(stagger(1, 5, 6)).toBe(1);
    expect(stagger(0.5, 0, 6)).toBe(1);
    expect(stagger(0.5, 5, 6)).toBe(0);
  });

  test("approach eases and snaps within half a pixel", () => {
    let v = 0;
    for (let i = 0; i < 40; i += 1) v = approach(v, 100);
    expect(v).toBe(100);
    expect(approach(99.5, 100)).toBe(100);
    expect(approach(0, 1)).toBeCloseTo(0.35);
  });
});

describe("pocket-remote hypr mirror", () => {
  const monitors: HyprMonitor[] = [
    {
      id: 0,
      name: "eDP-1",
      width: 2160,
      height: 1350,
      scale: 1.5,
      x: 0,
      y: 0,
      focused: true,
      activeWorkspace: { id: 1, name: "1" },
      specialWorkspace: { id: 0, name: "" },
    },
  ];
  const workspaces: HyprWorkspace[] = [
    { id: 1, name: "1", monitor: "eDP-1", windows: 2, tiledLayout: "dwindle" },
    { id: 2, name: "2", monitor: "eDP-1", windows: 0, tiledLayout: "scrolling" },
    { id: -98, name: "special:scratchpad", monitor: "eDP-1", windows: 1 },
  ];
  const client = (over: Partial<HyprClient>): HyprClient => ({
    address: "0x55f90cb39300",
    mapped: true,
    hidden: false,
    at: [12, 38],
    size: [701, 850],
    workspace: { id: 1, name: "1" },
    floating: false,
    monitor: 0,
    class: "foot",
    title: "evan@x1nano-omarchy:~",
    initialClass: "foot",
    pinned: false,
    fullscreen: 0,
    focusHistoryID: 0,
    ...over,
  });

  test("reduces monitors, workspaces and clients to one snapshot", () => {
    const clients = [
      client({}),
      client({ address: "0x55f90e41dd40", class: "chromium", title: "ChatGPT - Chromium", at: [725, 38], size: [1423, 850], focusHistoryID: 1 }),
      client({ address: "0xdead", mapped: false }),
      client({ address: "0xbeef", workspace: { id: -98, name: "special:scratchpad" } }),
    ];
    const state = buildState(monitors, workspaces, clients, { address: "0x55f90cb39300" });
    expect(state.mon).toEqual({ w: 1440, h: 900 });
    expect(state.active).toBe(1);
    expect(state.layout).toBe("dwindle");
    expect(state.ws).toEqual([{ id: 1, n: 2 }, { id: 2, n: 0 }]);
    expect(state.focus).toBe("0x55f90cb39300");
    expect(state.win.map((w) => w.a)).toEqual(["0x55f90cb39300", "0x55f90e41dd40"]);
    expect(state.win[1]).toEqual({
      a: "0x55f90e41dd40",
      c: "chromium",
      ti: "ChatGPT - Chromium",
      ws: 1,
      x: 725,
      y: 38,
      w: 1423,
      h: 850,
    });
    expect(state.special).toBeUndefined();
  });

  test("marks floating, fullscreen and pinned windows and the special workspace", () => {
    const shown = [{ ...monitors[0]!, activeWorkspace: { id: 2, name: "2" }, specialWorkspace: { id: -98, name: "special:scratchpad" } }];
    const state = buildState(shown, workspaces, [client({ floating: true, fullscreen: 2, pinned: true })], null);
    expect(state.layout).toBe("scrolling");
    expect(state.special).toBe(1);
    expect(state.focus).toBeNull();
    expect(state.win[0]).toMatchObject({ f: 1, fs: 2, p: 1 });
  });

  test("keeps the most recently focused WINDOWS_MAX windows", () => {
    const many = Array.from({ length: 40 }, (_, i) => client({ address: `0x${i}`, focusHistoryID: 39 - i }));
    const state = buildState(monitors, workspaces, many, null);
    expect(state.win.length).toBe(WINDOWS_MAX);
    expect(state.win[0]!.a).toBe("0x39");
  });

  test("window and workspace targets reach Lua only when well-formed", () => {
    expect(luaWindow("0x55f90cb39300")).toBe('"address:0x55f90cb39300"');
    expect(luaWindow('0x1" }) os.exit() --')).toBeNull();
    expect(luaWindow("foot")).toBeNull();
    expect(luaWorkspace(3)).toBe('"3"');
    expect(luaWorkspace(0)).toBeNull();
    expect(luaWorkspace(11)).toBeNull();
    expect(luaWorkspace(1.5)).toBeNull();
    expect(luaWorkspace(1, true)).toBe('"e+1"');
    expect(luaWorkspace(-1, true)).toBe('"e-1"');
    expect(luaWorkspace(0, true)).toBeNull();
  });

  test("parses socket2 event lines", () => {
    expect(parseEvent("workspacev2>>2,2")).toEqual({ name: "workspacev2", data: "2,2" });
    expect(parseEvent("activewindow>>foot,evan@x1nano-omarchy:~")).toEqual({ name: "activewindow", data: "foot,evan@x1nano-omarchy:~" });
    expect(parseEvent("garbage")).toBeNull();
  });
});

describe("pocket-remote omarchy readers", () => {
  test("pactl and brightnessctl output", () => {
    expect(parsePactlVolume("Volume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 /  40% / -23.88 dB")).toBeCloseTo(0.4);
    expect(parsePactlVolume("")).toBeNull();
    expect(parseBrightnessctl("intel_backlight,backlight,6310,33%,19393\n")).toBeCloseTo(0.33);
    expect(parseBrightnessctl("nonsense")).toBeNull();
  });

  test("colors.toml becomes the remote's palette, with fallbacks", () => {
    const toml = `accent = "#7aa2f7"\nbackground = "#1a1b26"\nforeground = "#a9b1d6"\n# comment\ncolor8 = "#414868"\ndark_foreground = "#565f89"\nred = "#F7768E"\n`;
    const colors = parseColorsToml(toml);
    expect(colors.accent).toBe("#7aa2f7");
    expect(colors.red).toBe("#f7768e");
    const palette = paletteFrom(colors);
    expect(palette.accent).toBe("#7aa2f7");
    expect(palette.bg).toBe("#1a1b26");
    expect(palette.muted).toBe("#414868");
    expect(palette.green).toBe(TOKYO_NIGHT.green); // absent -> fallback
    expect(isThemeColors(palette)).toBe(true);
    expect(isThemeColors({ ...palette, accent: "blue" })).toBe(false);
    expect(themeTitle("tokyo-night")).toBe("Tokyo Night");
    expect(themeTitle("osaka-jade")).toBe("Osaka Jade");
  });
});

describe("pocket-remote keyboard", () => {
  test("every layer fits the 480x320 screen and no two keys overlap", () => {
    for (const layer of ["lower", "upper", "sym"] as const) {
      const keys = keyboardKeys(layer);
      expect(keys.length).toBeGreaterThan(40);
      for (const key of keys) {
        expect(key.x).toBeGreaterThanOrEqual(0);
        expect(key.y).toBeGreaterThanOrEqual(28);
        expect(key.x + key.w).toBeLessThanOrEqual(SCREEN_W);
        expect(key.y + key.h).toBeLessThanOrEqual(SCREEN_H);
      }
      for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
          const a = keys[i]!;
          const b = keys[j]!;
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap).toBe(false);
        }
      }
    }
    const q = keyboardKeys("lower").find((k) => k.def.label === "q")!;
    expect(keyAt("lower", q.x + 5, q.y + 5)?.def.label).toBe("q");
    expect(keyAt("lower", 2, 2)).toBeNull();
  });

  test("keys become wire lines: text plain, keysyms under modifiers", () => {
    expect(keyToLine({ ch: "a" }, [])).toEqual({ t: "type", text: "a" });
    expect(keyToLine({ ch: "c" }, ["ctrl"])).toEqual({ t: "key", k: "c", mods: ["ctrl"] });
    expect(keyToLine({ ch: "." }, ["alt"])).toEqual({ t: "key", k: "period", mods: ["alt"] });
    expect(keyToLine({ ch: "€" }, ["ctrl"])).toBeNull();
    expect(keyToLine({ key: "Tab" }, [])).toEqual({ t: "key", k: "Tab" });
    expect(keyToLine({ key: "Tab" }, ["ctrl"])).toEqual({ t: "key", k: "Tab", mods: ["ctrl"] });
    expect(keyToLine({ layer: "sym" }, [])).toBeNull();
    expect(keysymFor("x")).toBe("x");
    expect(keysymFor("/")).toBe("slash");
    expect(keysymFor("é")).toBeNull();
  });

  test("held letters and digits offer variants as chips inside the screen", () => {
    const x = keyboardKeys("lower").find((k) => k.def.label === "x")!;
    expect(x.def.variants?.map((v) => v.label)).toEqual(["^X", "⌥X"]);
    const chips = chipRects(x, 2);
    expect(chips.length).toBe(2);
    for (const chip of chips) {
      expect(chip.x).toBeGreaterThanOrEqual(0);
      expect(chip.x + chip.w).toBeLessThanOrEqual(SCREEN_W);
      expect(chip.y).toBeGreaterThanOrEqual(0);
    }
    expect(chips[0]!.y).toBeLessThan(x.y); // above the key
    expect(chipAt(x, 2, chips[1]!.x + 10, chips[1]!.y + 10)).toBe(1);
    expect(chipAt(x, 2, x.x, x.y + 10)).toBeNull();
    const one = keyboardKeys("lower").find((k) => k.def.label === "1")!;
    expect(one.def.variants?.map((v) => v.k)).toEqual(["F1", "1"]);
    expect(chipRects(one, 2)[0]!.y).toBeGreaterThan(one.y); // top row: below
    const zero = keyboardKeys("lower").find((k) => k.def.label === "0")!;
    expect(zero.def.variants?.[0]?.k).toBe("F10");
  });
});

describe("pocket-remote wtype chords", () => {
  test("modifiers wrap the key and only allowed keysyms pass", () => {
    expect(wtypeArgs("c", ["ctrl"])).toEqual(["-M", "ctrl", "-k", "c", "-m", "ctrl"]);
    expect(wtypeArgs("Tab", ["ctrl", "shift"])).toEqual(["-M", "ctrl", "-M", "shift", "-k", "Tab", "-m", "shift", "-m", "ctrl"]);
    expect(wtypeArgs("F5")).toEqual(["-k", "F5"]);
    expect(wtypeArgs("period", ["alt"])).toEqual(["-M", "alt", "-k", "period", "-m", "alt"]);
    expect(wtypeArgs("rm -rf", [])).toBeNull();
    expect(wtypeArgs("c", ["hyper"])).toBeNull();
    expect(wtypeArgs("", [])).toBeNull();
  });
});
