// Pocket Remote: the wire constants pinned to spec.ts, framing, protocol
// clipping, the action table's invariants, the layout arithmetic (stage,
// ball, popup, control centre, menu sheet, deck), the Hyprland -> snapshot
// reduction, the Omarchy readers (levels, theme, network, MPRIS), the menu
// source parser and the baked menu table, and the deck's keyboard.

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
import { ACTIONS, actionById, actionsOf, LAUNCHERS } from "../apps/pocket-remote/actions.ts";
import { GLYPH } from "../apps/pocket-remote/glyphs.ts";
import * as wire from "../apps/pocket-remote/host/wire.ts";
import { buildState, luaWindow, luaWorkspace, parseEvent, type HyprClient, type HyprMonitor, type HyprWorkspace } from "../apps/pocket-remote/host/hypr.ts";
import { childrenOf, normalizeMenu, parentOf, parseMenuJsonc, stripJsonc } from "../apps/pocket-remote/host/menu-source.ts";
import {
  applicationDirectories,
  evaluateMenuConditions,
  launchableName,
  launchApp,
  paletteFrom,
  parseDesktopEntry,
  parseBrightnessctl,
  parseColorsToml,
  parseMprisNames,
  parseMprisPlayer,
  parseNetworkStatus,
  parsePactlVolume,
  parseRadio,
  runMenuEntry,
  wtypeArgs,
} from "../apps/pocket-remote/host/omarchy.ts";
import {
  bubbleRect,
  chipAt,
  chipRects,
  KEYBOARD,
  keyAt,
  keyboardKeys,
  keysymFor,
  keyToLine,
  TRACKPAD,
} from "../apps/pocket-remote/keyboard-layout.ts";
import {
  approach,
  BADGE,
  BALL,
  BALL_HOME,
  BALL_MARGIN,
  BALL_Y_MAX,
  BALL_Y_MIN,
  ballHit,
  ballSnap,
  CC,
  CC_BUTTON,
  CC_ROW_Y,
  CC_TRACK_W,
  CC_TRACK_X,
  ccHit,
  ccRowAt,
  easeProgress,
  fitMonitor,
  launchChipAt,
  launchChipRect,
  MODE,
  placePopup,
  pointerGain,
  POPUP_ROW_H,
  popupRowAt,
  SCREEN_H,
  SCREEN_W,
  SHEET,
  SHEET_LIST,
  SHEET_ROW_H,
  sheetContentH,
  sheetMaxScroll,
  sheetRowAt,
  sheetRowRect,
  STAGE,
  stageToMonitor,
  stageWindows,
  stagger,
  STRIP,
  stripTabs,
  swapDirection,
  TAB_MAX,
  TAB_W,
  TAB_X0,
  tabAt,
  TILE_POPUP_ROWS,
  tileRect,
  trackDelta,
  trackFill,
  windowAt,
} from "../apps/pocket-remote/layout.ts";
import { MENU, MENU_OMARCHY_VERSION } from "../apps/pocket-remote/menu.ts";
import { MENU_DOT_EMOJI, MENU_ROOT, menuChildren, menuItem, menuParent, menuTitle, menuVisible } from "../apps/pocket-remote/menu-tree.ts";
import { clipTitle, parseLines, REMOTE_PROTO, TITLE_MAX, WINDOWS_MAX, type HostState } from "../apps/pocket-remote/protocol.ts";
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
    expect(WIRE_MSG).toMatchObject(wire.WIRE_MSG);
    expect(wire.SVC_POLL_BUF).toBe(SVC_POLL_BUF);
    expect(REMOTE_PROTO).toBe(2);
  });

  test("frames round-trip through the parser, hello parses incrementally", () => {
    const parser = new wire.FrameParser();
    const a = wire.encodeCtrl('{"t":"ping"}');
    const b = wire.encodeFrame(WIRE_MSG.pong, new Uint8Array([1, 2, 3, 4]));
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    const frames = [...parser.push(joined.subarray(0, 5)), ...parser.push(joined.subarray(5))];
    expect(frames.length).toBe(2);
    expect(frames[0]!.type).toBe(WIRE_MSG.ctrl);
    expect(new TextDecoder().decode(frames[0]!.payload)).toBe('{"t":"ping"}');
    expect(frames[1]!.type).toBe(WIRE_MSG.pong);
    expect([...frames[1]!.payload]).toEqual([1, 2, 3, 4]);

    const hello = new Uint8Array(7 + 13);
    new DataView(hello.buffer).setUint32(0, WIRE_MAGIC, true);
    hello[4] = WIRE_VERSION;
    hello[6] = 13;
    hello.set(new TextEncoder().encode("pocket-remote"), 7);
    expect(wire.parseHello(hello.subarray(0, 10))).toBeNull();
    expect(wire.parseHello(hello)).toEqual({ app: "pocket-remote", consumed: 20 });
    expect(() => wire.parseHello(new Uint8Array(8))).toThrow(/magic/);
    expect(wire.encodeHelloAck().length).toBe(8);
  });

  test("beacon layout: magic, version, port, app, name", () => {
    const beacon = wire.encodeBeacon("pocket-remote", "x1nano", 8622);
    const view = new DataView(beacon.buffer);
    expect(view.getUint32(0, true)).toBe(WIRE_BEACON_MAGIC);
    expect(beacon[4]).toBe(WIRE_VERSION);
    expect(view.getUint16(6, true)).toBe(8622);
    expect(beacon[8]).toBe(13);
    expect(new TextDecoder().decode(beacon.subarray(9, 22))).toBe("pocket-remote");
    expect(beacon[22]).toBe(6);
  });
});

