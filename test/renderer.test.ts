// Renderer contract tests for the React default renderer and shared native tree.

import { beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { detectHost, installHost, parseHexColor, type Host, type HostOps } from "../src/host.ts";
import { For, Modal, Portal, Text, View, defineComponent } from "../src/components.tsx";
import { createSignal } from "../src/reactivity.ts";
import { render as publicRender } from "../src/index.ts";
import {
  createElement,
  createTextNode,
  insertNode,
  missCounters,
  registerTexture,
  resetRendererState,
  resetTextures,
  rootMirror,
  runSweep,
  setProp,
  setStyleResolver,
  type NodeMirror,
} from "../src/renderer.ts";
import { resetInput } from "../src/input.ts";
import { resetFrameHooks } from "../src/frame.ts";
import { registerStyles, resetStyles, resolveStyle } from "../src/styles.ts";
import { resetPack } from "../src/dcpak.ts";
import { encodeImageEntry, pack } from "../compiler/dcpak.ts";
import { BTN, DCPAK_DTYPE, NODE_TYPE, PSM, ROOT_ID, STYLE_ID_NONE } from "../spec/spec.ts";

type Call = [string, ...unknown[]];

interface MockHost extends Host {
  calls: Call[];
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
    animate(...args: number[]) {
      calls.push(["animate", ...args]);
      return 1;
    },
    cancelAnim: rec("cancelAnim"),
    setFocus: rec("setFocus"),
    loadStyles: rec("loadStyles"),
    loadFontAtlas: rec("loadFontAtlas"),
    measureText: () => 0,
  };
  return {
    ops,
    kind: "injected",
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

function childIds(node: NodeMirror): number[] {
  return node.children.map((c) => c.id);
}

let host: MockHost;

beforeEach(() => {
  host = makeMockHost();
  installHost(host);
  resetRendererState();
  resetStyles();
  resetTextures();
  resetPack();
  resetInput();
  resetFrameHooks();
  setStyleResolver(resolveStyle);
  const g = globalThis as { ui?: HostOps; __dcpak?: ArrayBuffer; frame?: (buttons: number) => void };
  delete g.ui;
  delete g.__dcpak;
  delete g.frame;
});

describe("native tree", () => {
  test("static view with text child produces create/setText/insert ops", () => {
    const root: NodeMirror = { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] };
    const el = createElement("view");
    const text = createTextNode("hello");
    insertNode(el, text);
    insertNode(root, el);

    expect(host.of("createNode").map((c) => c[1])).toEqual([NODE_TYPE.view, NODE_TYPE.text]);
    expect(host.of("setText")).toEqual([["setText", 3, "hello"]]);
    expect(host.of("insertBefore")).toEqual([
      ["insertBefore", 2, 3, 0],
      ["insertBefore", ROOT_ID, 2, 0],
    ]);
    expect(childIds(root)).toEqual([2]);
  });

  test("moves attached nodes without duplicates and without sweep destruction", () => {
    const root: NodeMirror = { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] };
    const a = createElement("view");
    const b = createElement("view");
    insertNode(root, a);
    insertNode(root, b);
    insertNode(root, a);
    expect(childIds(root)).toEqual([b.id, a.id]);
    runSweep();
    expect(host.of("destroyNode")).toEqual([]);
  });

  test("setProperty dispatch handles class, src, and strict misses", () => {
    registerStyles({ "bg-red p-2": 7 });
    const el = createElement("image");
    setProp(el, "class", "p-2 bg-red", undefined);
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, 7]]);

    registerTexture("logo.png", 42);
    setProp(el, "src", "logo.png", undefined);
    expect(host.of("setImage")).toContainEqual(["setImage", el.id, 42]);

    expect(() => setProp(el, "class", "missing", undefined)).toThrow(/unknown class/);
    host = makeMockHost(false);
    installHost(host);
    setStyleResolver(resolveStyle);
    setProp(createElement("view"), "class", "missing", undefined);
    expect(missCounters.unknownClass).toBeGreaterThan(0);
  });
});

