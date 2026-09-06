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
import { CLEAR_COLOR_PALETTE, type ClearPalette } from "./palette.ts";

export { KB_GAP, KB_H, KB_PAD, KB_ROW_H, KB_W } from "./keyboard-metrics.ts";

const POPUP_W = 44;
const POPUP_H = 46;

export interface KeyboardHandlers {
  onInsert(ch: string): void;
  onBackspace(): void;
  onEnter(): void;
}

const LAYER_NAMES: readonly KbLayerName[] = ["lower", "upper", "numbers", "symbols"];

export interface Keyboard {
  view: JSX.Element;
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

type CapKind = "char" | "action" | "engaged";

/** Character caps are graphite, action caps darker; the shift key on the
 *  upper layer renders as the light "engaged" cap. */
function capKind(key: KbKey, layer: KbLayerName): CapKind {
  if (key.action === "shift" && layer === "upper") return "engaged";
  return key.ch !== undefined ? "char" : "action";
}

export function makeKeyboard(
  handlers: KeyboardHandlers,
  palette: ClearPalette = CLEAR_COLOR_PALETTE,
): Keyboard {
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
    const [from, to, pressFrom, pressTo] = palette.keyboard[capKind(key, name)];
    jump(node, "gradFrom", pressFrom);
    jump(node, "gradTo", pressTo);
    animate(node, "gradFrom", from, { dur: 180, easing: "out" });
    animate(node, "gradTo", to, { dur: 180, easing: "out" });
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
          style={{ arcStart: 0, arcSweep: 360, arcWidth: 1.6, bgColor: palette.keyboard.keyText }}
        />
        <View
          class="absolute"
          style={{ insetL: 0, insetT: 8, width: 18, height: 1.6, bgColor: palette.keyboard.keyText }}
        />
        <View
          class="absolute"
          style={{ insetL: 8, insetT: 0, width: 1.6, height: 18, bgColor: palette.keyboard.keyText }}
        />
      </View>
    );
  }

  function renderKey(name: KbLayerName, key: KbKey, r: number, c: number) {
    const kind = capKind(key, name);
    const label = key.label ?? key.ch ?? "";
    const small = label.length > 1;
    const [from, to] = palette.keyboard[kind];
    return (
      <View
        nodeRef={(node) => {
          if (node) keyNodes.set(`${name}:${r}:${c}`, node);
        }}
        class="absolute rounded-md justify-center items-center bg-gradient-to-b"
        style={{
          insetL: key.x,
          insetT: KB_PAD + r * (KB_ROW_H + KB_GAP),
          width: key.w,
          height: KB_ROW_H,
          shadow: 1,
          gradFrom: from,
          gradTo: to,
        }}
      >
        {key.action === "globe" ? (
          globeIcon()
        ) : (
          <Text
            class={small ? "text-sm" : "text-lg"}
            style={{
              textColor: kind === "engaged"
                ? palette.keyboard.engagedText
                : palette.keyboard.keyText,
            }}
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
      class="absolute left-0 right-0 bottom-0 z-40 bg-gradient-to-b"
      style={{
        height: KB_H,
        translateY: KB_H + POPUP_H + 8,
        gradFrom: palette.keyboard.panelFrom,
        gradTo: palette.keyboard.panelTo,
      }}
    >
      <View
        class="absolute left-0 right-0 top-0"
        style={{ height: 1, bgColor: palette.keyboard.divider }}
      />
      {LAYER_NAMES.map((name) => renderLayer(name))}
      <View
        nodeRef={(node) => {
          if (node) popupNode = node;
        }}
        class="absolute rounded-lg justify-center items-center bg-gradient-to-b"
        style={{
          insetL: 0,
          insetT: 0,
          width: POPUP_W,
          height: POPUP_H,
          opacity: 0,
          shadow: 2,
          borderColor: palette.keyboard.popupBorder,
          borderWidth: 1,
          gradFrom: palette.keyboard.popupFrom,
          gradTo: palette.keyboard.popupTo,
        }}
      >
        <Text class="text-2xl" style={{ textColor: palette.keyboard.keyText }}>
          {popupText.value}
        </Text>
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