describe("pocket-remote protocol", () => {
  test("parseLines skips torn or foreign lines", () => {
    const lines = parseLines<{ t: string }>('{"t":"a"}\n{"t":"b"\n\n{"x":1}\n{"t":"c"}');
    expect(lines.map((l) => l.t)).toEqual(["a", "c"]);
  });

  test("titles clip to TITLE_MAX code points with an ellipsis", () => {
    expect(clipTitle("short")).toBe("short");
    const long = "x".repeat(TITLE_MAX + 5);
    expect(Array.from(clipTitle(long)).length).toBe(TITLE_MAX);
    expect(clipTitle(long).endsWith("…")).toBe(true);
    expect(clipTitle("  a   b\n c ")).toBe("a b c");
  });

  test("a full snapshot of WINDOWS_MAX windows fits one poll batch", () => {
    const state: HostState = {
      t: "state",
      mon: { w: 3840, h: 2160, x: 0, y: 0 },
      ws: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, n: 3 })),
      active: 10,
      focus: "0x55f90cb39300",
      layout: "scrolling",
      special: 1,
      win: Array.from({ length: WINDOWS_MAX }, (_, i) => ({
        a: `0x55f90cb3${(0x9300 + i).toString(16)}`,
        c: "org.gnome.Nautilus.Something",
        ti: "x".repeat(TITLE_MAX),
        ws: (i % 10) + 1,
        x: 1234,
        y: 1234,
        w: 3840,
        h: 2160,
        f: 1 as const,
        fs: 2 as const,
        p: 1 as const,
      })),
    };
    expect(JSON.stringify(state).length).toBeLessThan(SVC_POLL_BUF);
  });
});

describe("pocket-remote actions", () => {
  test("ids are unique, every launcher exists, commands are argv or Lua", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of LAUNCHERS) expect(actionById(id)?.group).toBe("launch");
    expect(actionById("nope")).toBeUndefined();
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
    expect(actionById("wsNext")!.run).toEqual({ dispatch: 'hl.dsp.focus({ workspace = "e+1" })' });
    expect(actionById("layout")!.run).toEqual({ exec: ["omarchy-hyprland-workspace-layout-toggle"] });
    expect(actionById("play")!.run).toEqual({ exec: ["omarchy-shell", "media", "playPause"] });
    expect(actionsOf("media").length).toBe(3);
  });
});