describe("public React render", () => {
  test("mounts and disposes an app layer plus overlay layer", () => {
    const dispose = publicRender(
      () => React.createElement(View, null, React.createElement(Text, null, "app")),
      { ops: host.ops },
    );

    const [appLayer, overlayLayer] = rootMirror.children;
    expect(appLayer.children.length).toBe(1);
    expect(overlayLayer.children.length).toBe(0);
    expect(host.of("setText").some((c) => c[2] === "app")).toBe(true);
    host.clear();

    dispose();
    expect(rootMirror.children.length).toBe(0);
    const destroyed = host.of("destroyNode").map((c) => c[1]);
    expect(destroyed).toContain(appLayer.id);
    expect(destroyed).toContain(overlayLayer.id);
  });

  test("signals rerender text and class bindings", async () => {
    registerStyles({ "bg-red p-2": 1, "bg-blue p-2": 2 });
    let setHot!: (v: boolean) => void;
    const App = defineComponent(function App() {
      const [hot, _setHot] = createSignal(false);
      setHot = _setHot;
      return React.createElement(
        View,
        { class: hot() ? "p-2 bg-blue" : "p-2 bg-red" },
        React.createElement(Text, null, hot() ? "hot" : "cold"),
      );
    });

    const dispose = publicRender(() => React.createElement(App), {
      ops: host.ops,
      styles: { "bg-red p-2": 1, "bg-blue p-2": 2 },
    });
    host.clear();
    setHot(true);
    await Bun.sleep(0);

    expect(host.of("setStyle").some((c) => c[2] === 2)).toBe(true);
    expect(host.of("replaceText", "setText").some((c) => c[2] === "hot")).toBe(true);
    dispose();
  });

  test("For removes rows and the frame-end sweep destroys detached nodes", async () => {
    let setItems!: (v: string[]) => void;
    const App = defineComponent(function App() {
      const [items, _setItems] = createSignal(["a", "b"]);
      setItems = _setItems;
      return React.createElement(
        For as React.ComponentType<any>,
        {
          each: items(),
          children: (item: string) => React.createElement(View, { key: item }),
        },
      );
    });

    const dispose = publicRender(() => React.createElement(App), { ops: host.ops });
    await Bun.sleep(0);
    const appRoot = rootMirror.children[0];
    expect(appRoot.children.length).toBe(2);
    const removed = appRoot.children[1];
    host.clear();

    setItems(["a"]);
    await Bun.sleep(0);
    expect(host.of("removeChild").some((c) => c[2] === removed.id)).toBe(true);
    runSweep();
    expect(host.of("destroyNode")).toContainEqual(["destroyNode", removed.id]);
    dispose();
  });

  test("Portal mounts outside the app layer", async () => {
    const dispose = publicRender(
      () =>
        React.createElement(
          View,
          null,
          React.createElement(Text, null, "app"),
          React.createElement(Portal, null, React.createElement(Text, null, "overlay")),
        ),
      { ops: host.ops },
    );
    await Bun.sleep(0);

    const [appLayer, overlayLayer] = rootMirror.children;
    expect(appLayer.children.length).toBe(1);
    expect(overlayLayer.children.length).toBe(1);
    expect(host.of("setText").some((c) => c[2] === "overlay")).toBe(true);
    dispose();
  });

  test("Modal blocks background button handlers while open", async () => {
    let backgroundPresses = 0;
    const dispose = publicRender(
      () =>
        React.createElement(
          View,
          null,
          React.createElement(View, { focusable: true, onPress: () => backgroundPresses++ }),
          React.createElement(
            Modal,
            { open: true },
            React.createElement(View, { focusable: true }, React.createElement(Text, null, "dialog")),
          ),
        ),
      {
        ops: host.ops,
        styles: {
          "absolute inset-0 z-50 flex-col items-center justify-center": 1,
          "absolute inset-0 bg-slate-950": 2,
          "flex-col gap-2 w-[328] p-3 rounded-xl shadow-lg bg-white border-slate-200": 3,
        },
      },
    );
    await Bun.sleep(0);

    (globalThis as { frame?: (buttons: number) => void }).frame?.(BTN.CIRCLE);
    expect(backgroundPresses).toBe(0);
    dispose();
  });
});

describe("host helpers", () => {
  test("PSP native namespace passed explicitly stays kind psp / non-strict", () => {
    const psp = makeMockHost();
    (psp.ops as HostOps & { __textures?: Record<string, number> }).__textures = {
      "logo.png": 12,
    };
    (globalThis as { ui?: HostOps }).ui = psp.ops;

    const detected = detectHost(psp.ops);
    expect(detected.kind).toBe("psp");
    expect(detected.strict).toBe(false);
  });

  test("parseHexColor valid and invalid forms", () => {
    expect(parseHexColor("#fff")).toBe(0xffffffff);
    expect(() => parseHexColor("#xyz")).toThrow(/bad color/);
  });

  test("mount loads dcpak assets through injected hosts", () => {
    const dcpak = pack([
      { key: "ui:styles", dtype: DCPAK_DTYPE.u8, data: new Uint8Array([1, 2, 3]) },
      {
        key: "ui:img.logo.png",
        dtype: DCPAK_DTYPE.u8,
        data: encodeImageEntry({ width: 1, height: 1, rgba: new Uint8Array([255, 255, 255, 255]) }, PSM.PSM_8888),
      },
    ]);

    const dispose = publicRender(() => React.createElement(View), {
      ops: host.ops,
      dcpak: new Uint8Array(dcpak).buffer,
    });
    expect(host.of("loadStyles")).toEqual([["loadStyles", new Uint8Array([1, 2, 3])]]);
    dispose();
  });
});
