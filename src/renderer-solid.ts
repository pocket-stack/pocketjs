// Legacy Solid baseline renderer over the shared native `ui.*` tree.
//
// This is intentionally kept for benchmarks, not as the default app engine.
// Current production-facing engines are React-compatible and Vue; `--engine=solid` lets
// the bench runner compare Vue against the prior Solid universal path on the
// same current demos and native timing feature.

import { createRenderer } from "solid-js/universal";
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
  registerTexture,
  release,
  removeNode,
  replaceText,
  resetRendererState,
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
  registerTexture,
  release,
  replaceText,
  resetRendererState,
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
  insert,
  spread,
  mergeProps,
  use,
} = renderer;

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
