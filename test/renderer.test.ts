// Renderer contract tests — drive src/renderer.ts against a MOCK HostOps that
// records every op call, using the real solid-js/universal reconciler under
// Bun. No JSX here (babel isn't in the loop for tests): we call the renderer
// exports exactly the way babel-preset-solid {generate:'universal'} compiled
// code does.
//
// Run: bun test --conditions=browser test/renderer.test.ts
//
// The --conditions=browser flag is REQUIRED: without it Bun resolves solid-js
// via its "node" export condition to dist/server.js — the SSR build, whose
// createRenderEffect never re-runs, so every reactive update silently no-ops.
// (Same rule applies to Bun.build in scripts/build.ts: conditions:["browser"].)

import { beforeEach, describe, expect, test } from "bun:test";
import { createSignal, For, Show } from "solid-js";

// Fail fast with a real message if the SSR build got resolved.
if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) {
  throw new Error(
    "solid-js resolved to its SSR build (dist/server.js) — reactive updates " +
      "would silently no-op. Run: bun test --conditions=browser",
  );
}

import {
  assertNativeHostContract,
  detectHost,
  installHost,
  parseHexColor,
  type Host,
  type HostOps,
} from "../src/host.ts";
import {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  missCounters,
  registerTexture,
  release,
  render,
  resetRendererState,
  resetTextures,
  retain,
  runSweep,
  setProp,
  setStyleResolver,
  type NodeMirror,
} from "../src/renderer.ts";
import { registerStyles, resetStyles, resolveStyle } from "../src/styles.ts";
import {
  getFocused,
  focusNode,
  handleFrame,
  pushFocusGrid,
  pushFocusScope,
  resetInput,
  setInputRoot,
} from "../src/input.ts";
import { mount as publicMount, render as publicRender } from "../src/index.ts";
import { pushButtonHandlerBlock, onButtonPress, onFrame } from "../src/lifecycle.ts";
import { rootMirror } from "../src/renderer.ts";
import { ActionBar, ActionHandler, FocusGrid, Modal, Portal, Text, View } from "../src/components.ts";
import { resetPack } from "../src/pak.ts";
import { encodeImageEntry, pack } from "../compiler/pak.ts";
import { BTN, PAK_DTYPE, NODE_TYPE, PSM, ROOT_ID, PROP, STYLE_ID_NONE } from "../spec/spec.ts";

// ---------------------------------------------------------------------------
// Mock host
// ---------------------------------------------------------------------------

type Call = [string, ...unknown[]];

// Solid's <For>/<Show> are typed against DOM JSX.Element; the renderer's node
// type here is NodeMirror. Runtime-identical — erase the type mismatch only.
const comp = createComponent as (fn: unknown, props: unknown) => NodeMirror;

interface MockHost extends Host {
  calls: Call[];
  /** calls filtered by op name(s) */
  of(...names: string[]): Call[];
  clear(): void;
  alive: Set<number>;
}

function makeMockHost(strict = true): MockHost {
  const calls: Call[] = [];
  let nextId = ROOT_ID + 1;
  const alive = new Set<number>([ROOT_ID]);
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ops: HostOps = {
    createNode(type: number): number {
      const id = nextId++;
      alive.add(id);
      calls.push(["createNode", type, id]);
      return id;
    },
    destroyNode(id: number): void {
      alive.delete(id);
      calls.push(["destroyNode", id]);
    },
    insertBefore: rec("insertBefore"),
    removeChild: rec("removeChild"),
    setStyle: rec("setStyle"),
    setProp: rec("setProp"),
    setText: rec("setText"),
    replaceText: rec("replaceText"),
    uploadTexture(_buf, _w, _h, _psm) {
      calls.push(["uploadTexture"]);
      return 900 + calls.length;
    },
    setImage: rec("setImage"),
    setSprite: rec("setSprite"),
    animate(...args: number[]) {
      calls.push(["animate", ...args]);
      return 1;
    },
    cancelAnim: rec("cancelAnim"),
    setFocus: rec("setFocus"),
    setActive: rec("setActive"),
    loadStyles: rec("loadStyles"),
    loadFontAtlas: rec("loadFontAtlas"),
    measureText: () => 0,
  };
  return {
    ops,
    kind: "injected",
    target: "test",
    strict,
    calls,
    alive,
    of(...names: string[]) {
      return calls.filter((c) => names.includes(c[0] as string));
    },
    clear() {
      calls.length = 0;
    },
  };
}

function freshRoot(): NodeMirror {
  return { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] };
}

/** Ids of a mirror node's children, in order. */
function childIds(node: NodeMirror): number[] {
  return node.children.map((c) => c.id);
}

let host: MockHost;
let root: NodeMirror;

