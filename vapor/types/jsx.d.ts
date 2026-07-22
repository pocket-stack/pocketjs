// vapor/types/jsx.d.ts — JSX typings for the Pocket Vapor host vocabulary.
//
// The vocabulary is one intrinsic: <row>. A row paints its text children at
// cell (x, y) in palette `pal`, padded with spaces to the right screen edge.
// Attributes may be static numbers or reactive expressions.

declare global {
  namespace JSX {
    type Element = unknown;
    interface ElementChildrenAttribute {
      children: unknown;
    }
    interface IntrinsicElements {
      row: {
        /** Cell row, 0..19. */
        y: number;
        /** Cell column the text starts at, 0..29 (default 0). */
        x?: number;
        /** Palette bank, 0..7 (default 0). */
        pal?: number;
        children?: unknown;
      };
    }
  }
}

export {};
