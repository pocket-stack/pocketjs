import type { JSX as SolidJSX } from "solid-js";
import { createElement, spread } from "./renderer-solid.ts";
import type { NodeMirror } from "./renderer-solid.ts";

type StyleObject = Record<string, number | string>;
type NodeRef = ((node: NodeMirror | null) => void) | { current: NodeMirror | null } | undefined;

export interface ViewProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  onPress?: () => void;
  focusable?: boolean;
  nodeRef?: NodeRef;
  ref?: NodeRef;
  children?: SolidJSX.Element;
}

export interface TextProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  nodeRef?: NodeRef;
  ref?: NodeRef;
  children?: SolidJSX.Element;
}

export interface ImageProps {
  class?: string;
  className?: string;
  src?: string;
  style?: StyleObject;
  nodeRef?: NodeRef;
  ref?: NodeRef;
}

function assignRef(ref: NodeRef, node: NodeMirror | null): void {
  if (!ref) return;
  if (typeof ref === "function") ref(node);
  else ref.current = node;
}

function primitive(tag: "view" | "text" | "image", props: Record<string, unknown>): SolidJSX.Element {
  const el = createElement(tag);
  const { nodeRef, ref, className, ...rest } = props;
  const hostProps = {
    ...rest,
    class: props.class ?? className,
    ref: (node: NodeMirror) => {
      assignRef(nodeRef as NodeRef, node);
      assignRef(ref as NodeRef, node);
    },
  };
  spread(el, hostProps, false);
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
