// TypeScript's app checker does not parse Vue SFC internals. The Vue language
// server owns template/prop inference; this ambient keeps an imported SFC a
// valid component at the TypeScript entry boundary.

declare module "*.vue" {
  const component: import("vue").VaporComponent;
  export default component;
}