beforeEach(() => {
  host = makeMockHost();
  installHost(host);
  resetRendererState();
  resetStyles();
  resetTextures();
  resetPack();
  resetInput();
  setStyleResolver(resolveStyle);
  root = freshRoot();
  const g = globalThis as { ui?: HostOps; __pak?: ArrayBuffer; frame?: (buttons: number) => void };
  delete g.ui;
  delete g.__pak;
  delete g.frame;
});

// ---------------------------------------------------------------------------

describe("basic mount", () => {
  test("static view with text child produces create/setText/insert ops", () => {
    const dispose = render(() => {
      const el = createElement("view");
      const t = createTextNode("hello");
      insertNode(el, t);
      return el;
    }, root);

    expect(host.of("createNode").map((c) => c[1])).toEqual([
      NODE_TYPE.view,
      NODE_TYPE.text,
    ]);
    expect(host.of("setText")).toEqual([["setText", 3, "hello"]]);
    // text into view (anchor 0 append), then view into root
    expect(host.of("insertBefore")).toEqual([
      ["insertBefore", 2, 3, 0],
      ["insertBefore", ROOT_ID, 2, 0],
    ]);
    expect(childIds(root)).toEqual([2]);
    dispose();
  });

  test("unknown tag throws", () => {
    expect(() => createElement("div")).toThrow(/unknown element/);
  });
});

describe("<For> reorder — DOM move semantics [R]", () => {
  test("reorder moves nodes without duplicates and without destroys", () => {
    const [items, setItems] = createSignal(["a", "b", "c"]);
    const byLabel = new Map<string, NodeMirror>();

    const dispose = render(
      () =>
        comp(For, {
          get each() {
            return items();
          },
          children: (item: string) => {
            const el = createElement("view");
            byLabel.set(item, el);
            return el;
          },
        }),
      root,
    );

    const [a, b, c] = [byLabel.get("a")!, byLabel.get("b")!, byLabel.get("c")!];
    expect(childIds(root)).toEqual([a.id, b.id, c.id]);
    host.clear();

    setItems(["c", "a", "b"]);

    // mirror order matches, no duplicate children
    expect(childIds(root)).toEqual([c.id, a.id, b.id]);
    expect(new Set(childIds(root)).size).toBe(3);
    // pure move: no node creation/destruction/removal, only insertBefore
    expect(host.of("createNode")).toEqual([]);
    expect(host.of("destroyNode")).toEqual([]);
    // every insertBefore targeted the root with an existing child (a move)
    for (const call of host.of("insertBefore")) {
      expect(call[1]).toBe(ROOT_ID);
      expect([a.id, b.id, c.id]).toContain(call[2] as number);
    }
    // sweep at frame end: nothing was left detached, so nothing is destroyed
    runSweep();
    expect(host.of("destroyNode")).toEqual([]);

    dispose();
  });

  test("row removal detaches, then the frame-end sweep destroys", () => {
    const [items, setItems] = createSignal(["a", "b"]);
    const byLabel = new Map<string, NodeMirror>();

    const dispose = render(
      () =>
        comp(For, {
          get each() {
            return items();
          },
          children: (item: string) => {
            const el = createElement("view");
            byLabel.set(item, el);
            return el;
          },
        }),
      root,
    );
    const b = byLabel.get("b")!;
    host.clear();

    setItems(["a"]);
    // detached but NOT yet destroyed (Solid may re-insert within the frame)
    expect(host.of("removeChild")).toEqual([["removeChild", ROOT_ID, b.id]]);
    expect(host.of("destroyNode")).toEqual([]);
    expect(childIds(root)).toEqual([byLabel.get("a")!.id]);

    runSweep(); // frame end
    expect(host.of("destroyNode")).toEqual([["destroyNode", b.id]]);

    dispose();
  });

  test("retain() exempts a removed subtree from the sweep; release() re-arms it", () => {
    const [items, setItems] = createSignal(["a", "b"]);
    const byLabel = new Map<string, NodeMirror>();
    const dispose = render(
      () =>
        comp(For, {
          get each() {
            return items();
          },
          children: (item: string) => {
            const el = createElement("view");
            byLabel.set(item, el);
            return el;
          },
        }),
      root,
    );
    const b = byLabel.get("b")!;
    retain(b);
    host.clear();

    setItems(["a"]);
    runSweep();
    expect(host.of("destroyNode")).toEqual([]); // retained: survives detached

    release(b);
    runSweep();
    expect(host.of("destroyNode")).toEqual([["destroyNode", b.id]]);

    dispose();
  });
});

