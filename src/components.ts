// Component-facing public API.

import type { JSX as SolidJSX } from "solid-js";
import { createEffect, onCleanup, onMount, splitProps } from "solid-js";
import { ENUMS, SCREEN_H, SCREEN_W, VIDEO_CMD, VIDEO_STATE } from "../spec/spec.ts";
import { getOps } from "./host.ts";
import { onFrame, pushButtonHandlerBlock, onButtonPress, type ButtonPressOptions } from "./frame.ts";
import { pushFocusGrid, pushFocusScope, type FocusGridOptions, type FocusScopeOptions } from "./input.ts";
import { getOverlayRoot } from "./overlay.ts";
import { View, type ViewProps } from "./primitives.ts";
import {
  createElement,
  detachNode,
  insertNode,
  render as rendererRender,
  setProp,
  type NodeMirror,
} from "./renderer.ts";

export { View, Text, Image, type ViewProps, type TextProps, type ImageProps } from "./primitives.ts";
export { For, Show, Index, Switch, Match } from "solid-js";
export type { NodeMirror } from "./renderer.ts";

type RefProp = ViewProps["ref"];

function callRef(ref: RefProp | undefined, node: NodeMirror): void {
  if (typeof ref === "function") ref(node);
}

function resolveActive(active: boolean | (() => boolean) | undefined): boolean {
  if (typeof active === "function") return active();
  return active ?? true;
}

export interface ScreenProps extends ViewProps {}

export function Screen(props: ScreenProps): SolidJSX.Element {
  return View({
    ...props,
    class: props.class ?? "relative flex-col w-full h-full bg-slate-50 overflow-hidden",
  });
}

export interface FocusableProps extends ViewProps {
  onPress?: () => void;
}

export function Focusable(props: FocusableProps): SolidJSX.Element {
  return View({ ...props, focusable: true });
}

export interface FocusScopeProps extends ViewProps, FocusScopeOptions {
  active?: boolean | (() => boolean);
}

export function FocusScope(props: FocusScopeProps): SolidJSX.Element {
  let root: NodeMirror | undefined;
  const [scopeProps, viewProps] = splitProps(props, ["active", "autoFocus", "restoreFocus"]);
  createEffect(() => {
    if (!root || !resolveActive(scopeProps.active)) return;
    const dispose = pushFocusScope(root, {
      autoFocus: scopeProps.autoFocus,
      restoreFocus: scopeProps.restoreFocus,
    });
    onCleanup(dispose);
  });
  return View({
    ...viewProps,
    ref: (node) => {
      root = node;
      callRef(viewProps.ref, node);
    },
  });
}

export interface FocusGridProps extends ViewProps, FocusGridOptions {
  active?: boolean | (() => boolean);
}

export function FocusGrid(props: FocusGridProps): SolidJSX.Element {
  let root: NodeMirror | undefined;
  const [gridProps, viewProps] = splitProps(props, ["active", "columns", "wrap"]);
  createEffect(() => {
    if (!root || !resolveActive(gridProps.active)) return;
    const dispose = pushFocusGrid(root, {
      columns: gridProps.columns,
      wrap: gridProps.wrap,
    });
    onCleanup(dispose);
  });
  return View({
    ...viewProps,
    ref: (node) => {
      root = node;
      callRef(viewProps.ref, node);
    },
  });
}

export interface ActionHandlerProps extends ButtonPressOptions {
  button: number;
  onPress: (pressed: number, buttons: number) => void;
  children?: SolidJSX.Element;
}

export function ActionHandler(props: ActionHandlerProps): SolidJSX.Element {
  onButtonPress(props.button, props.onPress, {
    allowWhenBlocked: props.allowWhenBlocked,
    active: props.active,
  });
  return props.children ?? null;
}

export interface PortalProps {
  children?: SolidJSX.Element | (() => SolidJSX.Element);
}

function renderPortalChild(child: PortalProps["children"]): unknown {
  if (typeof child === "function") return child();
  return child;
}

export function Portal(props: PortalProps): SolidJSX.Element {
  let host: NodeMirror | undefined;
  let dispose: (() => void) | undefined;

  onMount(() => {
    host = createElement("view");
    setProp(
      host,
      "style",
      {
        width: SCREEN_W,
        height: SCREEN_H,
        posType: ENUMS.PosType.Absolute,
        insetT: 0,
        insetR: 0,
        insetB: 0,
        insetL: 0,
        zIndex: 1000,
      },
      undefined,
    );
    insertNode(getOverlayRoot(), host);
    dispose = rendererRender(() => renderPortalChild(props.children) as NodeMirror, host);
  });

  onCleanup(() => {
    dispose?.();
    if (host?.parent) detachNode(host.parent, host);
  });

  return null;
}

export interface ModalProps {
  class?: string;
  panelClass?: string;
  open?: boolean | (() => boolean);
  children?: SolidJSX.Element;
}

