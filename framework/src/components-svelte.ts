// Public platform primitives for Svelte application code.
//
// The renderer still owns the lower-case host tags internally; apps import
// these components rather than writing `<view>` directly. `class`, `focusable`
// and `debugName` ride the host element's attributes; `style`, `onPress` and
// `nodeRef` are applied from attachments (see ./svelte/props.ts).

export { default as View } from "./svelte/View.svelte";
export { default as Text } from "./svelte/Text.svelte";
export { default as Image } from "./svelte/Image.svelte";
export { default as Sprite } from "./svelte/Sprite.svelte";
export { default as CompositorSurface } from "./svelte/CompositorSurface.svelte";
export { default as Screen } from "./svelte/Screen.svelte";
export { default as Focusable } from "./svelte/Focusable.svelte";
export { default as FocusScope } from "./svelte/FocusScope.svelte";
export { default as FocusGrid } from "./svelte/FocusGrid.svelte";
export { default as ActionHandler } from "./svelte/ActionHandler.svelte";
export { default as Portal } from "./svelte/Portal.svelte";
export { default as AuxiliarySurface } from "./svelte/AuxiliarySurface.svelte";
export { default as AuxiliaryPortal } from "./svelte/AuxiliaryPortal.svelte";
export { default as Modal } from "./svelte/Modal.svelte";
export { default as ActionBar } from "./svelte/ActionBar.svelte";
export { default as Grid } from "./svelte/Grid.svelte";
export { default as Lazy } from "./svelte/Lazy.svelte";
export { default as Gallery } from "./svelte/Gallery.svelte";

export type {
  CompositorSurfaceProps,
  ImageProps,
  NodeRef,
  SpriteProps,
  StyleObject,
  TextProps,
  ViewProps,
} from "./svelte/props.ts";
export type { NodeMirror } from "./renderer-svelte.ts";
