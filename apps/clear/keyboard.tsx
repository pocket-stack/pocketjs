// The edit keyboard: the system OSK's layer data and geometry math
// (framework/src/osk-layout.ts — pure data, no components) rendered at
// touch-first metrics for a 320-wide screen. All three layers mount once as
// stacked static panels; switching layers slides the inactive ones off the
// paint axis, so a layer flip costs three prop writes and zero re-renders.

import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import {
  clampPos,
  keyAtPoint,
  layoutRows,
  OSK_LAYERS,
  type OskKeyRect,
  type OskLayerName,
} from "../../framework/src/osk-layout.ts";

import { KB_GAP, KB_H, KB_PAD, KB_ROW_H, KB_W } from "./keyboard-metrics.ts";

export { KB_GAP, KB_H, KB_PAD, KB_ROW_H, KB_W } from "./keyboard-metrics.ts";
const INNER_W = KB_W - 2 * KB_PAD;

const KEY_BG = "#2a313d";
const KEY_BG_ACTION = "#222834";
const KEY_BG_PRESSED = "#4a5568";

export interface KeyboardHandlers {
  onInsert(ch: string): void;
  onBackspace(): void;
  onEnter(): void;
  onHide(): void;
  onCaret(delta: -1 | 1): void;
}

const LAYER_NAMES: readonly OskLayerName[] = ["lower", "upper", "symbols"];

export interface Keyboard {
  view: unknown;
  /** Dock/undock the panel (animated). */
  setOpen(open: boolean): void;
  isOpen(): boolean;
  /** The docked panel's screen rect, for the gesture region. */
  rect(): { x: number; y: number; w: number; h: number } | null;
  /** Route a contact's down edge (screen coordinates) into a key press. */
  pressAt(x: number, y: number, screenH: number): void;
}

export function makeKeyboard(handlers: KeyboardHandlers): Keyboard {
  const rects: Record<OskLayerName, OskKeyRect[][]> = {
    lower: layoutRows(OSK_LAYERS.lower, INNER_W, KB_GAP),
    upper: layoutRows(OSK_LAYERS.upper, INNER_W, KB_GAP),
    symbols: layoutRows(OSK_LAYERS.symbols, INNER_W, KB_GAP),
  };
  const layerNodes = new Map<OskLayerName, NodeMirror>();
  const keyNodes = new Map<string, NodeMirror>();
  let panel: NodeMirror | null = null;
  let open = false;
  let layer: OskLayerName = "lower";

  function applyLayer(next: OskLayerName): void {
    layer = next;
    for (const name of LAYER_NAMES) {
      const node = layerNodes.get(name);
      if (node) jump(node, "translateX", name === layer ? 0 : KB_W + 40);
    }
  }

  function flashKey(name: OskLayerName, row: number, col: number): void {
    const node = keyNodes.get(`${name}:${row}:${col}`);
    if (!node) return;
    const key = rects[name][row][col].key;
    jump(node, "bgColor", KEY_BG_PRESSED);
    animate(node, "bgColor", key.action ? KEY_BG_ACTION : KEY_BG, { dur: 180, easing: "out" });
  }

  function press(row: number, col: number): void {
    const pos = clampPos(rects[layer], { row, col });
    const key = rects[layer][pos.row][pos.col].key;
    flashKey(layer, pos.row, pos.col);
    if (key.ch !== undefined) {
      handlers.onInsert(key.ch);
      return;
    }
    switch (key.action) {
      case "shift":
        applyLayer(layer === "lower" ? "upper" : "lower");
        break;
      case "layer":
        applyLayer(layer === "symbols" ? "lower" : "symbols");
        break;
      case "backspace":
        handlers.onBackspace();
        break;
      case "enter":
        handlers.onEnter();
        break;
      case "hide":
        handlers.onHide();
        break;
      case "left":
        handlers.onCaret(-1);
        break;
      case "right":
        handlers.onCaret(1);
        break;
    }
  }

  function renderLayer(name: OskLayerName) {
    return (
      <View
        nodeRef={(node) => {
          if (node) layerNodes.set(name, node);
        }}
        class="absolute inset-0"
        style={{ translateX: name === "lower" ? 0 : KB_W + 40 }}
      >
        {rects[name].map((row, r) =>
          row.map((rect, c) => (
            <View
              nodeRef={(node) => {
                if (node) keyNodes.set(`${name}:${r}:${c}`, node);
              }}
              class="absolute rounded-md justify-center items-center"
              style={{
                insetL: KB_PAD + rect.x,
                insetT: KB_PAD + r * (KB_ROW_H + KB_GAP),
                width: rect.w,
                height: KB_ROW_H,
                bgColor: rect.key.action ? KEY_BG_ACTION : KEY_BG,
              }}
            >
              <Text class="text-sm text-white">{rect.key.label ?? rect.key.ch ?? ""}</Text>
            </View>
          )),
        )}
      </View>
    );
  }

  const view = (
    <View
      nodeRef={(node) => {
        if (node) panel = node;
      }}
      class="absolute left-0 right-0 bottom-0 bg-[#161a21] z-40"
      style={{ height: KB_H, translateY: KB_H + 8 }}
    >
      {LAYER_NAMES.map((name) => renderLayer(name))}
    </View>
  );

  return {
    view,
    setOpen(next: boolean): void {
      if (next === open) return;
      open = next;
      if (open) applyLayer("lower");
      if (panel) animate(panel, "translateY", open ? 0 : KB_H + 8, { dur: 200, easing: "out" });
    },
    isOpen: () => open,
    rect() {
      return open ? { x: 0, y: 480 - KB_H, w: KB_W, h: KB_H } : null;
    },
    pressAt(x: number, y: number, screenH: number): void {
      const pos = keyAtPoint(rects[layer], x - KB_PAD, y - (screenH - KB_H) - KB_PAD, KB_ROW_H, KB_GAP);
      if (pos) press(pos.row, pos.col);
    },
  };
}
