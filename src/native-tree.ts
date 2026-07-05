// Native tree mirror + HostOps mutation helpers shared by the Solid and Vue
// Vapor renderers.

import { NODE_TYPE, PROP, ROOT_ID, STYLE_ID_NONE, type PropName } from "../spec/spec.ts";
import { encodePropValue, getHost, getOps } from "./host.ts";
import { notifyDetached, registerFocusable, registerPress } from "./input.ts";

export interface NodeMirror {
  /** Native generation-tagged node id. */
  id: number;
  /** spec NODE_TYPE ordinal. */
  type: number;
  parent: NodeMirror | null;
  children: NodeMirror[];
  /** Current text (text nodes only). */
  text?: string;
  /** DOM-compatible nodeType for Vue Vapor's DOM-shaped runtime helpers. */
  domNodeType?: number;
  /** Lowercase DOM-compatible tag name for element nodes. */
  domTag?: string;
  /** Attribute cache used by DOM-style setAttribute/cloneNode adapters. */
  domAttrs?: Record<string, unknown>;
  /** Comment payload for DOM-compatible comment anchors. */
  domData?: string;
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
  domNodeType: 1,
  domTag: "root",
};

const DOM_NODE = Symbol.for("pocketjs.native-node");
const DOM_ELEMENT = 1;
const DOM_TEXT = 3;
const DOM_COMMENT = 8;
const NATIVE_ATTRIBUTE_NAMES = new Set([
  "class",
  "className",
  "style",
  "src",
  "onPress",
  "on:press",
  "focusable",
  "ref",
  "nodeRef",
  "key",
  "children",
]);

function domAttrs(node: NodeMirror): Record<string, unknown> {
  return (node.domAttrs ??= {});
}

export function isNativeNode(value: unknown): value is NodeMirror {
  return !!value && typeof value === "object" && (value as Record<symbol, unknown>)[DOM_NODE] === true;
}

function cloneNativeNode(node: NodeMirror, deep: boolean): NodeMirror {
  const nodeType = node.domNodeType ?? (isTextNode(node) ? DOM_TEXT : DOM_ELEMENT);
  const clone =
    nodeType === DOM_TEXT
      ? createTextNode(node.text ?? "")
      : nodeType === DOM_COMMENT
        ? createCommentNode(node.domData ?? "")
        : createElement(node.domTag ?? tagName(node));
  for (const key of Object.keys(node.domAttrs ?? {})) {
    setDomAttribute(clone, key, node.domAttrs![key]);
  }
  if (deep) {
    for (const child of node.children) insertNode(clone, cloneNativeNode(child, true));
  }
  return clone;
}

function setDomAttribute(node: NodeMirror, name: string, value: unknown): void {
  if (NATIVE_ATTRIBUTE_NAMES.has(name)) {
    setProp(node, name, value, node.domAttrs?.[name]);
    return;
  }
  if (value == null) delete domAttrs(node)[name];
  else domAttrs(node)[name] = value;
}

