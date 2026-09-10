// The edit keyboard: the classic early-iOS portrait layout (apps/clear/
// kb-layout.ts) rendered as four static layer panels that slide on and off
// the paint axis — a layer flip costs four prop writes and zero re-renders.
// Pressing a character key raises the classic key-cap popup: a balloon above
// the key showing the glyph enlarged, visible while the finger is down.
//
// Shift is one-shot (typing a letter on the upper layer drops back to
// lower); the numbers layer's third-row-left key toggles "#+=" symbols in
// place while the bottom-left key stays "ABC" on both, like the original.

import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { virtualNow } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { shallowRef, onScopeDispose } from "vue";
import { createKeyboardTouch } from "./keyboard-touch.ts";
import { remoteText, hasCompanion } from "./remote-text.tsx";
import type { ImeState } from "@pocketjs/framework/ime";
import { SCREEN_H } from "./metrics.ts";
import { IME_BAR_H } from "./keyboard-metrics.ts";
import { KB_GAP, KB_H, KB_PAD, KB_ROW_H, KB_W } from "./keyboard-metrics.ts";
import { KB_LAYERS, kbKeyAt, type KbKey, type KbLayerName } from "./kb-layout.ts";

export { KB_GAP, KB_H, KB_PAD, KB_ROW_H, KB_W } from "./keyboard-metrics.ts";

/** Key-cap gradients: an all-dark scheme (deliberately NOT the classic iOS
 *  chrome — same layout, own look). Character caps are a lighter graphite
 *  than the action caps; the engaged shift flips to a light cap. */
const CAP_FROM = "#3a3f46";
const CAP_TO = "#2d3138";
const CAP_PRESS_FROM = "#5c626b";
const CAP_PRESS_TO = "#4b515a";
const ACTION_FROM = "#24272c";
const ACTION_TO = "#1a1d21";
const ACTION_PRESS_FROM = "#3d4249";
const ACTION_PRESS_TO = "#31363c";
const ENGAGED_FROM = "#dfe2e6";
const ENGAGED_TO = "#c9cdd3";
const ENGAGED_PRESS_FROM = "#b7bcc3";
const ENGAGED_PRESS_TO = "#a8adb5";

const POPUP_W = 44;
const POPUP_H = 46;

export interface KeyboardHandlers {
  onInsert(ch: string): void;
  onBackspace(): void;
  onEnter(): void;
  onMode?(): void;
  onCandidate?(index: number): void;
  onPage?(direction: number): void;
  onCaret?(direction: number): void;
  onCancelComposition?(): void;
}

const LAYER_NAMES: readonly KbLayerName[] = ["lower", "upper", "numbers", "symbols"];

export interface Keyboard {
  view: JSX.Element;
  height(): number;
  setIme(state: ImeState, chinese: boolean): void;
  /** Dock/undock the panel (animated). */
  setOpen(open: boolean): void;
  isOpen(): boolean;
  /** The docked panel's screen rect, for the gesture region. */
  rect(): { x: number; y: number; w: number; h: number } | null;
  /** Route a contact's down edge (screen coordinates) into a key press. */
  pressAt(x: number, y: number, screenH: number, id?: number): void;
  moveAt(x: number, y: number, id?: number): void;
  /** The contact lifted (or was cancelled): dismiss the key-cap popup. */
  release(id?: number, cancelled?: boolean): void;
}

type CapKind = "char" | "action" | "engaged";

/** Character caps are graphite, action caps darker; the shift key on the
 *  upper layer renders as the light "engaged" cap. */
function capKind(key: KbKey, layer: KbLayerName): CapKind {
  if (key.action === "shift" && layer === "upper") return "engaged";
  return key.ch !== undefined ? "char" : "action";
}

const CAP_COLORS: Record<CapKind, [string, string, string, string]> = {
  char: [CAP_FROM, CAP_TO, CAP_PRESS_FROM, CAP_PRESS_TO],
  action: [ACTION_FROM, ACTION_TO, ACTION_PRESS_FROM, ACTION_PRESS_TO],
  engaged: [ENGAGED_FROM, ENGAGED_TO, ENGAGED_PRESS_FROM, ENGAGED_PRESS_TO],
};

