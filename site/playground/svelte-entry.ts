// The Svelte runtime, as ONE browser bundle. Compiled playground components
// import `svelte/internal/client`, `svelte/internal/flags/custom-renderer` and
// (for onMount and friends) `svelte`; the page import-map points all three
// here, so the flag and the reactivity graph have exactly one instance.
//
// The explicit re-exports below shadow the star export where the public API
// and the internal client share a name.

import "svelte/internal/flags/custom-renderer";

export * from "svelte/internal/client";
export { createRenderer } from "svelte/renderer";
export {
  createRawSnippet,
  flushSync,
  getAllContexts,
  getContext,
  hasContext,
  hydrate,
  mount,
  onDestroy,
  onMount,
  setContext,
  tick,
  unmount,
  untrack,
} from "svelte";
