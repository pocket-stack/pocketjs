// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/app.tsx — Pocket Remote: an Omarchy companion for the
// iPod touch. Landscape: the workspace strip on top with the mode switch
// centred and the control centre at its end; under it either the stage (a
// live miniature of the desktop you can touch, over a fixed launch bar) or
// the deck (keyboard over trackpad); a ball on one edge that opens
// Omarchy's menu as a sheet. The daemon on the Omarchy
// machine mirrors Hyprland into a snapshot and runs exactly the commands
// the keyboard would. See README.md for the design.

import { Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { Ball, ballHandlers } from "./ball.tsx";
import { Connect } from "./connect.tsx";
import { ccHandlers, ControlCentre } from "./control.tsx";
import { Deck, deckHandlers } from "./deck.tsx";
import type { GestureHandlers } from "./handlers.ts";
import { ballHit, STRIP } from "./layout.ts";
import { MenuSheet, sheetHandlers } from "./menu-sheet.tsx";
import { LaunchBar, popupHandlers, Stage, stageHandlers, TilePopup } from "./stage.tsx";
import { connectSvc, createRemoteStore, type Svc } from "./store.ts";
import { Strip, stripHandlers } from "./strip.tsx";
import { themed } from "./theme.ts";

/** The last action's name, briefly, over the top of the stage. */
function Toast(p: { store: ReturnType<typeof createRemoteStore> }) {
  return (
    <Show when={p.store.toast() !== ""}>
      <View class="absolute left-[140] top-[36] w-[200] h-[24] rounded-[12] bg-[#7aa2f7] items-center justify-center" ref={themed("accentFill")}>
        <Text class="text-xs font-bold text-[#13141c]" ref={themed("textOnAccent")}>
          {p.store.toast()}
        </Text>
      </View>
    </Show>
  );
}

export default function PocketRemote() {
  // The headless sim (tests/pocket-remote-sim.test.ts) has no svc channel;
  // it may install a fake one before the bundle runs to see what the remote
  // would send, and reads the store back to feed host lines in.
  const store = createRemoteStore((globalThis as { __pocketRemoteSvc?: Svc }).__pocketRemoteSvc ?? connectSvc());
  (globalThis as { __pocketRemote?: unknown }).__pocketRemote = store;

  const connected = () => store.link() === "up";
  // One recogniser for the whole screen. A tap single-fires on one owner, so
  // the layers cannot be separate recognisers stacked over each other;
  // instead each contact is routed at its down edge to the surface under it
  // — the sheet, the control centre or a popup while one is up, the ball,
  // the strip, then the stage or the deck — and every later callback for
  // that contact follows the same route.
  const strip = stripHandlers(store);
  const stage = stageHandlers(store);
  const popup = popupHandlers(store);
  const control = ccHandlers(store);
  const ball = ballHandlers(store);
  const sheet = sheetHandlers(store);
  const deck = deckHandlers(store);
  const routes = new Map<number, GestureHandlers>();
  const pick = (x: number, y: number): GestureHandlers => {
    if (store.sheet()) return sheet;
    if (store.cc()) return control;
    if (store.popup()) return popup;
    // A tile's resize corner wins where the ball overlaps it: the corner is
    // 18 px and fixed to its window, the ball is 44 px and can be dragged.
    if (store.mode() === "stage" && ballHit(x, y, store.ball()) && !store.gripAt(x, y)) return ball;
    if (y < STRIP.h) return strip;
    return store.mode() === "stage" ? stage : deck;
  };
  createGesture({
    tapSlop: 8,
    panSlop: 8,
    longPressSeconds: 0.35,
    onDown: (c) => {
      if (!connected()) return;
      const route = pick(c.x, c.y);
      routes.set(c.id, route);
      route.onDown?.(c);
    },
    // Routes are not cleared on up: onUp and onTap both describe one
    // release, and contact ids are reused only by a later onDown.
    onMove: (c) => routes.get(c.id)?.onMove?.(c),
    onTap: (c) => routes.get(c.id)?.onTap?.(c),
    onLongPress: (c) => routes.get(c.id)?.onLongPress?.(c),
    onPanStart: (c) => routes.get(c.id)?.onPanStart?.(c),
    onPanMove: (c) => routes.get(c.id)?.onPanMove?.(c),
    onUp: (c) => routes.get(c.id)?.onUp?.(c),
    onCancel: (c) => routes.get(c.id)?.onCancel?.(c),
  });

  return (
    <View class="absolute left-0 top-0 w-[480] h-[320] bg-[#1a1b26] overflow-hidden" ref={themed("surface")}>
      <Show when={connected()} fallback={<Connect store={store} />}>
        <Strip store={store} />
        <Show when={store.mode() === "stage"} fallback={<Deck store={store} />}>
          <Stage store={store} />
          <LaunchBar store={store} />
        </Show>
        <TilePopup store={store} />
        <Toast store={store} />
        {/* The ball belongs to the stage: on the deck it would sit on the
            trackpad, and the deck has SUPER for Omarchy's own menu. */}
        <Show when={!store.sheet() && store.mode() === "stage"}>
          <Ball store={store} />
        </Show>
        <Show when={store.cc()}>
          <ControlCentre store={store} />
        </Show>
        <Show when={store.sheet()}>
          <MenuSheet store={store} />
        </Show>
      </Show>
    </View>
  );
}
