// The imperative hot path — for values that change many times per second on
// a 333 MHz interpreter.
//
// Solid's reactive update path (signal write → effect re-run → JSX binding →
// op) is the right default: it costs nothing when values are unchanged and
// keeps structure declarative. But its constant factor under QuickJS on PSP
// hardware is milliseconds per triggered binding — measured ~8 ms for one
// signal with four subscribers, every rifle shot. A per-frame game value
// (ammo counter, health bar fill) cannot afford it.
//
// `hot.text` / `hot.prop` write straight to the native ops with a per-node
// last-value gate: an unchanged value costs one comparison, a changed one
// costs one FFI call (~50 µs on hardware). Rules:
//
//   - a hot-driven value must NOT also have a Solid binding (two writers,
//     last one wins — keep the JSX side a static initial value);
//   - `hot.prop` is for NUMERIC props. Pair `scaleX` + `translateX` for
//     bar fills: transforms are paint-only, so the update skips layout
//     entirely (a `width` write relayouts every frame — don't);
//   - put per-frame text in a FIXED cell (definite width+height style):
//     the core skips relayout for text swaps whose cell size cannot move.
//
// The escape hatch is deliberately tiny. If you reach for it for anything
// that changes less than a few times per second, use a signal instead.

import { NODE_TYPE, PROP, type PropName } from "../spec/spec.ts";
import { encodePropValue, getOps } from "./host.ts";
import type { NodeMirror } from "./native-tree.ts";

const lastText = new WeakMap<NodeMirror, string>();
const lastProp = new WeakMap<NodeMirror, Record<string, number>>();

/** The text-run node under `node`: itself, or its first text child (the
 *  node Solid's `{expr}` insert created). */
function textTarget(node: NodeMirror): NodeMirror | null {
  if (node.type === NODE_TYPE.text && node.text !== undefined) return node;
  for (const c of node.children) {
    if (c.text !== undefined) return c;
    if (c.type === NODE_TYPE.text) return c;
  }
  return node.type === NODE_TYPE.text ? node : null;
}

/** Imperatively set a text node's content (number or string). */
export function text(node: NodeMirror | undefined, value: string | number): void {
  if (!node) return;
  const target = textTarget(node);
  if (!target) return;
  const s = typeof value === "string" ? value : String(value);
  if (lastText.get(target) === s) return;
  lastText.set(target, s);
  target.text = s; // keep the JS mirror (and DevTools' tree) truthful
  getOps().setText(target.id, s);
}

/** Imperatively set a numeric style prop (opacity, scaleX, translateX, …). */
export function prop(node: NodeMirror | undefined, name: PropName, value: number): void {
  if (!node) return;
  let cache = lastProp.get(node);
  if (cache === undefined) {
    cache = {};
    lastProp.set(node, cache);
  }
  if (cache[name] === value) return;
  cache[name] = value;
  const propId = PROP[name];
  if (propId === undefined) {
    throw new Error(`PocketJS: unknown style prop '${name}' (see spec PROP)`);
  }
  getOps().setProp(node.id, propId, encodePropValue(name, value));
}