function ModalFrame(props: ModalProps): SolidJSX.Element {
  let backdrop: NodeMirror | undefined;
  let panel: NodeMirror | undefined;
  let unblockButtons: (() => void) | undefined;

  const open = () => resolveActive(props.open);

  createEffect(() => {
    const visible = open();
    if (visible && !unblockButtons) {
      unblockButtons = pushButtonHandlerBlock();
    } else if (!visible && unblockButtons) {
      unblockButtons();
      unblockButtons = undefined;
    }

    if (backdrop) setProp(backdrop, "style", { opacity: visible ? 0.62 : 0 }, undefined);
    if (panel) {
      setProp(
        panel,
        "style",
        {
          opacity: visible ? 1 : 0,
          translateY: 0,
          scale: 1,
        },
        undefined,
      );
    }
  });
  onCleanup(() => unblockButtons?.());

  return View({
    class: props.class ?? "absolute inset-0 z-50 flex-col items-center justify-center",
    children: [
      View({
        ref: (node) => {
          backdrop = node;
        },
        class: "absolute inset-0 bg-slate-950",
        style: { opacity: 0 },
      }),
      FocusScope({
        active: open,
        ref: (node) => {
          panel = node;
        },
        class:
          props.panelClass ??
          "flex-col gap-2 w-[328] p-3 rounded-xl shadow-lg bg-white border-slate-200",
        style: { opacity: 0, translateY: 0, scale: 1 },
        children: props.children,
      }),
    ],
  });
}

export function Modal(props: ModalProps): SolidJSX.Element {
  return Portal({ children: () => ModalFrame(props) });
}

// ---------------------------------------------------------------------------
// Video — a native, Media-Engine-decoded video surface (DESIGN.md "Video")
// ---------------------------------------------------------------------------
// Composites like an <Image>, but its pixels come from the host's decoder
// (PSP: scePsmfPlayer on the Media Engine) each frame, streamed from the host
// filesystem. The decode runs off the render thread, so the 60 fps UI never
// stalls on host I/O or decode.

type StyleObject = Record<string, number | string>;

export interface VideoProps {
  /** Host-fs stream path, e.g. `host0:/clip.pmf`. */
  src: string;
  class?: string;
  style?: StyleObject;
  /** Loop at end of stream (default false). */
  loop?: boolean;
  /** Begin playing on mount (default true). */
  autoplay?: boolean;
  /** Reactive pause control (boolean or accessor; default false = playing). */
  paused?: boolean | (() => boolean);
  /** Fires once when a non-looping stream reaches its end. */
  onEnded?: () => void;
  ref?: RefProp;
}

/** Native decode geometry — the PSP Media Engine's max / the panel size. */
const VIDEO_NATIVE_W = 480;
const VIDEO_NATIVE_H = 272;

export function Video(props: VideoProps): SolidJSX.Element {
  const el = createElement("video");
  callRef(props.ref, el);

  // class + style behave exactly as on any node (class may be a ternary of
  // full literals; style is prev-diffed).
  createEffect(() => setProp(el, "class", props.class, undefined));
  let prevStyle: StyleObject | undefined;
  createEffect(() => {
    setProp(el, "style", props.style, prevStyle);
    prevStyle = props.style;
  });

  let handle = -1;
  // The decoder begins playing the moment it opens (scePsmfPlayerStart), so we
  // track the last-known transport state and only send a command on an ACTUAL
  // change — autoplay therefore needs no command at all.
  let playing = true;
  let firstRun = true;
  const isPaused = () =>
    typeof props.paused === "function" ? props.paused() : props.paused ?? false;

  onMount(() => {
    const ops = getOps();
    // Hosts without decode support (wasm/test) omit videoOpen — the box still
    // lays out and the backend draws a placeholder for VIDEO_QUAD.
    if (!ops.videoOpen || !ops.videoBind) return;
    handle = ops.videoOpen(props.src, VIDEO_NATIVE_W, VIDEO_NATIVE_H, props.loop ? 1 : 0);
    if (handle < 0) return;
    ops.videoBind(el.id, handle);
  });

  // Single owner of play/pause (runs after onMount, so `handle` is set). On the
  // first run `autoplay === false` starts it paused; thereafter `paused` drives.
  createEffect(() => {
    const wantPlaying = !(isPaused() || (firstRun && props.autoplay === false));
    if (handle < 0) return;
    firstRun = false;
    if (wantPlaying === playing) return; // no transport change → no command
    playing = wantPlaying;
    getOps().videoControl?.(handle, wantPlaying ? VIDEO_CMD.play : VIDEO_CMD.pause, 0);
  });

  // onEnded: poll native playback state once per frame (only if wanted).
  if (props.onEnded) {
    let fired = false;
    onFrame(() => {
      if (handle < 0 || fired) return;
      const state = getOps().videoState?.(handle) ?? 0;
      if ((state & 0xff) === VIDEO_STATE.ended) {
        fired = true;
        props.onEnded!();
      }
    });
  }

  // Tear the decoder down (poll thread + frame buffers) before the node dies.
  onCleanup(() => {
    if (handle >= 0) getOps().videoControl?.(handle, VIDEO_CMD.close, 0);
  });

  return el as unknown as SolidJSX.Element;
}

export interface ActionBarProps extends ViewProps {}

export function ActionBar(props: ActionBarProps): SolidJSX.Element {
  return Portal({
    children: () =>
      View({
        ...props,
        class:
          props.class ??
          "absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200",
      }),
  });
}
