// Component-facing public API.

import type { JSX as SolidJSX } from "solid-js";
import { createEffect, onCleanup, onMount, splitProps } from "solid-js";
import { ENUMS, SCREEN_H, SCREEN_W } from "../spec/spec.ts";
import { pushButtonHandlerBlock, useButtonPress, type ButtonPressOptions } from "./frame.ts";
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
  useButtonPress(props.button, props.onPress, {
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
