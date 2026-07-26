// Vue Vapor playground runtime bundle. Import-map entries for
// @pocketjs/framework/vue-vapor/* point here, while Solid entries keep using
// runtime-entry.ts.

export { frameworkName, mount, render } from "../../framework/src/index-vue-vapor.ts";
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
} from "../../framework/src/components-vue-vapor.ts";
export { animate, spring, cancelAnim } from "../../framework/src/animation.ts";
export {
  onFrame,
  onButtonPress,
  createSpriteAnimation,
  pushButtonHandlerBlock,
} from "../../framework/src/lifecycle-vue-vapor.ts";
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
} from "../../framework/src/renderer-vue-vapor.ts";
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
