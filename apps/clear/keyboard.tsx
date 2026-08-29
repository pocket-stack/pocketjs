// The edit keyboard: the classic early-iOS portrait layout (apps/clear/
// kb-layout.ts) rendered as four static layer panels that slide on and off
// the paint axis — a layer flip costs four prop writes and zero re-renders.
// Pressing a character key raises the classic key-cap popup: a balloon above
// the key showing the glyph enlarged, visible while the finger is down.
//
// Shift is one-shot (typing a letter on the upper layer drops back to
// lower); the numbers layer's third-row-left key toggles "#+=" symbols in
// place while the bottom-left key stays "ABC" on both, like the original.

import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { shallowRef } from "vue";
import { KB_GAP, KB_H, KB_PAD, KB_ROW_H, KB_W } from "./keyboard-metrics.ts";
import { KB_LAYERS, kbKeyAt, type KbKey, type KbLayerName } from "./kb-layout.ts";

export { KB_GAP, KB_H, KB_PAD, KB_ROW_H, KB_W } from "./keyboard-metrics.ts";

/** Key-cap gradients: white character caps, slate action caps. */
const CAP_FROM = "#fdfdfe";
const CAP_TO = "#e9ebee";
const CAP_PRESS_FROM = "#c9cdd4";
const CAP_PRESS_TO = "#b6bbc4";
const ACTION_FROM = "#848f9e";
const ACTION_TO = "#666f7c";
const ACTION_PRESS_FROM = "#58616d";
const ACTION_PRESS_TO = "#454d58";

const POPUP_W = 44;
const POPUP_H = 46;

export interface KeyboardHandlers {
  onInsert(ch: string): void;
  onBackspace(): void;
  onEnter(): void;
}

const LAYER_NAMES: readonly KbLayerName[] = ["lower", "upper", "numbers", "symbols"];

export interface Keyboard {
  view: unknown;
  /** Dock/undock the panel (animated). */
  setOpen(open: boolean): void;
  isOpen(): boolean;
  /** The docked panel's screen rect, for the gesture region. */
  rect(): { x: number; y: number; w: number; h: number } | null;
  /** Route a contact's down edge (screen coordinates) into a key press. */
  pressAt(x: number, y: number, screenH: number): void;
  /** The contact lifted (or was cancelled): dismiss the key-cap popup. */
  release(): void;
}

/** Whether a key renders as a white character cap (vs a slate action cap).
 *  The engaged shift on the upper layer takes the white cap too. */
function isWhiteCap(key: KbKey, layer: KbLayerName): boolean {
  if (key.ch !== undefined) return true;
  return key.action === "shift" && layer === "upper";
}

