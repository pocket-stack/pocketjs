// Virtual cursor contract tests (input.cursor; spec ops 27..29) — drive
// src/input.ts against a mock HostOps with a scriptable hitTest, no
// reconciler in the loop (mirrors are hand-built).
//
// Run: bun test --conditions=browser test/cursor.test.ts
// (input.ts imports frame.ts -> solid-js; keep the browser condition so the
// SSR build never enters the picture.)

import { beforeEach, describe, expect, test } from "bun:test";

import { installHost, type Host, type HostOps } from "../src/host.ts";
import {
  __notifyTreeMutation,
  cursorX,
  cursorY,
  enableCursor,
  getFocused,
  handleFrame,
  pushFocusScope,
  resetInput,
  setInputRoot,
} from "../src/input.ts";
import { __setAnalog } from "../src/frame.ts";
import { resetClock } from "../src/clock.ts";
import type { NodeMirror } from "../src/renderer.ts";
import { ANALOG_CENTER, BTN, NODE_TYPE, PSM, ROOT_ID, SCREEN_H, SCREEN_W } from "../spec/spec.ts";

type Call = [string, ...unknown[]];

interface CursorMockHost extends Host {
  calls: Call[];
  of(...names: string[]): Call[];
  clear(): void;
  /** What the next hitTest calls return (a stand-in for core geometry). */
  hitResult: number;
}