describe("<Show> toggle", () => {
  test("toggle removes then sweep destroys; re-show creates fresh nodes", () => {
    const [show, setShow] = createSignal(true);
    let shown: NodeMirror | null = null;

    const dispose = render(
      () =>
        comp(Show, {
          get when() {
            return show();
          },
          get children() {
            const el = createElement("view");
            shown = el;
            return el;
          },
        }),
      root,
    );

    const first = shown! as NodeMirror;
    expect(childIds(root)).toEqual([first.id]);
    host.clear();

    setShow(false);
    expect(host.of("removeChild").length).toBe(1);
    expect(childIds(root)).toEqual([]);
    runSweep();
    expect(host.of("destroyNode")).toEqual([["destroyNode", first.id]]);
    host.clear();

    setShow(true);
    const second = shown! as NodeMirror;
    expect(second.id).not.toBe(first.id); // fresh native node
    expect(childIds(root)).toEqual([second.id]);
    runSweep();
    expect(host.of("destroyNode")).toEqual([]);

    dispose();
  });

  test("remove-then-reinsert within one frame is NOT destroyed by the sweep", () => {
    // Simulates a move that Solid expresses as remove + insert before the
    // frame ends: the sweep must leave the re-attached node alone.
    const dispose = render(() => {
      const el = createElement("view");
      return el;
    }, root);
    const el = root.children[0];
    host.clear();

    // hand-drive the reconciler ops the way cleanChildren/reconcile would
    // (removeNode is not exported — go through Solid: insert an array where
    // the node moves behind a new sibling)
    const other = createElement("view");
    insertNode(root, other);
    // move el after other: remove + reinsert with no anchor
    // (renderer semantics: insertNode on an attached node unlinks first)
    insertNode(root, el);
    expect(childIds(root)).toEqual([other.id, el.id]);
    runSweep();
    expect(host.of("destroyNode")).toEqual([]);
    expect(host.alive.has(el.id)).toBe(true);

    dispose();
  });
});

describe("mixed text — 'Count: {n()} items'", () => {
  test("dynamic segment updates via replaceText on the SAME text node", () => {
    const [n, setN] = createSignal(1);

    // babel-universal output shape for <text>Count: {n()} items</text>:
    //   const el = createElement("text");
    //   insert(el, () => `Count: ${n()} items`);   // single template child
    // …and for multi-part children it inserts static text nodes + a dynamic
    // insert with a marker. Exercise the multi-part form (the harder one).
    const dispose = render(() => {
      const el = createElement("text");
      const head = createTextNode("Count: ");
      insertNode(el, head);
      const tail = createTextNode(" items");
      insertNode(el, tail);
      insert(el, () => String(n()), tail); // dynamic, anchored before tail
      return el;
    }, root);

    // creates: the <text> ELEMENT + 3 text nodes ('Count: ', ' items', '1')
    const textCreates = host
      .of("createNode")
      .filter((c) => c[1] === NODE_TYPE.text);
    expect(textCreates.length).toBe(4);
    const dynSet = host.of("setText").find((c) => c[2] === "1")!;
    expect(dynSet).toBeDefined();
    const dynId = dynSet[1] as number;

    // mirror: text element children are [head, dyn, tail]
    const textEl = root.children[0];
    expect(textEl.children.length).toBe(3);
    expect(textEl.children[1].id).toBe(dynId);
    host.clear();

    setN(42);
    // updates replace text in place — no new nodes, no re-insert
    expect(host.of("replaceText")).toEqual([["replaceText", dynId, "42"]]);
    expect(host.of("createNode")).toEqual([]);
    expect(host.of("insertBefore")).toEqual([]);
    expect(textEl.children[1].text).toBe("42");

    dispose();
  });
});

