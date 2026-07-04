// JSX typings for PocketJS application code.

declare global {
  namespace JSX {
    type Element = unknown;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {
      view: Record<string, unknown>;
      text: Record<string, unknown>;
      image: Record<string, unknown>;
    }
  }
}

export {};
