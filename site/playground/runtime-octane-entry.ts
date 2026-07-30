// Octane playground runtime bundle. Import-map entries for
// @pocketjs/framework/octane/* point here, while Solid and Vue Vapor keep
// their own bundles. Compiled octane apps import the universal ABI (hooks,
// plan helpers, hookSlots/withSlot) from the renderer module, so the whole
// renderer surface is re-exported alongside the app-facing API.

export * from "../../framework/src/renderer-octane.ts";

export { frameworkName, mount, render } from "../../framework/src/index-octane.ts";
export {
  View,
  Text,
  Image,
  Sprite,
  Screen,
  Focusable,
  FocusScope,
  FocusGrid,
  ActionHandler,
  Portal,
  Modal,
  ActionBar,
  Grid,
  Lazy,
  Gallery,
} from "../../framework/src/components-octane.tsx";
export { animate, spring, cancelAnim } from "../../framework/src/animation.ts";
export {
  useFrame,
  useButtonPress,
  useSpriteAnimation,
  pushButtonHandlerBlock,
} from "../../framework/src/lifecycle-octane.ts";
export {
  BTN,
  focusNode,
  getFocused,
  pushFocusGrid,
  pushFocusScope,
} from "../../framework/src/input-api.ts";

import {
  resetRendererState,
  resetSprites,
  resetTextures,
} from "../../framework/src/renderer-octane.ts";
import { resetStyles } from "../../framework/src/styles.ts";
import { resetPack } from "../../framework/src/pak.ts";

export function __resetAll(): void {
  resetRendererState();
  resetTextures();
  resetSprites();
  resetStyles();
  resetPack();
  (globalThis as { frame?: unknown }).frame = undefined;
}