describe("setProperty dispatch table [R]", () => {
  test("signal-driven class swap emits setStyle per change", () => {
    registerStyles({ "bg-red p-2": 7, "bg-blue p-2": 8 });
    const [hot, setHot] = createSignal(false);

    const dispose = render(() => {
      const el = createElement("view");
      effect<string | undefined>((prev) =>
        setProp(el, "class", hot() ? "bg-blue p-2" : "bg-red p-2", prev),
      );
      return el;
    }, root);

    const el = root.children[0];
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, 7]]);
    host.clear();

    setHot(true);
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, 8]]);
    host.clear();

    setHot(false);
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, 7]]);

    dispose();
  });

  test("token-sorted alias: 'p-2 bg-red' resolves the 'bg-red p-2' style", () => {
    registerStyles({ "bg-red p-2": 7 });
    const el = createElement("view");
    setProp(el, "class", "p-2  bg-red", undefined); // extra spaces + reorder
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, 7]]);
  });

  test("order-sensitive alias collision is poisoned, not resolved arbitrarily", () => {
    // "m-1 px-4 p-2" and "p-2 px-4 m-1" share a token multiset but compile to
    // DIFFERENT records (dedupe is last-wins). A third ordering must MISS
    // (strict throw) rather than silently pick whichever registered later.
    registerStyles({ "m-1 px-4 p-2": 1, "p-2 px-4 m-1": 2 });
    expect(resolveStyle("m-1 px-4 p-2")).toBe(1); // verbatim always wins
    expect(resolveStyle("p-2 px-4 m-1")).toBe(2);
    expect(resolveStyle("px-4 m-1 p-2")).toBeUndefined();
    const el = createElement("view");
    expect(() => setProp(el, "class", "px-4 m-1 p-2", undefined)).toThrow(/unknown class/);
    // Commutative anagrams (same record => same id) keep aliasing.
    registerStyles({ "bg-red p-2": 7, "p-2 bg-red": 7 });
    expect(resolveStyle("p-2 bg-red")).toBe(7);
  });

  test("unknown class throws on a strict host, counts on native hosts", () => {
    const el = createElement("view");
    expect(() => setProp(el, "class", "not-compiled", undefined)).toThrow(
      /unknown class/,
    );

    const native = makeMockHost(false);
    native.kind = "native";
    native.target = "psp";
    installHost(native);
    const before = missCounters.unknownClass;
    const el2 = createElement("view");
    setProp(el2, "class", "not-compiled", undefined); // silent
    expect(missCounters.unknownClass).toBe(before + 1);
    expect(native.of("setStyle")).toEqual([]);
  });

  test("null class clears back to the default style", () => {
    const el = createElement("view");
    setProp(el, "class", null, "bg-red p-2");
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, STYLE_ID_NONE]]);
  });

  test("style object diffs per key and encodes per VALUE_KIND", () => {
    const el = createElement("view");
    setProp(el, "style", { width: 120, bgColor: "#ff0000" }, undefined);
    expect(host.of("setProp")).toEqual([
      ["setProp", el.id, PROP.width, 120],
      ["setProp", el.id, PROP.bgColor, 0xff0000ff], // ABGR: opaque red
    ]);
    host.clear();

    // prev-diff: only the changed key crosses the FFI
    setProp(
      el,
      "style",
      { width: 120, bgColor: "#00ff00" },
      { width: 120, bgColor: "#ff0000" },
    );
    expect(host.of("setProp")).toEqual([
      ["setProp", el.id, PROP.bgColor, 0xff00ff00],
    ]);
  });

  test("unknown style key throws", () => {
    const el = createElement("view");
    expect(() => setProp(el, "style", { widht: 1 }, undefined)).toThrow(
      /unknown style prop/,
    );
  });

  test("src looks up the texture registry", () => {
    registerTexture("logo.png", 77);
    const el = createElement("image");
    setProp(el, "src", "logo.png", undefined);
    expect(host.of("setImage")).toEqual([["setImage", el.id, 77]]);
    expect(() => setProp(el, "src", "nope.png", "logo.png")).toThrow(
      /unknown image src/,
    );
  });

  test("clearing src sends setImage(-1) — 0 is a real (first) texture handle", () => {
    registerTexture("logo.png", 0); // first upload => handle 0
    const el = createElement("image");
    setProp(el, "src", "logo.png", undefined);
    expect(host.of("setImage")).toEqual([["setImage", el.id, 0]]);
    host.clear();
    setProp(el, "src", "", "logo.png");
    expect(host.of("setImage")).toEqual([["setImage", el.id, -1]]);
    host.clear();
    setProp(el, "src", null, "");
    expect(host.of("setImage")).toEqual([["setImage", el.id, -1]]);
  });

  test("classList / bool: / prop: / unknown props are loud errors", () => {
    const el = createElement("view");
    expect(() => setProp(el, "classList", { a: true }, undefined)).toThrow(
      /classList/,
    );
    expect(() => setProp(el, "bool:x", true, undefined)).toThrow(/bool:x/);
    expect(() => setProp(el, "prop:x", 1, undefined)).toThrow(/prop:x/);
    expect(() => setProp(el, "onClick", () => {}, undefined)).toThrow(
      /unknown property 'onClick'/,
    );
  });
});

