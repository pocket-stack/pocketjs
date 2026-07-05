// Backward-compatible Solid renderer entry.
//
// Framework-aware builds target renderer-solid.ts or renderer-vue-vapor.ts
// directly. This file keeps existing imports and tests on the Solid path.

export * from "./renderer-solid.ts";
