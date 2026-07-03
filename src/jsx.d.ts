// JSX typings for psp-ui's three intrinsic elements: view / text / image.
//
// We reuse solid-js's JSX types for the COMPONENT side (Element, children
// unions, signals-in-JSX) but declare our OWN IntrinsicElements — the universal
// renderer has no DOM elements, only these three node types (spec.ts
// NODE_TYPE). tsconfig uses jsx:"preserve" with NO jsxImportSource, so
// TypeScript checks JSX against this global namespace while babel-preset-solid
// {generate:'universal'} owns the real transform.
//
// Prop surface is deliberately tiny (phase v1):
//   class    — whitespace-separated Tailwind-subset utility literal, compiled
//              to a styleId at build time (compiler/tailwind.ts). Dynamic
//              styling = ternaries of FULL literals, never fragments.
//   style    — dynamic per-prop overrides; keys are PROP names (spec.ts),
//              values numbers (px/scalars) or strings the renderer parses.
//   onPress  — CIRCLE press while this node is focused (input.ts).
//   focusable— joins the focus traversal order.
//   ref      — Solid ref (receives the JS mirror-node object).
// `classList` is NOT supported and errors loudly at runtime/compile [R].

import type { JSX as SolidJSX } from "solid-js";

interface ViewProps {
  class?: string;
  style?: Record<string, number | string>;
  onPress?: () => void;
  focusable?: boolean;
  ref?: any;
  children?: any;
}

interface TextProps {
  class?: string;
  children?: any;
}

interface ImageProps {
  class?: string;
  src?: string;
  style?: Record<string, number | string>;
  ref?: any;
}

declare global {
  namespace JSX {
    // What a component/JSX expression evaluates to — Solid's union (nodes,
    // strings, numbers, arrays, functions/signals...).
    type Element = SolidJSX.Element;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {
      view: ViewProps;
      text: TextProps;
      image: ImageProps;
    }
  }
}

export {};
