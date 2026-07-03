// Solid universal renderer over the native `ui.*` tree.
//
// This module is the babel-preset-solid {generate:'universal'} moduleName
// target: compiled JSX imports render/effect/memo/createComponent/
// createElement/createTextNode/insertNode/insert/spread/setProp/mergeProps/use
// from HERE (all produced by solid-js/universal's createRenderer).
//
// The renderer keeps a JS MIRROR TREE (NodeMirror) of the native tree so every
// reconciler READ (getParentNode/getFirstChild/getNextSibling/isTextNode) is a
// pure JS object walk — zero FFI crossings. Writes go through HostOps.
//
// NODE RECLAMATION [R]: Solid's reconciler calls removeNode for nodes that may
// be re-inserted within the same frame (moves across <For> rows, <Show> arms).
// removeChild therefore keeps native nodes alive; nodes still DETACHED at the
// end of the frame are destroyed by runSweep() (called from globalThis.frame
// after user code ran). retain()/release() opt a detached subtree out of/back
// into the sweep.

import { createRenderer } from "solid-js/universal";
import { NODE_TYPE, ROOT_ID, PROP, STYLE_ID_NONE, type PropName } from "../spec/spec.ts";
import { encodePropValue, getHost, getOps } from "./host.ts";
import { notifyDetached, registerFocusable, registerPress } from "./input.ts";

// ---------------------------------------------------------------------------
// Mirror tree
// ---------------------------------------------------------------------------

export interface NodeMirror {
  /** Native generation-tagged node id. */
  id: number;
  /** spec NODE_TYPE ordinal. */
  type: number;
  parent: NodeMirror | null;
  children: NodeMirror[];
  /** Current text (text nodes only). */
  text?: string;
  /** Focus traversal membership (input.ts). */
  focusable?: boolean;
  /** CIRCLE handler while focused (input.ts). */
  onPress?: (() => void) | undefined;
}

/** Mirror of the pre-created native root (full-screen flex column, id 1). */
export const rootMirror: NodeMirror = {
  id: ROOT_ID,
  type: NODE_TYPE.view,
  parent: null,
  children: [],
};

// ---------------------------------------------------------------------------
// Style resolver injection (avoids a hard dep on styles.generated.ts)
// ---------------------------------------------------------------------------

let styleResolver: ((cls: string) => number | undefined) | null = null;

/** Wire the class→styleId lookup (index.ts injects styles.ts's resolveStyle). */
export function setStyleResolver(fn: (cls: string) => number | undefined): void {
  styleResolver = fn;
}

/** Non-strict-host miss counters (PSP: don't crash, count). */
export const missCounters = { unknownClass: 0, unknownTexture: 0 };

// ---------------------------------------------------------------------------
// Texture registry ('src' prop → uploaded texture handle)
// ---------------------------------------------------------------------------

const textures = new Map<string, number>();

/** Bind an image key (the `src` string) to an uploadTexture handle. */
export function registerTexture(key: string, handle: number): void {
  textures.set(key, handle);
}

export function resetTextures(): void {
  textures.clear();
}

// ---------------------------------------------------------------------------
// End-of-frame sweep [R]
// ---------------------------------------------------------------------------

const sweepSet = new Set<NodeMirror>();
const retained = new Set<NodeMirror>();

/** Keep a detached subtree alive across frames (skip the sweep). */
export function retain(node: NodeMirror): void {
  retained.add(node);
  sweepSet.delete(node);
}

/** Undo retain(); a still-detached node re-enters the next sweep. */
export function release(node: NodeMirror): void {
  retained.delete(node);
  if (node.parent === null && node !== rootMirror) sweepSet.add(node);
}

function subtreeHasRetained(node: NodeMirror): boolean {
  if (retained.has(node)) return true;
  for (let i = 0; i < node.children.length; i++) {
    if (subtreeHasRetained(node.children[i])) return true;
  }
  return false;
}

/**
 * Destroy every subtree removed during the frame and still detached. Called
 * once per frame by globalThis.frame (index.ts) AFTER user code ran, so
 * remove-then-reinsert (Solid moves) never destroys live nodes.
 */
