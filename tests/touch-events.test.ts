// Touch events contract tests — drive framework/src/touch-events.ts against a
// mock HostOps with a scriptable hitTest and hand-built mirror trees, no
// reconciler in the loop (same harness as cursor.test.ts).
//
// Semantic oracle: W3C Touch Events (test names cite the section). The one
// deliberate deviation is bubble-only dispatch (no capture phase, no passive
// listeners) — see docs/prd-touch-events.md grill answers in the ESP32 repo.
//
// Run: bun test --conditions=browser tests/touch-events.test.ts

import { beforeEach, describe, expect, test } from "bun:test";

import { installHost, type Host, type HostOps } from "../framework/src/host.ts";
import type { NodeMirror } from "../framework/src/native-tree.ts";
import {
  __packTouchSample,
  handleTouchSamples,
  registerTouchHandler,
  resetTouchEvents,
  setTouchHitRootProvider,
  TouchPhase,
  type PocketTouchEvent,
} from "../framework/src/touch-events.ts";
import { NODE_TYPE, ROOT_ID } from "../contracts/spec/spec.ts";

type Call = [string, ...unknown[]];

interface TouchMockHost extends Host {
  calls: Call[];
  of(...names: string[]): Call[];
  hitResult: number;
}

function makeTouchHost(): TouchMockHost {
  const calls: Call[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const self: TouchMockHost = {
    kind: "injected",
    target: "test",
    strict: true,
    calls,
    hitResult: 0,
    of(...names: string[]) {
      return calls.filter((c) => names.includes(c[0] as string));
    },
    ops: {} as HostOps,
  };
  self.ops = {
    createNode: () => 0,
    destroyNode: rec("destroyNode"),
    insertBefore: rec("insertBefore"),
    removeChild: rec("removeChild"),
    setStyle: rec("setStyle"),
    setProp: rec("setProp"),
    setText: rec("setText"),
    replaceText: rec("replaceText"),
    uploadTexture: () => 1,
    setImage: rec("setImage"),
    setSprite: rec("setSprite"),
    animate: () => 1,
    cancelAnim: rec("cancelAnim"),
    setFocus: rec("setFocus"),
    measureText: () => 0,
    hitTest: (x: number, y: number) => {
      calls.push(["hitTest", x, y]);
      return self.hitResult;
    },
  } as unknown as HostOps;
  return self;
}

let host: TouchMockHost;

function mirror(id: number, parent: NodeMirror | null = null): NodeMirror {
  const node: NodeMirror = { id, type: NODE_TYPE.view, parent, children: [] };
  if (parent) parent.children.push(node);
  return node;
}

let root: NodeMirror;
let child: NodeMirror;
let grandchild: NodeMirror;

beforeEach(() => {
  host = makeTouchHost();
  installHost(host);
  resetTouchEvents();
  root = mirror(ROOT_ID);
  child = mirror(0x11, root);
  grandchild = mirror(0x22, child);
  setTouchHitRootProvider(() => root);
});

const FRAME_MS = 1000 / 60;

describe("wire format", () => {
  test("pack/decode round-trips phase, coords, dticks", () => {
    const p = __packTouchSample(TouchPhase.Move, 233, 117, 42);
    expect((p & 0x3) as TouchPhase).toBe(TouchPhase.Move);
    expect((p >>> 2) & 0x3ff).toBe(233);
    expect((p >>> 12) & 0x3ff).toBe(117);
    expect((p >>> 22) & 0x3f).toBe(42);
  });

  test("dticks clamp at 63", () => {
    expect((__packTouchSample(TouchPhase.Move, 0, 0, 500) >>> 22) & 0x3f).toBe(63);
  });
});

describe("phase dispatch", () => {
  test("start hits once and dispatches to the hit node (W3C §5.2 target)", () => {
    host.hitResult = grandchild.id;
    const seen: string[] = [];
    registerTouchHandler(grandchild, TouchPhase.Start, () => seen.push("gc"));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    expect(seen).toEqual(["gc"]);
    expect(host.of("hitTest")).toEqual([["hitTest", 10, 20]]);
  });

  test("sub-frame down+up dispatches BOTH events in order (regression: the old snapshot model lost these)", () => {
    host.hitResult = child.id;
    const seen: string[] = [];
    registerTouchHandler(child, TouchPhase.Start, () => seen.push("start"));
    registerTouchHandler(child, TouchPhase.End, () => seen.push("end"));
    handleTouchSamples(
      [
        __packTouchSample(TouchPhase.Start, 10, 20, 8),
        __packTouchSample(TouchPhase.End, 10, 20, 0),
      ],
      FRAME_MS,
    );
    expect(seen).toEqual(["start", "end"]);
  });

  test("no touchmove without movement (integer logical coords)", () => {
    host.hitResult = child.id;
    const seen: string[] = [];
    registerTouchHandler(child, TouchPhase.Move, () => seen.push("move"));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    handleTouchSamples([__packTouchSample(TouchPhase.Move, 10, 20)], 2 * FRAME_MS);
    expect(seen).toEqual([]);
    handleTouchSamples([__packTouchSample(TouchPhase.Move, 11, 20)], 3 * FRAME_MS);
    expect(seen).toEqual(["move"]);
  });

  test("move/end without a tracked start are ignored (host glitch safety)", () => {
    const seen: string[] = [];
    registerTouchHandler(root, TouchPhase.Move, () => seen.push("move"));
    registerTouchHandler(root, TouchPhase.End, () => seen.push("end"));
    handleTouchSamples([__packTouchSample(TouchPhase.Move, 5, 5)], FRAME_MS);
    handleTouchSamples([__packTouchSample(TouchPhase.End, 5, 5)], 2 * FRAME_MS);
    expect(seen).toEqual([]);
  });

  test("empty frames are free: no hitTest, no dispatch", () => {
    const seen: string[] = [];
    registerTouchHandler(root, TouchPhase.Start, () => seen.push("start"));
    handleTouchSamples(undefined, FRAME_MS);
    handleTouchSamples([], 2 * FRAME_MS);
    expect(seen).toEqual([]);
    expect(host.of("hitTest")).toEqual([]);
  });

  test("outlier guard: single-frame coordinate spikes are discarded, next plausible frame wins", () => {
    host.hitResult = child.id;
    const positions: [number, number][] = [];
    registerTouchHandler(child, TouchPhase.Move, (ev) =>
      positions.push([ev.changedTouches[0].clientX, ev.changedTouches[0].clientY]),
    );
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    // I2C partial-read artifact: finger cannot jump 400 px in one frame.
    handleTouchSamples([__packTouchSample(TouchPhase.Move, 410, 20)], 2 * FRAME_MS);
    expect(positions).toEqual([]);
    // A second spike is still measured against the last GOOD sample (10,20),
    // not against the discarded one — no drift accumulation.
    handleTouchSamples([__packTouchSample(TouchPhase.Move, 420, 200)], 3 * FRAME_MS);
    expect(positions).toEqual([]);
    // Next plausible frame dispatches normally.
    handleTouchSamples([__packTouchSample(TouchPhase.Move, 12, 22)], 4 * FRAME_MS);
    expect(positions).toEqual([[12, 22]]);
  });

  test("outlier guard: baseline resets on every start (fast taps never filtered)", () => {
    host.hitResult = child.id;
    const seen: string[] = [];
    registerTouchHandler(child, TouchPhase.Start, () => seen.push("start"));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    handleTouchSamples([__packTouchSample(TouchPhase.End, 10, 20)], 2 * FRAME_MS);
    // New contact far away: start is always trusted, never outlier-filtered.
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 600, 200)], 3 * FRAME_MS);
    expect(seen).toEqual(["start", "start"]);
    expect(host.of("hitTest")).toEqual([
      ["hitTest", 10, 20],
      ["hitTest", 600, 200],
    ]);
  });
});

