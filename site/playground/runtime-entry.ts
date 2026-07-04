// site/playground/runtime-entry.ts — the ONE PocketJS runtime bundle the
// playground loads. Bun bundles it (browser, ESM, conditions:["browser"]) into
// site/dist/pg/runtime.js, and the playground import-map points EVERY PocketJS
// specifier at that one file:
//
//   "@pocketjs/framework"            -> /pg/runtime.js
//   "@pocketjs/framework/components" -> /pg/runtime.js   (etc.)
//   "@pocketjs/framework/renderer"   -> /pg/runtime.js   (babel `moduleName` target)
//
// Because all specifiers resolve to the SAME module URL, the compiled app and
// its bootstrap share ONE runtime instance — one renderer mirror tree, one
// style registry, one wasm-backed host. That singleton is exactly what we want,
// but it means we must reset it between live-recompiles (see __resetAll).
//
// The facade re-exports each public name once (curated to avoid the collisions
// a bare `export *` would hit, e.g. app-`render` vs universal-`render`).

// ---- public app surface -----------------------------------------------------
export { mount, render } from "../../src/index.ts";
export {
  View,
  Text,
  Image,
  Show,
  For,
  Index,
  Switch,
  Match,
  Screen,
  Focusable,
  FocusScope,
  FocusGrid,
  ActionHandler,
  Portal,
  Modal,
  ActionBar,
} from "../../src/components.ts";
export {
  createSignal,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  batch,
  untrack,
} from "../../src/reactivity.ts";
export { animate, spring, cancelAnim } from "../../src/animation.ts";
export {
  onFrame,
  onButtonPress,
  createSpriteAnimation,
  pushButtonHandlerBlock,
} from "../../src/lifecycle.ts";
export {
  BTN,
  focusNode,
  getFocused,
  pushFocusGrid,
  pushFocusScope,
} from "../../src/input-api.ts";

// ---- universal-renderer surface (what babel-preset-solid imports from the
// `moduleName` specifier — must exist under this one module) ------------------
export {
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} from "../../src/renderer.ts";

// ---- reset between live-recompiles -----------------------------------------
import { resetRendererState, resetTextures } from "../../src/renderer.ts";
import { resetStyles } from "../../src/styles.ts";
import { resetPack } from "../../src/dcpak.ts";

/** Wipe every runtime singleton so the NEXT mount() starts from a blank slate:
 *  the renderer mirror tree, retained/sweep sets, the class→styleId registry,
 *  the texture registry, and the cached dcpak. The wasm core is reset
 *  separately by the host (ui_init). Call BEFORE each recompiled mount(). */
export function __resetAll(): void {
  resetRendererState();
  resetTextures();
  resetStyles();
  resetPack();
  // A fresh run installs a new globalThis.frame via installFrameHandler; drop
  // the previous one so a failed compile can't leave a stale handler ticking.
  (globalThis as { frame?: unknown }).frame = undefined;
}
