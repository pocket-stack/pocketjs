// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/deck.tsx — the deck: the laptop's C surface on the
// iPod. Five compact rows of keys over a trackpad, so typing and pointing
// need no mode of their own. Keys go straight to the desktop (wtype) as they
// are pressed; nothing is buffered on the device, so what the desktop shows
// is the truth. A pressed key rises, brightens and shows its character in a
// bubble above the finger — the feedback a capacitive keyboard owes.
//
// Chords two ways: sticky modifiers (tap ctrl, then the key; ctrl arms,
// paints itself, drops after one key) and hold-and-slide variants (hold a
// letter and ^X ⌥X fan out above it; hold a digit for its F-key).
//
// The trackpad is a relative pointer: one finger moves, tap clicks, two
// fingers scroll, a two-finger tap is the right button, and a hold picks
// something up — the button stays down until the finger lifts.

import { createEffect, createSignal, Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { GLYPH } from "./glyphs.ts";
import type { GestureHandlers } from "./handlers.ts";
import { Icon } from "./icons.tsx";
import {
  bubbleRect,
  chipAt,
  chipRects,
  keyAt,
  keyboardKeys,
  type KeyAction,
  type KeyDef,
  type KeyRect,
  keyToLine,
  TRACKPAD,
} from "./keyboard-layout.ts";
import { pointerGain, type Rect, SCROLL_GAIN, stagger, within } from "./layout.ts";
import type { RemoteStore } from "./store.ts";
import { themed } from "./theme.ts";

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------

function Key(p: { store: RemoteStore; key: KeyRect }) {
  const id = () => `key:${p.key.row}:${p.key.col}`;
  const armed = () => "mod" in p.key.def.act && p.store.kbMods().includes(p.key.def.act.mod);
  let root: NodeMirror | null = null;
  let glow: NodeMirror | null = null;
  createEffect(() => {
    const depth = p.store.pressed() === id() ? p.store.pressT() : 0;
    if (root) jump(root, "scale", 1 + 0.07 * depth);
    if (glow) jump(glow, "opacity", depth);
  });
  // Geometry through the mirror, not the style object: the layer switch
  // changes a row's key count, so the slot Index reuses keeps its node and
  // has to be re-placed.
  createEffect(() => {
    if (!root) return;
    jump(root, "insetL", p.key.x);
    jump(root, "insetT", p.key.y);
    jump(root, "width", p.key.w);
    jump(root, "height", p.key.h);
  });
  return (
    <View
      class={
        armed()
          ? "absolute rounded-[7] bg-[#7aa2f7] items-center justify-center"
          : p.key.def.dark
            ? "absolute rounded-[7] bg-[#1a1b26] items-center justify-center"
            : "absolute rounded-[7] bg-[#414868] items-center justify-center"
      }
      ref={(node) => {
        root = node;
        themed(() => (armed() ? "accentFill" : p.key.def.dark ? "surface" : "surfaceMuted"))(node);
      }}
    >
      <Text
        class={
          armed()
            ? "text-sm font-bold text-[#13141c]"
            : p.key.def.dark
              ? "text-xs text-[#a9b1d6]"
              : "text-base text-[#c0caf5]"
        }
        ref={themed(() => (armed() ? "textOnAccent" : "text"))}
      >
        {p.key.def.label}
      </Text>
      <Show when={p.key.def.variants}>
        <View class="absolute left-[3] top-[3] w-[3] h-[3] rounded-[1] bg-[#565f89]" ref={themed("fgDimFill")} />
      </Show>
      <View
        class="absolute left-0 top-0 w-full h-full rounded-[7] bg-[#c0caf566]"
        ref={(node) => {
          glow = node;
          jump(node, "opacity", 0);
        }}
      />
    </View>
  );
}

/**
 * The pressed character, large, above the key. One instance follows the
 * pressed key: Show holds it while the key underneath changes, so its
 * position has to be written through the mirror rather than read once into
 * a style object — typing "hello" left the bubble parked on the h.
 */
function Bubble(p: { store: RemoteStore; key: () => KeyRect }) {
  let root: NodeMirror | null = null;
  createEffect(() => {
    if (!root) return;
    const r = bubbleRect(p.key());
    jump(root, "insetL", r.x);
    jump(root, "insetT", r.y);
    jump(root, "width", r.w);
    jump(root, "height", r.h);
  });
  createEffect(() => {
    if (!root) return;
    const depth = p.store.pressT();
    jump(root, "opacity", depth);
    jump(root, "translateY", Math.round((1 - depth) * 8));
    jump(root, "scale", 0.9 + 0.1 * depth);
  });
  return (
    <View
      class="absolute rounded-[9] bg-[#c0caf5] items-center justify-center"
      ref={(node) => {
        root = node;
        themed("fgFill")(node);
      }}
    >
      <Text class="text-2xl font-bold text-[#13141c]" ref={themed("textOnAccent")}>
        {p.key().def.label}
      </Text>
    </View>
  );
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
      class={p.hot ? "absolute rounded-[9] bg-[#7aa2f7] items-center justify-center" : "absolute rounded-[9] bg-[#c0caf5] items-center justify-center"}
      style={{ insetL: p.rect.x, insetT: p.rect.y, width: p.rect.w, height: p.rect.h }}
      ref={(node) => {
        root = node;
        themed(() => (p.hot ? "accentFill" : "fgFill"))(node);
      }}
    >
      <Text class="text-base font-bold text-[#13141c]" ref={themed("textOnAccent")}>
        {p.label}
      </Text>
    </View>
  );
}

