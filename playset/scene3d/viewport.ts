// playset/scene3d/viewport.ts — <Viewport3D>: the ui-surface box a scene
// renders into.
//
// A Viewport3D is an ordinary layout box (a `view` node) bound to a Scene3D
// via `s3.bindViewport` — the host composites the rendered scene into the
// node's laid-out rect each frame, exactly the <Video>/videoBind shape.
// On hosts without a 3D core the binding is a no-op and the box renders
// empty (or whatever children you nest — HUD overlays compose as normal
// flex children ON TOP of the scene, since the scene paints as the node's
// background layer).
//
// The `scene` is fixed for the lifetime of the component instance — swap
// scenes by keying the component, not by mutating the prop.

import type { JSX as SolidJSX } from "solid-js";
import { onCleanup } from "solid-js";
import { View, type NodeMirror } from "@pocketjs/framework/components";
import type { Scene3D } from "./client.ts";

export interface Viewport3DProps {
  scene: Scene3D;
  class?: string;
  style?: Record<string, number | string>;
  debugName?: string;
  /** Overlay content (HUD) — laid out inside the viewport box, drawn above. */
  children?: SolidJSX.Element;
}

export function Viewport3D(props: Viewport3DProps): SolidJSX.Element {
  const scene = props.scene;
  return View({
    class: props.class,
    style: props.style,
    debugName: props.debugName ?? "Viewport3D",
    nodeRef: (node: NodeMirror) => {
      scene.bindViewport(node.id);
      onCleanup(() => scene.unbindViewport(node.id));
    },
    children: props.children,
  });
}
