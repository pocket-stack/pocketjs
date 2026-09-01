// JSX typings for PocketJS application code.
//
// The public UI surface is imported components (`View`, `Text`, `Image`) from
// `PocketJS`. Lower-case host tags (`view`, `text`, `image`) are renderer
// implementation details and are intentionally not declared as global JSX
// intrinsics; accidental app usage should fail typecheck.

import type { JSX as SolidJSX } from "solid-js";

declare global {
  // solid-js's JSX.Element refers to the DOM `Node` type. PocketJS does not
  // include lib.dom, so provide an opaque type-only stand-in; otherwise the
  // unresolved name degrades to `any` under skipLibCheck and generic control
  // flow children such as <Show>{(value) => ...}</Show> lose contextual types.
  interface Node {
    readonly __pocketjs_solid_node__: unique symbol;
  }

  namespace JSX {
    // What a component/JSX expression evaluates to: Solid's union of nodes,
    // strings, numbers, arrays and accessors.
    type Element = SolidJSX.Element;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {}
  }
}

export {};
