// DevTools shim contract tests (docs/DEVTOOLS.md) — drive the runtime shim
// (framework/src/devtools.ts) through the public render() with a mock HostOps + an
// in-process transport, exactly the way a device host injects one. The
// protocol IS the product here: everything the panel and tools/tape.ts
// rely on is asserted at this layer.
//
// Run: bun test --conditions=browser tests/devtools.test.ts
// (--conditions=browser: see renderer.test.ts — the SSR solid build no-ops.)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) {
  throw new Error("solid-js resolved to its SSR build — run: bun test --conditions=browser");
}

import { installHost, type Host, type HostOps } from "../framework/src/host.ts";
import { render as publicRender } from "../framework/src/index.ts";
import { expandTape, expandTapeTouch, fmt, type Tape } from "../framework/src/devtools.ts";
import { touches, __packTouch } from "../framework/src/touch.ts";
import { onFrame } from "../framework/src/lifecycle.ts";
import {
  createComponent,
  createTextNode,
  insertNode,
  resetRendererState,
  rootMirror,
  type NodeMirror,
} from "../framework/src/renderer.ts";
import { resetStyles } from "../framework/src/styles.ts";
import { resetInput } from "../framework/src/input.ts";
import { resetPack } from "../framework/src/pak.ts";
import { Named, View } from "../framework/src/components.ts";
import { BTN, ROOT_ID } from "../contracts/spec/spec.ts";

// ---------------------------------------------------------------------------
// Mock host with the DevTools ops + an in-process transport
// ---------------------------------------------------------------------------

interface DevMock extends Host {
  calls: [string, ...unknown[]][];
  of(name: string): [string, ...unknown[]][];
  rectXY: number;
  rectWH: number;
}

function makeDevHost(): DevMock {
  const calls: [string, ...unknown[]][] = [];
  let nextId = ROOT_ID + 1;
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const mock: DevMock = {
    kind: "injected",
    target: "test",
    strict: true,
    calls,
    rectXY: -1,
    rectWH: -1,
    of(name: string) {
      return calls.filter((c) => c[0] === name);
    },
    ops: {} as HostOps,
  };
  mock.ops = {
    createNode: () => nextId++,
    destroyNode: rec("destroyNode"),
    insertBefore: rec("insertBefore"),
    removeChild: rec("removeChild"),
    setStyle: rec("setStyle"),
    setProp: rec("setProp"),
    setText: rec("setText"),
    replaceText: rec("replaceText"),
    uploadTexture: () => 900,
    setImage: rec("setImage"),
    setSprite: rec("setSprite"),
    animate: () => 1,
    cancelAnim: rec("cancelAnim"),
    setFocus: rec("setFocus"),
    loadStyles: rec("loadStyles"),
    loadFontAtlas: rec("loadFontAtlas"),
    measureText: () => 0,
    debugInspect: rec("debugInspect"),
    debugRectXY: () => mock.rectXY,
    debugRectWH: () => mock.rectWH,
    debugPause: rec("debugPause"),
    debugStep: rec("debugStep"),
  };
  return mock;
}

let host: DevMock;
let inbox: string[];
let outbox: string[];
let dispose: (() => void) | null = null;

function push(msg: object): void {
  inbox.push(JSON.stringify(msg));
}

function sent(t: string): Record<string, unknown>[] {
  return outbox
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((m) => m.t === t);
}

function frame(buttons = 0): void {
  (globalThis as { frame?: (b: number) => void }).frame!(buttons);
}

const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  host = makeDevHost();
  installHost(host);
  resetRendererState();
  resetStyles();
  resetPack();
  resetInput();
  inbox = [];
  outbox = [];
  g.__pocketApp = "devtools-test";
  g.__pocketDevtoolsTransport = {
    send: (l: string) => outbox.push(l),
    recv: () => (inbox.length ? inbox.shift() : null),
  };
});

afterEach(() => {
  dispose?.();
  dispose = null;
  delete g.__pocketDevtoolsTransport;
  delete g.__pocketApp;
  g.frame = undefined;
});

function mountApp(app: () => unknown): void {
  dispose = publicRender(app, { ops: host.ops, styles: {} });
}

// ---------------------------------------------------------------------------

