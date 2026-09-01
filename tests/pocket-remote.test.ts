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
import { ACTIONS, actionById, actionsOf, DOCK, PAD_PAGES } from "../apps/pocket-remote/actions.ts";
import * as wire from "../apps/pocket-remote/host/wire.ts";
import { buildState, parseEvent, type HyprClient, type HyprMonitor, type HyprWorkspace } from "../apps/pocket-remote/host/hypr.ts";
import { paletteFrom, parseBrightnessctl, parseColorsToml, parsePactlVolume } from "../apps/pocket-remote/host/omarchy.ts";
import {
  approach,
  DOCK_SLOTS,
  DOCK_X0,
  dockSlotAt,
  fitMonitor,
  railDelta,
  railFill,
  RAIL_TRACK_H,
  STAGE,
  stageWindows,
  stripTabs,
  swapDirection,
  tabAt,
  tileRect,
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
  });

  test("actions run the command Omarchy binds, never a shell string", () => {
    for (const action of ACTIONS) {
      if ("exec" in action.run) {
        expect(action.run.exec.length).toBeGreaterThan(0);
        for (const word of action.run.exec) expect(word).not.toMatch(/[|;&$`]/);
      } else {
        expect(action.run.dispatch).toMatch(/^[a-z]+( .+)?$/);
      }
    }
    expect(actionById("terminal")!.run).toEqual({ exec: ["omarchy-launch-terminal"] });
    expect(actionById("close")!.run).toEqual({ dispatch: "killactive" });
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

  test("rails: a full-track drag spans the whole range, up raises", () => {
    expect(railDelta(-RAIL_TRACK_H)).toBeCloseTo(1);
    expect(railDelta(RAIL_TRACK_H / 2)).toBeCloseTo(-0.5);
    expect(railFill(0.4)).toBe(Math.round(0.4 * RAIL_TRACK_H));
    expect(railFill(2)).toBe(RAIL_TRACK_H);
  });

  test("dock slots tile the centre column", () => {
    expect(dockSlotAt(DOCK_X0 - 1)).toBeNull();
    expect(dockSlotAt(DOCK_X0)).toBe(0);
    expect(dockSlotAt(DOCK_X0 + 44 * (DOCK_SLOTS - 1) + 43)).toBe(DOCK_SLOTS - 1);
    expect(dockSlotAt(DOCK_X0 + 44 * DOCK_SLOTS)).toBeNull();
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