describe("implicit capture (W3C §5.2)", () => {
  test("move/end target stays the down node after sliding onto a sibling", () => {
    const sibling = mirror(0x33, root);
    host.hitResult = child.id;
    const targets: number[] = [];
    registerTouchHandler(child, TouchPhase.Move, (ev) => targets.push((ev.target as NodeMirror).id));
    registerTouchHandler(child, TouchPhase.End, (ev) => targets.push((ev.target as NodeMirror).id));
    registerTouchHandler(sibling, TouchPhase.Move, () => targets.push(-1));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    host.hitResult = sibling.id; // finger now over the sibling
    handleTouchSamples([__packTouchSample(TouchPhase.Move, 200, 20)], 2 * FRAME_MS);
    handleTouchSamples([__packTouchSample(TouchPhase.End, 200, 20)], 3 * FRAME_MS);
    expect(targets).toEqual([child.id, child.id]);
    // and no hitTest after the start: the capture table answers move/end
    expect(host.of("hitTest")).toHaveLength(1);
  });

  test("cancel delivers to the captured target", () => {
    host.hitResult = grandchild.id;
    const seen: string[] = [];
    registerTouchHandler(grandchild, TouchPhase.Cancel, () => seen.push("cancel"));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    handleTouchSamples([__packTouchSample(TouchPhase.Cancel, 10, 20)], 2 * FRAME_MS);
    expect(seen).toEqual(["cancel"]);
  });
});

