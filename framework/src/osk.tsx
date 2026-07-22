// System on-screen keyboard (@pocketjs/framework/osk).
//
// Text entry is a SYSTEM capability, not per-app furniture: every handheld
// PocketJS target needs one keyboard, driven by whatever the platform has —
// d-pad spatial navigation on a PSP, front-panel touch on a Vita, the
// virtual cursor wherever it's enabled. Apps get one seam:
//
//   const osk = createOsk({ value: query, setValue: setQuery,
//                           onCommit: () => search() });
//   onButtonPress(BTN.TRIANGLE, () => osk.open());
//   ... <Osk osk={osk} /> docked at the bottom of the screen column.
//
// While open the OSK is MODAL: it pushes a FocusScope (d-pad + press stay
// inside) AND a button-handler block (every app onButtonPress is muted, no
// per-handler `active:` gating — the exact bug class where an app freezes
// because its handlers were gated on a keyboard nobody could see). Raw
// button reads inside onFrame are NOT blocked; gate those on osk.isOpen().
//
// The layout is the LVGL-style variable-width grid in osk-layout.ts, the
// caret lives in the controller (‹ › move it), and the panel ships two
// themes — "dark" (default) and "light". Input adapters:
//   - d-pad: a focus controller (input.ts) doing spatial navigation with
//     the SAME pixel math that rendered the keys; CIRCLE presses via the
//     focus system, so `focus:`/`active:` styling is native and zero-JS.
//   - chords (PSP tradition): □ backspace · △ space · × close · R shift ·
//     L symbols · START commit.
//   - touch: per-frame contact edges resolve through input.hitFocusable
//     (exact, any placement); hosts without hitTest fall back to
//     dock-at-the-bottom geometry.
//   - cursor: keys are plain Focusables in a scope — hover-focus and click
//     already work, nothing to adapt.

