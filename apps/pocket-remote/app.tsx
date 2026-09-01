// apps/pocket-remote/app.tsx — Pocket Remote: an Omarchy companion for the
// iPod touch. Landscape, two-thumb: brightness and volume on the rails, the
// workspace strip on top, a live miniature of the desktop in the middle you
// can touch, the dock below, and a pad with the long tail. The daemon on the
// Omarchy machine mirrors Hyprland into a snapshot and runs exactly the
// commands the keyboard would (actions.ts). See README.md for the design.

import { Show } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { createGesture, type GestureContact } from "@pocketjs/framework/gesture";
import { Connect } from "./connect.tsx";
import { Desk, deskHandlers, type GestureHandlers } from "./desk.tsx";
import { KB_RECT, Keyboard, keyboardHandlers } from "./keyboard.tsx";
import { within } from "./layout.ts";
import { Pad, padHandlers } from "./pad.tsx";
import { createRemoteStore } from "./store.ts";
import { themed } from "./theme.ts";

export default function PocketRemote() {
  const store = createRemoteStore();
  // Debug handle for the headless sim test (tests/pocket-remote-sim.test.ts),
  // which has no daemon to mirror: it feeds host lines through applyLine.
  (globalThis as { __pocketRemote?: unknown }).__pocketRemote = store;

  const connected = () => store.link() === "up";
  // One recogniser for the whole screen. A tap single-fires on one owner, so
  // the sheets cannot be separate recognisers layered over the desk; instead
  // each contact is routed at its down edge to the surface under it — the
  // pad while it is open, the keyboard inside its sheet, the desk otherwise —
  // and every later callback for that contact follows the same route.
  const desk = deskHandlers(store, () => connected() && store.pad() === null);
  const pad = padHandlers(store);
  const keyboard = keyboardHandlers(store);
  const routes = new Map<number, GestureHandlers>();
  const pick = (c: GestureContact): GestureHandlers => {
    if (store.pad() !== null) return pad;
    if (store.kb() && within(c.x, c.y, KB_RECT)) return keyboard;
    return desk;
  };
  createGesture({
    tapSlop: 8,
    panSlop: 8,
    longPressSeconds: 0.35,
    onDown: (c) => {
      if (!connected()) return;
      const route = pick(c);
      routes.set(c.id, route);
      route.onDown?.(c);
    },
    // Routes are not cleared on up: onUp and onTap both describe one
    // release, and contact ids are reused only by a later onDown.
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
        <Desk store={store} />
        <Show when={store.kb() && store.pad() === null}>
          <Keyboard store={store} />
        </Show>
        <Show when={store.pad() !== null}>
          <Pad store={store} />
        </Show>
      </Show>
    </View>
  );
}