describe("bubbling (W3C §5.6)", () => {
  test("bubbles target -> parent -> root", () => {
    host.hitResult = grandchild.id;
    const order: string[] = [];
    registerTouchHandler(root, TouchPhase.Start, () => order.push("root"));
    registerTouchHandler(child, TouchPhase.Start, () => order.push("child"));
    registerTouchHandler(grandchild, TouchPhase.Start, () => order.push("gc"));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 1, 1)], FRAME_MS);
    expect(order).toEqual(["gc", "child", "root"]);
  });

  test("stopPropagation truncates the walk", () => {
    host.hitResult = grandchild.id;
    const order: string[] = [];
    registerTouchHandler(root, TouchPhase.Start, () => order.push("root"));
    registerTouchHandler(child, TouchPhase.Start, (ev) => {
      order.push("child");
      ev.stopPropagation();
    });
    registerTouchHandler(grandchild, TouchPhase.Start, () => order.push("gc"));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 1, 1)], FRAME_MS);
    expect(order).toEqual(["gc", "child"]);
  });

  test("currentTarget walks, target stays fixed", () => {
    host.hitResult = grandchild.id;
    const seen: Array<[number, number]> = [];
    const log = (ev: PocketTouchEvent) =>
      seen.push([(ev.target as NodeMirror).id, (ev.currentTarget as NodeMirror).id]);
    registerTouchHandler(child, TouchPhase.Start, log);
    registerTouchHandler(root, TouchPhase.Start, log);
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 1, 1)], FRAME_MS);
    expect(seen).toEqual([
      [grandchild.id, child.id],
      [grandchild.id, root.id],
    ]);
  });
});

describe("event lists (W3C §5.3)", () => {
  test("touchstart: touches and changedTouches contain the new contact", () => {
    host.hitResult = child.id;
    let ev0: PocketTouchEvent | null = null;
    registerTouchHandler(child, TouchPhase.Start, (ev) => (ev0 = ev));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    expect(ev0!.touches).toHaveLength(1);
    expect(ev0!.changedTouches).toHaveLength(1);
    expect(ev0!.changedTouches[0].clientX).toBe(10);
    expect(ev0!.changedTouches[0].clientY).toBe(20);
    expect(ev0!.targetTouches).toHaveLength(1); // currentTarget === target here
    expect(ev0!.touches[0].target).toBe(child);
  });

  test("touchend: touches is empty, changedTouches has the released contact", () => {
    host.hitResult = child.id;
    let ev0: PocketTouchEvent | null = null;
    registerTouchHandler(child, TouchPhase.End, (ev) => (ev0 = ev));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    handleTouchSamples([__packTouchSample(TouchPhase.End, 30, 40)], 2 * FRAME_MS);
    expect(ev0!.touches).toHaveLength(0);
    expect(ev0!.changedTouches).toHaveLength(1);
    expect(ev0!.changedTouches[0].clientX).toBe(30);
    expect(ev0!.changedTouches[0].clientY).toBe(40);
  });
});

describe("timeStamps (sample-time, tape-deterministic)", () => {
  test("timeStamp walks backwards from frame end by dticks", () => {
    host.hitResult = child.id;
    const stamps: number[] = [];
    registerTouchHandler(child, TouchPhase.Start, (ev) => stamps.push(ev.timeStamp));
    registerTouchHandler(child, TouchPhase.Move, (ev) => stamps.push(ev.timeStamp));
    registerTouchHandler(child, TouchPhase.End, (ev) => stamps.push(ev.timeStamp));
    // start at t-16ms, move at t-8ms, end at t: dticks are 8, 8, 0 reading
    // FORWARD, so the packed stream carries [start:8, move:8, end:0].
    handleTouchSamples(
      [
        __packTouchSample(TouchPhase.Start, 1, 1, 8),
        __packTouchSample(TouchPhase.Move, 2, 1, 8),
        __packTouchSample(TouchPhase.End, 2, 1, 0),
      ],
      1000,
    );
    expect(stamps).toEqual([984, 992, 1000]);
  });
});

describe("handler registration via prop names", () => {
  test("all four phases register and fire under both prop spellings", async () => {
    host.hitResult = child.id;
    const seen: string[] = [];
    // Exercise the native-tree prop path, not just the internal registry.
    const { setProp } = await import("../framework/src/native-tree.ts");
    setProp(child, "onTouchstart", () => seen.push("start"));
    setProp(child, "on:touchmove", () => seen.push("move"));
    setProp(child, "onTouchend", () => seen.push("end"));
    setProp(child, "on:touchcancel", () => seen.push("cancel"));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 1, 1)], FRAME_MS);
    handleTouchSamples([__packTouchSample(TouchPhase.Move, 2, 1)], 2 * FRAME_MS);
    handleTouchSamples([__packTouchSample(TouchPhase.End, 2, 1)], 3 * FRAME_MS);
    // cancel after end: contact already released, nothing fires
    handleTouchSamples([__packTouchSample(TouchPhase.Cancel, 2, 1)], 4 * FRAME_MS);
    expect(seen).toEqual(["start", "move", "end"]);
  });
});

