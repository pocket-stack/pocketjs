// Svelte custom renderer over the shared native `ui.*` tree.
//
// Svelte's renderer contract is DOM-shaped (fragments, comments, sibling
// walking) but every node it asks for maps onto a real native node, so this is
// a thin adapter rather than a shadow tree: the mirror in native-tree.ts
// already answers the structural queries, `insertNode` already has DOM move
// semantics, and detached subtrees already die in the end-of-frame sweep.
//
// Compiled components import this module as `$renderer` — the specifier is
// baked in by framework/compiler/svelte-compile.ts.

import { createRenderer } from "svelte/renderer";
import { flushSync, mount as svelteMount, unmount as svelteUnmount } from "svelte";
import { NODE_TYPE } from "../../contracts/spec/spec.ts";
import {
  createCommentNode,
  createElement as createNativeElement,
  createTextNode as createNativeTextNode,
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
  type NodeMirror,
} from "./native-tree.ts";

export {
  createCommentNode,
  createNativeElement as createElement,
  createNativeTextNode as createTextNode,
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
  flushSync,
  type NodeMirror,
};

const DOM_ELEMENT = 1;
const DOM_TEXT = 3;
const DOM_COMMENT = 8;

/** Svelte's only structure with no native counterpart: a staging list. */
interface SvelteFragment {
  fragment: true;
  children: SvelteNode[];
}

interface SvelteMirror extends NodeMirror {
  /** Fragment staging this node. `parent` stays null so the sweep still sees it. */
  frag?: SvelteFragment | null;
  /** Text as Svelte set it, before the blank-under-a-view rule below. */
  logicalText?: string;
}

type SvelteNode = SvelteMirror | SvelteFragment;

const isFragment = (node: SvelteNode): node is SvelteFragment =>
  (node as SvelteFragment).fragment === true;

const asMirror = (node: SvelteNode): SvelteMirror => node as SvelteMirror;

function parentOf(node: SvelteNode): SvelteNode | null {
  if (isFragment(node)) return null;
  return node.frag ?? node.parent ?? null;
}

/**
 * Svelte builds templates speculatively and abandons what it does not use, so
 * every node it creates is enrolled in the end-of-frame sweep the moment it
 * exists; `insertNode` un-enrolls it again. Without this an abandoned render
 * leaks one native node per element.
 */
function track(node: NodeMirror): SvelteMirror {
  release(node);
  return node as SvelteMirror;
}

/**
 * A whitespace-only run under a view would take a slot in the flex/gap layout,
 * so it ships as empty text — which the core excludes from taffy entirely.
 * Under a text parent the same run is real content and is written through.
 */
function syncText(node: SvelteMirror): void {
  const logical = node.logicalText ?? "";
  const meaningful = logical.trim() !== "" || node.parent?.type === NODE_TYPE.text;
  const want = meaningful ? logical : "";
  if (node.text !== want) replaceText(node, want);
}

function detachFragment(node: SvelteMirror): void {
  const frag = node.frag;
  if (!frag) return;
  const index = frag.children.indexOf(node);
  if (index >= 0) frag.children.splice(index, 1);
  node.frag = null;
}

function attachFragment(frag: SvelteFragment, node: SvelteMirror, anchor: SvelteNode | null): void {
  node.frag = frag;
  const index = anchor ? frag.children.indexOf(anchor) : -1;
  if (index >= 0) frag.children.splice(index, 0, node);
  else frag.children.push(node);
}