export function makeKeyboard(handlers: KeyboardHandlers): Keyboard {
  const layerNodes = new Map<KbLayerName, NodeMirror>();
  const keyNodes = new Map<string, NodeMirror>();
  let panel: NodeMirror | null = null;
  let popupNode: NodeMirror | null = null;
  const popupText = shallowRef("");
  let open = false;
  let layer: KbLayerName = "lower";

  function applyLayer(next: KbLayerName): void {
    layer = next;
    for (const name of LAYER_NAMES) {
      const node = layerNodes.get(name);
      if (node) jump(node, "translateX", name === layer ? 0 : KB_W + 40);
    }
  }

  function flashKey(name: KbLayerName, row: number, col: number): void {
    const node = keyNodes.get(`${name}:${row}:${col}`);
    if (!node) return;
    const key = KB_LAYERS[name][row][col];
    const white = isWhiteCap(key, name);
    jump(node, "gradFrom", white ? CAP_PRESS_FROM : ACTION_PRESS_FROM);
    jump(node, "gradTo", white ? CAP_PRESS_TO : ACTION_PRESS_TO);
    animate(node, "gradFrom", white ? CAP_FROM : ACTION_FROM, { dur: 180, easing: "out" });
    animate(node, "gradTo", white ? CAP_TO : ACTION_TO, { dur: 180, easing: "out" });
  }

  function showPopup(key: KbKey, row: number): void {
    if (!popupNode || key.ch === undefined || key.ch === " ") return;
    popupText.value = key.ch;
    const x = Math.max(2, Math.min(KB_W - POPUP_W - 2, key.x + key.w / 2 - POPUP_W / 2));
    const y = KB_PAD + row * (KB_ROW_H + KB_GAP) - POPUP_H - 6;
    jump(popupNode, "translateX", x);
    jump(popupNode, "translateY", y);
    jump(popupNode, "opacity", 1);
  }

  function press(row: number, col: number): void {
    const key = KB_LAYERS[layer][row][col];
    flashKey(layer, row, col);
    showPopup(key, row);
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
      case "backspace":
        handlers.onBackspace();
        break;
      case "return":
        handlers.onEnter();
        break;
      case "globe":
        break; // one keyboard only — the flash is the whole effect
    }
  }

  /** The globe key's icon: an arc ring with crosshair meridians. */
  function globeIcon() {
    return (
      <View class="absolute" style={{ insetL: 10, insetT: 11, width: 18, height: 18 }}>
        <View
          class="absolute inset-0"
          style={{ arcStart: 0, arcSweep: 360, arcWidth: 1.6, bgColor: "#ffffff" }}
        />
        <View class="absolute bg-[#ffffff]" style={{ insetL: 0, insetT: 8, width: 18, height: 1.6 }} />
        <View class="absolute bg-[#ffffff]" style={{ insetL: 8, insetT: 0, width: 1.6, height: 18 }} />
      </View>
    );
  }

  function renderKey(name: KbLayerName, key: KbKey, r: number, c: number) {
    const white = isWhiteCap(key, name);
    const label = key.label ?? key.ch ?? "";
    const small = label.length > 1;
    return (
      <View
        nodeRef={(node) => {
          if (node) keyNodes.set(`${name}:${r}:${c}`, node);
        }}
        class={
          white
            ? "absolute rounded-md justify-center items-center bg-gradient-to-b from-[#fdfdfe] to-[#e9ebee]"
            : "absolute rounded-md justify-center items-center bg-gradient-to-b from-[#848f9e] to-[#666f7c]"
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
        ) : (
          <Text
            class={
              white
                ? small
                  ? "text-sm text-[#1b1f26]"
                  : "text-lg text-[#1b1f26]"
                : small
                  ? "text-sm text-white"
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
      class="absolute left-0 right-0 bottom-0 z-40 bg-gradient-to-b from-[#8e99a8] to-[#5b6573]"
      style={{ height: KB_H, translateY: KB_H + POPUP_H + 8 }}
    >
      <View class="absolute left-0 right-0 top-0 bg-[#39404a]" style={{ height: 1 }} />
      {LAYER_NAMES.map((name) => renderLayer(name))}
      <View
        nodeRef={(node) => {
          if (node) popupNode = node;
        }}
        class="absolute rounded-lg justify-center items-center bg-gradient-to-b from-[#ffffff] to-[#eff1f4]"
        style={{
          insetL: 0,
          insetT: 0,
          width: POPUP_W,
          height: POPUP_H,
          opacity: 0,
          shadow: 2,
          borderColor: "#6f7988",
          borderWidth: 1,
        }}
      >
        <Text class="text-2xl text-[#14181e]">{popupText.value}</Text>
      </View>
    </View>
  );

  return {
    view,
    setOpen(next: boolean): void {
      if (next === open) return;
      open = next;
      if (open) applyLayer("lower");
      if (popupNode) jump(popupNode, "opacity", 0);
      if (panel) {
        animate(panel, "translateY", open ? 0 : KB_H + POPUP_H + 8, { dur: 200, easing: "out" });
      }
    },
    isOpen: () => open,
    rect() {
      return open ? { x: 0, y: 480 - KB_H, w: KB_W, h: KB_H } : null;
    },
    pressAt(x: number, y: number, screenH: number): void {
      const pos = kbKeyAt(KB_LAYERS[layer], x, y - (screenH - KB_H));
      if (pos) press(pos.row, pos.col);
    },
    release(): void {
      if (popupNode) animate(popupNode, "opacity", 0, { dur: 90, easing: "out" });
    },
  };
}
