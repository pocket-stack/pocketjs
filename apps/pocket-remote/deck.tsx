// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/deck.tsx — the deck: the laptop's C surface on the
// iPod. Five rows of keys, and under them the band a laptop uses the same
// way — Omarchy's menu key and the click button on the left rest, the
// trackpad in the middle, a d-pad cross on the right rest.
//
// Keys go straight to the desktop (wtype) as they are pressed; nothing is
// buffered on the device, so what the desktop shows is the truth. A pressed
// key rises and brightens; the hit regions tile the keyboard and correct for
// where a finger actually lands (keyboard-layout.ts).
//
// Chords two ways: sticky modifiers (tap ctrl, alt or super, then the key;
// it arms, paints itself, drops after one key) and hold-and-slide variants
// (hold a letter and ^X ⌥X fan out above it; hold a digit for its F-key).
// The modifiers reach the pointer too: ctrl then a click is a ctrl-click,
// and ctrl with the click key held is a ctrl-drag.
//
// The click key is the drag-select the pad could not model: hold it with one
// thumb and the laptop's left button stays down, so the other finger's
// travel on the pad drags a selection — a laptop's own two-handed gesture.

import { createEffect, createSignal, Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { GLYPH } from "./glyphs.ts";
import type { GestureHandlers } from "./handlers.ts";
import { Icon } from "./icons.tsx";
import {
  chipAt,
  chipRects,
  CLICK_KEY,
  deckTargetAt,
  DIRECTION_GLYPH,
  type Direction4,
  DPAD_KEYS,
  keyboardKeys,
  type KeyAction,
  type KeyDef,
  type KeyRect,
  keyToLine,
  MENU_KEY,
  TRACKPAD,
} from "./keyboard-layout.ts";
import { pointerGain, type Rect, SCROLL_GAIN, stagger } from "./layout.ts";
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
      <Show
        when={!p.key.def.glyph}
        fallback={<Icon glyph={p.key.def.glyph ?? ""} tone={() => (armed() ? "onAccent" : "fg")} size="xl" />}
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
    </>
  );
}

// ---------------------------------------------------------------------------
// the band: menu, click, trackpad, d-pad
// ---------------------------------------------------------------------------

function MenuButton(p: { store: RemoteStore }) {
  return (
    <View
      class="absolute rounded-[10] bg-[#1a1b26] border border-[#414868] items-center justify-center"
      style={{ insetL: MENU_KEY.x, insetT: MENU_KEY.y, width: MENU_KEY.w, height: MENU_KEY.h }}
      ref={(node) => {
        themed("surface")(node);
        themed("borderMuted")(node);
      }}
    >
      <Icon glyph={GLYPH.menu} tone="fg" size="2xl" />
      <View class={p.store.pressed() === "deck:menu" ? "absolute left-0 top-0 w-full h-full rounded-[10] bg-[#ffffff22]" : "hidden"} />
    </View>
  );
}

/**
 * The click button: a tap is a click, and holding it keeps the laptop's left
 * button down so the other finger's travel on the pad drags a selection.
 *
 * Held, it fills with the accent rather than tinting: a rounded node with a
 * coloured border is drawn by filling the whole rounded box with the BORDER
 * colour and insetting the background over it (engine draw.rs), so a
 * translucent fill inside a border shows the border's colour through it.
 */
function ClickButton(p: { store: RemoteStore }) {
  const held = () => p.store.clickHeld();
  return (
    <View
      class={
        held()
          ? "absolute rounded-[10] bg-[#7aa2f7] items-center justify-center"
          : "absolute rounded-[10] bg-[#1a1b26] border border-[#414868] items-center justify-center"
      }
      style={{ insetL: CLICK_KEY.x, insetT: CLICK_KEY.y, width: CLICK_KEY.w, height: CLICK_KEY.h }}
      ref={(node) => {
        themed(() => (held() ? "accentFill" : "surface"))(node);
        themed(() => (held() ? "accentFill" : "borderMuted"))(node);
      }}
    >
      <Text
        class={held() ? "text-xs font-bold text-[#13141c]" : "text-xs text-[#a9b1d6]"}
        ref={themed(() => (held() ? "textOnAccent" : "text"))}
      >
        {held() ? "held" : "click"}
      </Text>
      <View class={p.store.pressed() === "deck:click" ? "absolute left-0 top-0 w-full h-full rounded-[10] bg-[#ffffff22]" : "hidden"} />
    </View>
  );
}

function DpadCross(p: { store: RemoteStore }) {
  const dirs: Direction4[] = ["u", "l", "r", "d"];
  return (
    <Index each={dirs}>
      {(dir) => {
        const r = DPAD_KEYS[dir()];
        const down = () => p.store.dpad()?.dir === dir();
        return (
          <View
            class={
              down()
                ? "absolute rounded-[8] bg-[#7aa2f7] items-center justify-center"
                : "absolute rounded-[8] bg-[#1a1b26] border border-[#414868] items-center justify-center"
            }
            style={{ insetL: r.x, insetT: r.y, width: r.w, height: r.h }}
            ref={(node) => {
              themed(() => (down() ? "accentFill" : "surface"))(node);
              themed(() => (down() ? "accentFill" : "borderMuted"))(node);
            }}
          >
            <Text
              class={down() ? "text-base font-bold text-[#13141c]" : "text-base text-[#a9b1d6]"}
              ref={themed(() => (down() ? "textOnAccent" : "text"))}
            >
              {DIRECTION_GLYPH[dir()]}
            </Text>
          </View>
        );
      }}
    </Index>
  );
}