const renderer = createRenderer<{
  fragment: SvelteFragment;
  element: SvelteMirror;
  text: SvelteMirror;
  comment: SvelteMirror;
}>({
  createFragment: (): SvelteFragment => ({ fragment: true, children: [] }),
  createElement: (name: string) => track(createNativeElement(name)),
  createTextNode: (data: string) => {
    const node = track(createNativeTextNode(""));
    node.logicalText = data;
    syncText(node);
    return node;
  },
  createComment: (data: string) => {
    const node = track(createCommentNode(data));
    node.logicalText = "";
    return node;
  },

  nodeType: (node) => {
    if (isFragment(node)) return "fragment";
    if (node.domNodeType === DOM_COMMENT) return "comment";
    return node.domNodeType === DOM_TEXT ? "text" : "element";
  },

  getNodeValue: (node) =>
    node.domNodeType === DOM_COMMENT ? node.domData ?? "" : node.logicalText ?? "",

  setText(node, text) {
    if (node.domNodeType === DOM_COMMENT) {
      node.domData = text;
      return;
    }
    node.logicalText = text;
    syncText(node);
  },

  getFirstChild: (node) => (node.children[0] as SvelteNode | undefined) ?? null,
  getLastChild: (node) => (node.children[node.children.length - 1] as SvelteNode | undefined) ?? null,
  getParent: (node) => parentOf(node),

  getNextSibling(node) {
    const parent = parentOf(node);
    if (parent === null) return null;
    const index = parent.children.indexOf(node);
    return index >= 0 ? (parent.children[index + 1] as SvelteNode | undefined) ?? null : null;
  },

  insert(parent, node, anchor) {
    if (isFragment(node)) {
      // Fragments never reach the native tree: `from_tree` stages a template in
      // one and appends it into its parent element, so splat and empty it.
      for (const child of node.children.slice()) renderer.insert(parent, child, anchor);
      node.children.length = 0;
      return;
    }

    const mirror = asMirror(node);
    detachFragment(mirror);

    if (isFragment(parent)) {
      attachFragment(parent, mirror, anchor);
      return;
    }

    insertNode(parent, mirror, anchor ? asMirror(anchor) : undefined);
    if (mirror.domNodeType === DOM_TEXT) syncText(mirror);
  },

  remove(node) {
    const mirror = asMirror(node);
    detachFragment(mirror);
    // Never destroy here: the frame's sweep does it, so a node Svelte removes
    // and re-inserts in the same frame survives (`insertNode` un-enrolls it).
    if (mirror.parent) removeNode(mirror.parent, mirror);
  },

  getAttribute: (element, name) => {
    const value = element.domAttrs?.[name];
    return value == null ? null : typeof value === "string" ? value : String(value);
  },
  hasAttribute: (element, name) => element.domAttrs !== undefined && name in element.domAttrs,

  setAttribute(element, key, value) {
    if (key === "style") {
      throw new Error(
        "PocketJS: a `style` attribute is CSS text, which the native tree has no parser for — " +
          "pass a style object to the component instead (<View style={{ width: 10 }} />)",
      );
    }
    setProp(element, key, value, element.domAttrs?.[key]);
  },

  removeAttribute(element, name) {
    // `style` never reached the node (setAttribute refuses it), so clearing it
    // when a style prop goes undefined must stay a no-op rather than throw.
    if (name !== "style") setProp(element, name, null);
  },

  addEventListener(target, type, handler) {
    if (type !== "press") {
      throw new Error(
        `PocketJS: <${target.domTag}> has no "${type}" event — the native surface exposes only ` +
          `"press" (onpress); use onFrame/onButtonPress from @pocketjs/framework/svelte/lifecycle`,
      );
    }
    setProp(target, "onPress", handler);
  },

  removeEventListener(target, type) {
    if (type === "press") setProp(target, "onPress", undefined);
  },
});

export default renderer;

/** The component type `mount()` accepts; apps hand `mount()` their default export. */
export type SvelteRenderRoot = Parameters<typeof svelteMount>[0];

/**
 * Mount a component into a native node. Svelte inserts before an anchor, so one
 * is created up front rather than letting `mount()` append a stray text node.
 */
export function mountInto(
  code: SvelteRenderRoot,
  host: NodeMirror,
  options: { props?: Record<string, unknown>; context?: Map<unknown, unknown> } = {},
): () => void {
  const anchor = createCommentNode("");
  insertNode(host, anchor);
  const instance = svelteMount(code, {
    renderer,
    target: host as never,
    anchor: anchor as never,
    props: options.props ?? {},
    ...(options.context ? { context: options.context } : {}),
  } as never);
  return () => {
    svelteUnmount(instance);
    if (anchor.parent) removeNode(anchor.parent, anchor);
  };
}

export function render(code: SvelteRenderRoot, root: NodeMirror): () => void {
  const dispose = mountInto(code, root);
  flushSync();
  return dispose;
}