export function decorateNativeNode(node: NodeMirror): NodeMirror {
  if ((node as unknown as Record<symbol, unknown>)[DOM_NODE] === true) return node;
  Object.defineProperty(node, DOM_NODE, { value: true });
  Object.defineProperties(node, {
    nodeType: {
      configurable: true,
      get() {
        return node.domNodeType ?? (isTextNode(node) ? DOM_TEXT : DOM_ELEMENT);
      },
    },
    nodeValue: {
      configurable: true,
      get() {
        return node.domNodeType === DOM_COMMENT ? node.domData ?? "" : node.text ?? "";
      },
      set(value: unknown) {
        if (node.domNodeType === DOM_COMMENT) node.domData = String(value ?? "");
        else replaceText(node, String(value ?? ""));
      },
    },
    data: {
      configurable: true,
      get() {
        return node.domNodeType === DOM_COMMENT ? node.domData ?? "" : node.text ?? "";
      },
      set(value: unknown) {
        if (node.domNodeType === DOM_COMMENT) node.domData = String(value ?? "");
        else replaceText(node, String(value ?? ""));
      },
    },
    textContent: {
      configurable: true,
      get() {
        if (node.domNodeType === DOM_COMMENT) return node.domData ?? "";
        if (isTextNode(node)) return node.text ?? "";
        return node.children.map((child) => child.text ?? "").join("");
      },
      set(value: unknown) {
        const text = String(value ?? "");
        if (node.domNodeType === DOM_COMMENT) {
          node.domData = text;
        } else if (isTextNode(node)) {
          replaceText(node, text);
        } else {
          clearContainer(node);
          if (text) insertNode(node, createTextNode(text));
        }
      },
    },
    parentNode: {
      configurable: true,
      get() {
        return node.parent;
      },
    },
    parentElement: {
      configurable: true,
      get() {
        return node.parent;
      },
    },
    childNodes: {
      configurable: true,
      get() {
        return node.children;
      },
    },
    firstChild: {
      configurable: true,
      get() {
        return node.children[0] ?? null;
      },
    },
    lastChild: {
      configurable: true,
      get() {
        return node.children[node.children.length - 1] ?? null;
      },
    },
    nextSibling: {
      configurable: true,
      get() {
        return getNextSibling(node) ?? null;
      },
    },
    previousSibling: {
      configurable: true,
      get() {
        const parent = node.parent;
        if (!parent) return null;
        const index = parent.children.indexOf(node);
        return index > 0 ? parent.children[index - 1] : null;
      },
    },
    tagName: {
      configurable: true,
      get() {
        return (node.domTag ?? tagName(node)).toUpperCase();
      },
    },
    nodeName: {
      configurable: true,
      get() {
        if (node.domNodeType === DOM_TEXT) return "#text";
        if (node.domNodeType === DOM_COMMENT) return "#comment";
        return (node.domTag ?? tagName(node)).toUpperCase();
      },
    },
    className: {
      configurable: true,
      get() {
        return String(node.domAttrs?.class ?? "");
      },
      set(value: unknown) {
        setProp(node, "class", value, node.domAttrs?.class);
      },
    },
    isConnected: {
      configurable: true,
      get() {
        let current: NodeMirror | null = node;
        while (current) {
          if (current === rootMirror) return true;
          current = current.parent;
        }
        return false;
      },
    },
  });
  const methods = {
    appendChild(child: NodeMirror) {
      insertNode(node, child);
      return child;
    },
    insertBefore(child: NodeMirror, anchor?: NodeMirror | null) {
      insertNode(node, child, anchor ?? null);
      return child;
    },
    removeChild(child: NodeMirror) {
      removeNode(node, child);
      return child;
    },
    replaceChild(next: NodeMirror, current: NodeMirror) {
      insertNode(node, next, current);
      removeNode(node, current);
      return current;
    },
    cloneNode(deep = false) {
      return cloneNativeNode(node, !!deep);
    },
    remove() {
      if (node.parent) removeNode(node.parent, node);
    },
    setAttribute(name: string, value: unknown) {
      setDomAttribute(node, name, value);
    },
    removeAttribute(name: string) {
      setDomAttribute(node, name, undefined);
    },
    getAttribute(name: string) {
      const value = node.domAttrs?.[name];
      return value == null ? null : String(value);
    },
    hasAttribute(name: string) {
      return node.domAttrs?.[name] != null;
    },
    hasChildNodes() {
      return node.children.length > 0;
    },
    contains(other: NodeMirror | null | undefined) {
      let current = other ?? null;
      while (current) {
        if (current === node) return true;
        current = current.parent;
      }
      return false;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.assign(node, methods, {
    style: { length: 0, item: () => "" },
    classList: { add() {}, remove() {} },
  });
  return node;
}

decorateNativeNode(rootMirror);

let styleResolver: ((cls: string) => number | undefined) | null = null;

/** Wire the class->styleId lookup (index.ts injects styles.ts's resolveStyle). */
export function setStyleResolver(fn: (cls: string) => number | undefined): void {
  styleResolver = fn;
}

/** Non-strict-host miss counters (PSP: don't crash, count). */
export const missCounters = { unknownClass: 0, unknownTexture: 0 };

const textures = new Map<string, number>();

/** Bind an image key (the `src` string) to an uploadTexture handle. */
export function registerTexture(key: string, handle: number): void {
  textures.set(key, handle);
}

export function resetTextures(): void {
  textures.clear();
}

/** A `sprite` key → its atlas texture handle + animation metadata. */
export interface SpriteMeta {
  /** uploadTexture handle of the atlas. */
  handle: number;
  frames: number;
  cols: number;
  /** vblanks per frame. */
  step: number;
}

const sprites = new Map<string, SpriteMeta>();

/** Bind a sprite key (the `sprite` string) to its atlas handle + meta. */
export function registerSprite(key: string, meta: SpriteMeta): void {
  sprites.set(key, meta);
}

export function resetSprites(): void {
  sprites.clear();
}

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
  if (!node) return false;
  if (retained.has(node)) return true;
  for (let i = 0; i < node.children.length; i++) {
    if (subtreeHasRetained(node.children[i])) return true;
  }
  return false;
}

/**
 * Destroy every subtree removed during the frame and still detached. Called
 * once per frame by globalThis.frame after app code and input handlers ran.
 */
export function runSweep(): void {
  if (sweepSet.size === 0) return;
  const ops = getOps();
  const keep: NodeMirror[] = [];
  for (const node of sweepSet) {
    if (!node) continue;
    if (node.parent !== null) continue;
    if (subtreeHasRetained(node)) {
      keep.push(node);
      continue;
    }
    ops.destroyNode(node.id);
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

export function createElement(tag: string): NodeMirror {
  const type = (NODE_TYPE as Record<string, number>)[tag];
  if (type === undefined) {
    throw new Error(`PocketJS: unknown element <${tag}> - only view/text/image exist`);
  }
  return decorateNativeNode({
    id: getOps().createNode(type),
    type,
    parent: null,
    children: [],
    domNodeType: DOM_ELEMENT,
    domTag: tag,
  });
}

export function createTextNode(value: string): NodeMirror {
  const ops = getOps();
  const id = ops.createNode(NODE_TYPE.text);
  ops.setText(id, value);
  return decorateNativeNode({
    id,
    type: NODE_TYPE.text,
    parent: null,
    children: [],
    text: value,
    domNodeType: DOM_TEXT,
    domTag: "#text",
  });
}

export function createCommentNode(data = ""): NodeMirror {
  const node = createTextNode("");
  node.domNodeType = DOM_COMMENT;
  node.domTag = "#comment";
  node.domData = data;
  return node;
}

export function replaceText(node: NodeMirror, value: string): void {
  getOps().replaceText(node.id, value);
  node.text = value;
}

export function isTextNode(node: NodeMirror): boolean {
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

export function insertNode(parent: NodeMirror, node: NodeMirror, anchor?: NodeMirror | null): void {
  const ops = getOps();
  unlink(node);
  sweepSet.delete(node);
  ops.insertBefore(parent.id, node.id, anchor ? anchor.id : 0);
  if (anchor) {
    const i = parent.children.indexOf(anchor);
    if (i < 0) throw new Error("PocketJS: insert anchor is not a child of parent");
    parent.children.splice(i, 0, node);
  } else {
    parent.children.push(node);
  }
  node.parent = parent;
}

export function removeNode(parent: NodeMirror, node: NodeMirror): void {
  if (!node) return;
  notifyDetached(node);
  getOps().removeChild(parent.id, node.id);
  unlink(node);
  sweepSet.add(node);
}

export function detachNode(parent: NodeMirror, node: NodeMirror): void {
  removeNode(parent, node);
}

export function getParentNode(node: NodeMirror): NodeMirror | undefined {
  return node.parent ?? undefined;
}

export function getFirstChild(node: NodeMirror): NodeMirror | undefined {
  return node.children[0];
}

export function getNextSibling(node: NodeMirror): NodeMirror | undefined {
  const p = node.parent;
  if (!p) return undefined;
  const i = p.children.indexOf(node);
  return i >= 0 ? p.children[i + 1] : undefined;
}

function setClass(node: NodeMirror, value: unknown): void {
  const ops = getOps();
  if (value == null || value === "") {
    ops.setStyle(node.id, STYLE_ID_NONE);
    return;
  }
  if (typeof value !== "string") {
    throw new Error("PocketJS: class must be a string literal of utilities");
  }
  const styleId = styleResolver ? styleResolver(value) : undefined;
  if (styleId === undefined) {
    if (getHost().strict) {
      throw new Error(
        `PocketJS: unknown class "${value}" - not in the compiled style table ` +
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
    ops.setImage(node.id, -1);
    return;
  }
  if (typeof value !== "string") {
    throw new Error("PocketJS: src must be a string key");
  }
  const handle = textures.get(value);
  if (handle === undefined) {
    if (getHost().strict) {
      throw new Error(
        `PocketJS: unknown image src "${value}" - no texture registered under that key`,
      );
    }
    missCounters.unknownTexture++;
    return;
  }
  ops.setImage(node.id, handle);
}

/** `sprite` prop → bind an animated sprite atlas. Auto-play is native; JS never
 *  touches it per frame. Clearing reverts the node to a plain (empty) image. */
function setSpriteSrc(node: NodeMirror, value: unknown): void {
  const ops = getOps();
  if (value == null || value === "") {
    ops.setSprite(node.id, -1, 0, 0, 0);
    return;
  }
  if (typeof value !== "string") {
    throw new Error("PocketJS: sprite must be a string key");
  }
  const meta = sprites.get(value);
  if (meta === undefined) {
    if (getHost().strict) {
      throw new Error(
        `PocketJS: unknown sprite "${value}" - no sprite atlas registered under that key`,
      );
    }
    missCounters.unknownTexture++;
    return;
  }
  ops.setSprite(node.id, meta.handle, meta.frames, meta.cols, meta.step);
}

type StyleObject = Record<string, number | string>;

function setStyleObject(node: NodeMirror, value: unknown, prev: unknown): void {
  const ops = getOps();
  const next = (value ?? {}) as StyleObject;
  const before = (prev ?? {}) as StyleObject;
  for (const key in next) {
    const v = next[key];
    if (before[key] === v) continue;
    const propId = (PROP as Record<string, number>)[key];
    if (propId === undefined) {
      throw new Error(`PocketJS: unknown style prop '${key}' (see spec PROP)`);
    }
    ops.setProp(node.id, propId, encodePropValue(key as PropName, v));
  }
}

export function setProp<T>(node: NodeMirror, name: string, value: T, prev?: T): T {
  if (value === prev && name !== "style") return value;
  if (name === "className") name = "class";
  if (name !== "children" && name !== "key" && name !== "ref" && name !== "nodeRef") {
    if (value == null) delete domAttrs(node)[name];
    else domAttrs(node)[name] = value;
  }
  switch (name) {
    case "class":
      setClass(node, value);
      return value;
    case "onPress":
    case "on:press":
      registerPress(node, value as (() => void) | undefined);
      return value;
    case "src":
      setSrc(node, value);
      return value;
    case "sprite":
      setSpriteSrc(node, value);
      return value;
    case "style":
      setStyleObject(node, value, prev);
      return value;
    case "focusable":
      registerFocusable(node, !!value);
      return value;
    case "ref":
    case "nodeRef":
    case "key":
    case "children":
      return value;
    default:
      break;
  }
  if (name === "classList") {
    throw new Error(
      "PocketJS: classList is not supported - use ternaries of full class literals",
    );
  }
  if (name.startsWith("on:") || name.startsWith("bool:") || name.startsWith("prop:")) {
    throw new Error(`PocketJS: unsupported namespaced attribute '${name}'`);
  }
  throw new Error(`PocketJS: unknown property '${name}' on <${tagName(node)}>`);
}

export type HostProps = Record<string, unknown>;

export function applyProps(node: NodeMirror, next: HostProps, prev: HostProps = {}): void {
  const seen = new Set<string>();
  for (const key of Object.keys(next)) {
    seen.add(key);
    setProp(node, key, next[key], prev[key]);
  }
  for (const key of Object.keys(prev)) {
    if (seen.has(key)) continue;
    if (key === "children" || key === "key" || key === "ref" || key === "nodeRef") continue;
    setProp(node, key, undefined, prev[key]);
  }
}

export function clearContainer(container: NodeMirror): void {
  for (const child of [...container.children]) removeNode(container, child);
}

function tagName(node: NodeMirror): string {
  for (const key of Object.keys(NODE_TYPE)) {
    if ((NODE_TYPE as Record<string, number>)[key] === node.type) return key;
  }
  return String(node.type);
}