export function makeKeyboard(handlers: KeyboardHandlers): Keyboard {
  const imeHeight = hasCompanion() ? IME_BAR_H : 0;
  const imeStatus = shallowRef("EN");
  const preedit = shallowRef("");
  const candidates = Array.from({ length: 5 }, () => shallowRef(""));
  const layerNodes = new Map<KbLayerName, NodeMirror>();
  const keyNodes = new Map<string, NodeMirror>();
  const spaceNodes = new Set<NodeMirror>();
  let spacePressed = false;
  let panel: NodeMirror | null = null;
  let popupNode: NodeMirror | null = null;
  const popupText = shallowRef("");
  const tracking = shallowRef(false), detent = shallowRef(false);
  let popupOwner = -1, popupAt = 0, popupHideAt = Infinity, detentUntil = 0;
  let open = false;
  let layer: KbLayerName = "lower";
  const touch = createKeyboardTouch({
    space: () => handlers.onInsert(" "), backspace: () => handlers.onBackspace(),
    caret: direction => handlers.onCaret?.(direction),
    trackpad(active) {
      tracking.value = active;
      if (active && popupNode) { jump(popupNode, "opacity", 0); popupOwner = -1; popupHideAt = Infinity; }
    },
    detent() { detent.value = true; detentUntil = virtualNow() + 0.075; },
  });
  onFrame(() => {
    const now = virtualNow();
    touch.step(now);
    syncSpacePress();
    if (detent.value && now >= detentUntil) detent.value = false;
    if (now >= popupHideAt) {
      popupHideAt = Infinity;
      if (popupNode) animate(popupNode, "opacity", 0, { dur: 120, easing: "out" });
    }
  });
  onScopeDispose(() => touch.cancel());

  function applyLayer(next: KbLayerName): void {
    layer = next;
    for (const name of LAYER_NAMES) {
      const node = layerNodes.get(name);
      if (node) jump(node, "translateX", name === layer ? 0 : KB_W + 40);
    }
  }

  function syncSpacePress(fade = true): void {
    const pressed = touch.holdingSpace();
    if (pressed === spacePressed) return;
    spacePressed = pressed;
    for (const node of spaceNodes) {
      if (pressed || !fade) {
        jump(node, "gradFrom", pressed ? CAP_PRESS_FROM : CAP_FROM);
        jump(node, "gradTo", pressed ? CAP_PRESS_TO : CAP_TO);
      } else {
        animate(node, "gradFrom", CAP_FROM, { dur: 180, easing: "out" });
        animate(node, "gradTo", CAP_TO, { dur: 180, easing: "out" });
      }
    }
  }

  function flashKey(name: KbLayerName, row: number, col: number): void {
    const node = keyNodes.get(`${name}:${row}:${col}`);
    if (!node) return;
    const key = KB_LAYERS[name][row][col];
    const [from, to, pressFrom, pressTo] = CAP_COLORS[capKind(key, name)];
    jump(node, "gradFrom", pressFrom);
    jump(node, "gradTo", pressTo);
    animate(node, "gradFrom", from, { dur: 180, easing: "out" });
    animate(node, "gradTo", to, { dur: 180, easing: "out" });
  }

  function showPopup(key: KbKey, row: number, id: number): void {
    if (!popupNode || key.ch === undefined || key.ch === " ") return;
    popupText.value = key.ch;
    popupOwner = id; popupAt = virtualNow(); popupHideAt = Infinity;
    const x = Math.max(2, Math.min(KB_W - POPUP_W - 2, key.x + key.w / 2 - POPUP_W / 2));
    const y = KB_PAD + row * (KB_ROW_H + KB_GAP) - POPUP_H - 6;
    jump(popupNode, "translateX", x);
    jump(popupNode, "translateY", y);
    jump(popupNode, "opacity", 1);
  }

  function press(row: number, col: number, id: number, x: number, y: number, screenH: number): void {
    const key = KB_LAYERS[layer][row][col];
    if (!touch.begin(id, x, y, key.ch === " " ? "space" : key.action === "backspace" ? "backspace" : "other",
      { x: key.x, y: screenH - KB_H + KB_PAD + row * (KB_ROW_H + KB_GAP), w: key.w, h: KB_ROW_H }, virtualNow())) return;
    if (key.ch === " ") syncSpacePress();
    else flashKey(layer, row, col);
    showPopup(key, row, id);
    if (key.ch === " " || key.action === "backspace") return;
    if (key.ch !== undefined) {
      handlers.onInsert(key.ch);
      if (layer === "upper") applyLayer("lower"); // one-shot shift
      return;
    }
    switch (key.action) {
      case "shift":
        applyLayer(layer === "lower" ? "upper" : "lower");
        break;
      case "num":
        applyLayer("numbers");
        break;
      case "sym":
        applyLayer("symbols");
        break;
      case "abc":
        applyLayer("lower");
        break;
      case "return":
        handlers.onEnter();
        break;
      case "globe":
        handlers.onMode?.();
        break;
    }
  }

  /** Baked filled contours keep thin meridians antialiased at native density. */
  function globeIcon() {
    return (
      <Image src="icon-globe.svg" style={{ width: 24, height: 24, opacity: tracking.value ? 0.25 : 1 }} />
    );
  }

  function renderKey(name: KbLayerName, key: KbKey, r: number, c: number) {
    const kind = capKind(key, name);
    const label = key.label ?? key.ch ?? "";
    const small = label.length > 1;
    return (
      <View
        nodeRef={(node) => {
          if (node) {
            keyNodes.set(`${name}:${r}:${c}`, node);
            if (key.ch === " ") spaceNodes.add(node);
          }
        }}
        class={
          kind === "char"
            ? "absolute rounded-md justify-center items-center bg-gradient-to-b from-[#3a3f46] to-[#2d3138]"
            : kind === "action"
              ? "absolute rounded-md justify-center items-center bg-gradient-to-b from-[#24272c] to-[#1a1d21]"
              : "absolute rounded-md justify-center items-center bg-gradient-to-b from-[#dfe2e6] to-[#c9cdd3]"
        }
        style={{
          insetL: key.x,
          insetT: KB_PAD + r * (KB_ROW_H + KB_GAP),
          width: key.w,
          height: KB_ROW_H,
          shadow: 1,
        }}
      >
        {key.action === "globe" ? (
          globeIcon()
        ) : key.action === "backspace" ? (
          <Image src="icon-backspace.svg" style={{ width: 26, height: 24, opacity: tracking.value ? 0.25 : 1 }} />
        ) : key.ch === " " && tracking.value ? (
          <View class="absolute inset-0 items-center justify-center">
            <Image src="icon-trackpad.svg" style={{ width: 96, height: 24 }} />
            <View class="absolute rounded-full w-[1] h-[8] bg-[#cbd3dd]" style={{ insetT: 16, opacity: detent.value ? 0.7 : 0 }} />
          </View>
        ) : (
          <Text
            style={{ opacity: tracking.value ? 0.25 : 1 }}
            class={
              kind === "engaged"
                ? "text-lg text-[#16181c]"
                : small
                  ? "text-sm text-[#d3d7dc]"
                  : "text-lg text-white"
            }
          >
            {label}
          </Text>
        )}
      </View>
    );
  }

  function renderLayer(name: KbLayerName) {
    return (
      <View
        nodeRef={(node) => {
          if (node) layerNodes.set(name, node);
        }}
        class="absolute inset-0"
        style={{ translateX: name === "lower" ? 0 : KB_W + 40 }}
      >
        {KB_LAYERS[name].map((row, r) => row.map((key, c) => renderKey(name, key, r, c)))}
      </View>
    );
  }

  const view = (
    <View
      nodeRef={(node) => {
        if (node) panel = node;
      }}
      class="absolute left-0 right-0 bottom-0 z-40 bg-gradient-to-b from-[#17191d] to-[#0d0f12]"
      style={{ height: KB_H, translateY: KB_H + POPUP_H + IME_BAR_H + 8 }}
    >
      <View class="absolute left-0 right-0 top-0 bg-[#000000]" style={{ height: 1 }} />
      {imeHeight > 0 ? <View class="absolute left-0 right-0 bg-[#1a1d21]" style={{ insetT: -imeHeight, height: imeHeight }}>
        <Text class="absolute left-[6] top-[4] text-sm text-[#b3bbc6]">{imeStatus.value}</Text>
        <View class="absolute left-[42] top-[4]">{remoteText(() => preedit.value, KB_W - 140, 16)}</View>
        <View class="absolute right-[54] top-[2] w-[42] h-[28] items-center justify-center"><Image src="icon-cancel.svg" class="w-[22] h-[22]" /></View>
        <View class="absolute right-[26] top-[2] w-[24] h-[28] items-center justify-center"><Image src="icon-previous.svg" class="w-[16] h-[16]" /></View>
        <View class="absolute right-[2] top-[2] w-[24] h-[28] items-center justify-center"><Image src="icon-next.svg" class="w-[16] h-[16]" /></View>
        {candidates.map((candidate, i) => <View class="absolute overflow-hidden" style={{ insetL: 4 + i * (KB_W - 8) / 5, insetT: 30, width: 60, height: 28 }}>
          {remoteText(() => candidate.value, 60, 16)}
        </View>)}
      </View> : null}
      {LAYER_NAMES.map((name) => renderLayer(name))}
      <View
        nodeRef={(node) => {
          if (node) popupNode = node;
        }}
        class="absolute rounded-lg justify-center items-center bg-gradient-to-b from-[#454b53] to-[#34383f]"
        style={{
          insetL: 0,
          insetT: 0,
          width: POPUP_W,
          height: POPUP_H,
          opacity: 0,
          shadow: 2,
          borderColor: "#101215",
          borderWidth: 1,
        }}
      >
        <Text class="text-2xl text-white">{popupText.value}</Text>
      </View>
    </View>
  );

  return {
    view,
    height: () => KB_H + imeHeight,
    setIme(state, chinese) {
      imeStatus.value = chinese ? "PY" : "EN";
      preedit.value = !chinese ? "" : !state.connected ? "Offline (queued)" : state.error ? "Retry / clear" :
        state.preedit ? `${state.preedit.slice(0, state.caret)}|${state.preedit.slice(state.caret)}${state.pending ? "..." : ""}` : state.pending ? "..." : "Pinyin";
      for (let i = 0; i < 5; i++) candidates[i].value = chinese && !state.pending ? state.candidates[i] ?? "" : "";
    },
    setOpen(next: boolean): void {
      if (next === open) return;
      open = next;
      touch.cancel(); syncSpacePress(false); popupOwner = -1; popupHideAt = Infinity;
      if (open) applyLayer("lower");
      if (popupNode) jump(popupNode, "opacity", 0);
      if (panel) {
        animate(panel, "translateY", open ? 0 : KB_H + POPUP_H + IME_BAR_H + 8, { dur: 200, easing: "out" });
      }
    },
    isOpen: () => open,
    rect() {
      return open ? { x: 0, y: SCREEN_H - KB_H - imeHeight, w: KB_W, h: KB_H + imeHeight } : null;
    },
    pressAt(x: number, y: number, screenH: number, id = 0): void {
      if (touch.tracking()) return;
      const barY = y - (screenH - KB_H - imeHeight);
      if (imeHeight && barY >= 0 && barY < imeHeight) {
        if (barY >= 28) handlers.onCandidate?.(Math.max(0, Math.min(4, Math.floor((x - 4) / ((KB_W - 8) / 5)))));
        else if (x > KB_W - 50) handlers.onPage?.(x < KB_W - 24 ? -1 : 1);
        else if (x > KB_W - 96) handlers.onCancelComposition?.();
        else if (x < 45) handlers.onMode?.();
        else handlers.onCaret?.(x < 158 ? -1 : 1);
        return;
      }
      const pos = kbKeyAt(KB_LAYERS[layer], x, y - (screenH - KB_H));
      if (pos) press(pos.row, pos.col, id, x, y, screenH);
    },
    moveAt(x: number, y: number, id = 0) { touch.move(id, x, y); syncSpacePress(); },
    release(id = 0, cancelled = false): void {
      touch.release(id, cancelled);
      syncSpacePress();
      if (id === popupOwner) {
        popupOwner = -1;
        popupHideAt = cancelled ? virtualNow() : Math.max(popupAt + 0.24, virtualNow() + 0.14);
      }
    },
  };
}
