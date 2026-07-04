export const Fragment = Symbol.for("react.fragment");

export interface VNode {
  $$typeof: symbol;
  type: unknown;
  key: string | number | null;
  ref: unknown;
  props: Record<string, unknown>;
}

const ELEMENT = Symbol.for("react.element");

export function jsx(type: unknown, props: Record<string, unknown> | null, key?: string | number): VNode {
  const out = { ...(props ?? {}) };
  const explicitKey = key ?? (out.key as string | number | undefined);
  const ref = out.ref;
  delete out.key;
  delete out.ref;
  return {
    $$typeof: ELEMENT,
    type,
    key: explicitKey ?? null,
    ref: ref ?? null,
    props: out,
  };
}

export const jsxs = jsx;
export const jsxDEV = jsx;