function Keyboard(p: { store: RemoteStore }) {
  const keys = () => keyboardKeys(p.store.kbLayer());
  const pressedKey = (): KeyRect | null => {
    const id = p.store.pressed();
    if (!id || !id.startsWith("key:")) return null;
    const [, row, col] = id.split(":");
    const key = keys().find((k) => k.row === Number(row) && k.col === Number(col));
    return key && "ch" in key.def.act ? key : null;
  };
  return (
    <>
      <Index each={keys()}>{(key) => <Key store={p.store} key={key()} />}</Index>
      <Show when={p.store.keyFly()}>
        {(f) => (
          <Index each={chipRects(f().key, f().variants.length)}>
            {(rect, i) => <Chip store={p.store} rect={rect()} label={f().variants[i]!.label} i={i} count={f().variants.length} hot={f().hot === i} />}
          </Index>
        )}
      </Show>
      <Show when={!p.store.keyFly() && pressedKey()}>
        <Bubble store={p.store} key={() => pressedKey()!} />
      </Show>
    </>
  );
}

// ---------------------------------------------------------------------------
// trackpad
// ---------------------------------------------------------------------------

function Trackpad(p: { store: RemoteStore }) {
  const target = () => {
    const c = p.store.focusClass();
    const mods = p.store.kbMods();
    const prefix = mods.length ? `${mods.join(" + ")} + ` : "";
    return c ? `${prefix}${c}` : `${prefix}no focused window`;
  };
  return (
    <View
      class={
        p.store.pressed() === "pad:drag"
          ? "absolute rounded-[10] bg-[#1f2335] border border-[#7aa2f7]"
          : p.store.pressed() === "pad"
            ? "absolute rounded-[10] bg-[#1f2335] border border-[#565f89]"
            : "absolute rounded-[10] bg-[#1a1b26] border border-[#414868]"
      }
      style={{ insetL: TRACKPAD.x, insetT: TRACKPAD.y, width: TRACKPAD.w, height: TRACKPAD.h }}
      ref={(node) => {
        themed("surface")(node);
        themed(() => (p.store.pressed() === "pad:drag" ? "borderAccent" : "borderMuted"))(node);
      }}
    >
      <View class="absolute left-[10] top-[6] w-[20] h-[20] items-center justify-center">
        <Icon glyph={GLYPH.trackpad} tone="dim" size="base" />
      </View>
      <View class="absolute left-[34] top-[6] w-[200] h-[20] items-center overflow-hidden">
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {target()}
        </Text>
      </View>
      <View class="absolute right-[10] top-[6] w-[240] h-[20] items-center justify-end">
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {p.store.pressed() === "pad:drag" ? "dragging · lift to drop" : "tap · two fingers scroll · hold to drag"}
        </Text>
      </View>
    </View>
  );
}

