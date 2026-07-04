// React-JSX-facing public component API.

import type { ReactElement, ReactNode } from "react";
import { ENUMS, SCREEN_H, SCREEN_W } from "../spec/spec.ts";
import { pushButtonHandlerBlock, onButtonPress, type ButtonPressOptions } from "./frame.ts";
import { pushFocusGrid, pushFocusScope, type FocusGridOptions, type FocusScopeOptions } from "./input.ts";
import { getOverlayRoot } from "./overlay.ts";
import { Children, Fragment, isValidElement } from "./react-compat.ts";
import { jsx, jsxs } from "./react-jsx-runtime.ts";
import {
  createElement,
  createRenderRoot,
  detachNode,
  insertNode,
  setProp,
  type NodeMirror,
  type RenderRoot,
} from "./renderer.ts";
import { createEffect, onCleanup, onMount, useRuntimeSlot } from "./runtime.ts";

export type { NodeMirror } from "./renderer.ts";

type StyleObject = Record<string, number | string>;
type NodeRef = ((node: NodeMirror | null) => void) | { current: NodeMirror | null } | undefined;
type ComponentFn<P> = (props: P) => ReactNode;

function asElement(value: unknown): ReactElement {
  return value as ReactElement;
}

function assignRef(ref: NodeRef, node: NodeMirror | null): void {
  if (!ref) return;
  if (typeof ref === "function") ref(node);
  else ref.current = node;
}

function joinRefs(...refs: NodeRef[]): (node: NodeMirror | null) => void {
  return (node) => {
    for (const ref of refs) assignRef(ref, node);
  };
}

export function defineComponent<P extends object>(fn: ComponentFn<P>): ComponentFn<P> {
  return fn;
}

export interface ViewProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  onPress?: () => void;
  focusable?: boolean;
  nodeRef?: NodeRef;
  ref?: NodeRef;
  children?: ReactNode;
  key?: string | number;
}

export interface TextProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  nodeRef?: NodeRef;
  ref?: NodeRef;
  children?: ReactNode;
  key?: string | number;
}

export interface ImageProps {
  class?: string;
  className?: string;
  src?: string;
  style?: StyleObject;
  nodeRef?: NodeRef;
  ref?: NodeRef;
  key?: string | number;
}

export function View(props: ViewProps): ReactElement {
  const { nodeRef, ref, ...rest } = props;
  return asElement(jsx("view", { ...rest, ref: joinRefs(nodeRef, ref) }));
}

export function Text(props: TextProps): ReactElement {
  const { nodeRef, ref, ...rest } = props;
  return asElement(jsx("text", { ...rest, ref: joinRefs(nodeRef, ref) }));
}

export function Image(props: ImageProps): ReactElement {
  const { nodeRef, ref, ...rest } = props;
  return asElement(jsx("image", { ...rest, ref: joinRefs(nodeRef, ref) }));
}

export interface ShowProps<T> {
  when: T | false | null | undefined;
  keyed?: boolean;
  fallback?: ReactNode;
  children?: ReactNode | ((value: NonNullable<T>) => ReactNode);
}

export function Show<T>(props: ShowProps<T>): ReactNode {
  if (!props.when) return props.fallback ?? null;
  return typeof props.children === "function"
    ? (props.children as (value: NonNullable<T>) => ReactNode)(props.when as NonNullable<T>)
    : props.children;
}

interface ForItemProps<T> {
  item: T;
  index: number;
  render: (item: T, index: () => number) => ReactNode;
}

const ForItem = defineComponent(<T,>(props: ForItemProps<T>) => props.render(props.item, () => props.index));

export interface ForProps<T> {
  each: readonly T[];
  children: (item: T, index: () => number) => ReactNode;
}