export function runSweep(): void {
  if (sweepSet.size === 0) return;
  const ops = getOps();
  const keep: NodeMirror[] = [];
  for (const node of sweepSet) {
    if (node.parent !== null) continue; // re-attached (defensive)
    if (subtreeHasRetained(node)) {
      keep.push(node); // stays pending until released/re-attached
      continue;
    }
    ops.destroyNode(node.id); // native destroy is recursive
  }
  sweepSet.clear();
  for (let i = 0; i < keep.length; i++) sweepSet.add(keep[i]);
}

/** Tests: drop sweep/retain state without touching the native tree. */
export function resetRendererState(): void {
  sweepSet.clear();
  retained.clear();
  rootMirror.children.length = 0;
}

// ---------------------------------------------------------------------------
// Renderer options
// ---------------------------------------------------------------------------

function createElementImpl(tag: string): NodeMirror {
  const type = (NODE_TYPE as Record<string, number>)[tag];
  if (type === undefined) {
    throw new Error(
      `psp-ui: unknown element <${tag}> — only view/text/image exist`,
    );
  }
  return { id: getOps().createNode(type), type, parent: null, children: [] };
}

function createTextNodeImpl(value: string): NodeMirror {
  const ops = getOps();
  const id = ops.createNode(NODE_TYPE.text);
  ops.setText(id, value);
  return { id, type: NODE_TYPE.text, parent: null, children: [], text: value };
}

function replaceTextImpl(textNode: NodeMirror, value: string): void {
  getOps().replaceText(textNode.id, value);
  textNode.text = value;
}

function isTextNodeImpl(node: NodeMirror): boolean {
  return node.type === NODE_TYPE.text;
}

/** Unlink from the current mirror parent (native insertBefore self-unlinks). */
function unlink(node: NodeMirror): void {
  const p = node.parent;
  if (!p) return;
  const i = p.children.indexOf(node);
  if (i >= 0) p.children.splice(i, 1);
  node.parent = null;
}

function insertNodeImpl(
  parent: NodeMirror,
  node: NodeMirror,
  anchor?: NodeMirror,
): void {
  const ops = getOps();
  // DOM move semantics [R]: an attached node is unlinked first — natively by
  // insertBefore itself, and here in the mirror.
  unlink(node);
  sweepSet.delete(node); // re-attached before the sweep: not garbage
  ops.insertBefore(parent.id, node.id, anchor ? anchor.id : 0);
  if (anchor) {
    const i = parent.children.indexOf(anchor);
    if (i < 0) {
      throw new Error("psp-ui: insert anchor is not a child of parent");
    }
    parent.children.splice(i, 0, node);
  } else {
    parent.children.push(node);
  }
  node.parent = parent;
}

function removeNodeImpl(parent: NodeMirror, node: NodeMirror): void {
  // Focus repair [R] runs BEFORE the unlink so sibling order is still known.
  notifyDetached(node);
  getOps().removeChild(parent.id, node.id);
  unlink(node);
  sweepSet.add(node); // destroyed at frame end unless re-attached/retained
}

export function detachNode(parent: NodeMirror, node: NodeMirror): void {
  removeNodeImpl(parent, node);
}

function getParentNodeImpl(node: NodeMirror): NodeMirror | undefined {
  return node.parent ?? undefined;
}

function getFirstChildImpl(node: NodeMirror): NodeMirror | undefined {
  return node.children[0];
}

function getNextSiblingImpl(node: NodeMirror): NodeMirror | undefined {
  const p = node.parent;
  if (!p) return undefined;
  const i = p.children.indexOf(node);
  return i >= 0 ? p.children[i + 1] : undefined;
}

// ---- setProperty dispatch table [R] ----------------------------------------

