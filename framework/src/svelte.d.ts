// TypeScript's app checker does not parse Svelte component internals. The
// Svelte language server owns template/prop inference; this ambient keeps an
// imported component a valid mount target at the TypeScript entry boundary.

declare module "*.svelte" {
  const component: import("svelte").Component<Record<string, unknown>>;
  export default component;
}