describe("tree + semantic names", () => {
  test("getTree returns the mirror tree with debugName and <Named> tags", () => {
    // Same type erasure as renderer.test.ts: runtime-identical, DOM-typed JSX.
    const comp = createComponent as (fn: unknown, props: unknown) => NodeMirror;
    mountApp(() =>
      View({
        children: comp(Named, {
          name: "Card",
          get children() {
            const v = View({}) as unknown as NodeMirror;
            insertNode(v, createTextNode("hello world"));
            return v;
          },
        }) as unknown as ReturnType<typeof View>,
        debugName: "Shell",
      }),
    );
    push({ t: "getTree" });
    frame();

    const hello = sent("hello");
    expect(hello.length).toBe(1);
    expect(hello[0].app).toBe("devtools-test");

    const trees = sent("tree");
    expect(trees.length).toBeGreaterThan(0);
    const root = trees[trees.length - 1].root as {
      k?: { n?: string; k?: { n?: string; k?: { x?: string }[] }[] }[];
    };
    // root -> appRoot(view) -> Shell -> Card -> #text
    const appRoot = root.k![0];
    const shell = appRoot.k![0];
    expect(shell.n).toBe("Shell");
    const card = shell.k![0] as { n?: string; k?: { x?: string }[] };
    expect(card.n).toBe("Card");
    expect(card.k![0].x).toBe("hello world");
  });

  test("tree traversal tolerates Vue Vapor fragment wrappers", () => {
    mountApp(() => View({ debugName: "PlaybackStatus" }));
    const playbackStatus = rootMirror.children[0].children[0];
    const paused = createTextNode("PAUSED");

    // Vue Vapor's dynamic conditional temporarily represents the swapped
    // branch as a fragment wrapper. It is not a native node and therefore
    // has `nodes`, not `children`.
    (playbackStatus.children as unknown[]).push({ nodes: [[paused]] });

    push({ t: "getTree" });
    expect(() => frame()).not.toThrow();
    const trees = sent("tree");
    expect(trees.length).toBeGreaterThan(0);
    expect(JSON.stringify(trees[trees.length - 1])).toContain("PAUSED");

    // Periodic stats use a separate traversal and must stay safe too.
    expect(() => {
      for (let index = 0; index < 30; index++) frame();
    }).not.toThrow();
  });
});

describe("pause / step / resume", () => {
  test("pause freezes app frames, step runs exactly one, resume continues", () => {
    let ran = 0;
    mountApp(() => {
      onFrame(() => {
        ran++;
      });
      return View({});
    });
    frame();
    frame();
    expect(ran).toBe(2);

    push({ t: "pause" });
    frame();
    frame();
    expect(ran).toBe(2); // frozen: hooks skipped
    expect(host.of("debugPause")).toEqual([["debugPause", true]]);

    push({ t: "step" });
    frame();
    expect(ran).toBe(3); // exactly one
    expect(host.of("debugStep").length).toBe(1);
    frame();
    expect(ran).toBe(3);

    push({ t: "resume" });
    frame();
    expect(ran).toBe(4);
    expect(host.of("debugPause")).toEqual([
      ["debugPause", true],
      ["debugPause", false],
    ]);
  });
});

describe("inspect", () => {
  test("inspect forwards to the core op and reports the decoded world rect", () => {
    mountApp(() => View({}));
    host.rectXY = 10 | (20 << 16);
    host.rectWH = 30 | (40 << 16);
    push({ t: "inspect", id: 2 });
    frame(); // poll applies inspect; the report flushes on the NEXT call
    frame();
    expect(host.of("debugInspect")).toEqual([["debugInspect", 2]]);
    const reports = sent("inspect");
    expect(reports.length).toBe(1);
    expect(reports[0].id).toBe(2);
    expect(reports[0].rect).toEqual([10, 20, 30, 40]);
  });

  test("inspect 0 clears immediately with a null rect", () => {
    mountApp(() => View({}));
    push({ t: "inspect", id: 0 });
    frame();
    const reports = sent("inspect");
    expect(reports[0]).toMatchObject({ id: 0, rect: null });
  });
});