function makeCursorHost(strict = true): CursorMockHost {
  const calls: Call[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const self: CursorMockHost = {
    kind: "injected",
    target: "test",
    strict,
    calls,
    hitResult: 0,
    of(...names: string[]) {
      return calls.filter((c) => names.includes(c[0] as string));
    },
    clear() {
      calls.length = 0;
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
    uploadTexture(_buf, w, h, psm) {
      calls.push(["uploadTexture", w, h, psm]);
      return 700 + calls.length;
    },
    setImage: rec("setImage"),
    setSprite: rec("setSprite"),
    animate: () => 1,
    cancelAnim: rec("cancelAnim"),
    setFocus: rec("setFocus"),
    setActive: rec("setActive"),
    measureText: () => 0,
    uploadImgEntry(blob: Uint8Array) {
      calls.push(["uploadImgEntry", blob.length]);
      return 800 + calls.length;
    },
    freeTexture: rec("freeTexture"),
    hitTest(x: number, y: number) {
      calls.push(["hitTest", x, y]);
      return self.hitResult;
    },
    setCursor: rec("setCursor"),
    setCursorPos: rec("setCursorPos"),
  };
  return self;
}

/** Hand-built mirror node (no reconciler in these tests). */
function mk(
  id: number,
  parent: NodeMirror | null,
  extra: Partial<NodeMirror> = {},
): NodeMirror {
  const n: NodeMirror = {
    id,
    type: NODE_TYPE.view,
    parent,
    children: [],
    ...extra,
  };
  if (parent) parent.children.push(n);
  return n;
}

let host: CursorMockHost;
let root: NodeMirror;

beforeEach(() => {
  host = makeCursorHost();
  installHost(host);
  resetInput();
  resetClock();
  __setAnalog(ANALOG_CENTER);
  root = mk(ROOT_ID, null);
  setInputRoot(root);
});

const CENTER: [number, number] = [Math.floor(SCREEN_W / 2), Math.floor(SCREEN_H / 2)];

describe("enableCursor lifecycle", () => {
  test("first frame lazily uploads the built-in arrow, binds it, and centers", () => {
    enableCursor();
    expect(host.of("setCursor")).toEqual([]); // nothing until a frame runs
    handleFrame(0);
    expect(host.of("uploadTexture")).toEqual([["uploadTexture", 16, 16, PSM.PSM_8888]]);
    const tex = (host.of("setCursor")[0] ?? [])[1];
    expect(host.of("setCursor")).toEqual([["setCursor", tex, 0, 0, 0, 0]]);
    expect(host.of("setCursorPos")).toEqual([["setCursorPos", CENTER[0], CENTER[1]]]);
    expect([cursorX(), cursorY()]).toEqual(CENTER);
  });

  test("a pak-style IMG blob becomes the sprite via uploadImgEntry", () => {
    enableCursor({ image: new Uint8Array(64), hotspot: [1, 2], size: [12, 18] });
    handleFrame(0);
    expect(host.of("uploadImgEntry")).toEqual([["uploadImgEntry", 64]]);
    expect(host.of("uploadTexture")).toEqual([]);
    const tex = (host.of("setCursor")[0] ?? [])[1];
    expect(host.of("setCursor")).toEqual([["setCursor", tex, 1, 2, 12, 18]]);
  });

  test("the disposer hides the sprite, frees it, and restores d-pad focus", () => {
    const row = mk(7, root, { focusable: true });
    const dispose = enableCursor();
    handleFrame(0);
    const tex = (host.of("setCursor")[0] ?? [])[1];
    host.clear();
    // d-pad is suppressed while the cursor owns input.
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(null);
    dispose();
    expect(host.of("setCursor")).toEqual([["setCursor", -1, 0, 0, 0, 0]]);
    expect(host.of("freeTexture")).toEqual([["freeTexture", tex]]);
    handleFrame(0); // release edge for the suppressed frame's mask
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(row);
  });

  test("cursorX/Y report NaN while disabled", () => {
    expect(Number.isNaN(cursorX())).toBe(true);
    expect(Number.isNaN(cursorY())).toBe(true);
  });
});

describe("steering", () => {
  test("full deflection moves speed/60 px per frame and clamps to the viewport", () => {
    enableCursor({ speed: 240 });
    handleFrame(0); // init at center
    host.clear();
    __setAnalog((255 << 8) | 128); // full right
    handleFrame(0);
    expect(host.of("setCursorPos")).toEqual([["setCursorPos", CENTER[0] + 4, CENTER[1]]]);
    for (let i = 0; i < 200; i++) handleFrame(0);
    expect(cursorX()).toBe(SCREEN_W - 1); // clamped at the last hit-testable px
  });

  test("dpadSpeed opts the d-pad in as a slow fallback stick", () => {
    enableCursor({ speed: 240, dpadSpeed: 60 });
    handleFrame(0);
    host.clear();
    handleFrame(BTN.RIGHT);
    expect(host.of("setCursorPos")).toEqual([["setCursorPos", CENTER[0] + 1, CENTER[1]]]);
  });
});

describe("hover and click", () => {
  test("hover focuses the nearest focusable ancestor of the hit", () => {
    const row = mk(5, root, { focusable: true });
    const label = mk(6, row, { type: NODE_TYPE.text });
    enableCursor();
    host.hitResult = label.id; // core reports the deepest node
    handleFrame(0);
    expect(getFocused()).toBe(row);
    expect(host.of("setFocus").pop()).toEqual(["setFocus", row.id]);
    // Leaving for a non-focusable area clears the hover (the mock moves the
    // hit without cursor motion, so signal the change like a mutation would).
    host.hitResult = ROOT_ID;
    __notifyTreeMutation();
    handleFrame(0);
    expect(getFocused()).toBe(null);
  });

  test("a parked cursor over a quiet tree skips the hit test entirely", () => {
    const row = mk(5, root, { focusable: true });
    enableCursor();
    host.hitResult = row.id;
    handleFrame(0); // first frame resolves
    expect(host.of("hitTest").length).toBe(1);
    handleFrame(0);
    handleFrame(0);
    expect(host.of("hitTest").length).toBe(1); // no movement, no mutations
    __notifyTreeMutation(); // tree/style/scope change → one re-resolve
    handleFrame(0);
    expect(host.of("hitTest").length).toBe(2);
    handleFrame(BTN.CIRCLE); // press edge always re-resolves
    expect(host.of("hitTest").length).toBe(3);
  });

  test("a focus scope makes everything outside it inert", () => {
    const row = mk(5, root, { focusable: true });
    const panel = mk(8, root);
    const button = mk(9, panel, { focusable: true });
    enableCursor();
    const release = pushFocusScope(panel, { autoFocus: false });
    host.hitResult = row.id; // hovering the background behind the modal
    handleFrame(0);
    expect(getFocused()).toBe(null);
    host.hitResult = button.id;
    __notifyTreeMutation(); // the mock moves the hit without cursor motion
    handleFrame(0);
    expect(getFocused()).toBe(button);
    release();
  });

  test("press arms, leave pops, re-enter re-presses, release over target fires", () => {
    let presses = 0;
    const row = mk(5, root, { focusable: true, onPress: () => presses++ });
    enableCursor();
    host.hitResult = row.id;
    handleFrame(0);
    host.clear();

    handleFrame(BTN.CIRCLE); // press down over the row
    expect(host.of("setActive").pop()).toEqual(["setActive", row.id, 1]);
    host.hitResult = ROOT_ID; // drag off while held (a real drag moves the
    __notifyTreeMutation(); //  cursor; the mock signals the change instead)
    handleFrame(BTN.CIRCLE);
    expect(host.of("setActive").pop()).toEqual(["setActive", row.id, 0]);
    host.hitResult = row.id; // drag back on
    __notifyTreeMutation();
    handleFrame(BTN.CIRCLE);
    expect(host.of("setActive").pop()).toEqual(["setActive", row.id, 1]);
    handleFrame(0); // release over the target
    expect(presses).toBe(1);
    expect(host.of("setActive").pop()).toEqual(["setActive", row.id, 0]);

    // Release off-target cancels the click.
    handleFrame(BTN.CIRCLE);
    host.hitResult = ROOT_ID;
    __notifyTreeMutation();
    handleFrame(BTN.CIRCLE);
    handleFrame(0);
    expect(presses).toBe(1);
  });

  test("the press bubbles from the focusable to an ancestor handler", () => {
    let presses = 0;
    const list = mk(4, root, { onPress: () => presses++ });
    const row = mk(5, list, { focusable: true });
    enableCursor();
    host.hitResult = row.id;
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    handleFrame(0);
    expect(presses).toBe(1);
  });

  test("a custom press button replaces CIRCLE", () => {
    let presses = 0;
    const row = mk(5, root, { focusable: true, onPress: () => presses++ });
    enableCursor({ button: BTN.CROSS });
    host.hitResult = row.id;
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    handleFrame(0);
    expect(presses).toBe(0);
    handleFrame(BTN.CROSS);
    handleFrame(0);
    expect(presses).toBe(1);
  });
});

describe("degradation", () => {
  test("hosts without the cursor ops fall back to classic d-pad focus", () => {
    delete (host.ops as Partial<HostOps>).hitTest;
    delete (host.ops as Partial<HostOps>).setCursor;
    delete (host.ops as Partial<HostOps>).setCursorPos;
    const row = mk(5, root, { focusable: true });
    enableCursor();
    // The cursor cannot operate — the classic model keeps the app usable.
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(row);
    expect(Number.isNaN(cursorX())).toBe(true); // never operated
    let presses = 0;
    row.onPress = () => presses++;
    handleFrame(BTN.DOWN | BTN.CIRCLE);
    expect(presses).toBe(1);
  });
});

describe("re-enable", () => {
  test("an identical sprite config keeps the uploaded texture", () => {
    enableCursor({ hotspot: [1, 1] });
    handleFrame(0);
    expect(host.of("uploadTexture").length).toBe(1);
    enableCursor({ hotspot: [1, 1], speed: 500 }); // same sprite, new speed
    handleFrame(0);
    expect(host.of("uploadTexture").length).toBe(1);
    expect(host.of("freeTexture")).toEqual([]);
    enableCursor({ hotspot: [3, 3] }); // hotspot changed → rebind + upload
    handleFrame(0);
    expect(host.of("uploadTexture").length).toBe(2);
    expect(host.of("freeTexture").length).toBe(1);
  });

  test("speed 0 with d-pad steering stays finite", () => {
    enableCursor({ speed: 0, dpadSpeed: 60 });
    handleFrame(0);
    host.clear();
    handleFrame(BTN.RIGHT);
    expect(host.of("setCursorPos")).toEqual([["setCursorPos", CENTER[0] + 1, CENTER[1]]]);
    expect(Number.isFinite(cursorX())).toBe(true);
  });

  test("reconfiguring mid-hold never strands the pressed visual", () => {
    const row = mk(5, root, { focusable: true });
    enableCursor();
    host.hitResult = row.id;
    handleFrame(0);
    handleFrame(BTN.CIRCLE); // armed + active
    expect(host.of("setActive").pop()).toEqual(["setActive", row.id, 1]);
    enableCursor({ button: BTN.CROSS }); // reconfigure while held
    expect(host.of("setActive").pop()).toEqual(["setActive", row.id, 0]);
    handleFrame(BTN.CIRCLE); // still held
    handleFrame(0); // released: no stuck visual, no spurious press
    expect(host.of("setActive").pop()).toEqual(["setActive", row.id, 0]);
  });
});
