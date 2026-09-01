// tests/pocket-shell-wm.test.ts — the window manager's layout rules, without
// a device: dwindle splits, scrolling columns, directional focus and swap,
// resize, fullscreen, workspace moves, and the touch handles.

import { describe, expect, test } from "bun:test";
import {
  BAR_H,
  GAP_IN,
  GAP_OUT,
  STAGE_H,
  STAGE_W,
  WindowManager,
  type Rect,
} from "../apps/pocket-shell/wm.ts";
import { CHORDS, chordFor, keySheet, labelFor, layerOf } from "../apps/pocket-shell/chords.ts";
import { CLEAR, complete, formatClock, formatUptime, run, type ShellApi } from "../apps/pocket-shell/shell.ts";
import { BTN } from "../contracts/spec/spec.ts";

type App = "term" | "clock" | "notes";

const rectOf = (wm: WindowManager<App>, id: number): Rect => {
  const placement = wm.placement(id);
  if (!placement) throw new Error(`no placement for #${id}`);
  return placement.rect;
};

describe("dwindle", () => {
  test("the first window fills the workspace inside the gaps", () => {
    const wm = new WindowManager<App>();
    const id = wm.open("term");
    expect(rectOf(wm, id)).toEqual({
      x: GAP_OUT + GAP_IN,
      y: BAR_H + GAP_OUT + GAP_IN,
      w: STAGE_W - 2 * (GAP_OUT + GAP_IN),
      h: STAGE_H - BAR_H - 2 * (GAP_OUT + GAP_IN),
    });
    expect(wm.workspace().focus).toBe(id);
  });

  test("a second window splits the wide first one side by side, third stacks", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    const b = wm.open("clock");
    const ra = rectOf(wm, a);
    const rb = rectOf(wm, b);
    expect(ra.y).toBe(rb.y);
    expect(rb.x).toBeGreaterThan(ra.x + ra.w);
    expect(rb.x - (ra.x + ra.w)).toBe(2 * GAP_IN);
    // The focused (right) column is taller than wide, so the third stacks under it.
    const c = wm.open("notes");
    const rb2 = rectOf(wm, b);
    const rc = rectOf(wm, c);
    expect(rc.x).toBe(rb2.x);
    expect(rc.y).toBeGreaterThan(rb2.y + rb2.h);
    expect(wm.order()).toEqual([a, b, c]);
  });

  test("closing gives the space back and focuses the neighbour", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    const b = wm.open("clock");
    const c = wm.open("notes");
    expect(wm.close(c)).toBe(true);
    expect(wm.workspace().focus).toBe(b);
    expect(rectOf(wm, b).h).toBe(rectOf(wm, a).h);
    wm.close(b);
    expect(rectOf(wm, a).w).toBe(STAGE_W - 2 * (GAP_OUT + GAP_IN));
    wm.close(a);
    expect(wm.count()).toBe(0);
    expect(wm.workspace().focus).toBeNull();
    expect(wm.close()).toBe(false);
  });

  test("reopen brings back the last closed app", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    wm.open("clock");
    wm.close(a);
    const again = wm.reopen();
    expect(again).not.toBeNull();
    expect(wm.windows.get(again!)?.app).toBe("term");
    expect(wm.windows.get(again!)?.title).toBe("term");
    wm.close(); // closes term again
    wm.close(); // clock
    wm.reopen();
    wm.reopen();
    expect(wm.reopen()).toBeNull();
  });

  test("focus and swap follow the d-pad directions", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    const b = wm.open("clock");
    const c = wm.open("notes");
    expect(wm.workspace().focus).toBe(c);
    expect(wm.focusDir("up")).toBe(true);
    expect(wm.workspace().focus).toBe(b);
    expect(wm.focusDir("left")).toBe(true);
    expect(wm.workspace().focus).toBe(a);
    expect(wm.focusDir("left")).toBe(false);
    // Swap a with its right neighbour: a takes b's slot.
    const before = rectOf(wm, b);
    expect(wm.swapDir("right")).toBe(true);
    expect(rectOf(wm, a)).toEqual(before);
    expect(wm.workspace().focus).toBe(a);
    expect(wm.order()).toEqual([b, a, c]);
  });

  test("resize pushes the nearest boundary in the pad's direction", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    const b = wm.open("clock");
    wm.focusWin(a);
    const wa = rectOf(wm, a).w;
    wm.resize(20, 0);
    expect(rectOf(wm, a).w).toBe(wa + 20);
    // From the right window, pushing right has no boundary on that side, so
    // the left boundary moves right and the window shrinks.
    wm.focusWin(b);
    const wb = rectOf(wm, b).w;
    wm.resize(20, 0);
    expect(rectOf(wm, b).w).toBe(wb - 20);
    // Ratios clamp.
    for (let i = 0; i < 100; i++) wm.resize(50, 0);
    expect(rectOf(wm, a).w).toBeGreaterThan(rectOf(wm, b).w);
    expect(rectOf(wm, b).w).toBeGreaterThan(20);
  });

  test("toggleSplit flips orientation; swapSplit exchanges halves", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    const b = wm.open("clock");
    expect(wm.toggleSplit()).toBe(true);
    expect(rectOf(wm, a).x).toBe(rectOf(wm, b).x);
    expect(rectOf(wm, b).y).toBeGreaterThan(rectOf(wm, a).y);
    expect(wm.swapSplit()).toBe(true);
    expect(rectOf(wm, a).y).toBeGreaterThan(rectOf(wm, b).y);
    expect(wm.order()).toEqual([b, a]);
  });

  test("fullscreen covers the stage and hides the others; focus elsewhere clears it", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    const b = wm.open("clock");
    wm.toggleFullscreen("full");
    expect(rectOf(wm, b)).toEqual({ x: 0, y: 0, w: STAGE_W, h: STAGE_H });
    expect(wm.placement(a)?.hidden).toBe(true);
    wm.toggleFullscreen("max");
    expect(rectOf(wm, b)).toEqual(wm.area());
    wm.focusWin(a);
    expect(wm.workspace().fullscreen).toBeNull();
    expect(wm.placement(a)?.hidden).toBe(false);
  });

  test("a split boundary can be found and dragged", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    wm.open("clock");
    const ra = rectOf(wm, a);
    const handle = wm.splitAt({ x: ra.x + ra.w + GAP_IN, y: 120 }, 6);
    expect(handle?.axis).toBe("x");
    wm.dragSplit(handle!, { x: 100, y: 120 });
    expect(rectOf(wm, a).x + rectOf(wm, a).w + GAP_IN).toBe(100);
    expect(wm.splitAt({ x: 200, y: 20 }, 6)).toBeNull();
  });

  test("the bar can be hidden and the area grows", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    const before = rectOf(wm, a);
    wm.toggleBar();
    expect(rectOf(wm, a).y).toBe(before.y - BAR_H);
    expect(rectOf(wm, a).h).toBe(before.h + BAR_H);
  });
});