describe("eval + console", () => {
  test("eval runs in the app global scope and reports formatted results", () => {
    mountApp(() => View({}));
    push({ t: "eval", id: 7, code: "6 * 7" });
    push({ t: "eval", id: 8, code: "throw new Error('boom')" });
    frame();
    const results = sent("evalResult");
    expect(results).toMatchObject([
      { id: 7, ok: true, value: "42" },
      { id: 8, ok: false, value: "Error: boom" },
    ]);
  });

  test("console.log mirrors to the channel with formatted args", () => {
    mountApp(() => View({}));
    console.log("hi", { a: 1, b: [1, 2, 3] });
    const logs = sent("log");
    expect(logs.length).toBe(1);
    expect(logs[0].level).toBe("log");
    expect(logs[0].args).toEqual(["hi", "{a: 1, b: [1, 2, 3]}"]);
  });
});

describe("tape", () => {
  test("flight recorder RLE-dumps the exact per-frame masks", () => {
    mountApp(() => View({}));
    frame(0);
    frame(0);
    frame(BTN.UP);
    frame(BTN.UP);
    frame(BTN.UP);
    frame(0);
    push({ t: "dumpTape" });
    frame(0); // poll dumps BEFORE this frame records
    const tapes = sent("tape");
    expect(tapes.length).toBe(1);
    const tape = tapes[0].tape as Tape;
    expect(tape.frames).toBe(6);
    expect(tape.masks).toEqual([
      [0, 2],
      [BTN.UP, 3],
      [0, 1],
    ]);
    expect(tape.startFrame).toBe(0);
  });

  test("replay overrides live input mask-for-mask, then returns to live", () => {
    const seen: number[] = [];
    mountApp(() => {
      onFrame((buttons: number) => {
        seen.push(buttons);
      });
      return View({});
    });
    push({
      t: "replay",
      tape: { v: 1, frames: 3, masks: [[BTN.CROSS, 2], [0, 1]] },
    });
    frame(BTN.START); // live START is overridden by the tape
    frame(BTN.START);
    frame(BTN.START);
    frame(BTN.START); // tape exhausted: live input again
    expect(seen).toEqual([BTN.CROSS, BTN.CROSS, 0, BTN.START]);
    expect(sent("replayDone").length).toBe(1);
  });

  test("expandTape unrolls RLE pairs", () => {
    const tape: Tape = { v: 1, frames: 4, masks: [[5, 1], [0, 2], [9, 1]] };
    expect(Array.from(expandTape(tape))).toEqual([5, 0, 0, 9]);
  });
});

describe("tape v2 touch track", () => {
  function frameTouch(buttons: number, touches?: readonly number[]): void {
    (globalThis as { frame?: (b: number, a?: number, t?: readonly number[]) => void }).frame!(
      buttons,
      undefined,
      touches,
    );
  }

  test("a touch-free session still exports v:1 with no touch key", () => {
    mountApp(() => View({}));
    frame(BTN.UP);
    frame(0);
    push({ t: "dumpTape" });
    frame(0);
    const tape = sent("tape")[0].tape as Tape;
    expect(tape.v).toBe(1);
    expect("touch" in tape).toBe(false);
  });

  test("contact frames export a sparse v:2 track", () => {
    mountApp(() => View({}));
    frameTouch(0); // frame 0: no contacts
    frameTouch(0, [__packTouch(1, 100, 50)]); // frame 1
    frameTouch(0, [__packTouch(1, 110, 60), __packTouch(2, 30, 30)]); // frame 2
    frameTouch(0); // frame 3: released
    push({ t: "dumpTape" });
    frame(0);
    const tape = sent("tape")[0].tape as Tape;
    expect(tape.v).toBe(2);
    expect(tape.frames).toBe(4);
    expect(tape.touch).toEqual([
      [1, [__packTouch(1, 100, 50)]],
      [2, [__packTouch(1, 110, 60), __packTouch(2, 30, 30)]],
    ]);
  });

  test("v2 replay drives touches(); live hardware contacts never leak", () => {
    const seen: number[] = [];
    mountApp(() => {
      onFrame(() => seen.push(touches().length));
      return View({});
    });
    const packed = __packTouch(1, 200, 100);
    push({
      t: "replay",
      tape: { v: 2, frames: 3, masks: [[0, 3]], touch: [[1, [packed]]] } satisfies Tape,
    });
    // Live contacts supplied on every frame — replay must own the track:
    frameTouch(0, [__packTouch(7, 1, 1)]); // tape frame 0: no contacts
    frameTouch(0, [__packTouch(7, 1, 1)]); // tape frame 1: the tape's contact
    frameTouch(0, [__packTouch(7, 1, 1)]); // tape frame 2: no contacts
    frameTouch(0, [__packTouch(7, 1, 1)]); // exhausted: live input again
    expect(seen).toEqual([0, 1, 0, 1]);
  });

  test("a v1 tape replays every frame as no-contacts", () => {
    const seen: number[] = [];
    mountApp(() => {
      onFrame(() => seen.push(touches().length));
      return View({});
    });
    push({ t: "replay", tape: { v: 1, frames: 2, masks: [[0, 2]] } satisfies Tape });
    frameTouch(0, [__packTouch(7, 1, 1)]);
    frameTouch(0, [__packTouch(7, 1, 1)]);
    expect(seen).toEqual([0, 0]);
  });

  test("recorded touch round-trips through export + replay byte-exactly", () => {
    mountApp(() => View({}));
    frameTouch(0, [__packTouch(3, 10, 20)]);
    frameTouch(0, [__packTouch(3, 12, 24)]);
    frameTouch(0);
    push({ t: "dumpTape" });
    frame(0);
    const exported = sent("tape")[0].tape as Tape;
    const expanded = expandTapeTouch(exported);
    expect(expanded[0]).toEqual([__packTouch(3, 10, 20)]);
    expect(expanded[1]).toEqual([__packTouch(3, 12, 24)]);
    expect(expanded[2]).toBeUndefined();
    expect(expanded[3]).toBeUndefined(); // the dump-poll frame
  });

  test("expandTapeTouch on a v1 tape is all undefined", () => {
    const tape: Tape = { v: 1, frames: 3, masks: [[0, 3]] };
    expect(expandTapeTouch(tape)).toEqual([undefined, undefined, undefined]);
  });
});

