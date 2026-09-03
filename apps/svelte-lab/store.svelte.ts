// Shared reactive state in a runes module — one instance per program, so it
// outlives anything that remounts the tree. Svelte's counterpart to a Vue
// composable, with no provide/inject in the way.

export const session = $state({ presses: 0 });

export function recordPress(): void {
  session.presses += 1;
}
