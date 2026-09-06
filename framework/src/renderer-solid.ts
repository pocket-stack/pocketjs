// Solid universal renderer over the shared native `ui.*` tree.
//
// This is the default `framework: "solid"` renderer and the
// babel-preset-solid {generate:"universal"} moduleName target.

import { createRenderer } from "@solidjs/universal";
import {
  createElement as createNativeElement,
  createTextNode,
  detachNode,
  getFirstChild,
  getNextSibling,
  getParentNode,
  insertNode,
  isTextNode,
  missCounters,
  registerSprite,
  registerTexture,
  release,
  removeNode,
  replaceText,
  resetRendererState,
  resetSprites,
  resetTextures,
  retain,
  rootMirror,
  runSweep,
  setProp,
  setStyleResolver,
  type HostProps,
  type NodeMirror,
} from "./native-tree.ts";

export {
  createTextNode,
  detachNode,
  getFirstChild,
  getNextSibling,
  getParentNode,
  insertNode,
  isTextNode,
  missCounters,
  registerSprite,
  registerTexture,
  release,
  replaceText,
  resetRendererState,
  resetSprites,
  resetTextures,
  retain,
  rootMirror,
  runSweep,
  setProp,
  setStyleResolver,
  type NodeMirror,
};

function setProperty<T>(node: NodeMirror, name: string, value: T, prev?: T): void {
  if (name === "ref" && typeof value === "function") {
    (value as (node: NodeMirror) => void)(node);
    return;
  }
  setProp(node, name, value, prev);
}

const renderer = createRenderer<NodeMirror>({
  createElement: createNativeElement,
  createTextNode,
  createSentinel() {
    const node = createNativeElement("view");
    setProp(node, "style", { posType: 1, width: 0, height: 0, hitPass: 1 });
    return node;
  },
  replaceText,
  isTextNode,
  setProperty,
  insertNode(parent, node, anchor) {
    insertNode(parent, node, anchor);
  },
  removeNode(parent, node) {
    removeNode(parent, node);
  },
  getParentNode,
  getFirstChild,
  getNextSibling,
});

export const {
  render,
  effect,
  memo,
  createComponent,
  createElement,
  spread,
  mergeProps,
  ref,
  applyRef,
} = renderer;

/** Preserve a scalar text segment's native node across marked insertions.
 * Universal v2 otherwise normalizes every scalar in a marked segment into a
 * fresh text node. A per-segment node avoids allocation on counter/caret updates. */
export const insert: typeof renderer.insert = (parent, accessor, marker, initial, options) => {
  if (marker === undefined || typeof accessor !== "function") return renderer.insert(parent, accessor, marker, initial, options);
  let text: NodeMirror | undefined;
  return renderer.insert(parent, () => {
    const value = (accessor as () => unknown)();
    if (typeof value !== "string" && typeof value !== "number") return value;
    const next = String(value);
    if (!text?.parent) text = createTextNode(next);
    else if (text.text !== next) replaceText(text, next);
    return text;
  }, marker, initial, options);
};

export function createRenderRoot(root: NodeMirror) {
  let dispose: (() => void) | undefined;
  return {
    update(node: unknown) {
      dispose?.();
      dispose = render(() => node as NodeMirror, root);
    },
    dispose() {
      dispose?.();
      dispose = undefined;
    },
  };
}

export function applySpread(node: NodeMirror, props: HostProps): void {
  spread(node, props, false);
}
