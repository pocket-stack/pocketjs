// Shared prop shapes and the two helpers every host primitive needs.
//
// `class`, `focusable` and `debugName` ride the element's own attributes —
// Svelte hands those through to the renderer as raw values. `style` and
// `onPress` cannot: a `style` attribute is CSS text, and an always-registered
// press wrapper would swallow the CIRCLE bubble that input.ts walks to the
// nearest ancestor with a handler. Both are applied from an attachment instead.

import type { Snippet } from "svelte";
import { setProp, type NodeMirror } from "../renderer-svelte.ts";

export type { NodeMirror };
export type StyleObject = Record<string, number | string>;
export type NodeRef = (node: NodeMirror) => void;

export interface ViewProps {
  class?: string;
  style?: StyleObject;
  onPress?: () => void;
  focusable?: boolean;
  /** DevTools semantic name shown in the component tree (docs/DEVTOOLS.md). */
  debugName?: string;
  nodeRef?: NodeRef;
  children?: Snippet;
}

export interface TextProps {
  class?: string;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
  children?: Snippet;
}

export interface ImageProps {
  class?: string;
  src?: string;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
}

export interface SpriteProps {
  class?: string;
  sprite?: string;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
}

export interface CompositorSurfaceProps {
  class?: string;
  package: string;
  focused?: boolean;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
}

/** `active` accepts a value or a getter, the convention the other frameworks use. */
export function resolveActive(active: boolean | (() => boolean) | undefined): boolean {
  if (typeof active === "function") return active();
  return active ?? true;
}

export function applyStyle(node: NodeMirror, style: StyleObject | undefined): void {
  setProp(node, "style", style, node.domAttrs?.style);
}

export function applyPress(node: NodeMirror, onPress: (() => void) | undefined): void {
  setProp(node, "onPress", onPress);
}