import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor, type JSX as SolidJSX } from "solid-js";
import { BTN, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { animate } from "./anim.ts";
import { virtualFrame } from "./clock.ts";
import { Focusable, FocusScope, Text, View } from "./components.ts";
import { pushButtonHandlerBlock } from "./frame.ts";
import { getOps, hostViewport } from "./host.ts";
import { focusNode, getFocused, hitFocusable, pushFocusController, type FocusDirection } from "./input.ts";
import { onButtonPress, onFrame } from "./lifecycle.ts";
import { touches } from "./touch.ts";
import {
  clampPos,
  keyAtPoint,
  layoutRows,
  navigate,
  OSK_GAP,
  OSK_H,
  OSK_LAYERS,
  OSK_PAD,
  OSK_ROW_H,
  type OskKeyDef,
  type OskKeyRect,
  type OskLayerName,
  type OskPos,
} from "./osk-layout.ts";
import type { NodeMirror } from "./renderer.ts";

export { OSK_H, OSK_LAYERS, type OskKeyDef, type OskLayerName } from "./osk-layout.ts";

// ---------------------------------------------------------------------------
// Controller — the text-editing session (buffer via the app's signal, caret
// and open-state here). The keyboard VIEW is just one input method driving
// it; a host with a real keyboard could call insert()/backspace() directly.
// ---------------------------------------------------------------------------

export interface CreateOskOptions {
  /** The app-owned text signal the OSK edits. */
  value: Accessor<string>;
  setValue: (next: string) => void;
  /** ↵ / ✓ / START. Closes afterwards unless closeOnCommit is false. */
  onCommit?: (text: string) => void;
  /** × / ▼ — closed without committing. */
  onClose?: () => void;
  maxLength?: number;
  closeOnCommit?: boolean;
}

export interface OskController {
  open(): void;
  close(): void;
  isOpen: Accessor<boolean>;
  /** Caret index into value(), clamped live against external edits. */
  caret: Accessor<number>;
  /** value() with the caret marker inserted while open. */
  display(marker?: string): string;
  insert(text: string): void;
  backspace(): void;
  moveCaret(delta: number): void;
  commit(): void;
  cancel(): void;
  /** Virtual frame of the last open() — same-frame presses must not type. */
  openedFrame(): number;
}

export function createOsk(opts: CreateOskOptions): OskController {
  const [isOpen, setOpen] = createSignal(false);
  const [caretRaw, setCaretRaw] = createSignal(0);
  let opened = -1;

  const caret = () => Math.min(caretRaw(), opts.value().length);

  const controller: OskController = {
    open() {
      setCaretRaw(opts.value().length);
      opened = virtualFrame();
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    isOpen,
    caret,
    display(marker = "|") {
      const v = opts.value();
      if (!isOpen()) return v;
      const c = caret();
      return v.slice(0, c) + marker + v.slice(c);
    },
    insert(text) {
      const v = opts.value();
      if (opts.maxLength !== undefined && v.length + text.length > opts.maxLength) return;
      const c = caret();
      opts.setValue(v.slice(0, c) + text + v.slice(c));
      setCaretRaw(c + text.length);
    },
    backspace() {
      const c = caret();
      if (c === 0) return;
      const v = opts.value();
      opts.setValue(v.slice(0, c - 1) + v.slice(c));
      setCaretRaw(c - 1);
    },
    moveCaret(delta) {
      setCaretRaw(Math.max(0, Math.min(caret() + delta, opts.value().length)));
    },
    commit() {
      opts.onCommit?.(opts.value());
      if (opts.closeOnCommit !== false) controller.close();
    },
    cancel() {
      opts.onClose?.();
      controller.close();
    },
    openedFrame: () => opened,
  };
  return controller;
}

// ---------------------------------------------------------------------------
// Themes — whole class literals (the build harvests classes and codepoints
// from source literals; composed strings would not compile).
// ---------------------------------------------------------------------------

export type OskThemeName = "dark" | "light";

const PANEL_DARK = "relative bg-[#10151c] border-[#1d2634]";
const PANEL_LIGHT = "relative bg-[#e7ebf0] border-[#d3d9e0]";

const KEY_DARK =
  "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#1c232e] border-[#252e3a] focus:bg-[#28425e] focus:border-[#7ab8ff] active:bg-[#345779]";
const KEY_DARK_SPECIAL =
  "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#151b24] border-[#202935] focus:bg-[#28425e] focus:border-[#7ab8ff] active:bg-[#345779]";
const KEY_LIGHT =
  "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#ffffff] border-[#d8dde4] focus:bg-[#dceafe] focus:border-[#3d8bff] active:bg-[#c8dffc]";
const KEY_LIGHT_SPECIAL =
  "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#eef1f5] border-[#d8dde4] focus:bg-[#dceafe] focus:border-[#3d8bff] active:bg-[#c8dffc]";

const INK = { dark: "#dbe7ee", light: "#1c2430" } as const;
const INK_DIM = { dark: "#8fa3ad", light: "#5f6b78" } as const;

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface OskProps {
  osk: OskController;
  /** Default "dark". */
  theme?: OskThemeName;
}

/** The docked keyboard panel. Render it at the bottom of the screen column;
 *  it takes OSK_H of height while osk.isOpen() and nothing otherwise. */
export function Osk(props: OskProps): SolidJSX.Element {
  return (
    <Show when={props.osk.isOpen()}>
      <OskPanel osk={props.osk} theme={props.theme ?? "dark"} />
    </Show>
  );
}

const INNER_W = SCREEN_W - 2 * OSK_PAD;

function OskPanel(props: { osk: OskController; theme: OskThemeName }): SolidJSX.Element {
  const [layer, setLayer] = createSignal<OskLayerName>("lower");
  const rows = createMemo(() => layoutRows(OSK_LAYERS[layer()], INNER_W));

  // -- modality: mute every app button handler while the panel lives --------
  onCleanup(pushButtonHandlerBlock());

  // -- key node bookkeeping (rebuilt whenever the layer re-renders) ---------
  let rootNode: NodeMirror | undefined;
  let nodesFor: OskKeyRect[][] | null = null;
  let keyNodes: (NodeMirror | undefined)[][] = [];
  const nodeInfo = new Map<NodeMirror, OskKeyRect>();
  let lastPos: OskPos = { row: 0, col: 1 }; // 'q' — friendlier than the corner

  const registerKey = (node: NodeMirror, rect: OskKeyRect): void => {
    if (nodesFor !== rows()) {
      nodesFor = rows();
      keyNodes = rows().map((r) => new Array(r.length));
      nodeInfo.clear();
    }
    keyNodes[rect.row][rect.col] = node;
    nodeInfo.set(node, rect);
  };

  const focusPos = (pos: OskPos): void => {
    lastPos = clampPos(rows(), pos);
    const node = keyNodes[lastPos.row]?.[lastPos.col];
    if (node) focusNode(node);
  };

  // Initial focus + refocus after every layer switch (the switch rebuilds
  // the key subtree, which would otherwise dump focus via removal repair).
  createEffect(() => {
    rows();
    focusPos(lastPos);
  });

  // -- activation -------------------------------------------------------------
  const activate = (key: OskKeyDef): void => {
    // The press that OPENED the keyboard must not also type on it.
    if (virtualFrame() === props.osk.openedFrame()) return;
    if (key.ch !== undefined) {
      props.osk.insert(key.ch);
      return;
    }
    switch (key.action) {
      case "shift":
        setLayer((l) => (l === "upper" ? "lower" : "upper"));
        break;
      case "layer":
        setLayer((l) => (l === "symbols" ? "lower" : "symbols"));
        break;
      case "backspace":
        props.osk.backspace();
        break;
      case "enter":
        props.osk.commit();
        break;
      case "left":
        props.osk.moveCaret(-1);
        break;
      case "right":
        props.osk.moveCaret(1);
        break;
      case "hide":
        props.osk.cancel();
        break;
    }
  };

  // -- d-pad: spatial navigation with the render-side pixel math ------------
  createEffect(() => {
    if (!rootNode) return;
    animate(rootNode, "translateY", 0, { dur: 150, easing: "out" }); // slide in
    const dispose = pushFocusController(rootNode, (direction: FocusDirection) => {
      const focused = getFocused();
      const from = focused ? nodeInfo.get(focused) ?? lastPos : lastPos;
      focusPos(navigate(rows(), { row: from.row, col: from.col }, direction));
      return true; // clamped edges are handled too — never fall through
    });
    onCleanup(dispose);
  });

  // -- chords (PSP tradition; latched — the panel mounts under a held key) --
  const chord = { latched: true, allowWhenBlocked: true };
  onButtonPress(BTN.SQUARE, () => props.osk.backspace(), chord);
  onButtonPress(BTN.TRIANGLE, () => props.osk.insert(" "), chord);
  onButtonPress(BTN.CROSS, () => props.osk.cancel(), chord);
  onButtonPress(BTN.START, () => props.osk.commit(), chord);
  onButtonPress(BTN.RTRIGGER, () => setLayer((l) => (l === "upper" ? "lower" : "upper")), chord);
  onButtonPress(BTN.LTRIGGER, () => setLayer((l) => (l === "symbols" ? "lower" : "symbols")), chord);

  // -- touch: contact edges -> keys (input.touch platforms) -----------------
  let prevTouchIds = new Set<number>();
  onFrame(() => {
    const list = touches();
    if (list.length === 0) {
      if (prevTouchIds.size > 0) prevTouchIds = new Set();
      return;
    }
    const ids = new Set<number>();
    for (const contact of list) {
      ids.add(contact.id);
      if (prevTouchIds.has(contact.id)) continue;
      const rect = resolveTouch(contact.x, contact.y);
      if (!rect) continue;
      focusPos({ row: rect.row, col: rect.col });
      activate(rect.key);
    }
    prevTouchIds = ids;
  });

  const resolveTouch = (x: number, y: number): OskKeyRect | null => {
    const node = hitFocusable(x, y);
    if (node) return nodeInfo.get(node) ?? null;
    if (getOps().hitTest) return null; // exact miss — not a key
    // No hitTest op: assume the panel is docked at the bottom of the screen.
    const vh = hostViewport(getOps())?.h ?? SCREEN_H;
    const pos = keyAtPoint(rows(), x - OSK_PAD, y - (vh - OSK_H) - OSK_PAD);
    return pos ? rows()[pos.row][pos.col] : null;
  };

  // -- panel ------------------------------------------------------------------
  const keyCls = (key: OskKeyDef): string => {
    const special = key.ch === undefined;
    if (props.theme === "light") return special ? KEY_LIGHT_SPECIAL : KEY_LIGHT;
    return special ? KEY_DARK_SPECIAL : KEY_DARK;
  };

  return (
    <FocusScope
      restoreFocus={false}
      ref={(n: NodeMirror) => {
        rootNode = n;
      }}
      class={props.theme === "light" ? PANEL_LIGHT : PANEL_DARK}
      style={{ height: OSK_H, width: SCREEN_W, translateY: OSK_H }}
    >
      {/* Structural reactivity must ride <For> — a bare `{rows().map(…)}`
          child compiles to a static insert and never re-renders on a layer
          switch (each layer is a fresh array, so <For> swaps everything). */}
      <For each={rows()}>
        {(row, r) => (
          <View
            class="absolute"
            style={{ insetT: OSK_PAD + r() * (OSK_ROW_H + OSK_GAP), insetL: OSK_PAD, width: INNER_W, height: OSK_ROW_H }}
          >
            <For each={row}>
              {(rect) => (
                <Focusable
                  nodeRef={(n) => registerKey(n, rect)}
                  class={keyCls(rect.key)}
                  style={{ insetL: rect.x, insetT: 0, width: rect.w, height: OSK_ROW_H }}
                  onPress={() => activate(rect.key)}
                >
                  <Text
                    class="text-xs font-bold"
                    style={{
                      textColor: rect.key.ch !== undefined ? INK[props.theme] : INK_DIM[props.theme],
                      lineHeight: 12,
                    }}
                  >
                    {rect.key.label ?? rect.key.ch ?? ""}
                  </Text>
                </Focusable>
              )}
            </For>
          </View>
        )}
      </For>
    </FocusScope>
  );
}
