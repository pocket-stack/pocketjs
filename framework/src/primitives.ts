// Public platform primitives for application code.
//
// The renderer still owns the lower-case host tags internally. Apps should
// import these React Native-style components from `PocketJS` instead of writing
// host tags directly. This file intentionally contains no JSX so ordinary Bun
// tests can import the public entry without a Solid transform step.

import type { JSX as SolidJSX } from "solid-js";
import { createElement, spread } from "./renderer.ts";
import type { NodeMirror } from "./renderer.ts";
import type { TouchHandler } from "./touch-events.ts";

type StyleObject = Record<string, number | string>;
type RefProp =
  | ((node: NodeMirror) => void)
  | { current: NodeMirror | null }
  | NodeMirror
  | undefined;

/** W3C-subset touch handlers shared by every primitive (framework/src/touch-events.ts).
 *  JSX spells them onTouchstart etc.; Vue templates bind @touchstart. Both land in
 *  native-tree's touch registry via setProperty. */
export interface TouchHandlers {
  onTouchstart?: TouchHandler;
  onTouchmove?: TouchHandler;
  onTouchend?: TouchHandler;
  onTouchcancel?: TouchHandler;
}

export interface ViewProps extends TouchHandlers {
  class?: string;
  style?: StyleObject;
  onPress?: () => void;
  focusable?: boolean;
  /** DevTools semantic name shown in the component tree (docs/DEVTOOLS.md). */
  debugName?: string;
  ref?: RefProp;
  nodeRef?: RefProp;
  children?: SolidJSX.Element;
}

export interface TextProps extends TouchHandlers {
  class?: string;
  style?: StyleObject;
  /** DevTools semantic name shown in the component tree (docs/DEVTOOLS.md). */
  debugName?: string;
  ref?: RefProp;
  nodeRef?: RefProp;
  children?: SolidJSX.Element;
}

export interface ImageProps extends TouchHandlers {
  class?: string;
  src?: string;
  style?: StyleObject;
  /** DevTools semantic name shown in the component tree (docs/DEVTOOLS.md). */
  debugName?: string;
  ref?: RefProp;
  nodeRef?: RefProp;
}

function callRef(ref: RefProp, node: NodeMirror): void {
  if (!ref) return;
  if (typeof ref === "function") ref(node);
  else if ("current" in ref) ref.current = node;
}

export interface SpriteProps extends TouchHandlers {
  class?: string;
  /** DevTools semantic name shown in the component tree (docs/DEVTOOLS.md). */
  debugName?: string;
  /** Sprite-atlas key (a `ui:sprite.<name>` entry baked into the pak). */
  sprite?: string;
  style?: StyleObject;
  ref?: RefProp;
}

function primitive(tag: "view" | "text" | "image", props: Record<string, unknown>): SolidJSX.Element {
  const el = createElement(tag);
  spread(el, props, false);
  callRef(props.nodeRef as RefProp, el);
  return el as unknown as SolidJSX.Element;
}

export function View(props: ViewProps): SolidJSX.Element {
  return primitive("view", props as Record<string, unknown>);
}

export function Text(props: TextProps): SolidJSX.Element {
  return primitive("text", props as Record<string, unknown>);
}

export function Image(props: ImageProps): SolidJSX.Element {
  return primitive("image", props as Record<string, unknown>);
}

/**
 * An auto-playing animated sprite — a native primitive alongside View/Text/Image.
 * Backed by an image node whose `sprite` atlas the Rust core cycles per vblank
 * (deterministic, zero per-frame JS). It plays from the first frame the moment
 * it is displayed, so revealing/paging one starts its animation automatically.
 */
export function Sprite(props: SpriteProps): SolidJSX.Element {
  return primitive("image", props as Record<string, unknown>);
}
