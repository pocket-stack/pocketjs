// Real pointer contract (input.pointer): ordered frame-input edges drive
// hover/focus/activation without enabling or drawing input.cursor.

import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetFrameInput,
  __setFrameInput,
  POINTER_EVENT,
  pointerEvents,
  type PointerWireEvent,
} from "../framework/src/frame-input.ts";
import { installHost, type Host, type HostOps } from "../framework/src/host.ts";
import {
  getFocused,
  handlePointerInput,
  pointer,
  resetInput,
  setInputRoot,
} from "../framework/src/input.ts";
import type { NodeMirror } from "../framework/src/renderer.ts";
import { NODE_TYPE, ROOT_ID } from "../contracts/spec/spec.ts";

type Call = [string, ...unknown[]];

interface PointerHost extends Host {
  calls: Call[];
  hitResult: number;
}

function makeHost(): PointerHost {
  const calls: Call[] = [];
  const host: PointerHost = {
    kind: "injected",
    target: "test",
    strict: true,
    calls,
    hitResult: 0,
    ops: {} as HostOps,
  };
  const rec = (name: string) => (...args: unknown[]) => calls.push([name, ...args]);
  host.ops = {
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
    setActive: rec("setActive"),
    setCursor: rec("setCursor"),
    setCursorPos: rec("setCursorPos"),
    hitTest(x, y) {
      calls.push(["hitTest", x, y]);
      return host.hitResult;
    },
    measureText: () => 0,
  };
  (host.ops as HostOps & { __viewport: { w: number; h: number } }).__viewport = {
    w: 4096,
    h: 4096,
  };
  return host;
}

function mk(id: number, parent: NodeMirror | null, extra: Partial<NodeMirror> = {}): NodeMirror {
  const node: NodeMirror = { id, type: NODE_TYPE.view, parent, children: [], ...extra };
  if (parent) parent.children.push(node);
  return node;
}

let host: PointerHost;
let root: NodeMirror;

beforeEach(() => {
  host = makeHost();
  installHost(host);
  __resetFrameInput();
  resetInput();
  root = mk(ROOT_ID, null);
  setInputRoot(root);
});

function frame(events: readonly PointerWireEvent[]): void {
  __setFrameInput({ v: 1, pointer: events });
  handlePointerInput();
}

describe("versioned frame input", () => {
  test("keeps high-resolution coordinates and immutable ordered edges", () => {
    frame([
      [POINTER_EVENT.MOVE, 4095, 3072],
      [POINTER_EVENT.DOWN, 4095, 3072],
      [POINTER_EVENT.UP, 4095, 3072],
    ]);
    expect(pointerEvents().map((event) => event.type)).toEqual(["move", "down", "up"]);
    expect(Object.isFrozen(pointerEvents())).toBe(true);
    expect(pointer()).toEqual({ x: 4095, y: 3072, down: false });
  });

  test("unsupported versions and malformed coordinates deliver no events", () => {
    __setFrameInput({ v: 2, pointer: [[POINTER_EVENT.MOVE, 1, 2]] } as never);
    expect(pointerEvents()).toEqual([]);
    __setFrameInput({ v: 1, pointer: [[POINTER_EVENT.MOVE, Number.NaN, 2]] });
    expect(pointerEvents()).toEqual([]);
  });
});

describe("framework-owned interaction", () => {
  test("hover focuses without allocating or moving a virtual cursor sprite", () => {
    const button = mk(10, root, { focusable: true });
    host.hitResult = button.id;
    frame([[POINTER_EVENT.MOVE, 120, 80]]);
    expect(getFocused()).toBe(button);
    expect(host.calls.filter(([name]) => name === "setCursor" || name === "setCursorPos")).toEqual([]);
  });

  test("a complete fast click in one tick fires onPress exactly once", () => {
    let presses = 0;
    const button = mk(11, root, { focusable: true, onPress: () => presses++ });
    host.hitResult = button.id;
    frame([
      [POINTER_EVENT.DOWN, 50, 40],
      [POINTER_EVENT.UP, 50, 40],
    ]);
    expect(presses).toBe(1);
    expect(host.calls.filter(([name]) => name === "setActive")).toEqual([
      ["setActive", button.id, 1],
      ["setActive", button.id, 0],
    ]);
  });

  test("drag-away release cancels, while re-enter before release succeeds", () => {
    let presses = 0;
    const button = mk(12, root, { focusable: true, onPress: () => presses++ });
    const other = mk(13, root, { focusable: true });
    host.hitResult = button.id;
    frame([[POINTER_EVENT.DOWN, 10, 10]]);
    host.hitResult = other.id;
    frame([[POINTER_EVENT.MOVE, 90, 90], [POINTER_EVENT.UP, 90, 90]]);
    expect(presses).toBe(0);

    host.hitResult = button.id;
    frame([[POINTER_EVENT.DOWN, 10, 10]]);
    host.hitResult = other.id;
    frame([[POINTER_EVENT.MOVE, 90, 90]]);
    host.hitResult = button.id;
    frame([[POINTER_EVENT.MOVE, 10, 10], [POINTER_EVENT.UP, 10, 10]]);
    expect(presses).toBe(1);
  });

  test("leave clears hover and cancel clears capture without firing", () => {
    let presses = 0;
    const button = mk(14, root, { focusable: true, onPress: () => presses++ });
    host.hitResult = button.id;
    frame([[POINTER_EVENT.DOWN, 20, 20]]);
    frame([[POINTER_EVENT.LEAVE]]);
    expect(getFocused()).toBeNull();
    expect(pointer()).toBeNull();
    frame([[POINTER_EVENT.CANCEL]]);
    frame([[POINTER_EVENT.UP, 20, 20]]);
    expect(presses).toBe(0);
  });

  test("reads the live viewport after resize instead of caching old bounds", () => {
    frame([[POINTER_EVENT.MOVE, 4000, 3000]]);
    expect(pointer()).toEqual({ x: 4000, y: 3000, down: false });
    (host.ops as HostOps & { __viewport: { w: number; h: number } }).__viewport = {
      w: 320,
      h: 180,
    };
    frame([[POINTER_EVENT.MOVE, 4000, 3000]]);
    expect(pointer()).toEqual({ x: 319, y: 179, down: false });
    expect(host.calls.filter(([name]) => name === "hitTest").at(-1)).toEqual([
      "hitTest",
      319,
      179,
    ]);
  });
});
