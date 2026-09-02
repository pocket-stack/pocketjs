// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/connect.tsx — what the remote shows before it has a
// desktop to mirror: looking for the daemon's beacon, then waiting for the
// laptop to approve this device (the daemon puts a dialog on the desktop),
// then nothing — the desk takes over. A pulse keeps the screen visibly alive
// during the wait, which on a WiFi handheld can take a few seconds.

import { createEffect, createSignal, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { RemoteStore } from "./store.ts";
import { themed } from "./theme.ts";

export function Connect(p: { store: RemoteStore }) {
  const [phase, setPhase] = createSignal(0);
  let frames = 0;
  onFrame(() => {
    frames += 1;
    if (frames % 2 === 0) setPhase((frames / 2) % 60);
  });
  let ring: NodeMirror | null = null;
  createEffect(() => {
    if (!ring) return;
    const t = phase() / 60;
    // A ring that grows and fades, once a second.
    jump(ring, "scale", 1 + t * 0.7);
    jump(ring, "opacity", 1 - t);
  });
  const status = () => {
    switch (p.store.link()) {
      case "off":
        return "this host has no network channel";
      case "search":
        return "looking for your Omarchy desktop…";
      case "pending":
        return `approve this remote on ${p.store.hostName() || "your laptop"}`;
      case "denied":
        return `${p.store.hostName() || "the laptop"} declined this remote`;
      default:
        return "";
    }
  };
  return (
    <View class="absolute left-0 top-0 w-[480] h-[320] bg-[#1a1b26]" ref={themed("surface")}>
      <View
        class="absolute left-[212] top-[90] w-[56] h-[56] rounded-full border-2 border-[#7aa2f7]"
        ref={(node) => {
          ring = node;
          themed("borderAccent")(node);
        }}
      />
      <View class="absolute left-[228] top-[106] w-[24] h-[24] rounded-full bg-[#7aa2f7]" ref={themed("accentFill")} />
      <View class="absolute left-0 top-[160] w-[480] h-[32] items-center justify-center">
        <Text class="text-2xl font-bold text-[#c0caf5]" ref={themed("text")}>
          Pocket Remote
        </Text>
      </View>
      <View class="absolute left-0 top-[196] w-[480] h-[20] items-center justify-center">
        <Text class="text-sm text-[#565f89]" ref={themed("textDim")}>
          {status()}
        </Text>
      </View>
      <Show when={p.store.link() === "pending"}>
        <View class="absolute left-[140] top-[236] w-[200] h-[28] rounded-[14] bg-[#414868] items-center justify-center" ref={themed("surfaceMuted")}>
          <Text class="text-xs text-[#a9b1d6]" ref={themed("text")}>
            a dialog is on the laptop screen
          </Text>
        </View>
      </Show>
      <View class="absolute left-0 top-[290] w-[480] h-[20] items-center justify-center">
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          an Omarchy companion · PocketJS
        </Text>
      </View>
    </View>
  );
}