describe("focus + onPress (input.ts)", () => {
  test("d-pad traversal in document order, CIRCLE fires focused handler", () => {
    setInputRoot(root);
    let pressedA = 0;
    let pressedB = 0;

    const dispose = render(() => {
      const list = createElement("view");
      const a = createElement("view");
      setProp(a, "focusable", true, undefined);
      setProp(a, "onPress", () => pressedA++, undefined);
      insertNode(list, a);
      const b = createElement("view");
      setProp(b, "focusable", true, undefined);
      setProp(b, "onPress", () => pressedB++, undefined);
      insertNode(list, b);
      return list;
    }, root);

    handleFrame(BTN.DOWN); // focus first
    const a = root.children[0].children[0];
    const b = root.children[0].children[1];
    expect(host.of("setFocus").at(-1)).toEqual(["setFocus", a.id]);

    handleFrame(0); // release
    handleFrame(BTN.DOWN); // next
    expect(host.of("setFocus").at(-1)).toEqual(["setFocus", b.id]);

    handleFrame(BTN.DOWN); // held: edge-detected, no repeat
    const focusCalls = host.of("setFocus").length;
    handleFrame(BTN.DOWN);
    expect(host.of("setFocus").length).toBe(focusCalls);

    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    expect(pressedB).toBe(1);
    expect(pressedA).toBe(0);

    handleFrame(0);
    handleFrame(BTN.UP); // back to a
    expect(getFocused()).toBe(a);
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    expect(pressedA).toBe(1);

    dispose();
  });

  test("CIRCLE hold applies active: on the focused node, release clears", () => {
    setInputRoot(root);
    const dispose = render(() => {
      const list = createElement("view");
      const a = createElement("view");
      setProp(a, "focusable", true, undefined);
      insertNode(list, a);
      const b = createElement("view");
      setProp(b, "focusable", true, undefined);
      insertNode(list, b);
      return list;
    }, root);

    const a = root.children[0].children[0];
    const b = root.children[0].children[1];

    handleFrame(BTN.DOWN); // focus a
    handleFrame(BTN.DOWN | BTN.CIRCLE); // press while holding DOWN's frame
    expect(host.of("setActive").at(-1)).toEqual(["setActive", a.id, 1]);

    handleFrame(BTN.CIRCLE); // still held: no repeat
    const activeCalls = host.of("setActive").length;
    handleFrame(BTN.CIRCLE);
    expect(host.of("setActive").length).toBe(activeCalls);

    handleFrame(0); // release
    expect(host.of("setActive").at(-1)).toEqual(["setActive", a.id, 0]);

    // d-pad move WHILE held: active follows off the old node (clears), the
    // newly focused node is not pressed (press is an edge, not a state).
    handleFrame(BTN.CIRCLE); // press on a again
    expect(host.of("setActive").at(-1)).toEqual(["setActive", a.id, 1]);
    handleFrame(BTN.CIRCLE | BTN.DOWN); // move to b with CIRCLE still down
    expect(getFocused()).toBe(b);
    expect(host.of("setActive").at(-1)).toEqual(["setActive", a.id, 0]);

    // CIRCLE with nothing focused: no active call.
    handleFrame(0);
    setInputRoot(root);
    const before = host.of("setActive").length;
    handleFrame(BTN.CIRCLE);
    expect(host.of("setActive").length).toBe(before);

    dispose();
  });

  test("focus repair on removal: next sibling, else prev, else ancestor [R]", () => {
    setInputRoot(root);
    const [items, setItems] = createSignal(["a", "b", "c"]);
    const byLabel = new Map<string, NodeMirror>();

    const dispose = render(
      () =>
        comp(For, {
          get each() {
            return items();
          },
          children: (item: string) => {
            const el = createElement("view");
            setProp(el, "focusable", true, undefined);
            byLabel.set(item, el);
            return el;
          },
        }),
      root,
    );

    handleFrame(BTN.DOWN);
    handleFrame(0);
    handleFrame(BTN.DOWN); // focus 'b'
    expect(getFocused()).toBe(byLabel.get("b")!);

    setItems(["a", "c"]); // remove focused 'b' → next sibling 'c'
    expect(getFocused()).toBe(byLabel.get("c")!);

    setItems(["a"]); // remove focused 'c' → no next → prev sibling 'a'
    expect(getFocused()).toBe(byLabel.get("a")!);

    setItems([]); // remove focused 'a' → nothing focusable left
    expect(getFocused()).toBe(null);
    expect(host.of("setFocus").at(-1)).toEqual(["setFocus", 0]);

    dispose();
  });

  test("focus scope traps traversal/press and restores previous focus", () => {
    setInputRoot(root);
    let backgroundPresses = 0;
    let modalPresses = 0;
    let background!: NodeMirror;
    let modalRoot!: NodeMirror;
    let modalItem!: NodeMirror;

    const dispose = render(() => {
      const page = createElement("view");
      background = createElement("view");
      setProp(background, "focusable", true, undefined);
      setProp(background, "onPress", () => backgroundPresses++, undefined);
      insertNode(page, background);

      modalRoot = createElement("view");
      modalItem = createElement("view");
      setProp(modalItem, "focusable", true, undefined);
      setProp(modalItem, "onPress", () => modalPresses++, undefined);
      insertNode(modalRoot, modalItem);
      insertNode(page, modalRoot);
      return page;
    }, root);

    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(background);

    const releaseScope = pushFocusScope(modalRoot);
    expect(getFocused()).toBe(modalItem);

    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    expect(modalPresses).toBe(1);
    expect(backgroundPresses).toBe(0);

    handleFrame(0);
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(modalItem);

    releaseScope();
    expect(getFocused()).toBe(background);
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    expect(backgroundPresses).toBe(1);

    dispose();
  });

  test("focus grid maps d-pad directions by row and column", () => {
    setInputRoot(root);
    const grid = createElement("view");
    const cells = ["a", "b", "c", "d", "e"].map(() => {
      const cell = createElement("view");
      setProp(cell, "focusable", true, undefined);
      insertNode(grid, cell);
      return cell;
    });
    insertNode(root, grid);
    const releaseGrid = pushFocusGrid(grid, { columns: 2 });

    focusNode(cells[0]);
    handleFrame(BTN.RIGHT);
    expect(getFocused()).toBe(cells[1]);
    handleFrame(0);
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(cells[3]);
    handleFrame(0);
    handleFrame(BTN.LEFT);
    expect(getFocused()).toBe(cells[2]);
    handleFrame(0);
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(cells[4]);
    handleFrame(0);
    handleFrame(BTN.RIGHT);
    expect(getFocused()).toBe(cells[4]);

    releaseGrid();
  });
});

