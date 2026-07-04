// Vue renderer over the native `ui.*` tree.

import { createRenderer, type VNode } from "vue";
import {
  clearContainer,
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

export function createElement(type: string): NodeMirror {
  return createNativeElement(type);
}

const renderer = createRenderer<NodeMirror, NodeMirror>({
  patchProp(node, key, prev, next) {
    setProp(node, key, next, prev);
  },
  insert(child, parent, anchor = null) {
    insertNode(parent, child, anchor);
  },
  remove(child) {
    if (child.parent) removeNode(child.parent, child);
  },
  createElement(type) {
    return createNativeElement(type);
  },
  createText(text) {
    return createTextNode(text);
  },
  createComment(text) {
    return createTextNode(text);
  },
  setText(node, text) {
    replaceText(node, text);
  },
  setElementText(node, text) {
    clearContainer(node);
    replaceText(node, text);
  },
  parentNode(node) {
    return getParentNode(node) ?? null;
  },
  nextSibling(node) {
    return getNextSibling(node) ?? null;
  },
});

export interface RenderRoot {
  update(node: unknown): void;
  dispose(): void;
}

export function createRenderRoot(root: NodeMirror): RenderRoot {
  return {
    update(node: unknown) {
      renderer.render(node as VNode | null, root);
    },
    dispose() {
      renderer.render(null, root);
    },
  };
}

export function render(code: () => unknown, root: NodeMirror): () => void {
  const renderRoot = createRenderRoot(root);
  renderRoot.update(code());
  return () => renderRoot.dispose();
}

export const createApp = renderer.createApp;

export function createComponent<T>(Comp: (props: T) => unknown, props: T): unknown {
  return { type: Comp, props };
}

export function effect<T>(fn: (prev?: T) => T, init?: T): void {
  fn(init);
}

export function memo<T>(fn: () => T): () => T {
  return fn;
}

export function insert(_parent: NodeMirror, _accessor: unknown, _marker?: NodeMirror | null): void {}
export function spread(node: NodeMirror, props: Record<string, unknown>): void {
  for (const key in props) setProp(node, key, props[key], undefined);
}
export function mergeProps(...sources: unknown[]): unknown {
  return Object.assign({}, ...sources);
}
export function use(fn: (el: NodeMirror) => void, el: NodeMirror): void {
  fn(el);
}
