// demos/youtube/player.tsx — the playback screen.
//
// One full-screen Image node bound to the native video plane (spec ops
// 34..37): videoOpen() on entry, videoTick() every frame (the bounded USB IO
// pump — it returns the presented source frame index, which IS the play
// clock), videoClose() on the way out. The HUD (title, progress, hints)
// rides hot.prop/hot.text — per-frame paint-only writes, no reactive churn.
//
// Input: ○ pause/resume · ◁/▷ seek ±10 s · × back to results.

import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { getOps } from "@pocketjs/framework/host";
import * as hot from "@pocketjs/framework/hot";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import type { YoutubeStore } from "./store.ts";

const INK = "#e8f0f2";
const DIM = "#8fa3ad";
const RED = "#ff4757";

function fmt(s: number): string {
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);
  const sec = Math.floor(s % 60);
  const ms = `${m}:${String(sec).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : ms;
}

/** Frames the HUD stays up after the last input. */
const HUD_FRAMES = 180;

export default function Player(props: { store: YoutubeStore }) {
  const ops = getOps();
  let plane: NodeMirror | undefined;
  let hud: NodeMirror | undefined;
  let bar: NodeMirror | undefined;
  let clock: NodeMirror | undefined;
  let currentS = 0;
  let hudLeft = HUD_FRAMES;
  const [planeOk, setPlaneOk] = createSignal(false);

  // A fresh "playing" reply = a fresh .pkst file: (re)open the stream and
  // rebind the plane texture. playSerial() is the tracked trigger.
  createEffect(() => {
    props.store.playSerial();
    const p = props.store.player();
    if (!p) return;
    setPlaneOk(ops.videoOpen?.(p.stream) ?? false);
    currentS = 0;
    hudLeft = HUD_FRAMES;
    if (planeOk() && plane) {
      const tex = ops.videoTexture?.() ?? -1;
      if (tex >= 0) ops.setImage(plane.id, tex);
    }
  });

  onCleanup(() => {
    ops.videoClose?.();
  });

  onFrame((buttons) => {
    const p = props.store.player();
    if (planeOk()) {
      const idx = ops.videoTick?.() ?? -1;
      if (idx >= 0 && p) currentS = idx / p.fps;
    }
    hudLeft = buttons !== 0 ? HUD_FRAMES : Math.max(0, hudLeft - 1);
    const paused = p ? !p.playing || p.ended : false;
    hot.prop(hud, "opacity", hudLeft > 0 || paused ? 1 : 0);
    if (p && p.durationS > 0) {
      hot.prop(bar, "scaleX", Math.min(1, currentS / p.durationS));
      hot.text(clock, `${fmt(currentS)} / ${fmt(p.durationS)}`);
    }
  });

  onButtonPress(BTN.CIRCLE, () => props.store.togglePause());
  onButtonPress(BTN.START, () => props.store.togglePause());
  onButtonPress(BTN.LEFT, () => props.store.seekTo(currentS - 10));
  onButtonPress(BTN.RIGHT, () => props.store.seekTo(currentS + 10));
  onButtonPress(BTN.CROSS, () => props.store.stopPlayback());

  return (
    <View class="w-full h-full" style={{ bgColor: "#000000" }}>
      {/* The plane: a 256x128 CLUT8 texture the native side updates in
          place, stretched to the full screen (bilinear). */}
      <Image nodeRef={(n) => (plane = n)} style={{ width: 480, height: 272 }} />

      <Show when={!planeOk()}>
        <View class="absolute inset-0 items-center justify-center flex-col gap-2">
          <Text class="text-sm tracking-wide" style={{ textColor: DIM }}>
            {props.store.transport() === "http"
              ? "STREAMING TO THE HOST — VIDEO PLANE IS PSP-ONLY"
              : "VIDEO PLANE UNAVAILABLE"}
          </Text>
        </View>
      </Show>

      {/* Instant pause feedback: the store flips `playing` optimistically on
          the very press frame, so this badge appears immediately — the
          PICTURE freezes a beat later (host SIGSTOP + ring drain), and
          without the badge that gap reads as "the button didn't work". */}
      <Show when={props.store.player() && !props.store.player()!.playing && !props.store.player()!.ended}>
        <View class="absolute inset-0 items-center justify-center">
          <View class="w-[56] h-[56] rounded-[28] bg-[#000000b4] border-[#ffffff2e] flex-row items-center justify-center gap-2">
            <View class="w-[7] h-[24] rounded-sm bg-[#ffffff]" />
            <View class="w-[7] h-[24] rounded-sm bg-[#ffffff]" />
          </View>
        </View>
      </Show>

      {/* HUD overlay (hot-driven opacity; shown while inputs are fresh). */}
      <View
        nodeRef={(n) => (hud = n)}
        class="absolute inset-0 flex-col justify-between"
        style={{ opacity: 1 }}
      >
        <View class="px-3 py-2 bg-[#000000aa]">
          <Text class="text-sm font-bold" style={{ textColor: INK, lineHeight: 16 }}>
            {props.store.player()?.title ?? ""}
          </Text>
        </View>
        <View class="flex-col gap-1 px-3 py-2 bg-[#000000aa]">
          <Show when={props.store.player()?.ended}>
            <Text class="text-xs font-bold tracking-wide" style={{ textColor: RED }}>
              ENDED — ◁ REWIND OR × BACK
            </Text>
          </Show>
          <Show when={props.store.player() && !props.store.player()!.playing && !props.store.player()!.ended}>
            <Text class="text-xs font-bold tracking-wide" style={{ textColor: RED }}>
              PAUSED
            </Text>
          </Show>
          <View class="w-full h-[3] bg-[#2a3542] rounded-sm">
            <View
              nodeRef={(n) => (bar = n)}
              class="w-full h-full rounded-sm"
              style={{ bgColor: RED, scaleX: 0, originX: -0.5 }}
            />
          </View>
          <View class="flex-row justify-between items-center">
            <Text nodeRef={(n) => (clock = n)} class="text-xs" style={{ textColor: INK, width: 110, lineHeight: 13 }}>
              0:00 / 0:00
            </Text>
            <Text class="text-xs tracking-wide" style={{ textColor: DIM, lineHeight: 13 }}>
              ○ PAUSE · ◁▷ ±10s · × BACK
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}