describe("scrolling", () => {
  test("columns take 0.49 of the width and the strip follows focus", () => {
    const wm = new WindowManager<App>();
    wm.toggleLayout();
    expect(wm.workspace().layout).toBe("scrolling");
    const a = wm.open("term");
    const b = wm.open("clock");
    const area = wm.area();
    expect(rectOf(wm, a).w).toBe(Math.round(area.w * 0.49) - 2 * GAP_IN);
    expect(rectOf(wm, a).x).toBe(area.x + GAP_IN);
    expect(rectOf(wm, b).x).toBe(area.x + Math.round(area.w * 0.49) + GAP_IN);
    // A third column does not fit: the strip scrolls so it is fully visible.
    const c = wm.open("notes");
    const rc = rectOf(wm, c);
    expect(rc.x + rc.w + GAP_IN).toBeLessThanOrEqual(area.x + area.w);
    expect(wm.workspace().scroll).toBeGreaterThan(0);
    expect(rectOf(wm, a).x).toBeLessThan(area.x);
    // Focusing the first column scrolls back.
    wm.focusWin(a);
    expect(wm.workspace().scroll).toBe(0);
  });

  test("focus and swap work across offscreen columns", () => {
    const wm = new WindowManager<App>();
    wm.toggleLayout();
    const a = wm.open("term");
    const b = wm.open("clock");
    const c = wm.open("notes");
    wm.focusWin(a);
    expect(wm.focusDir("right")).toBe(true);
    expect(wm.workspace().focus).toBe(b);
    expect(wm.focusDir("right")).toBe(true);
    expect(wm.workspace().focus).toBe(c);
    expect(wm.focusDir("right")).toBe(false);
    expect(wm.swapDir("left")).toBe(true);
    expect(wm.order()).toEqual([a, c, b]);
  });

  test("column width cycles, and stack/unstack moves a window between columns", () => {
    const wm = new WindowManager<App>();
    wm.toggleLayout();
    const a = wm.open("term");
    const b = wm.open("clock");
    expect(wm.cycleColumnWidth()).toBe(true);
    expect(wm.workspace().columns[1].width).toBe(0.66);
    // b joins a's column.
    expect(wm.consumeOrExpel()).toBe(true);
    expect(wm.workspace().columns.length).toBe(1);
    expect(wm.workspace().columns[0].wins).toEqual([a, b]);
    expect(rectOf(wm, b).y).toBeGreaterThan(rectOf(wm, a).y);
    expect(wm.focusDir("up")).toBe(true);
    expect(wm.workspace().focus).toBe(a);
    // a leaves into its own column to the right.
    expect(wm.consumeOrExpel()).toBe(true);
    expect(wm.workspace().columns.map((c) => c.wins)).toEqual([[b], [a]]);
  });

  test("toggling back to dwindle keeps order and focus", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    const b = wm.open("clock");
    const c = wm.open("notes");
    wm.focusWin(b);
    wm.toggleLayout();
    expect(wm.order()).toEqual([a, b, c]);
    expect(wm.workspace().focus).toBe(b);
    wm.toggleLayout();
    expect(wm.workspace().layout).toBe("dwindle");
    expect(wm.order()).toEqual([a, b, c]);
    expect(wm.workspace().focus).toBe(b);
    expect(wm.placements().length).toBe(3);
  });

  test("a column edge can be dragged", () => {
    const wm = new WindowManager<App>();
    wm.toggleLayout();
    wm.open("term");
    wm.open("clock");
    const area = wm.area();
    const edge = area.x + Math.round(area.w * 0.49);
    const handle = wm.columnEdgeAt({ x: edge + 2, y: 100 }, 6);
    expect(handle).not.toBeNull();
    wm.dragColumnEdge(handle!, { x: area.x + Math.round(area.w * 0.3), y: 100 });
    expect(handle!.column.width).toBeCloseTo(0.3, 1);
  });
});