function Trackpad(p: { store: RemoteStore }) {
  const target = () => {
    const c = p.store.focusClass();
    const mods = p.store.kbMods();
    const prefix = mods.length ? `${mods.join(" + ")} + ` : "";
    return c ? `${prefix}${c}` : `${prefix}no focused window`;
  };
  const hint = () =>
    p.store.clickHeld()
      ? "held · slide to select"
      : p.store.pressed() === "pad:drag"
        ? "dragging · lift to drop"
        : "tap · two fingers scroll";
  const lit = () => p.store.clickHeld() || p.store.pressed() === "pad:drag";
  return (
    <View
      class={
        lit()
          ? "absolute rounded-[10] bg-[#1f2335] border border-[#7aa2f7]"
          : p.store.pressed() === "pad"
            ? "absolute rounded-[10] bg-[#1f2335] border border-[#565f89]"
            : "absolute rounded-[10] bg-[#1a1b26] border border-[#414868]"
      }
      style={{ insetL: TRACKPAD.x, insetT: TRACKPAD.y, width: TRACKPAD.w, height: TRACKPAD.h }}
      ref={(node) => {
        themed("surface")(node);
        themed(() => (lit() ? "borderAccent" : "borderMuted"))(node);
      }}
    >
      <View class="absolute left-[8] top-[5] w-[20] h-[20] items-center justify-center">
        <Icon glyph={GLYPH.trackpad} tone="dim" size="base" />
      </View>
      <View class="absolute left-[32] top-[5] w-[100] h-[20] items-center overflow-hidden">
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {target()}
        </Text>
      </View>
      <View class="absolute right-[8] top-[5] w-[144] h-[20] items-center justify-end">
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {hint()}
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
        <MenuButton store={p.store} />
        <ClickButton store={p.store} />
        <Trackpad store={p.store} />
        <DpadCross store={p.store} />
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
  /** Contacts that own one of the band's buttons. */
  let clicker: number | null = null;
  let steering: { id: number; dir: Direction4 } | null = null;
  let menuing: number | null = null;

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

  return {
    onDown: (c) => {
      holding = false;
      const target = deckTargetAt(store.kbLayer(), c.x, c.y);
      setDown(null);
      switch (target.kind) {
        case "pad":
          pads.set(c.id, { moved: false });
          if (pads.size >= 2) {
            twoFinger = true;
            twoFingerMoved = false;
          } else {
            leader = c.id;
          }
          store.pressDown(dragging ? "pad:drag" : "pad");
          return;
        case "menu":
          menuing = c.id;
          store.pressDown("deck:menu");
          return;
        case "click":
          // The button goes down with the finger: a tap is a click, and a
          // hold leaves it down for the other finger to drag with.
          clicker = c.id;
          store.pressDown("deck:click");
          store.dragButton(true);
          return;
        case "dpad":
          steering = { id: c.id, dir: target.dir };
          store.pressDown(`dpad:${target.dir}`);
          store.dpadDown(target.dir);
          return;
        case "key":
          setDown(target.key);
          store.pressDown(`key:${target.key.row}:${target.key.col}`);
          return;
        default:
          store.pressDown(null);
      }
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
      // The pad, the click key and the d-pad all answer on release.
      if (pads.has(c.id) || clicker === c.id || steering?.id === c.id) return;
      if (menuing === c.id) {
        menuing = null;
        store.pressRelease();
        store.openSheet();
        return;
      }
      const key = down();
      store.pressRelease();
      if (key) press(key);
      setDown(null);
    },
    onLongPress: (c) => {
      if (clicker === c.id || steering?.id === c.id || menuing === c.id) return;
      const pad = pads.get(c.id);
      if (pad) {
        if (twoFinger || pad.moved || dragging || store.clickHeld()) return;
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
      if (pads.has(c.id) || holding || clicker === c.id || steering?.id === c.id) return;
      store.pressDown(null);
      setDown(null);
      menuing = null;
    },
    onUp: (c) => {
      if (clicker === c.id) {
        clicker = null;
        store.dragButton(false);
        store.pressRelease();
        return;
      }
      if (steering?.id === c.id) {
        steering = null;
        store.dpadUp();
        store.pressRelease();
        return;
      }
      const pad = pads.get(c.id);
      if (pad) {
        pads.delete(c.id);
        if (pads.size === 0) {
          if (twoFinger) {
            if (!twoFingerMoved) store.click("r");
            twoFinger = false;
          } else if (dragging) {
            store.dragButton(false);
          } else if (!pad.moved && c.frames < 20 && !store.clickHeld()) {
            // With the click key's button already down, a tap on the pad
            // would be a second press rather than a click.
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
      if (clicker === c.id) {
        clicker = null;
        store.dragButton(false);
      }
      if (steering?.id === c.id) {
        steering = null;
        store.dpadUp();
      }
      menuing = null;
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
