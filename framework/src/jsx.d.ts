// JSX typings for PocketJS application code.
//
// The public UI surface is imported components (`View`, `Text`, `Image`) from
// `PocketJS`. Lower-case host tags (`view`, `text`, `image`) are renderer
// implementation details and are intentionally not declared as global JSX
// intrinsics; accidental app usage should fail typecheck.

import type { Element as SolidElement } from "solid-js";

declare global {
  namespace JSX {
    // What a component/JSX expression evaluates to: Solid's union of nodes,
    // strings, numbers, arrays and accessors.
    type Element = SolidElement;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {}
  }
}

export {};
