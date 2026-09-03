// Svelte renderer contract tests — drive framework/src/renderer-svelte.ts
// against a MOCK HostOps that records every op call, using the real Svelte
// custom-renderer runtime under Bun.
//
// Run: bun test --conditions=browser,custom-renderer,production tests/renderer-svelte.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NODE_TYPE, ROOT_ID } from "../contracts/spec/spec.ts";
import { installHost, type HostOps } from "../framework/src/host.ts";
import { resetInput } from "../framework/src/input.ts";
import { resetPack } from "../framework/src/pak.ts";
import { registerStyles, resetStyles, resolveStyle } from "../framework/src/styles.ts";
import {
  flushSync,
  render,
  resetRendererState,
  resetTextures,
  rootMirror,
  runSweep,
  setStyleResolver,
  type NodeMirror,
} from "../framework/src/renderer-svelte.ts";
import { installSvelteLoader } from "./svelte-test-runtime.ts";

// Fail fast with a real message if the server build got resolved: mount() does
// not exist there, and svelte/renderer throws on import.
if (!("mount" in (await import("svelte")))) {
  throw new Error(
    "svelte resolved to its server build — mount() is missing. " +
      "Run: bun test --conditions=browser,custom-renderer,production",
  );
}

installSvelteLoader();

const { state } = await import("./fixtures/svelte/store.svelte.ts");
const Basic = (await import("./fixtures/svelte/Basic.svelte")).default;

type Call = [string, ...unknown[]];

interface MockHost {
  ops: HostOps;
  kind: "injected";
  target: string;
  strict: boolean;
  calls: Call[];
  alive: Set<number>;
  of(...names: string[]): Call[];
  clear(): void;
}

function makeMockHost(): MockHost {
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
    uploadTexture: () => 900,
    setImage: rec("setImage"),
    setSprite: rec("setSprite"),
    animate: () => 1,
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
    strict: false,
    calls,
    alive,
    of(...names) {
      return calls.filter((call) => names.includes(call[0] as string));
    },
    clear() {
      calls.length = 0;
    },
  };
}

let host: MockHost;
let root: NodeMirror;
let dispose: () => void;
let disposed = false;

function teardown(): void {
  if (disposed) return;
  disposed = true;
  dispose();
}

/** Text runs the native tree is actually carrying, in tree order. */
function texts(node: NodeMirror = root): string[] {
  const out: string[] = [];
  const walk = (n: NodeMirror): void => {
    if (n.type === NODE_TYPE.text && n.text) out.push(n.text);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}

function find(predicate: (node: NodeMirror) => boolean): NodeMirror | undefined {
  const walk = (n: NodeMirror): NodeMirror | undefined => {
    if (predicate(n)) return n;
    for (const child of n.children) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(root);
}

beforeEach(() => {
  host = makeMockHost();
  installHost(host);
  resetRendererState();
  resetStyles();
  resetTextures();
  resetPack();
  resetInput();
  setStyleResolver(resolveStyle);
  // The fixture's one class literal, as the Tailwind pass would have compiled it.
  registerStyles({ "p-2 flex-col": 7 });
  state.label = "hi";
  state.on = false;
  state.items = [
    { id: "a", n: "A" },
    { id: "b", n: "B" },
    { id: "c", n: "C" },
  ];
  state.presses = 0;
  root = { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] };
  disposed = false;
  dispose = render(Basic, root);
});

// The fixture's state is one module instance shared by every mount, so a
// surviving component from an earlier test would answer the next test's writes.
afterEach(() => {
  teardown();
  runSweep();
});

describe("mount", () => {
  test("projects the component onto native nodes", () => {
    expect(texts()).toEqual(["hi", "A", "B", "C", "press"]);
    expect(host.of("createNode").length).toBeGreaterThan(0);
  });

  test("comment anchors are empty native text, so they take no layout slot", () => {
    // {#if} and {#each} each contribute one anchor, plus render()'s own.
    const anchors: NodeMirror[] = [];
    const walk = (n: NodeMirror): void => {
      if (n.domNodeType === 8) anchors.push(n);
      for (const child of n.children) walk(child);
    };
    walk(root);
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    for (const anchor of anchors) expect(anchor.text).toBe("");
  });

  test("a class attribute resolves through the style table", () => {
    expect(host.of("setStyle").length).toBeGreaterThan(0);
  });
});

describe("updates", () => {
  test("text edits replace in place rather than rebuilding the node", () => {
    const before = host.of("createNode").length;
    host.clear();

    state.label = "bye";
    flushSync();

    expect(texts()[0]).toBe("bye");
    expect(host.of("replaceText")).toHaveLength(1);
    expect(host.of("createNode")).toHaveLength(0);
    expect(before).toBeGreaterThan(0);
  });

  test("an {#if} builds on entry and the sweep destroys it on exit", () => {
    state.on = true;
    flushSync();
    expect(texts()).toContain("shown");

    host.clear();
    state.on = false;
    flushSync();
    // Removal detaches; nothing is destroyed until the frame's sweep runs.
    expect(host.of("destroyNode")).toHaveLength(0);
    expect(host.of("removeChild").length).toBeGreaterThan(0);

    runSweep();
    expect(host.of("destroyNode").length).toBeGreaterThan(0);
    expect(texts()).not.toContain("shown");
  });

  test("a keyed {#each} reorders by moving nodes, never destroying them", () => {
    host.clear();
    state.items = [
      { id: "c", n: "C" },
      { id: "a", n: "A" },
      { id: "b", n: "B" },
    ];
    flushSync();
    runSweep();

    expect(texts()).toEqual(["hi", "C", "A", "B", "press"]);
    expect(host.of("createNode")).toHaveLength(0);
    expect(host.of("destroyNode")).toHaveLength(0);
    expect(host.of("insertBefore").length).toBeGreaterThan(0);
  });
});

describe("events", () => {
  test("onpress reaches the node as the native press handler", () => {
    const button = find((node) => typeof node.onPress === "function");
    expect(button).toBeDefined();

    button!.onPress!();
    flushSync();

    expect(state.presses).toBe(1);
  });

  test("only the element that declared a handler carries one", () => {
    const handlers: NodeMirror[] = [];
    const walk = (n: NodeMirror): void => {
      if (n.onPress) handlers.push(n);
      for (const child of n.children) walk(child);
    };
    walk(root);
    // A press wrapper on every view would swallow the CIRCLE bubble that
    // input.ts walks to the nearest ancestor with a handler.
    expect(handlers).toHaveLength(1);
  });
});

describe("teardown", () => {
  test("unmount leaves nothing behind once the sweep runs", () => {
    teardown();
    runSweep();

    expect(root.children).toHaveLength(0);
    expect(rootMirror.children).toHaveLength(0);
  });
});