describe("errors + formatting", () => {
  test("a throwing frame reports to the channel and still rethrows", () => {
    let boom = false;
    mountApp(() => {
      onFrame(() => {
        if (boom) throw new Error("kaput");
      });
      return View({});
    });
    frame();
    boom = true;
    expect(() => frame()).toThrow("kaput");
    const errors = sent("error");
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe("kaput");
  });

  test("fmt caps depth and array length", () => {
    expect(fmt({ a: { b: { c: { d: 1 } } } })).toBe("{a: {b: {c: {…}}}}");
    expect(fmt(Array.from({ length: 25 }, (_, i) => i))).toContain("… 5 more");
    expect(fmt("plain")).toBe("plain");
    expect(fmt(undefined)).toBe("undefined");
  });
});

// ---------------------------------------------------------------------------
// stats (OP.debugStats) + the bundle-hash twin
// ---------------------------------------------------------------------------

describe("stats", () => {
  test("stats replies with the host's parsed counter snapshot", () => {
    host.ops.debugStats = () =>
      '{"app":"devtools-test","bundle":"cafe00cafe00cafe","vid":{"presented":42}}';
    mountApp(() => View({}));
    push({ t: "devStats" });
    frame();
    const s = sent("devStats");
    expect(s.length).toBe(1);
    const data = s[0].data as Record<string, unknown>;
    expect(data.bundle).toBe("cafe00cafe00cafe");
    expect((data.vid as Record<string, unknown>).presented).toBe(42);
  });

  test("a host without the op still completes the round trip (data: null)", () => {
    mountApp(() => View({}));
    push({ t: "devStats" });
    frame();
    const s = sent("devStats");
    expect(s.length).toBe(1);
    expect(s[0].data).toBeNull();
  });
});

describe("bundle hash", () => {
  test("fnv1a64 matches the published FNV-1a 64 test vectors", async () => {
    const { fnv1a64 } = await import("../tools/bundle-hash.ts");
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(fnv1a64(new Uint8Array(0))).toBe("cbf29ce484222325"); // offset basis
    expect(fnv1a64(bytes("a"))).toBe("af63dc4c8601ec8c");
    expect(fnv1a64(bytes("hello"))).toBe("a430d84680aabd0b");
    // Chunk boundaries must not matter (js+pak concatenation).
    expect(fnv1a64(bytes("he"), bytes("llo"))).toBe(fnv1a64(bytes("hello")));
  });
});
