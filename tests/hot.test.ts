// The imperative hot path (framework/src/hot.ts): last-value gating, op emission,
// and mirror truthfulness — the per-frame escape hatch must cost zero ops
// for unchanged values and exactly one op per change.
import { beforeEach, expect, test } from "bun:test";
import { installHost, type Host, type HostOps } from "../framework/src/host.ts";
import { createElement, resetRendererState, type NodeMirror } from "../framework/src/native-tree.ts";
import * as hot from "../framework/src/hot.ts";

let calls: [string, ...unknown[]][];

function mockHost(): Host {
  calls = [];
  let nextId = 100;
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ops = {
    createNode: () => nextId++,
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
    loadStyles: () => true,
    loadFontAtlas: () => true,
    measureText: () => 0,
  } as unknown as HostOps;
  return { kind: "injected", target: "test", strict: true, ops };
}

function of(name: string): [string, ...unknown[]][] {
  return calls.filter((c) => c[0] === name);
}

beforeEach(() => {
  installHost(mockHost());
  resetRendererState();
});

function textElement(): { el: NodeMirror; run: NodeMirror } {
  const el = createElement("text");
  const run = createElement("text");
  run.text = "0";
  run.parent = el;
  el.children.push(run);
  return { el, run };
}

test("hot.text targets the text run, gates on value, syncs the mirror", () => {
  const { el, run } = textElement();
  hot.text(el, 29);
  expect(of("setText")).toEqual([["setText", run.id, "29"]]);
  expect(run.text).toBe("29");
  hot.text(el, 29); // unchanged → zero ops
  expect(of("setText").length).toBe(1);
  hot.text(el, "28");
  expect(of("setText").length).toBe(2);
});

test("hot.prop encodes, gates, and rejects unknown props", () => {
  const el = createElement("view");
  hot.prop(el, "scaleX", 0.5);
  expect(of("setProp").length).toBe(1);
  const [, id, , value] = of("setProp")[0];
  expect(id).toBe(el.id);
  expect(value).toBe(0.5);
  hot.prop(el, "scaleX", 0.5); // unchanged → zero ops
  expect(of("setProp").length).toBe(1);
  hot.prop(el, "translateX", -8);
  expect(of("setProp").length).toBe(2);
  expect(() => hot.prop(el, "notAProp" as never, 1)).toThrow(/unknown style prop/);
});

test("hot.text on a bare text node works without a wrapper", () => {
  const run = createElement("text");
  run.text = "";
  hot.text(run, "GO");
  expect(of("setText")).toEqual([["setText", run.id, "GO"]]);
});