function itemKey<T>(item: T, index: number): string | number {
  if (item && typeof item === "object" && "id" in item) {
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  if (typeof item === "string" || typeof item === "number") return item;
  return index;
}

export function For<T>(props: ForProps<T>): ReactElement {
  return asElement(jsx(Fragment, {
    children: props.each.map((item, index) =>
      jsx(ForItem, { item, index, render: props.children }, itemKey(item, index)),
    ),
  }));
}

export interface MatchProps {
  when: unknown;
  children?: ReactNode;
}

export function Match(props: MatchProps): ReactNode {
  return props.when ? props.children ?? null : null;
}

export function Switch(props: { children?: ReactNode }): ReactNode {
  for (const child of Children.toArray(props.children)) {
    const matchProps = isValidElement(child) ? (child.props as unknown as MatchProps) : null;
    if (matchProps?.when) {
      return matchProps.children ?? null;
    }
  }
  return null;
}

export const Index = For;

function resolveActive(active: boolean | (() => boolean) | undefined): boolean {
  if (typeof active === "function") return active();
  return active ?? true;
}

export interface ScreenProps extends ViewProps {}

export function Screen(props: ScreenProps): ReactElement {
  return asElement(jsx(View, {
    ...props,
    class: props.class ?? "relative flex-col w-full h-full bg-slate-50 overflow-hidden",
  }));
}

export interface FocusableProps extends ViewProps {
  onPress?: () => void;
}

export function Focusable(props: FocusableProps): ReactElement {
  return asElement(jsx(View, { ...props, focusable: true }));
}

export interface FocusScopeProps extends ViewProps, FocusScopeOptions {
  active?: boolean | (() => boolean);
}

export const FocusScope = defineComponent<FocusScopeProps>((props) => {
  let root: NodeMirror | undefined;
  const { active, autoFocus, restoreFocus, nodeRef, ...viewProps } = props;
  createEffect(() => {
    if (!root || !resolveActive(active)) return;
    const dispose = pushFocusScope(root, {
      autoFocus,
      restoreFocus,
    });
    onCleanup(dispose);
  });
  return asElement(jsx(View, {
    ...viewProps,
    nodeRef: (node: NodeMirror | null) => {
      root = node ?? undefined;
      assignRef(nodeRef, node);
    },
  }));
});

export interface FocusGridProps extends ViewProps, FocusGridOptions {
  active?: boolean | (() => boolean);
}

export const FocusGrid = defineComponent<FocusGridProps>((props) => {
  let root: NodeMirror | undefined;
  const { active, columns, wrap, nodeRef, ...viewProps } = props;
  createEffect(() => {
    if (!root || !resolveActive(active)) return;
    const dispose = pushFocusGrid(root, {
      columns,
      wrap,
    });
    onCleanup(dispose);
  });
  return asElement(jsx(View, {
    ...viewProps,
    nodeRef: (node: NodeMirror | null) => {
      root = node ?? undefined;
      assignRef(nodeRef, node);
    },
  }));
});

export interface ActionHandlerProps extends ButtonPressOptions {
  button: number;
  onPress: (pressed: number, buttons: number) => void;
  children?: ReactNode;
}

export const ActionHandler = defineComponent<ActionHandlerProps>((props) => {
  onButtonPress(props.button, props.onPress, {
    allowWhenBlocked: props.allowWhenBlocked,
    active: props.active,
  });
  return asElement(jsx(Fragment, { children: props.children ?? null }));
});

export interface PortalProps {
  children?: ReactNode | (() => ReactNode);
}

function renderPortalChild(child: PortalProps["children"]): ReactNode {
  if (typeof child === "function") return child();
  return child ?? null;
}

export const Portal = defineComponent<PortalProps>((props) => {
  const state = useRuntimeSlot("portal", () => ({
    host: undefined as NodeMirror | undefined,
    root: undefined as RenderRoot | undefined,
  }));

  onMount(() => {
    state.host = createElement("view");
    setProp(
      state.host,
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
    insertNode(getOverlayRoot(), state.host);
    state.root = createRenderRoot(state.host);
    return () => {
      state.root?.dispose();
      if (state.host?.parent) detachNode(state.host.parent, state.host);
    };
  });

  createEffect(() => {
    state.root?.update(jsx(Fragment, { children: renderPortalChild(props.children) }));
  });

  return null;
});

export interface ModalProps {
  class?: string;
  panelClass?: string;
  open?: boolean | (() => boolean);
  children?: ReactNode;
}

const ModalFrame = defineComponent<ModalProps>((props) => {
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
    onCleanup(() => unblockButtons?.());
  });

  return asElement(jsxs(View, {
    class: props.class ?? "absolute inset-0 z-50 flex-col items-center justify-center",
    children: [
      jsx(View, {
        nodeRef: (node: NodeMirror | null) => {
          backdrop = node ?? undefined;
        },
        class: "absolute inset-0 bg-slate-950",
        style: { opacity: 0 },
      }),
      jsx(FocusScope, {
        active: open,
        nodeRef: (node: NodeMirror | null) => {
          panel = node ?? undefined;
        },
        class: props.panelClass ?? "flex-col gap-2 w-[328] p-3 rounded-xl shadow-lg bg-white border-slate-200",
        style: { opacity: 0, translateY: 0, scale: 1 },
        children: props.children,
      }),
    ],
  }));
});

export function Modal(props: ModalProps): ReactElement {
  return asElement(jsx(Portal, { children: () => jsx(ModalFrame, { ...props }) }));
}

export interface ActionBarProps extends ViewProps {}

export function ActionBar(props: ActionBarProps): ReactElement {
  return asElement(jsx(Portal, {
    children: () =>
      jsx(View, {
        ...props,
        class:
          props.class ??
          "absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200",
      }),
  }));
}