describe("workspaces", () => {
  test("carry moves the focused window and follows it", () => {
    const wm = new WindowManager<App>();
    const a = wm.open("term");
    const b = wm.open("clock");
    expect(wm.carryWs(1)).toBe(true);
    expect(wm.active).toBe(2);
    expect(wm.workspace(2).focus).toBe(b);
    expect(wm.workspace(1).focus).toBe(a);
    expect(wm.count(wm.workspace(1))).toBe(1);
    expect(wm.windows.get(b)?.ws).toBe(2);
    expect(wm.stepWs(-1)).toBe(true);
    expect(wm.stepWs(-1)).toBe(false);
    expect(wm.moveToWs(a, 1)).toBe(false);
    expect(wm.moveToWs(a, 5)).toBe(true);
    expect(wm.active).toBe(1);
    expect(wm.count()).toBe(0);
  });

  test("each workspace keeps its own layout", () => {
    const wm = new WindowManager<App>();
    wm.toggleLayout();
    wm.switchWs(2);
    expect(wm.workspace().layout).toBe("dwindle");
    wm.switchWs(1);
    expect(wm.workspace().layout).toBe("scrolling");
  });
});

describe("chords", () => {
  test("layers come from the shoulders", () => {
    expect(layerOf(0)).toBe("plain");
    expect(layerOf(BTN.LTRIGGER)).toBe("super");
    expect(layerOf(BTN.RTRIGGER)).toBe("shift");
    expect(layerOf(BTN.LTRIGGER | BTN.RTRIGGER)).toBe("ws");
  });

  test("every chord is unique per layer and every action has a label", () => {
    const seen = new Set<string>();
    for (const chord of CHORDS) {
      const key = `${chord.layer}:${chord.button}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(labelFor(chord.action, "dwindle").length).toBeGreaterThan(0);
      expect(labelFor(chord.action, "scrolling").length).toBeGreaterThan(0);
    }
    expect(chordFor("super", BTN.CROSS)?.action).toBe("close");
    expect(chordFor("plain", BTN.CROSS)).toBeUndefined();
    expect(keySheet("dwindle").length).toBe(4);
  });
});

describe("pocketsh", () => {
  function fakeApi(): { api: ShellApi; log: string[] } {
    const log: string[] = [];
    const api: ShellApi = {
      apps: () => ["term", "clock"],
      windows: () => [{ id: 1, app: "term", title: "term", ws: 1, focused: true }],
      workspace: () => 1,
      layout: () => "dwindle",
      wallpaper: () => "road",
      uptimeSeconds: () => 3725,
      now: () => new Date(2000, 0, 1, 9, 41, 0),
      host: () => "3ds",
      open: (app) => (app === "clock" ? 2 : null),
      close: (id) => {
        log.push(`close ${id ?? "focused"}`);
        return true;
      },
      focus: (id) => id === 1,
      switchWs: (id) => id >= 1 && id <= 5,
      setLayout: (layout) => {
        log.push(`layout ${layout}`);
      },
      nextWallpaper: () => "lake",
      keys: () => [{ title: "L", rows: [{ keys: "L + B", what: "close" }] }],
    };
    return { api, log };
  }

  test("commands drive the api and report", () => {
    const { api, log } = fakeApi();
    expect(run("ls", api)).toEqual(["* #1  term"]);
    expect(run("open clock", api)).toEqual(["opened clock as #2"]);
    expect(run("open nope", api)[0]).toContain("no app");
    expect(run("close #1", api)).toEqual(["closed #1"]);
    expect(run("layout scrolling", api)).toEqual(["workspace 1 is now scrolling"]);
    expect(log).toEqual(["close 1", "layout scrolling"]);
    expect(run("ws 9", api)[0]).toContain("1-5");
    expect(run("wall next", api)).toEqual(["wallpaper: lake"]);
    expect(run("date", api)).toEqual(["Sat Jan 1 2000 09:41"]);
    expect(run("uptime", api)).toEqual(["1h 02m 05s"]);
    expect(run("echo hi there", api)).toEqual(["hi there"]);
    expect(run("clear", api)).toEqual([CLEAR]);
    expect(run("", api)).toEqual([]);
    expect(run("frob", api)).toEqual(["pocketsh: frob: command not found"]);
    expect(run("keys", api)).toEqual(["L", "  L + B        close"]);
    expect(run("fetch", api).length).toBe(6);
  });

  test("completion and clock formatting", () => {
    expect(complete("la")).toEqual(["layout"]);
    expect(complete("")).toHaveLength(14);
    expect(formatClock(new Date(2000, 0, 1, 0, 5), false)).toBe("00:05");
    expect(formatClock(new Date(2000, 0, 1, 13, 5), true)).toBe("01:05");
    expect(formatClock(new Date(2000, 0, 1, 0, 5), true)).toBe("12:05");
    expect(formatUptime(59)).toBe("0m 59s");
  });
});