export function Deck(p: { store: RemoteStore }) {
  return (
    <View class="absolute left-0 top-[28] w-[480] h-[292] bg-[#13141c] overflow-hidden" ref={themed("surfaceDark")}>
      <View class="absolute w-[480] h-[320]" style={{ insetL: 0, insetT: -28 }}>
        <Keyboard store={p.store} />
        <Trackpad store={p.store} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// gestures
// ---------------------------------------------------------------------------

export function deckHandlers(store: RemoteStore): GestureHandlers {
  const [down, setDown] = createSignal<KeyRect | null>(null);
  let holding = false;

  // Trackpad contacts, by id. A second finger makes the gesture two-finger
  // for the rest of its life: scroll while they move, the right button if
  // they lift without moving.
  const pads = new Map<number, { moved: boolean }>();
  let twoFinger = false;
  let twoFingerMoved = false;
  let leader: number | null = null;
  let dragging = false;

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
    if ("mod" in act) {
      const mods = store.kbMods();
      store.setKbMods(mods.includes(act.mod) ? mods.filter((m) => m !== act.mod) : [...mods, act.mod]);
      return;
    }
    send(act);
    // One-shot shift: the upper layer drops back after a character.
    if ("ch" in act && store.kbLayer() === "upper") store.setKbLayer("lower");
  };

  const onPad = (x: number, y: number) => within(x, y, TRACKPAD);

  return {
    onDown: (c) => {
      holding = false;
      if (onPad(c.x, c.y)) {
        setDown(null);
        pads.set(c.id, { moved: false });
        if (pads.size >= 2) {
          twoFinger = true;
          twoFingerMoved = false;
        } else {
          leader = c.id;
        }
        store.pressDown(dragging ? "pad:drag" : "pad");
        return;
      }
      const key = keyAt(store.kbLayer(), c.x, c.y);
      setDown(key);
      store.pressDown(key ? `key:${key.row}:${key.col}` : null);
    },
    onMove: (c) => {
      const pad = pads.get(c.id);
      if (pad) {
        if (c.fdx === 0 && c.fdy === 0) return;
        if (Math.abs(c.dx) > 3 || Math.abs(c.dy) > 3) pad.moved = true;
        if (twoFinger) {
          if (c.id === leader) {
            store.scroll(c.fdx * SCROLL_GAIN, c.fdy * SCROLL_GAIN);
            twoFingerMoved = true;
          }
          return;
        }
        const gain = pointerGain(Math.hypot(c.fdx, c.fdy));
        store.pointer(c.fdx * gain, c.fdy * gain);
        return;
      }
      if (!holding) return;
      const key = down();
      const f = store.keyFly();
      if (!key || !f) return;
      store.keyHover(chipAt(key, f.variants.length, c.x, c.y));
    },
    onTap: (c) => {
      if (pads.has(c.id)) {
        // The tap resolves at the last finger's up (below); a two-finger
        // tap must not also click twice.
        return;
      }
      const key = down();
      store.pressRelease();
      if (key) press(key);
      setDown(null);
    },
    onLongPress: (c) => {
      const pad = pads.get(c.id);
      if (pad) {
        if (twoFinger || pad.moved || dragging) return;
        dragging = true;
        store.dragButton(true);
        store.pressDown("pad:drag");
        return;
      }
      const key = down();
      if (!key || !key.def.variants) return;
      holding = true;
      store.pressDown(null);
      store.openKeyFly({ key: { x: key.x, y: key.y, w: key.w, h: key.h }, variants: key.def.variants, hot: null });
    },
    onPanStart: (c) => {
      if (pads.has(c.id) || holding) return;
      store.pressDown(null);
      setDown(null);
    },
    onUp: (c) => {
      const pad = pads.get(c.id);
      if (pad) {
        pads.delete(c.id);
        if (pads.size === 0) {
          if (twoFinger) {
            if (!twoFingerMoved) store.click("r");
            twoFinger = false;
          } else if (dragging) {
            store.dragButton(false);
          } else if (!pad.moved && c.frames < 20) {
            store.click("l");
          }
          dragging = false;
          leader = null;
          store.pressRelease();
        } else if (c.id === leader) {
          leader = pads.keys().next().value ?? null;
        }
        return;
      }
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
    onCancel: (c) => {
      if (pads.delete(c.id) && pads.size === 0) {
        if (dragging) store.dragButton(false);
        dragging = false;
        twoFinger = false;
        leader = null;
      }
      if (holding) store.closeKeyFly();
      holding = false;
      store.pressRelease();
      setDown(null);
    },
  };
}

export type { KeyDef };