describe("pocket-remote layout", () => {
  const mon = { w: 1440, h: 900 };

  test("the strip and the stage cover the screen; the strip's controls clear the tabs", () => {
    expect(STRIP.y).toBe(0);
    expect(STAGE.y).toBe(STRIP.h);
    expect(STAGE.y + STAGE.h).toBe(SCREEN_H);
    const tabsEnd = TAB_X0 + TAB_MAX * TAB_W;
    expect(BADGE.x).toBeGreaterThanOrEqual(tabsEnd);
    expect(BADGE.x + BADGE.w).toBeLessThanOrEqual(MODE.x);
    expect(MODE.x + MODE.w).toBeLessThanOrEqual(CC_BUTTON.x);
    expect(CC_BUTTON.x + CC_BUTTON.w).toBeLessThanOrEqual(SCREEN_W);
    for (const r of [BADGE, MODE, CC_BUTTON]) expect(r.y + r.h).toBeLessThanOrEqual(STRIP.h);
  });

  test("a 16:10 monitor fits the stage centred, preserving aspect", () => {
    const fit = fitMonitor(mon);
    expect(fit.rect.w).toBeLessThanOrEqual(STAGE.w);
    expect(fit.rect.h).toBeLessThanOrEqual(STAGE.h);
    expect(Math.abs(fit.rect.w / fit.rect.h - 1.6)).toBeLessThan(0.02);
    expect(fit.rect.x + fit.rect.w / 2).toBeCloseTo(STAGE.x + STAGE.w / 2, -1);
    expect(fit.rect.y + fit.rect.h / 2).toBeCloseTo(STAGE.y + STAGE.h / 2, -1);
  });

  test("tiles map window geometry to stage pixels, stay hit-testable and map back", () => {
    const fit = fitMonitor(mon);
    const left = tileRect({ a: "a", c: "foot", ti: "", ws: 1, x: 0, y: 0, w: 720, h: 900 }, fit);
    const right = tileRect({ a: "b", c: "web", ti: "", ws: 1, x: 720, y: 0, w: 720, h: 900 }, fit);
    expect(left.x).toBe(fit.rect.x);
    expect(left.x + left.w).toBe(right.x);
    expect(right.x + right.w).toBe(fit.rect.x + fit.rect.w);
    const tiles = [{ a: "a", rect: left }, { a: "b", rect: right }];
    expect(windowAt(left.x + 5, left.y + 5, tiles)).toBe("a");
    expect(windowAt(right.x + 5, right.y + 5, tiles)).toBe("b");
    expect(windowAt(0, 0, tiles)).toBeNull();
    expect(swapDirection(left, right)).toBe("r");
    expect(swapDirection(right, left)).toBe("l");
    const back = stageToMonitor(right.x, right.y, fit);
    expect(Math.abs(back.x - 720)).toBeLessThanOrEqual(2);
    expect(Math.abs(back.y)).toBeLessThanOrEqual(2);
    const tiny = tileRect({ a: "c", c: "x", ti: "", ws: 1, x: 0, y: 0, w: 1, h: 1 }, fit);
    expect(tiny.w).toBeGreaterThanOrEqual(8);
  });

  test("floating windows paint after tiled ones on the active workspace only", () => {
    const state: HostState = {
      t: "state",
      mon,
      ws: [{ id: 1, n: 3 }],
      active: 1,
      focus: null,
      layout: "dwindle",
      win: [
        { a: "f", c: "", ti: "", ws: 1, x: 0, y: 0, w: 1, h: 1, f: 1 },
        { a: "t", c: "", ti: "", ws: 1, x: 0, y: 0, w: 1, h: 1 },
        { a: "o", c: "", ti: "", ws: 2, x: 0, y: 0, w: 1, h: 1 },
      ],
    };
    expect(stageWindows(state).map((w) => w.a)).toEqual(["t", "f"]);
  });

  test("the strip lists every workspace, the active one, and one empty tab after", () => {
    const tabs = stripTabs([{ id: 1, n: 2 }, { id: 3, n: 1 }], 3);
    expect(tabs.map((t) => t.id)).toEqual([1, 3, 4]);
    expect(tabs[2]!.n).toBe(0);
    expect(stripTabs([{ id: 1, n: 0 }], 1).map((t) => t.id)).toEqual([1]);
    expect(stripTabs([], 5).map((t) => t.id)).toEqual([5]); // already empty: no trailing tab
    expect(stripTabs(Array.from({ length: 12 }, (_, i) => ({ id: i + 1, n: 1 })), 1).length).toBe(TAB_MAX);
    expect(tabAt(tabs[1]!.x + 3, tabs)!.id).toBe(3);
    expect(tabAt(0, tabs)).toBeNull();
  });

  test("launch chips sit centred on the empty stage and hit-test", () => {
    const rects = [0, 1, 2].map((i) => launchChipRect(i, 3));
    expect(rects[0]!.x).toBeGreaterThan(0);
    expect(rects[2]!.x + rects[2]!.w).toBeLessThan(SCREEN_W);
    expect(SCREEN_W - (rects[2]!.x + rects[2]!.w)).toBeCloseTo(rects[0]!.x, -1);
    expect(launchChipAt(rects[1]!.x + 10, rects[1]!.y + 10, 3)).toBe(1);
    expect(launchChipAt(rects[1]!.x + 10, rects[1]!.y - 10, 3)).toBeNull();
  });

  test("the ball snaps to the nearer edge, keeps its height, stays under the strip", () => {
    expect(BALL_HOME.x + BALL).toBeLessThanOrEqual(SCREEN_W);
    expect(ballSnap(100, 150)).toEqual({ x: BALL_MARGIN, y: 150 });
    expect(ballSnap(300, 150)).toEqual({ x: SCREEN_W - BALL - BALL_MARGIN, y: 150 });
    expect(ballSnap(300, 0).y).toBe(BALL_Y_MIN);
    expect(ballSnap(300, 900).y).toBe(BALL_Y_MAX);
    const ball = { x: 400, y: 200 };
    expect(ballHit(420, 220, ball)).toBe(true);
    expect(ballHit(398, 220, ball)).toBe(true); // 4 px of slack
    expect(ballHit(380, 220, ball)).toBe(false);
  });

  test("a popup opens below its anchor when there is room, above otherwise, stays on the stage, and its first row is a short slide away", () => {
    const below = placePopup(240, 60, TILE_POPUP_ROWS);
    expect(below.below).toBe(true);
    expect(below.y).toBeGreaterThan(60);
    expect(below.h).toBe(TILE_POPUP_ROWS * POPUP_ROW_H + 8);
    // A hold-and-slide has to reach row zero without letting go.
    expect(below.y + 4 + POPUP_ROW_H / 2 - 60).toBeLessThanOrEqual(32);
    const above = placePopup(240, 300, TILE_POPUP_ROWS);
    expect(above.below).toBe(false);
    expect(above.y + above.h).toBeLessThan(300);
    const edge = placePopup(5, 60, TILE_POPUP_ROWS);
    expect(edge.x).toBeGreaterThanOrEqual(STAGE.x + 6);
    const far = placePopup(478, 60, TILE_POPUP_ROWS);
    expect(far.x + far.w).toBeLessThanOrEqual(SCREEN_W - 6);
    expect(popupRowAt(below, below.x + 10, below.y + 4 + 10)).toBe(0);
    expect(popupRowAt(below, below.x + 10, below.y + 4 + POPUP_ROW_H * 2 + 10)).toBe(2);
    expect(popupRowAt(below, below.x - 1, below.y + 10)).toBeNull();
    expect(popupRowAt(below, below.x + 10, below.y + below.h + 4)).toBeNull();
  });

  test("the control centre hangs from its button and hit-tests its tiles, transport and sliders", () => {
    expect(CC.x + CC.w).toBeLessThanOrEqual(SCREEN_W);
    expect(CC.y).toBeGreaterThanOrEqual(STRIP.h);
    expect(CC.y + CC.h).toBeLessThanOrEqual(SCREEN_H);
    expect(CC_BUTTON.x + CC_BUTTON.w / 2).toBeGreaterThan(CC.x);
    expect(ccHit(CC.x - 1, CC.y + 20)).toBeNull();
    expect(ccHit(CC.x + 20, CC.y + 30)).toEqual({ kind: "wifi" });
    expect(ccHit(CC.x + 160, CC.y + 30)).toEqual({ kind: "shot" });
    expect(ccHit(CC.x + 220, CC.y + 30)).toEqual({ kind: "night" });
    expect(ccHit(CC.x + 60, CC.y + 90)).toEqual({ kind: "media" });
    expect(ccHit(CC.x + 160, CC.y + 90)).toEqual({ kind: "prev" });
    expect(ccHit(CC.x + 200, CC.y + 90)).toEqual({ kind: "play" });
    expect(ccHit(CC.x + 240, CC.y + 90)).toEqual({ kind: "next" });
    expect(ccHit(CC.x + 20, CC.y + CC_ROW_Y[0] + 10)).toEqual({ kind: "icon", row: 0 });
    expect(ccHit(CC.x + 120, CC.y + CC_ROW_Y[0] + 10)).toEqual({ kind: "track", row: 0 });
    expect(ccHit(CC.x + 120, CC.y + CC_ROW_Y[1] + 10)).toEqual({ kind: "track", row: 1 });
    expect(ccHit(CC.x + 20, CC.y + CC_ROW_Y[1] + 10)).toEqual({ kind: "icon", row: 1 });
    expect(ccRowAt(CC.y + 30)).toBeNull();
    expect(ccRowAt(CC.y + CC_ROW_Y[0] + 5)).toBe(0);
    expect(ccRowAt(CC.y + CC_ROW_Y[1] + 5)).toBe(1);
    expect(trackDelta(CC_TRACK_W)).toBeCloseTo(1);
    expect(trackDelta(-CC_TRACK_W / 4)).toBeCloseTo(-0.25);
    expect(trackFill(0.4)).toBe(Math.round(0.4 * CC_TRACK_W));
    expect(trackFill(2)).toBe(CC_TRACK_W);
    expect(CC_TRACK_X + CC_TRACK_W).toBeLessThan(CC.w);
  });

  test("the menu sheet is one column, is centred, scrolls what does not fit, and hit-tests through the scroll", () => {
    expect(SHEET.x + SHEET.w).toBeLessThanOrEqual(SCREEN_W);
    expect(SHEET.y + SHEET.h).toBeLessThanOrEqual(SCREEN_H);
    expect(SHEET.x).toBe(SCREEN_W - (SHEET.x + SHEET.w)); // centred
    expect(SHEET_LIST.y + SHEET_LIST.h).toBeLessThanOrEqual(SHEET.y + SHEET.h);
    expect(sheetRowRect(0)).toEqual({ x: 0, y: 0, w: SHEET_LIST.w, h: SHEET_ROW_H });
    expect(sheetRowRect(1)).toMatchObject({ x: 0, y: SHEET_ROW_H });
    // Ten root rows in one column already scroll.
    expect(sheetContentH(10)).toBeGreaterThan(SHEET_LIST.h);
    expect(sheetMaxScroll(10)).toBe(sheetContentH(10) - SHEET_LIST.h);
    expect(sheetMaxScroll(2)).toBe(0);
    expect(sheetRowAt(SHEET_LIST.x + 10, SHEET_LIST.y + 10, 10, 0)).toBe(0);
    expect(sheetRowAt(SHEET_LIST.x + 10, SHEET_LIST.y + 3 * SHEET_ROW_H + 10, 10, 0)).toBe(3);
    expect(sheetRowAt(SHEET_LIST.x + 10, SHEET_LIST.y + 10, 10, 3 * SHEET_ROW_H)).toBe(3);
    expect(sheetRowAt(SHEET_LIST.x + 10, SHEET_LIST.y + 10, 0, 0)).toBeNull();
    expect(sheetRowAt(SHEET.x + 2, SHEET_LIST.y + 10, 10, 0)).toBeNull();
  });

  test("pointer gain grows with speed inside its bounds", () => {
    expect(pointerGain(0)).toBe(1.2);
    expect(pointerGain(5)).toBeGreaterThan(pointerGain(1));
    expect(pointerGain(100)).toBe(4);
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
    expect(state.mon).toEqual({ w: 1440, h: 900, x: 0, y: 0 });
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

  test("a second monitor's origin comes off its windows and rides along for placements", () => {
    const right = [{ ...monitors[0]!, x: 2160, y: 100 }];
    const state = buildState(right, workspaces, [client({ at: [2160 + 12, 100 + 38] })], null);
    expect(state.mon.x).toBe(2160);
    expect(state.mon.y).toBe(100);
    expect(state.win[0]).toMatchObject({ x: 12, y: 38 });
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

  test("network status and the radio", () => {
    expect(parseNetworkStatus("wifi\tPetite Auberge\t54\t5560.0\n")).toEqual({ type: "wifi", ssid: "Petite Auberge", sig: 54 });
    expect(parseNetworkStatus("ethernet\tenp0s31f6\t\t\n")).toEqual({ type: "ethernet", ssid: "enp0s31f6", sig: 0 });
    expect(parseNetworkStatus("disconnected\t\t\t\n")).toEqual({ type: "disconnected", ssid: "", sig: 0 });
    expect(parseNetworkStatus("")).toEqual({ type: "disconnected", ssid: "", sig: 0 });
    expect(parseRadio("enabled\n")).toBe(true);
    expect(parseRadio("disabled\n")).toBe(false);
  });

  test("MPRIS players and their properties out of busctl's JSON", () => {
    const list = JSON.stringify([
      { name: "org.freedesktop.Notifications", pid: 1 },
      { name: "org.mpris.MediaPlayer2.spotify", pid: 2 },
      { name: ":1.42", pid: 3 },
    ]);
    expect(parseMprisNames(list)).toEqual(["org.mpris.MediaPlayer2.spotify"]);
    expect(parseMprisNames("nonsense")).toEqual([]);
    const props = JSON.stringify({
      type: "a{sv}",
      data: [
        {
          PlaybackStatus: { type: "s", data: "Playing" },
          Metadata: {
            type: "a{sv}",
            data: {
              "xesam:title": { type: "s", data: "Blue in Green" },
              "xesam:artist": { type: "as", data: ["Miles Davis", "Bill Evans"] },
            },
          },
        },
      ],
    });
    expect(parseMprisPlayer(props)).toEqual({ st: "playing", title: "Blue in Green", artist: "Miles Davis, Bill Evans" });
    expect(parseMprisPlayer('{"type":"a{sv}","data":[{"PlaybackStatus":{"type":"s","data":"Stopped"}}]}')).toEqual({ st: "none", title: "", artist: "" });
    expect(parseMprisPlayer("")).toBeNull();
  });
});

describe("pocket-remote applications", () => {
  test("desktop entries are read the way a launcher reads them", () => {
    const entry = parseDesktopEntry(
      `[Desktop Entry]\n# a comment\nType=Application\nName=Files\nName[de]=Dateien\nExec=nautilus --new-window\nIcon=org.gnome.Nautilus\n\n[Desktop Action new-window]\nName=New Window\n`,
    );
    expect(entry.Name).toBe("Files");
    expect(entry.Exec).toBe("nautilus --new-window");
    expect(entry["Name[de]"]).toBeUndefined();
    expect(launchableName(entry)).toBe("Files");
    expect(launchableName(parseDesktopEntry("[Desktop Entry]\nType=Application\nName=X\nNoDisplay=true\n"))).toBeNull();
    expect(launchableName(parseDesktopEntry("[Desktop Entry]\nType=Link\nName=X\n"))).toBeNull();
    expect(launchableName(parseDesktopEntry("[Desktop Entry]\nType=Application\n"))).toBeNull();
  });

  test("the user's own directory comes first and flatpak's is included", () => {
    const dirs = applicationDirectories({ HOME: "/home/evan", XDG_DATA_DIRS: "/usr/share:/usr/local/share" });
    expect(dirs[0]!.endsWith("/.local/share/applications")).toBe(true);
    expect(dirs).toContain("/usr/share/applications");
    expect(dirs.some((dir) => dir.startsWith("/var/lib/flatpak"))).toBe(true);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  test("only a well-formed desktop id may be launched", () => {
    const said: string[] = [];
    expect(launchApp("../../etc/passwd", (m) => said.push(m))).toBe(false);
    expect(launchApp("foo; rm -rf /", (m) => said.push(m))).toBe(false);
    expect(said).toEqual([]);
  });
});

describe("pocket-remote menu source", () => {
  const jsonc = `{
  // Root Menu
  "learn": {"icon":"󰧑","label":"Learn"},
  "learn.omarchy": {"icon":"","label":"Omarchy","action":"omarchy-launch-webapp 'https://omarchy.org/manual/'"},
  "apps": {"icon":"󰀻","label":"Apps","provider":"apps"}, /* trailing comma next */
  "system": {"icon":"","label":"System","aliases":["power-menu"]},
  "system.suspend": {"icon":"󰒲","label":"Suspend","when":"! omarchy-toggle-enabled suspend-off","action":"systemctl suspend"},
  "system.dns": {"icon":"","label":"DNS","checked":"[[ \\"$(omarchy-dns)\\" == \\"DHCP\\" ]]","action":"omarchy-dns DHCP",},
}`;

  test("strips comments and trailing commas but leaves the URLs inside strings alone", () => {
    const parsed = parseMenuJsonc(jsonc);
    expect(Object.keys(parsed)).toEqual(["learn", "learn.omarchy", "apps", "system", "system.suspend", "system.dns"]);
    expect(parsed["learn.omarchy"]!.action).toBe("omarchy-launch-webapp 'https://omarchy.org/manual/'");
    expect(parsed["system.dns"]!.checked).toBe('[[ "$(omarchy-dns)" == "DHCP" ]]');
    // A comment can hide a trailing comma: both go.
    expect(JSON.parse(stripJsonc('{"a": "x // y", // c\n}'))).toEqual({ a: "x // y" });
    expect(JSON.parse(stripJsonc('["a", /* b */ "c",\n]'))).toEqual(["a", "c"]);
  });

  test("normalises rows the way the shell infers them, and later layers override", () => {
    const entries = normalizeMenu([parseMenuJsonc(jsonc), { "system.suspend": { label: "Sleep" }, personal: { icon: "", label: "Personal" } }]);
    expect(entries.map((e) => e.kind)).toEqual(["menu", "action", "provider", "menu", "action", "action", "menu"]);
    expect(entries.find((e) => e.id === "system.suspend")).toMatchObject({ parent: "system", label: "Sleep", action: "systemctl suspend", when: "! omarchy-toggle-enabled suspend-off" });
    expect(parentOf("trigger.capture.screenrecord.stop")).toBe("trigger.capture.screenrecord");
    expect(parentOf("about")).toBe("root");
    expect(childrenOf(entries, "system").map((e) => e.id)).toEqual(["system.suspend", "system.dns"]);
    expect(childrenOf(entries, "root").map((e) => e.id)).toEqual(["learn", "apps", "system", "personal"]);
  });

  test("runs an action under bash, summons anything else, refuses unknown ids", () => {
    const entries = normalizeMenu([parseMenuJsonc(jsonc)]);
    const ran: string[] = [];
    // runMenuEntry spawns detached; here the id validation and lookup are what matter.
    expect(runMenuEntry(entries, "nope", (m) => ran.push(m))).toBe(false);
    expect(runMenuEntry(entries, 'x"; rm -rf /', (m) => ran.push(m))).toBe(false);
    expect(ran).toEqual([]);
  });

  test("conditions are evaluated in one bash run and reported by id", async () => {
    const entries = normalizeMenu([
      {
        hidden: { label: "Hidden", when: "false", action: "true" },
        shown: { label: "Shown", when: "true", action: "true" },
        ticked: { label: "Ticked", checked: "[[ 1 == 1 ]]", action: "true" },
        plain: { label: "Plain", checked: "[[ 1 == 2 ]]", action: "true" },
        'bad id"': { label: "Bad", when: "false", action: "true" },
      },
    ]);
    const result = await evaluateMenuConditions(entries);
    expect(result.hide).toEqual(["hidden"]);
    expect(result.check).toEqual(["ticked"]);
  }, 20_000);
});

describe("pocket-remote baked menu", () => {
  test("the table is Omarchy's tree: unique ids, every parent present, the root in the shell's order", () => {
    expect(MENU_OMARCHY_VERSION).toMatch(/^\d/);
    const ids = new Set(MENU.map((item) => item.id));
    expect(ids.size).toBe(MENU.length);
    for (const item of MENU) if (item.parent !== MENU_ROOT) expect(ids.has(item.parent)).toBe(true);
    expect(menuChildren(MENU_ROOT).map((item) => item.label)).toEqual([
      "Apps", "Learn", "Trigger", "Style", "Setup", "Install", "Remove", "Update", "About", "System",
    ]);
    expect(menuItem("apps")?.kind).toBe("provider");
    expect(menuItem("about")?.kind).toBe("action");
    expect(menuTitle(MENU_ROOT)).toBe("Go");
    expect(menuTitle("setup.default.agent")).toBe("Default Agent");
    expect(menuParent("trigger.capture.screenshot")).toBe("trigger.capture");
  });

  test("hidden rows disappear and take an emptied submenu with them", () => {
    const hardware = menuChildren("trigger.hardware").map((item) => item.id);
    expect(hardware).toContain("trigger.hardware.touchpad");
    const hidden = new Set(menuChildren("trigger.hardware").map((item) => item.id));
    expect(menuChildren("trigger.hardware", hidden)).toEqual([]);
    expect(menuVisible(menuItem("trigger.hardware")!, hidden)).toBe(false);
    expect(menuChildren("trigger", hidden).map((item) => item.id)).not.toContain("trigger.hardware");
    expect(menuChildren("trigger", new Set()).map((item) => item.id)).toContain("trigger.hardware");
  });

  test("every icon is a glyph the atlas can carry, or one of the four channel dots", () => {
    for (const item of MENU) {
      if (!item.icon) continue;
      const cp = item.icon.codePointAt(0)!;
      const pua = (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd);
      expect(pua || item.icon in MENU_DOT_EMOJI).toBe(true);
    }
    for (const glyph of Object.values(GLYPH)) expect(glyph.codePointAt(0)!).toBeGreaterThanOrEqual(0xf0000);
  });
});

describe("pocket-remote deck", () => {
  test("every layer fits over the trackpad and no two keys overlap", () => {
    for (const layer of ["lower", "upper", "sym"] as const) {
      const keys = keyboardKeys(layer);
      expect(keys.length).toBeGreaterThan(40);
      for (const key of keys) {
        expect(key.x).toBeGreaterThanOrEqual(0);
        expect(key.x + key.w).toBeLessThanOrEqual(SCREEN_W);
        expect(key.y).toBeGreaterThanOrEqual(KEYBOARD.y);
        expect(key.y + key.h).toBeLessThanOrEqual(TRACKPAD.y);
      }
      for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
          const a = keys[i]!;
          const b = keys[j]!;
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }
      }
      const labels = keys.map((k) => k.def.label);
      expect(labels).toContain("esc");
      expect(labels).toContain("tab");
      expect(labels).toContain("ctrl");
    }
    expect(TRACKPAD.y + TRACKPAD.h).toBeLessThanOrEqual(SCREEN_H);
    expect(TRACKPAD.h).toBeGreaterThanOrEqual(96);
    const lower = keyboardKeys("lower").map((k) => k.def.label);
    expect(lower).toContain(",");
    expect(lower).toContain(".");
    expect(lower).toContain("'");
    const sym = keyboardKeys("sym").map((k) => k.def.label);
    expect(sym).toContain("`");
    expect(sym).toContain("~");
    const f = keyboardKeys("lower").find((k) => k.def.label === "f")!;
    expect(keyAt("lower", f.x + 2, f.y + 2)).toBe(f);
    expect(keyAt("lower", f.x + f.w + 1, f.y + 2)).toBe(f); // the gap belongs to a key
    expect(keyAt("lower", 240, TRACKPAD.y + 10)).toBeNull();
  });

  test("keys become wire lines: text plain, keysyms under modifiers", () => {
    expect(keyToLine({ ch: "a" }, [])).toEqual({ t: "type", text: "a" });
    expect(keyToLine({ ch: "a" }, ["ctrl"])).toEqual({ t: "key", k: "a", mods: ["ctrl"] });
    expect(keyToLine({ ch: "." }, ["alt"])).toEqual({ t: "key", k: "period", mods: ["alt"] });
    expect(keyToLine({ ch: "€" }, ["ctrl"])).toBeNull();
    expect(keyToLine({ key: "Tab" }, [])).toEqual({ t: "key", k: "Tab" });
    expect(keyToLine({ key: "Return" }, ["ctrl"])).toEqual({ t: "key", k: "Return", mods: ["ctrl"] });
    expect(keyToLine({ layer: "sym" }, [])).toBeNull();
    expect(keysymFor("/")).toBe("slash");
    expect(keysymFor("Z")).toBeNull();
  });

  test("held letters and digits offer variants as chips inside the screen; the bubble stays on screen", () => {
    const keys = keyboardKeys("lower");
    const x = keys.find((k) => k.def.label === "x")!;
    expect(x.def.variants!.map((v) => v.label)).toEqual(["^X", "⌥X"]);
    const one = keys.find((k) => k.def.label === "1")!;
    expect(one.def.variants!.map((v) => v.k)).toEqual(["F1", "1"]);
    for (const key of [x, one, keys.find((k) => k.def.label === "p")!]) {
      const chips = chipRects(key, 2);
      for (const chip of chips) {
        expect(chip.x).toBeGreaterThanOrEqual(0);
        expect(chip.x + chip.w).toBeLessThanOrEqual(SCREEN_W);
        expect(chip.y).toBeGreaterThanOrEqual(STRIP.h);
      }
      expect(chipAt(key, 2, chips[1]!.x + 5, chips[1]!.y + 5)).toBe(1);
      expect(chipAt(key, 2, key.x, key.y + key.h + 60)).toBeNull();
      const bubble = bubbleRect(key);
      expect(bubble.x).toBeGreaterThanOrEqual(0);
      expect(bubble.x + bubble.w).toBeLessThanOrEqual(SCREEN_W);
    }
    // The top row's chips and bubble open below it.
    expect(chipRects(one, 2)[0]!.y).toBeGreaterThan(one.y);
    expect(bubbleRect(one).y).toBeGreaterThan(one.y);
    expect(bubbleRect(x).y).toBeLessThan(x.y);
  });
});

describe("pocket-remote wtype chords", () => {
  test("modifiers wrap the key and only allowed keysyms pass", () => {
    expect(wtypeArgs("c", ["ctrl"])).toEqual(["-M", "ctrl", "-k", "c", "-m", "ctrl"]);
    expect(wtypeArgs("Tab", ["ctrl", "shift"])).toEqual(["-M", "ctrl", "-M", "shift", "-k", "Tab", "-m", "shift", "-m", "ctrl"]);
    expect(wtypeArgs("F5")).toEqual(["-k", "F5"]);
    expect(wtypeArgs("rm -rf", ["ctrl"])).toBeNull();
    expect(wtypeArgs("c", ["hyper"])).toBeNull();
  });
});
