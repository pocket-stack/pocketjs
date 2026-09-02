// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/ball.tsx — the menu's handle: a translucent ball that
// floats over everything and lives on a side edge. Tap it and Omarchy's menu
// opens; hold it and it comes along with the finger, and when let go it
// slides to the nearer edge and stays at that height. It fades while idle so
// what is under it stays legible.
//
// The mark is a glyph, not drawn rings: a stroked circle built from bordered
// Views is rasterised at the panel's logical size and looked soft on a 2x
// panel, while the glyph comes out of an atlas baked at the panel's own
// density.

import { createEffect } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { GLYPH } from "./glyphs.ts";
import type { GestureHandlers } from "./handlers.ts";
import { Icon } from "./icons.tsx";
import type { RemoteStore } from "./store.ts";
import { themed } from "./theme.ts";

export function Ball(p: { store: RemoteStore }) {
  let root: NodeMirror | null = null;
  createEffect(() => {
    if (!root) return;
    const lifted = p.store.ballDragging() || p.store.pressed() === "ball";
    jump(root, "opacity", lifted ? 1 : 0.66);
    jump(root, "scale", p.store.ballDragging() ? 1.12 : 1);
  });
  return (
    <View
      class="absolute w-[44] h-[44] rounded-full bg-[#13141ce6] items-center justify-center"
      ref={(node) => {
        root = node;
        p.store.bindBall(node);
        themed("surfaceDark")(node);
      }}
    >
      <View class="absolute left-[4] top-[4] w-[36] h-[36] rounded-full bg-[#414868]" ref={themed("surfaceMuted")} />
      <Icon glyph={GLYPH.menu} tone="fg" size="2xl" />
    </View>
  );
}

export function ballHandlers(store: RemoteStore): GestureHandlers {
  return {
    onDown: () => store.pressDown("ball"),
    onTap: () => {
      store.pressRelease();
      store.openSheet();
    },
    onLongPress: (c) => {
      store.ballGrab(c.x, c.y);
    },
    onMove: (c) => {
      if (store.ballDragging()) store.ballDragTo(c.x, c.y);
    },
    onPanStart: (c) => {
      // A drag without the hold still moves it: the ball is meant to get
      // out of the way.
      if (!store.ballDragging()) store.ballGrab(c.startX, c.startY);
      store.ballDragTo(c.x, c.y);
    },
    onPanMove: (c) => store.ballDragTo(c.x, c.y),
    onUp: () => {
      store.ballRelease();
      store.pressRelease();
    },
    onCancel: () => {
      store.ballRelease();
      store.pressRelease();
    },
  };
}
