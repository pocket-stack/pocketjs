// Vue Vapor playground runtime bundle. Import-map entries for
// @pocketjs/framework/vue-vapor/* point here, while Solid entries keep using
// runtime-entry.ts.

export { frameworkName, mount, render } from "../../src/index-vue-vapor.ts";
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
} from "../../src/components-vue-vapor.ts";
export { animate, spring, cancelAnim } from "../../src/animation.ts";
export {
  onFrame,
  onButtonPress,
  createSpriteAnimation,
  pushButtonHandlerBlock,
} from "../../src/lifecycle-vue-vapor.ts";
export {
  BTN,
  focusNode,
  getFocused,
  pushFocusGrid,
  pushFocusScope,
} from "../../src/input-api.ts";

import {
  resetRendererState,
  resetSprites,
  resetTextures,
} from "../../src/renderer-vue-vapor.ts";
import { resetStyles } from "../../src/styles.ts";
import { resetPack } from "../../src/pak.ts";

export function __resetAll(): void {
  resetRendererState();
  resetTextures();
  resetSprites();
  resetStyles();
  resetPack();
  (globalThis as { frame?: unknown }).frame = undefined;
}
