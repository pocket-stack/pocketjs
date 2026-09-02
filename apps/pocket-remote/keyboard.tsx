// apps/pocket-remote/keyboard.tsx — the whole iPod as a keyboard. When
// typing is the job, nothing else on the remote matters, so the sheet takes
// the full 480x320: five rows of 48 px keys, ten columns, a caption naming
// the window the keys land in and a chevron to put the keyboard away.
//
// Keys go straight to the desktop (wtype) as they are pressed; nothing is
// buffered on the device, so what the desktop shows is the truth.
//
// Developers type chords, so the keyboard has two ways to make them:
//   - sticky modifiers: tap ctrl (or alt), then the key — the modifier arms,
//     paints itself, and drops after one key;
//   - hold-and-slide: hold a letter and its variants fan out above it
//     (^x · ⌥x); slide onto one and release. Digits offer their F-key and
//     ctrl variant the same way. Releasing on the key itself types it plain.
//
// Geometry and the key table live in keyboard-layout.ts.

import { createEffect, createSignal, Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import type { GestureHandlers } from "./desk.tsx";
import { Icon } from "./icons.tsx";
import {
  CAPTION_H,
  chipAt,
  chipRects,
  HIDE_W,
  KB_RECT,
  keyAt,
  keyboardKeys,
  type KeyAction,
  type KeyDef,
  type KeyRect,
  keyToLine,
} from "./keyboard-layout.ts";
import { type Rect, SCREEN_W, stagger } from "./layout.ts";
import type { RemoteStore } from "./store.ts";
import { themed } from "./theme.ts";

export { KB_RECT } from "./keyboard-layout.ts";

export function keyboardHandlers(store: RemoteStore): GestureHandlers {
  const [down, setDown] = createSignal<KeyRect | null>(null);
  let holding = false;
  const active = () => store.kb() && store.pad() === null;

  const send = (act: KeyAction) => {
    const mods = store.kbMods();
    const line = keyToLine(act, mods);
    if (line) {
      if (line.t === "type") store.typeText(line.text);
      else store.typeKey(line.k, line.mods ?? []);
    }
    if (mods.length) store.setKbMods([]);
  };

  const press = (key: KeyRect) => {
    const act = key.def.act;
    if ("layer" in act) {
      store.setKbLayer(act.layer);
      return;
    }
    if ("hide" in act) {
      store.setKb(false);
      return;
    }
    if ("mod" in act) {
      const mods = store.kbMods();
      store.setKbMods(mods.includes(act.mod) ? mods.filter((m) => m !== act.mod) : [...mods, act.mod]);
      return;
    }
    send(act);
    // One-shot shift: the upper layer drops back after a letter.
    if ("ch" in act && store.kbLayer() === "upper") store.setKbLayer("lower");
  };

  return {
    onDown: (c) => {
      if (!active()) return;
      holding = false;
      if (c.y < CAPTION_H) {
        setDown(null);
        if (c.x >= SCREEN_W - HIDE_W) store.pressDown("kbhide");
        return;
      }
      const key = keyAt(store.kbLayer(), c.x, c.y);
      setDown(key);
      if (key) store.pressDown(`key:${key.row}:${key.col}`);
    },
    onMove: (c) => {
      if (!active() || !holding) return;
      const key = down();
      const f = store.flyout();
      if (!key || !f || f.kind !== "keyvar") return;
      store.keyHover(chipAt(key, f.variants.length, c.x, c.y));
    },
    onTap: () => {
      if (!active()) return;
      const key = down();
      if (store.pressed() === "kbhide") {
        store.pressRelease();
        store.setKb(false);
        return;
      }
      store.pressRelease();
      if (key) press(key);
      setDown(null);
    },
    onLongPress: () => {
      if (!active()) return;
      const key = down();
      if (!key || !key.def.variants) return;
      holding = true;
      store.pressDown(null);
      store.openFlyout({ kind: "keyvar", key: { x: key.x, y: key.y, w: key.w, h: key.h }, variants: key.def.variants, hot: null });
    },
    onPanStart: () => {
      if (holding) return;
      store.pressDown(null);
      setDown(null);
    },
    onUp: () => {
      if (!active()) return;
      if (holding) {
        const chosen = store.keyRelease();
        const key = down();
        if (chosen) store.typeKey(chosen.k, chosen.mods);
        else if (key && "ch" in key.def.act) send(key.def.act); // release on the key: plain
        holding = false;
        setDown(null);
      }
      store.pressRelease();
    },
    onCancel: () => {
      if (holding) store.closeFlyout();
      holding = false;
      store.pressRelease();
      setDown(null);
    },
  };
}

function Chip(p: { store: RemoteStore; rect: Rect; label: string; i: number; count: number; hot: boolean }) {
  let root: NodeMirror | null = null;
  createEffect(() => {
    if (!root) return;
    const t = stagger(p.store.flyT(), p.i, p.count, 0.3);
    jump(root, "translateY", Math.round((1 - t) * 10));
    jump(root, "opacity", t);
    jump(root, "scale", p.hot ? 1.08 : 1);
  });
  return (
    <View
      class={
        p.hot
          ? "absolute rounded-[10] bg-[#7aa2f7] items-center justify-center"
          : "absolute rounded-[10] bg-[#a9b1d6] items-center justify-center"
      }
      style={{ insetL: p.rect.x, insetT: p.rect.y, width: p.rect.w, height: p.rect.h }}
      ref={(node) => {
        root = node;
        // A light chip over dark keys: the iOS accent-popup contrast.
        themed(() => (p.hot ? "accentFill" : "fgFill"))(node);
      }}
    >
      <Text class="text-base font-bold text-[#13141c]" ref={themed("textOnAccent")}>
        {p.label}
      </Text>
    </View>
  );
}

export function Keyboard(p: { store: RemoteStore }) {
  const keys = () => keyboardKeys(p.store.kbLayer());
  const target = () => {
    const c = p.store.focusClass();
    const mods = p.store.kbMods();
    const prefix = mods.length ? `${mods.join(" + ")} + ` : "";
    return c ? `${prefix}typing into ${c}` : `${prefix}no focused window`;
  };
  const fly = () => {
    const f = p.store.flyout();
    return f && f.kind === "keyvar" ? f : null;
  };
  const armed = (def: KeyDef) => "mod" in def.act && p.store.kbMods().includes(def.act.mod);
  return (
    <View class="absolute left-0 top-0 w-[480] h-[320] bg-[#13141c] overflow-hidden" ref={themed("surfaceDark")}>
      <View class="absolute left-[12] top-0 w-[400] h-[28] justify-center">
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {target()}
        </Text>
      </View>
      {/* hide */}
      <View class="absolute left-[436] top-[2] w-[44] h-[24] items-center justify-center">
        <View class="absolute left-[10] top-0 w-[24] h-[24]">
          <Icon name="hide" tone="fg" />
        </View>
        <View class={p.store.pressed() === "kbhide" ? "absolute left-0 top-0 w-[44] h-[24] rounded-[6] bg-[#ffffff22]" : "hidden"} />
      </View>
      <Index each={keys()}>
        {(key) => (
          <View
            class={
              armed(key().def)
                ? "absolute rounded-[8] bg-[#7aa2f7] items-center justify-center"
                : key().def.dark
                  ? "absolute rounded-[8] bg-[#1a1b26] items-center justify-center"
                  : "absolute rounded-[8] bg-[#414868] items-center justify-center"
            }
            style={{ insetL: key().x, insetT: key().y, width: key().w, height: key().h }}
            ref={themed(() => (armed(key().def) ? "accentFill" : key().def.dark ? "surface" : "surfaceMuted"))}
          >
            <Text
              class={
                armed(key().def)
                  ? "text-sm font-bold text-[#13141c]"
                  : key().def.dark
                    ? "text-sm text-[#a9b1d6]"
                    : "text-lg text-[#c0caf5]"
              }
              ref={themed(() => (armed(key().def) ? "textOnAccent" : "text"))}
            >
              {key().def.label}
            </Text>
            <Show when={key().def.variants}>
              <View class="absolute left-[3] top-[3] w-[3] h-[3] rounded-[1] bg-[#565f89]" ref={themed("fgDimFill")} />
            </Show>
            <View
              class={
                p.store.pressed() === `key:${key().row}:${key().col}`
                  ? "absolute left-0 top-0 w-full h-full rounded-[8] bg-[#ffffff33]"
                  : "hidden"
              }
            />
          </View>
        )}
      </Index>
      <Show when={fly()}>
        {(f) => (
          <Index each={chipRects(f().key, f().variants.length)}>
            {(rect, i) => (
              <Chip store={p.store} rect={rect()} label={f().variants[i]!.label} i={i} count={f().variants.length} hot={f().hot === i} />
            )}
          </Index>
        )}
      </Show>
      <Show when={p.store.kbLayer() === "upper"}>
        <View class="absolute left-[4] top-[10] w-[6] h-[6] rounded-full bg-[#7aa2f7]" ref={themed("accentFill")} />
      </Show>
    </View>
  );
}
