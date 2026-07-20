// @pocketjs/playset — game-mechanism playsets for Pocket.
//
// Structure (see SKILL.md for the copy-into-project workflow):
//   math/     three-compatible math value types (Vector3, Quaternion, ...)
//   scene3d/  the scene3d presentation surface (ops contract, client, viewport)
//   modules/  the ported GameBlocks module library (motion, camera, gameplay,
//             behavior, world, user-interface) — vendored per game project
//   loop.ts   fixed-step game loop on the virtual clock

export * from "./math/index.ts";
export * from "./scene3d/index.ts";
export { createGameLoop, FIXED_DT, type GameInput, type GameLoopOptions } from "./loop.ts";