describe("preventDefault", () => {
  test("defaultPrevented round-trips within the event", () => {
    host.hitResult = child.id;
    let prevented = false;
    registerTouchHandler(child, TouchPhase.Start, (ev) => {
      ev.preventDefault();
      prevented = ev.defaultPrevented;
    });
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 1, 1)], FRAME_MS);
    expect(prevented).toBe(true);
  });
});

// ---- W3C canonical cases -----------------------------------------------------
// These codify the semantics a browser developer expects. They exist because
// the demo app exposed two real bugs the happy-path tests above missed:
//   1. a global listener on the root saw "blank" before the element listener
//      reported — bubble ORDER was under-tested;
//   2. touching bare background (no element) never reached a root listener —
//      root dispatch was under-tested.

describe("W3C canonical bubbling order", () => {
  test("target first, then ancestors up to root (target phase -> bubble phase)", () => {
    host.hitResult = grandchild.id;
    const order: string[] = [];
    registerTouchHandler(root, TouchPhase.Start, () => order.push("root"));
    registerTouchHandler(child, TouchPhase.Start, () => order.push("child"));
    registerTouchHandler(grandchild, TouchPhase.Start, () => order.push("grandchild"));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    // W3C §5.6: the event target's own listeners run FIRST (target phase),
    // then bubble ancestors from innermost to outermost.
    expect(order).toEqual(["grandchild", "child", "root"]);
  });

  test("currentTarget tracks the bubbling node while target stays fixed", () => {
    host.hitResult = grandchild.id;
    const seen: [number, number][] = []; // [currentTarget.id, target.id]
    const log = (ev: PocketTouchEvent) =>
      seen.push([(ev.currentTarget as NodeMirror).id, (ev.target as NodeMirror).id]);
    registerTouchHandler(root, TouchPhase.Start, log);
    registerTouchHandler(child, TouchPhase.Start, log);
    registerTouchHandler(grandchild, TouchPhase.Start, log);
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    expect(seen).toEqual([
      [grandchild.id, grandchild.id],
      [child.id, grandchild.id],
      [root.id, grandchild.id],
    ]);
  });

  test("root listener observes touches that hit NO element (background)", () => {
    // The demo bug: tapping bare background never updated a root-level
    // listener. W3C: hit tests that fall through to the document still
    // dispatch, with the document (here: root) as target.
    host.hitResult = 0; // no element claims the point
    const seen: string[] = [];
    registerTouchHandler(root, TouchPhase.Start, () => seen.push("start"));
    registerTouchHandler(root, TouchPhase.End, () => seen.push("end"));
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 500, 150)], FRAME_MS);
    handleTouchSamples([__packTouchSample(TouchPhase.End, 500, 150)], 2 * FRAME_MS);
    expect(seen).toEqual(["start", "end"]);
  });

  test("root-as-target bubbles nowhere above root (no crash, single dispatch)", () => {
    host.hitResult = 0;
    const seen: string[] = [];
    registerTouchHandler(root, TouchPhase.Start, (ev) => {
      seen.push("start");
      expect(ev.target as NodeMirror | null).toBe(ev.currentTarget);
    });
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 500, 150)], FRAME_MS);
    expect(seen).toEqual(["start"]);
  });

  test("stopPropagation at the target prevents ALL ancestor listeners", () => {
    host.hitResult = grandchild.id;
    const order: string[] = [];
    registerTouchHandler(root, TouchPhase.Start, () => order.push("root"));
    registerTouchHandler(child, TouchPhase.Start, () => order.push("child"));
    registerTouchHandler(grandchild, TouchPhase.Start, (ev) => {
      order.push("grandchild");
      ev.stopPropagation();
    });
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    expect(order).toEqual(["grandchild"]);
  });

  test("targetTouches lists only contacts whose target is the currentTarget (W3C §5.3)", () => {
    host.hitResult = child.id;
    let atChild: number | undefined;
    let atRoot: number | undefined;
    registerTouchHandler(child, TouchPhase.Start, (ev) => {
      atChild = ev.targetTouches.length;
    });
    registerTouchHandler(root, TouchPhase.Start, (ev) => {
      atRoot = ev.targetTouches.length;
    });
    handleTouchSamples([__packTouchSample(TouchPhase.Start, 10, 20)], FRAME_MS);
    expect(atChild).toBe(1); // the contact targets child
    expect(atRoot).toBe(0); // not root, even though root sees the bubble
  });
});
