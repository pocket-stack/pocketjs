// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/control.tsx — the control centre: a card that hangs
// from its button at the strip's right end. Wi-Fi, a screenshot, nightlight,
// what is playing with its transport, then brightness and volume as
// sliders. Levels follow the finger relatively — touching a slider never
// jumps the level to the finger — and a tap on a track nudges by a step.
// Opened by a tap it stays until a tap outside; opened by a hold it follows
// that finger down onto a slider and puts itself away after the release.

import { createEffect, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { GLYPH } from "./glyphs.ts";
import type { GestureHandlers } from "./handlers.ts";
import { Icon } from "./icons.tsx";
import {
  CC,
  CC_BUTTON,
  CC_ICON_W,
  CC_ICON_X,
  CC_MEDIA,
  CC_MEDIA_BTN_W,
  CC_MEDIA_BTN_X,
  CC_NIGHT,
  CC_ROW_Y,
  CC_SHOT,
  CC_TRACK_H,
  CC_TRACK_W,
  CC_TRACK_X,
  CC_VALUE_X,
  CC_WIFI,
  ccHit,
  clamp01,
  trackDelta,
  trackFill,
  within,
} from "./layout.ts";
import type { RemoteStore } from "./store.ts";
import { themed } from "./theme.ts";

function Slider(p: { store: RemoteStore; row: 0 | 1 }) {
  const level = () => (p.row === 0 ? p.store.bri() : p.store.vol());
  const hot = () => p.store.cc()?.row === p.row;
  let fill: NodeMirror | null = null;
  createEffect(() => {
    if (fill) jump(fill, "width", trackFill(level()));
  });
  const glyph = () => {
    if (p.row === 0) return GLYPH.brightness;
    if (p.store.mute() || p.store.vol() === 0) return GLYPH.volumeOff;
    return p.store.vol() < 0.5 ? GLYPH.volumeMid : GLYPH.volume;
  };
  return (
    <View class="absolute left-0 w-[268] h-[36]" style={{ insetT: CC_ROW_Y[p.row] }}>
      <View
        class={hot() ? "absolute top-0 w-[36] h-[36] rounded-[10] bg-[#7aa2f733] items-center justify-center" : "absolute top-0 w-[36] h-[36] rounded-[10] bg-[#1a1b26] items-center justify-center"}
        style={{ insetL: CC_ICON_X, width: CC_ICON_W }}
        ref={themed(() => (hot() ? "accentTint" : "surface"))}
      >
        <Icon glyph={glyph} tone={() => (p.row === 1 && p.store.mute() ? "dim" : "fg")} size="lg" />
        <View class={p.store.pressed() === `ccicon:${p.row}` ? "absolute left-0 top-0 w-[36] h-[36] rounded-[10] bg-[#ffffff22]" : "hidden"} />
      </View>
      <View
        class="absolute top-[13] rounded-[5] bg-[#414868] overflow-hidden"
        style={{ insetL: CC_TRACK_X, width: CC_TRACK_W, height: CC_TRACK_H }}
        ref={themed("surfaceMuted")}
      >
        <View
          class="absolute left-0 top-0 w-0 h-[10] rounded-[5] bg-[#7aa2f7]"
          ref={(node) => {
            fill = node;
            themed("accentFill")(node);
            jump(node, "width", trackFill(level()));
          }}
        />
      </View>
      <View class="absolute top-[10] w-[38] h-[16] items-center justify-center" style={{ insetL: CC_VALUE_X }}>
        <Text class={hot() ? "text-xs font-bold text-[#7aa2f7]" : "text-xs text-[#565f89]"} ref={themed(() => (hot() ? "textAccent" : "textDim"))}>
          {`${Math.round(level() * 100)}`}
        </Text>
      </View>
    </View>
  );
}

export function ControlCentre(p: { store: RemoteStore }) {
  let root: NodeMirror | null = null;
  createEffect(() => {
    if (!root) return;
    const t = p.store.ccT();
    jump(root, "translateY", Math.round((1 - t) * -10));
    jump(root, "opacity", t);
  });
  const wifi = () => p.store.wifi();
  const media = () => p.store.media();
  const pressed = (id: string) => p.store.pressed() === id;
  return (
    <View
      class="absolute left-0 top-0 w-[480] h-[320]"
      ref={(node) => {
        root = node;
      }}
    >
      {/* caret under the button */}
      <View
        class="absolute w-[16] h-[16] rotate-45 bg-[#414868]"
        style={{ insetL: CC_BUTTON.x + CC_BUTTON.w / 2 - 8, insetT: CC.y - 8 }}
        ref={themed("surfaceMuted")}
      />
      <View
        class="absolute rounded-[14] bg-[#13141c] border border-[#414868] overflow-hidden"
        style={{ insetL: CC.x, insetT: CC.y, width: CC.w, height: CC.h }}
        ref={(node) => {
          themed("surfaceDark")(node);
          themed("borderMuted")(node);
        }}
      >
        {/* wifi */}
        <View
          class={wifi().on ? "absolute rounded-[12] bg-[#7aa2f7]" : "absolute rounded-[12] bg-[#1a1b26]"}
          style={{ insetL: CC_WIFI.x, insetT: CC_WIFI.y, width: CC_WIFI.w, height: CC_WIFI.h }}
          ref={themed(() => (wifi().on ? "accentFill" : "surface"))}
        >
          <View class="absolute left-[10] top-[14] w-[24] h-[24] items-center justify-center">
            <Icon glyph={() => (wifi().on ? GLYPH.wifi : GLYPH.wifiOff)} tone={() => (wifi().on ? "onAccent" : "dim")} size="xl" />
          </View>
          <View class="absolute left-[42] top-[9] h-[18] justify-center">
            <Text class={wifi().on ? "text-sm font-bold text-[#13141c]" : "text-sm font-bold text-[#a9b1d6]"} ref={themed(() => (wifi().on ? "textOnAccent" : "text"))}>
              Wi-Fi
            </Text>
          </View>
          <View class="absolute left-[42] top-[27] w-[84] h-[16] items-start justify-center overflow-hidden">
            <Text class={wifi().on ? "text-xs text-[#13141c]" : "text-xs text-[#565f89]"} ref={themed(() => (wifi().on ? "textOnAccent" : "textDim"))}>
              {wifi().on ? (wifi().ssid || "not connected") : "off"}
            </Text>
          </View>
          <View class={pressed("cc:wifi") ? "absolute left-0 top-0 w-full h-full rounded-[12] bg-[#ffffff22]" : "hidden"} />
        </View>
        {/* screenshot */}
        <View
          class="absolute rounded-[12] bg-[#1a1b26] items-center justify-center"
          style={{ insetL: CC_SHOT.x, insetT: CC_SHOT.y, width: CC_SHOT.w, height: CC_SHOT.h }}
          ref={themed("surface")}
        >
          <Icon glyph={GLYPH.camera} tone="fg" size="xl" />
          <View class={pressed("cc:shot") ? "absolute left-0 top-0 w-full h-full rounded-[12] bg-[#ffffff22]" : "hidden"} />
        </View>
        {/* nightlight */}
        <View
          class="absolute rounded-[12] bg-[#1a1b26] items-center justify-center"
          style={{ insetL: CC_NIGHT.x, insetT: CC_NIGHT.y, width: CC_NIGHT.w, height: CC_NIGHT.h }}
          ref={themed("surface")}
        >
          <Icon glyph={GLYPH.night} tone="fg" size="xl" />
          <View class={pressed("cc:night") ? "absolute left-0 top-0 w-full h-full rounded-[12] bg-[#ffffff22]" : "hidden"} />
        </View>
        {/* now playing */}
        <View
          class="absolute rounded-[12] bg-[#1a1b26]"
          style={{ insetL: CC_MEDIA.x, insetT: CC_MEDIA.y, width: CC_MEDIA.w, height: CC_MEDIA.h }}
          ref={themed("surface")}
        >
          <View class="absolute left-[10] top-[12] w-[24] h-[24] items-center justify-center">
            <Icon glyph={GLYPH.music} tone={() => (media().st === "playing" ? "accent" : "dim")} size="xl" />
          </View>
          <View class="absolute left-[42] top-[6] w-[100] h-[18] items-start justify-center overflow-hidden">
            <Text class="text-sm text-[#c0caf5]" ref={themed("text")}>
              {media().st === "none" ? "Nothing playing" : media().title || "Untitled"}
            </Text>
          </View>
          <View class="absolute left-[42] top-[25] w-[100] h-[16] items-start justify-center overflow-hidden">
            <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
              {media().st === "none" ? "" : media().artist}
            </Text>
          </View>
          <View class="absolute top-0 w-[36] h-[48] items-center justify-center" style={{ insetL: CC_MEDIA_BTN_X[0] - CC_MEDIA.x }}>
            <Icon glyph={GLYPH.prev} tone="fg" size="xl" />
            <View class={pressed("cc:prev") ? "absolute left-0 top-0 w-[36] h-[48] rounded-[8] bg-[#ffffff22]" : "hidden"} />
          </View>
          <View class="absolute top-0 w-[36] h-[48] items-center justify-center" style={{ insetL: CC_MEDIA_BTN_X[1] - CC_MEDIA.x }}>
            <Icon glyph={() => (media().st === "playing" ? GLYPH.pause : GLYPH.play)} tone="fg" size="2xl" />
            <View class={pressed("cc:play") ? "absolute left-0 top-0 w-[36] h-[48] rounded-[8] bg-[#ffffff22]" : "hidden"} />
          </View>
          <View class="absolute top-0 w-[36] h-[48] items-center justify-center" style={{ insetL: CC_MEDIA_BTN_X[2] - CC_MEDIA.x }}>
            <Icon glyph={GLYPH.next} tone="fg" size="xl" />
            <View class={pressed("cc:next") ? "absolute left-0 top-0 w-[36] h-[48] rounded-[8] bg-[#ffffff22]" : "hidden"} />
          </View>
        </View>
        <Slider store={p.store} row={0} />
        <Slider store={p.store} row={1} />
      </View>
      <Show when={p.store.cc()?.mode === "hold"}>
        <View class="absolute top-[212] w-[268] h-[14] items-center justify-center" style={{ insetL: CC.x }}>
          <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
            slide onto a slider · release to close
          </Text>
        </View>
      </Show>
    </View>
  );
}

/** While the control centre is up (sticky): tiles and buttons answer taps,
 *  tracks drag relatively, a touch anywhere else puts it away. */
export function ccHandlers(store: RemoteStore): GestureHandlers {
  let down: ReturnType<typeof ccHit> | "button" | "outside" = null;
  const pressIdFor = (hit: ReturnType<typeof ccHit>): string | null => {
    if (!hit) return null;
    if (hit.kind === "icon") return `ccicon:${hit.row}`;
    if (hit.kind === "track" || hit.kind === "card" || hit.kind === "media") return null;
    return `cc:${hit.kind}`;
  };
  return {
    onDown: (c) => {
      if (within(c.x, c.y, CC_BUTTON)) {
        down = "button";
        store.pressDown("cc");
        return;
      }
      const hit = ccHit(c.x, c.y);
      if (!hit) {
        down = "outside";
        store.closeCc();
        return;
      }
      down = hit;
      store.pressDown(pressIdFor(hit));
      if (hit.kind === "track") store.ccGrabTrack(hit.row, c.x);
    },
    onTap: (c) => {
      const t = down;
      store.pressRelease();
      if (t === "button") {
        store.closeCc();
        return;
      }
      if (!t || t === "outside") return;
      switch (t.kind) {
        case "wifi":
          store.wifiToggle();
          break;
        case "shot":
          store.act("screenshot");
          break;
        case "night":
          store.act("nightlight");
          break;
        case "prev":
        case "play":
        case "next":
          store.mediaOp(t.kind);
          break;
        case "icon":
          if (t.row === 1) store.toggleMute();
          break;
        case "track": {
          // A tap on the track nudges by the keyboard's own step.
          const level = t.row === 0 ? store.bri() : store.vol();
          const knob = CC.x + CC_TRACK_X + trackFill(level);
          store.setLevel(t.row === 0 ? "bri" : "vol", level + (c.x > knob ? 0.05 : -0.05), true);
          store.ccReleased();
          break;
        }
        default:
          break;
      }
    },
    onPanStart: () => {
      if (!down || down === "button" || down === "outside" || down.kind !== "track") store.pressDown(null);
    },
    onPanMove: (c) => {
      const cc = store.cc();
      if (!cc || cc.row === null || !down || down === "button" || down === "outside" || down.kind !== "track") return;
      store.setLevel(cc.row === 0 ? "bri" : "vol", clamp01(cc.refLevel + trackDelta(c.x - cc.refX)));
    },
    onUp: () => {
      const cc = store.cc();
      if (cc && cc.row !== null && down && down !== "button" && down !== "outside" && down.kind === "track") store.ccReleased();
      store.pressRelease();
    },
    onCancel: () => {
      store.pressRelease();
    },
  };
}

export { CC_MEDIA_BTN_W };
