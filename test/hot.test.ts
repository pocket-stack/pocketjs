// The imperative hot path (src/hot.ts): last-value gating, op emission,
// and mirror truthfulness — the per-frame escape hatch must cost zero ops
// for unchanged values and exactly one op per change.
import { beforeEach, expect, test } from "bun:test";
import { installHost, type Host, type HostOps } from "../src/host.ts";
import { createElement, registerTexture, resetRendererState, type NodeMirror } from "../src/native-tree.ts";
import * as hot from "../src/hot.ts";

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
  return { kind: "injected", strict: true, ops };
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

test("hot.position falls back to two props and gates the coordinate pair", () => {
  const el = createElement("view");
  hot.position(el, 12, -4);
  expect(of("setProp")).toEqual([
    ["setProp", el.id, 128, 12],
    ["setProp", el.id, 129, -4],
  ]);
  hot.position(el, 12, -4);
  expect(of("setProp").length).toBe(2);
});

test("hot.position uses the fused host operation when available", () => {
  const host = mockHost();
  host.ops.setTranslation = (...args) => calls.push(["setTranslation", ...args]);
  installHost(host);
  const el = createElement("view");
  hot.position(el, 7, 9);
  expect(of("setTranslation")).toEqual([["setTranslation", el.id, 7, 9]]);
  expect(of("setProp")).toEqual([]);
});

test("hot.image swaps textures once per changed key", () => {
  registerTexture("wisp.png", 7);
  registerTexture("kasa.png", 9);
  const image = createElement("image");
  hot.image(image, "wisp.png");
  hot.image(image, "wisp.png");
  hot.image(image, "kasa.png");
  expect(of("setImage")).toEqual([
    ["setImage", image.id, 7],
    ["setImage", image.id, 9],
  ]);
});

test("particle batches pack f32 geometry and ABGR words into one host call", () => {
  const host = mockHost();
  host.ops.setParticles = (id, words, count) => {
    const floats = new Float32Array(words.buffer);
    calls.push(["setParticles", id, count, floats[0], floats[1], floats[2], words[3]]);
  };
  installHost(host);
  expect(hot.supportsParticles()).toBe(true);
  const layer = createElement("view");
  const batch = hot.createParticleBatch(2);
  batch.push(3.5, -2, 8, 0xff112233);
  batch.flush(layer);
  expect(of("setParticles")).toEqual([["setParticles", layer.id, 1, 3.5, -2, 8, 0xff112233]]);
});

test("particle batch direct writes flush through flushCount, clamped to capacity", () => {
  const host = mockHost();
  host.ops.setParticles = (id, words, count) => {
    const floats = new Float32Array(words.buffer);
    calls.push(["setParticles", id, count, floats[4], floats[5], floats[6], words[7]]);
  };
  installHost(host);
  const layer = createElement("view");
  const batch = hot.createParticleBatch(2);
  expect(batch.capacity).toBe(2);
  // particle 1 via the direct-write fast path (no push closure)
  batch.floats[4] = 9.5;
  batch.floats[5] = -1;
  batch.floats[6] = 6;
  batch.words[7] = 0xffaabbcc;
  batch.flushCount(layer, 2);
  expect(of("setParticles")).toEqual([["setParticles", layer.id, 2, 9.5, -1, 6, 0xffaabbcc]]);
  batch.flushCount(layer, 99); // over-capacity count is clamped
  expect(of("setParticles")[1][2]).toBe(2);
  batch.flushCount(layer, -3); // negative clamps to zero
  expect(of("setParticles")[2][2]).toBe(0);
});

test("hot.text on a bare text node works without a wrapper", () => {
  const run = createElement("text");
  run.text = "";
  hot.text(run, "GO");
  expect(of("setText")).toEqual([["setText", run.id, "GO"]]);
});
