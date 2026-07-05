// Public platform primitives for application code.
//
// The renderer still owns the lower-case host tags internally. Apps should
// import these React Native-style components from `PocketJS` instead of writing
// host tags directly. This file intentionally contains no JSX so ordinary Bun
// tests can import the public entry without a Solid transform step.

import type { JSX as SolidJSX } from "solid-js";
import { createElement, spread } from "./renderer.ts";
import type { NodeMirror } from "./renderer.ts";

type StyleObject = Record<string, number | string>;
type RefProp =
  | ((node: NodeMirror) => void)
  | { current: NodeMirror | null }
  | NodeMirror
  | undefined;

export interface ViewProps {
  class?: string;
  style?: StyleObject;
  onPress?: () => void;
  focusable?: boolean;
  ref?: RefProp;
  nodeRef?: RefProp;
  children?: SolidJSX.Element;
}

export interface TextProps {
  class?: string;
  style?: StyleObject;
  ref?: RefProp;
  nodeRef?: RefProp;
  children?: SolidJSX.Element;
}

export interface ImageProps {
  class?: string;
  src?: string;
  style?: StyleObject;
  ref?: RefProp;
  nodeRef?: RefProp;
}

function callRef(ref: RefProp, node: NodeMirror): void {
  if (!ref) return;
  if (typeof ref === "function") ref(node);
  else if ("current" in ref) ref.current = node;
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