function setClass(node: NodeMirror, value: unknown): void {
  const ops = getOps();
  if (value == null || value === "") {
    ops.setStyle(node.id, STYLE_ID_NONE);
    return;
  }
  if (typeof value !== "string") {
    throw new Error("psp-ui: class must be a string literal of utilities");
  }
  const styleId = styleResolver ? styleResolver(value) : undefined;
  if (styleId === undefined) {
    if (getHost().strict) {
      throw new Error(
        `psp-ui: unknown class "${value}" — not in the compiled style table ` +
          "(dynamic classes must be ternaries of full literals)",
      );
    }
    missCounters.unknownClass++;
    return;
  }
  ops.setStyle(node.id, styleId);
}

function setSrc(node: NodeMirror, value: unknown): void {
  const ops = getOps();
  if (value == null || value === "") {
    // -1 clears: texture handles are 0-BASED (0 is the first upload), so the
    // node-id "0 = none" convention does not apply here.
    ops.setImage(node.id, -1);
    return;
  }
  if (typeof value !== "string") {
    throw new Error("psp-ui: src must be a string key");
  }
  const handle = textures.get(value);
  if (handle === undefined) {
    if (getHost().strict) {
      throw new Error(
        `psp-ui: unknown image src "${value}" — no texture registered under that key`,
      );
    }
    missCounters.unknownTexture++;
    return;
  }
  ops.setImage(node.id, handle);
}

type StyleObject = Record<string, number | string>;

function setStyleObject(node: NodeMirror, value: unknown, prev: unknown): void {
  const ops = getOps();
  const next = (value ?? {}) as StyleObject;
  const before = (prev ?? {}) as StyleObject;
  for (const key in next) {
    const v = next[key];
    if (before[key] === v) continue; // prev-diff: only changed keys cross FFI
    const propId = (PROP as Record<string, number>)[key];
    if (propId === undefined) {
      throw new Error(`psp-ui: unknown style prop '${key}' (see spec PROP)`);
    }
    ops.setProp(node.id, propId, encodePropValue(key as PropName, v));
  }
  // Keys present before but absent now keep their last value — there is no
  // native "clear prop" op in v1. Set an explicit default instead of deleting.
}

function setPropertyImpl<T>(
  node: NodeMirror,
  name: string,
  value: T,
  prev?: T,
): void {
  if (value === prev && name !== "style") return;
  switch (name) {
    case "class":
      setClass(node, value);
      return;
    case "onPress":
    case "on:press":
      registerPress(node, value as (() => void) | undefined);
      return;
    case "src":
      setSrc(node, value);
      return;
    case "style":
      setStyleObject(node, value, prev);
      return;
    case "focusable":
      registerFocusable(node, !!value);
      return;
    case "ref":
      // spread() handles ref itself; compiled templates use use(). Support a
      // stray function ref defensively.
      if (typeof value === "function") (value as (n: NodeMirror) => void)(node);
      return;
    default:
      break;
  }
  if (name === "classList") {
    throw new Error(
      "psp-ui: classList is not supported [R] — use ternaries of full class literals",
    );
  }
  if (name.startsWith("on:") || name.startsWith("bool:") || name.startsWith("prop:")) {
    throw new Error(`psp-ui: unsupported namespaced attribute '${name}'`);
  }
  throw new Error(`psp-ui: unknown property '${name}' on <${tagName(node)}>`);
}

function tagName(node: NodeMirror): string {
  for (const key of Object.keys(NODE_TYPE)) {
    if ((NODE_TYPE as Record<string, number>)[key] === node.type) return key;
  }
  return String(node.type);
}

// ---------------------------------------------------------------------------
// The renderer (everything compiled JSX imports)
// ---------------------------------------------------------------------------

const renderer = createRenderer<NodeMirror>({
  createElement: createElementImpl,
  createTextNode: createTextNodeImpl,
  replaceText: replaceTextImpl,
  isTextNode: isTextNodeImpl,
  setProperty: setPropertyImpl,
  insertNode: insertNodeImpl,
  removeNode: removeNodeImpl,
  getParentNode: getParentNodeImpl,
  getFirstChild: getFirstChildImpl,
  getNextSibling: getNextSiblingImpl,
});

// effect/memo/createComponent come back from createRenderer wrapping solid-js's
// createRenderEffect/createMemo/createComponent — re-exported from the result
// so compiled code has ONE import source (this module).
export const {
  render,
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} = renderer;