describe("host detection (host.ts)", () => {
  test("resolved build contract rejects the wrong native target or ABI", () => {
    const ops = makeMockHost().ops;
    ops.__host = "vita";
    ops.__hostAbi = 1;

    expect(() =>
      assertNativeHostContract(ops, {
        target: "vita",
        hostAbi: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertNativeHostContract(ops, {
        target: "psp",
        hostAbi: 1,
      }),
    ).toThrow(/target mismatch/);
    expect(() =>
      assertNativeHostContract(ops, {
        target: "vita",
        hostAbi: 2,
      }),
    ).toThrow(/ABI mismatch/);
  });

  test("native namespace passed explicitly stays native / non-strict", () => {
    // Demo entries pass globalThis.ui to render(); object identity must keep
    // the namespace native instead of turning it into an
    // injected/strict host (crash-on-miss on hardware + double asset feed).
    const psp = makeMockHost();
    psp.ops.__host = "psp";
    (psp.ops as HostOps & { __textures?: Record<string, number> }).__textures = {
      "logo.png": 0,
    };
    const g = globalThis as { ui?: HostOps };
    g.ui = psp.ops;
    try {
      const detected = detectHost(psp.ops);
      expect(detected.kind).toBe("native");
      expect(detected.target).toBe("psp");
      expect(detected.strict).toBe(false);
      // render() then takes the PSP branch: native handles bound, NO
      // loadStyles/loadFontAtlas re-feed through the FFI.
      const dispose = publicRender(() => createElement("view"), {
        ops: psp.ops,
        styles: { "p-2": 0 },
      });
      expect(psp.of("loadStyles", "loadFontAtlas", "uploadTexture")).toEqual([]);
      dispose();
    } finally {
      delete g.ui;
    }
  });

  test("a real injected host stays strict even when globalThis.ui exists", () => {
    const psp = makeMockHost();
    (psp.ops as HostOps & { __textures?: unknown }).__textures = {};
    const g = globalThis as { ui?: HostOps };
    g.ui = psp.ops;
    try {
      const injected = makeMockHost();
      const detected = detectHost(injected.ops); // different ops object
      expect(detected.kind).toBe("injected");
      expect(detected.strict).toBe(true);
    } finally {
      delete g.ui;
    }
  });

  test("a global web/wasm namespace without native identity stays injected", () => {
    const wasm = makeMockHost();
    const g = globalThis as { ui?: HostOps };
    g.ui = wasm.ops;
    try {
      const detected = detectHost(wasm.ops);
      expect(detected.kind).toBe("injected");
      expect(detected.target).toBe("injected");
      expect(detected.strict).toBe(true);
    } finally {
      delete g.ui;
    }
  });

  test("injected ops stay strict (web/wasm/test hosts)", () => {
    const injected = makeMockHost();
    const detected = detectHost(injected.ops);
    expect(detected.kind).toBe("injected");
    expect(detected.strict).toBe(true);
  });
});

describe("parseHexColor (host.ts)", () => {
  test("valid forms produce ABGR", () => {
    expect(parseHexColor("#ff0000")).toBe(0xff0000ff);
    expect(parseHexColor("#f00")).toBe(0xff0000ff);
    expect(parseHexColor("#00ff0080")).toBe(0x8000ff00);
  });
  test("garbage hex throws instead of parsing a prefix", () => {
    expect(() => parseHexColor("#ff00zz")).toThrow(/bad color/); // pre-fix: 0xff00 prefix
    expect(() => parseHexColor("#1x2y3z")).toThrow(/bad color/);
    expect(() => parseHexColor("#0x1234")).toThrow(/bad color/);
    expect(() => parseHexColor("#12345")).toThrow(/bad color/);
  });
});

describe("public render() (index.ts)", () => {
  test("mounts into the shared root, installs frame(), dispose destroys", () => {
    // index.render always uses the renderer's shared rootMirror (native id 1)
    const dispose = publicRender(
      () => {
        const el = createElement("view");
        insertNode(el, createTextNode("bye"));
        return el;
      },
      { ops: host.ops, styles: { "p-2": 0 } },
    );

    expect(rootMirror.children.length).toBe(2);
    const appLayer = rootMirror.children[0];
    const overlayLayer = rootMirror.children[1];
    const el = appLayer.children[0];
    expect(overlayLayer.children.length).toBe(0);
    expect(typeof (globalThis as { frame?: unknown }).frame).toBe("function");
    host.clear();

    dispose();
    expect(rootMirror.children.length).toBe(0);
    // layer roots are destroyed once each (native destroy recurses).
    expect(host.of("destroyNode").map((c) => c[1])).toEqual([appLayer.id, overlayLayer.id]);
  });

  test("Portal mounts overlay content outside the app layer", () => {
    const dispose = publicRender(
      () =>
        View({
          children: [
            Text({ children: "app" }),
            Portal({ children: () => Text({ children: "overlay" }) }),
          ],
        }),
      { ops: host.ops },
    );

    const [appLayer, overlayLayer] = rootMirror.children;
    expect(appLayer.children.length).toBe(1);
    expect(overlayLayer.children.length).toBe(1);
    expect(appLayer.children[0].children.length).toBe(1);
    expect(overlayLayer.children[0].children.length).toBe(1);

    dispose();
  });

  test("ActionBar uses the overlay layer instead of app layout", () => {
    const dispose = publicRender(
      () =>
        View({
          children: [
            View({ class: "w-full h-full" }),
            ActionBar({ children: Text({ children: "SELECT" }) }),
          ],
        }),
      {
        ops: host.ops,
        styles: {
          "w-full h-full": 1,
          "absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200": 2,
        },
      },
    );

    const [appLayer, overlayLayer] = rootMirror.children;
    expect(appLayer.children[0].children.length).toBe(1);
    expect(overlayLayer.children.length).toBe(1);

    dispose();
  });

  test("Modal stays mounted while open state toggles overlay props without animation", () => {
    const [open, setOpen] = createSignal(true);
    const dispose = publicRender(
      () =>
        View({
          children: Modal({
            open,
            class: "modal-frame",
            panelClass: "modal-panel",
            children: Text({ children: "dialog" }),
          }),
        }),
      {
        ops: host.ops,
        styles: {
          "modal-frame": 1,
          "modal-panel": 2,
          "absolute inset-0 bg-slate-950": 3,
        },
      },
    );

    const overlayLayer = rootMirror.children[1];
    expect(overlayLayer.children.length).toBe(1);
    const portalHost = overlayLayer.children[0];
    const modalFrame = portalHost.children[0];
    const [backdrop, panel] = modalFrame.children;
    host.clear();

    setOpen(false);
    expect(overlayLayer.children).toEqual([portalHost]);
    expect(portalHost.children).toEqual([modalFrame]);
    expect(modalFrame.children).toEqual([backdrop, panel]);
    expect(host.of("removeChild")).toEqual([]);
    expect(host.of("destroyNode")).toEqual([]);
    expect(host.of("animate")).toEqual([]);
    expect(host.of("setProp").map((call) => [call[1], call[2], call[3]])).toEqual(
      expect.arrayContaining([
        [backdrop.id, PROP.opacity, 0],
        [panel.id, PROP.opacity, 0],
        [panel.id, PROP.translateY, 0],
        [panel.id, PROP.scale, 1],
      ]),
    );

    host.clear();
    setOpen(true);
    expect(overlayLayer.children).toEqual([portalHost]);
    expect(host.of("removeChild")).toEqual([]);
    expect(host.of("destroyNode")).toEqual([]);
    expect(host.of("animate")).toEqual([]);
    expect(host.of("setProp").map((call) => [call[1], call[2], call[3]])).toEqual(
      expect.arrayContaining([
        [backdrop.id, PROP.opacity, 0.62],
        [panel.id, PROP.opacity, 1],
        [panel.id, PROP.translateY, 0],
        [panel.id, PROP.scale, 1],
      ]),
    );

    dispose();
  });

  test("closed modal content is excluded from default app focus traversal", () => {
    let background!: NodeMirror;
    let hiddenModalItem!: NodeMirror;

    const dispose = publicRender(
      () =>
        View({
          children: [
            View({ ref: (node) => (background = node), focusable: true }),
            Modal({
              open: false,
              class: "modal-frame",
              panelClass: "modal-panel",
              children: View({ ref: (node) => (hiddenModalItem = node), focusable: true }),
            }),
          ],
        }),
      {
        ops: host.ops,
        styles: {
          "modal-frame": 1,
          "modal-panel": 2,
          "absolute inset-0 bg-slate-950": 3,
        },
      },
    );

    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(background);
    handleFrame(0);
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(background);
    expect(getFocused()).not.toBe(hiddenModalItem);

    dispose();
  });

  test("FocusGrid component registers row and column traversal", () => {
    let first!: NodeMirror;
    let second!: NodeMirror;
    let third!: NodeMirror;

    const dispose = publicRender(
      () =>
        FocusGrid({
          columns: 2,
          children: [
            View({ ref: (node) => (first = node), focusable: true }),
            View({ ref: (node) => (second = node), focusable: true }),
            View({ ref: (node) => (third = node), focusable: true }),
          ],
        }),
      { ops: host.ops },
    );

    focusNode(first);
    handleFrame(BTN.RIGHT);
    expect(getFocused()).toBe(second);
    handleFrame(0);
    handleFrame(BTN.LEFT);
    expect(getFocused()).toBe(first);
    handleFrame(0);
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(third);

    dispose();
  });

  test("mount() hides host, pak image, and frame boilerplate", () => {
    const g = globalThis as { ui?: HostOps; __pak?: ArrayBuffer; frame?: (buttons: number) => void };
    g.ui = host.ops;
    const image = encodeImageEntry(
      { width: 1, height: 1, rgba: new Uint8Array([10, 20, 30, 255]) },
      PSM.PSM_8888,
    );
    const pak = pack([{ key: "ui:img.logo.png", dtype: PAK_DTYPE.u8, data: image }]);
    g.__pak = pak.buffer.slice(pak.byteOffset, pak.byteOffset + pak.byteLength) as ArrayBuffer;

    const before: number[] = [];
    const dispose = publicMount(
      () => {
        onFrame((buttons) => before.push(buttons));
        const img = createElement("image");
        setProp(img, "src", "logo.png", undefined);
        return img;
      },
    );

    expect(host.of("uploadTexture")).toEqual([["uploadTexture"]]);
    expect(host.of("setImage").length).toBe(1);
    expect(typeof g.frame).toBe("function");
    g.frame?.(BTN.CIRCLE);
    expect(before).toEqual([BTN.CIRCLE]);

    dispose();
  });

  test("button handler blocks suppress background actions but not frame ticks", () => {
    const g = globalThis as { ui?: HostOps; frame?: (buttons: number) => void };
    g.ui = host.ops;
    let frames = 0;
    let backgroundPresses = 0;
    let systemPresses = 0;

    const dispose = publicMount(
      () => {
        onFrame(() => frames++);
        onButtonPress(BTN.SELECT, () => backgroundPresses++);
        onButtonPress(BTN.SELECT, () => systemPresses++, { allowWhenBlocked: true });
        return createElement("view");
      },
    );
    const unblock = pushButtonHandlerBlock();

    g.frame?.(BTN.SELECT);
    expect(frames).toBe(1);
    expect(backgroundPresses).toBe(0);
    expect(systemPresses).toBe(1);

    g.frame?.(0);
    unblock();
    g.frame?.(BTN.SELECT);
    expect(frames).toBe(3);
    expect(backgroundPresses).toBe(1);
    expect(systemPresses).toBe(2);

    dispose();
  });

  test("ActionHandler active=false tracks held buttons without firing later", () => {
    const g = globalThis as { ui?: HostOps; frame?: (buttons: number) => void };
    const [enabled, setEnabled] = createSignal(false);
    g.ui = host.ops;
    let presses = 0;

    const dispose = publicMount(
      () =>
        View({
          children: ActionHandler({
            button: BTN.SELECT,
            active: enabled,
            onPress: () => presses++,
          }),
        }),
    );

    g.frame?.(BTN.SELECT);
    expect(presses).toBe(0);

    setEnabled(true);
    g.frame?.(BTN.SELECT);
    expect(presses).toBe(0);

    g.frame?.(0);
    g.frame?.(BTN.SELECT);
    expect(presses).toBe(1);

    dispose();
  });
});
