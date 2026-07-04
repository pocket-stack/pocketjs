import { Fragment, jsx, type VNode } from "./react-jsx-runtime.ts";

export { Fragment };

export type ReactNode = unknown;
export type ReactElement = VNode;
export type Key = string | number;
export type ComponentType<P = Record<string, unknown>> = (props: P) => ReactNode;

export function createElement(
  type: unknown,
  config?: Record<string, unknown> | null,
  ...children: unknown[]
): VNode {
  const props = { ...(config ?? {}) };
  if (children.length === 1) props.children = children[0];
  else if (children.length > 1) props.children = children;
  return jsx(type, props, props.key as Key | undefined);
}

export function isValidElement(value: unknown): value is VNode {
  return !!value && typeof value === "object" && (value as { $$typeof?: unknown }).$$typeof === Symbol.for("react.element");
}

function flatten(value: unknown, out: unknown[]): void {
  if (value == null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const child of value) flatten(child, out);
    return;
  }
  out.push(value);
}

export const Children = {
  toArray(children: unknown): unknown[] {
    const out: unknown[] = [];
    flatten(children, out);
    return out;
  },
};

export function forwardRef<P>(
  render: (props: P, ref: unknown) => ReactNode,
): (props: P & { ref?: unknown }) => ReactNode {
  return (props) => render(props, props.ref);
}

export function createRef<T = unknown>(): { current: T | null } {
  return { current: null };
}

export default {
  Children,
  Fragment,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
};
