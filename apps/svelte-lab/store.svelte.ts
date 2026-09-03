// Shared reactive state in a runes module: one instance per program, so it
// survives anything that remounts the tree.

export const session = $state({ presses: 0 });

export function recordPress(): void {
  session.presses += 1;
}
