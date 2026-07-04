// Vue Vapor-facing public component API.

import {
  createFor,
  createIf,
  defineVaporComponent,
  insert as vaporInsert,
  onScopeDispose,
  renderEffect,
} from "vue";
import { ENUMS, SCREEN_H, SCREEN_W } from "../spec/spec.ts";
import { pushButtonHandlerBlock, onButtonPress, type ButtonPressOptions } from "./frame.ts";
import { pushFocusGrid, pushFocusScope, type FocusGridOptions, type FocusScopeOptions } from "./input.ts";
import { getOverlayRoot } from "./overlay.ts";
import {
  createCommentNode,
  createElement,
  detachNode,
  insertNode,
  setProp,
  type HostProps,
  type NodeMirror,
} from "./native-tree.ts";
import { createEffect, onCleanup, onMount } from "./reactivity.ts";
import { createRenderRoot, type RenderRoot } from "./renderer.ts";
import { createRuntimeInstance, runCleanups, withRuntime, type RuntimeInstance } from "./runtime.ts";

export type { NodeMirror } from "./renderer.ts";

type StyleObject = Record<string, number | string>;
type NodeRef = ((node: NodeMirror | null) => void) | { current: NodeMirror | null } | undefined;
type SlotFn = (...args: unknown[]) => unknown;
type SlotBag = Record<string, SlotFn | undefined> | SlotFn | undefined;

export type VNodeChild = unknown;
const NO_FALLTHROUGH = { inheritAttrs: false } as const;
type VaporCtx = { slots: SlotBag; attrs: Record<string, unknown> };
type VaporSetup<P extends object> = (props: P, ctx: VaporCtx) => unknown;
type VaporRef<T> = { value: T };
const definePocketVaporComponent = defineVaporComponent as unknown as <P extends object>(
  setup: VaporSetup<P>,
  extraOptions?: typeof NO_FALLTHROUGH,
) => (props: P) => unknown;
const insertVaporBlock = vaporInsert as unknown as (
  block: unknown,
  parent: NodeMirror,
  anchor?: NodeMirror | null,
) => void;
const createIfBlock = createIf as unknown as (
  condition: () => boolean,
  positive: () => unknown,
  negative?: () => unknown,
) => unknown;
const createForBlock = createFor as unknown as (
  source: () => readonly unknown[],
  render: (item: VaporRef<unknown>, key: VaporRef<unknown> | undefined, index: VaporRef<number>) => unknown,
  key?: (item: unknown, key: unknown, index: number) => string | number,
) => unknown;

export interface ViewProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  onPress?: () => void;
  focusable?: boolean;
  nodeRef?: NodeRef;
  children?: VNodeChild;
}

export interface TextProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  nodeRef?: NodeRef;
  children?: VNodeChild;
}

export interface ImageProps {
  class?: string;
  className?: string;
  src?: string;
  style?: StyleObject;
  nodeRef?: NodeRef;
}

function valueOf<T>(value: T): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function callbackOf<T extends (...args: never[]) => unknown>(value: unknown): T | undefined {
  return typeof value === "function" ? (value as T) : undefined;
}

function booleanOption(value: unknown): boolean | undefined {
  const resolved = valueOf(value);
  return typeof resolved === "boolean" ? resolved : undefined;
}

function assignRef(refValue: unknown, node: NodeMirror | null): void {
  const ref = refValue as NodeRef;
  if (!ref) return;
  if (typeof ref === "function") ref(node);
  else ref.current = node;
}

function slotDefault(slots: SlotBag, ...args: unknown[]): unknown {
  if (typeof slots === "function") return slots(...args);
  return slots?.default?.(...args);
}

function normalizeVaporBlock(block: unknown): unknown | null {
  if (block == null || typeof block === "boolean") return null;
  if (!Array.isArray(block)) return block;
  const out: unknown[] = [];
  for (const child of block) {
    const normalized = normalizeVaporBlock(child);
    if (Array.isArray(normalized)) out.push(...normalized);
    else if (normalized != null) out.push(normalized);
  }
  return out.length > 0 ? out : null;
}

function defaultBlock(slots: SlotBag, ...args: unknown[]): unknown | null {
  return normalizeVaporBlock(slotDefault(slots, ...args));
}

function normalizeClassValue(value: unknown): unknown {
  const resolved = valueOf(value);
  if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
    return Object.entries(resolved)
      .filter(([, active]) => !!valueOf(active))
      .map(([name]) => name)
      .join(" ");
  }
  if (!Array.isArray(resolved)) return resolved;
  const parts = resolved
    .map((part) => normalizeClassValue(part))
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join(" ");
}

function normalizeStyleValue(value: unknown): unknown {
  const resolved = valueOf(value);
  if (!Array.isArray(resolved)) return resolved;
  const out: StyleObject = {};
  for (const part of resolved) {
    const normalized = normalizeStyleValue(part);
    if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
      Object.assign(out, normalized);
    }
  }
  return out;
}

function componentProps<P extends object>(
  declaredProps: P,
  attrs: Record<string, unknown>,
  slots: SlotBag,
): P {
  return new Proxy({} as P, {
    get(_target, key) {
      if (key === "children") return defaultBlock(slots);
      if (typeof key === "string" && key in declaredProps) return (declaredProps as Record<string, unknown>)[key];
      return attrs[key as string];
    },
    has(_target, key) {
      return key === "children" || key in declaredProps || key in attrs;
    },
    ownKeys() {
      return [...new Set([...Reflect.ownKeys(attrs), ...Reflect.ownKeys(declaredProps), "children"])];
    },
    getOwnPropertyDescriptor(_target, key) {
      if (key === "children" || key in declaredProps || key in attrs) {
        return { enumerable: true, configurable: true };
      }
      return undefined;
    },
  });
}

function cleanProps(props: Record<string, unknown>, omit: Set<string>): HostProps {
  const out: HostProps = {};
  for (const key of Object.keys(props)) {
    if (omit.has(key)) continue;
    if (key === "class" || key === "className") out[key] = normalizeClassValue(props[key]);
    else if (key === "style") out[key] = normalizeStyleValue(props[key]);
    else if (key === "onPress" || key === "on:press") out[key] = props[key];
    else out[key] = valueOf(props[key]);
  }
  if (out.class == null && out.className != null) out.class = out.className;
  delete out.className;
  return out;
}

function cleanExtraProps(props: HostProps): HostProps {
  const out: HostProps = {};
  for (const key of Object.keys(props)) {
    if (key === "class" || key === "className") out[key] = normalizeClassValue(props[key]);
    else if (key === "style") out[key] = normalizeStyleValue(props[key]);
    else out[key] = props[key];
  }
  if (out.class == null && out.className != null) out.class = out.className;
  delete out.className;
  return out;
}

function insertBlock(block: unknown, parent: NodeMirror): void {
  const normalized = normalizeVaporBlock(block);
  if (normalized) insertVaporBlock(normalized, parent);
}

function mountChildren(node: NodeMirror, slots: SlotBag): void {
  insertBlock(slotDefault(slots), node);
}

function createPrimitiveNode(
  tag: "view" | "text" | "image",
  rawProps: Record<string, unknown>,
  slots: SlotBag,
  opts: { omit?: string[]; onNode?: (node: NodeMirror) => void; extra?: HostProps | (() => HostProps) } = {},
): NodeMirror {
  const node = createElement(tag);
  opts.onNode?.(node);
  mountChildren(node, slots);
  const omit = new Set(["children", "key", "ref", "nodeRef", ...(opts.omit ?? [])]);
  let prev: HostProps = {};
  renderEffect(() => {
    const extra = typeof opts.extra === "function" ? opts.extra() : (opts.extra ?? {});
    const next = { ...cleanProps(rawProps, omit), ...cleanExtraProps(extra) };
    for (const key of Object.keys(next)) setProp(node, key, next[key], prev[key]);
    for (const key of Object.keys(prev)) {
      if (!(key in next)) setProp(node, key, undefined, prev[key]);
    }
    prev = next;
    assignRef(rawProps.nodeRef ?? rawProps.ref, node);
  });
  return node;
}

function primitive(tag: "view" | "text" | "image") {
  return definePocketVaporComponent(
    (_props: Record<string, unknown>, { attrs, slots }: VaporCtx) => createPrimitiveNode(tag, attrs, slots),
    NO_FALLTHROUGH,
  );
}

export const View = primitive("view");
export const Text = primitive("text");
export const Image = primitive("image");

export function defineComponent<P extends object>(
  fn: (props: P, ctx: { slots: SlotBag; attrs: Record<string, unknown> }) => unknown,
) {
  return definePocketVaporComponent((props: P, ctx: VaporCtx) => {
    const instance: RuntimeInstance = createRuntimeInstance(() => {});
    onScopeDispose(() => runCleanups(instance));
    return withRuntime(instance, () => fn(componentProps(props, ctx.attrs, ctx.slots), ctx));
  }, NO_FALLTHROUGH);
}

export const Show = definePocketVaporComponent(
  (_props: Record<string, unknown>, { attrs, slots }: VaporCtx) =>
    createIfBlock(
      () => !!valueOf(attrs.when),
      () => defaultBlock(slots, valueOf(attrs.when)) ?? createCommentNode("show"),
      () => valueOf(attrs.fallback) ?? createCommentNode("show"),
    ),
  NO_FALLTHROUGH,
);
function itemKey(item: unknown, index: number): string | number {
  if (item && typeof item === "object" && "id" in item) {
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  if (typeof item === "string" || typeof item === "number") return item;
  return index;
}

export const For = definePocketVaporComponent(
  (_props: Record<string, unknown>, { attrs, slots }: VaporCtx) =>
    createForBlock(
      () => (valueOf(attrs.each) ?? []) as readonly unknown[],
      (item, _key, index) => defaultBlock(slots, item.value, () => index.value) ?? createCommentNode("for"),
      (item, _key, index) => itemKey(item, index),
    ),
  NO_FALLTHROUGH,
);
export const Index = For;
export const Match = Show;
export const Switch = definePocketVaporComponent(
  (_props: Record<string, unknown>, { slots }: VaporCtx) =>
    defaultBlock(slots) ?? createCommentNode("switch"),
  NO_FALLTHROUGH,
);

function resolveActive(active: unknown): boolean {
  const resolved = valueOf(active);
  return typeof resolved === "function" ? !!resolved() : (resolved as boolean | undefined) ?? true;
}

export interface ScreenProps extends ViewProps {}

export const Screen = definePocketVaporComponent(
  (_props: ScreenProps, { attrs, slots }: VaporCtx) =>
    createPrimitiveNode("view", attrs, slots, {
      extra: () => ({ class: attrs.class ?? "relative flex-col w-full h-full bg-slate-50 overflow-hidden" }),
    }),
  NO_FALLTHROUGH,
);

export interface FocusableProps extends ViewProps {
  onPress?: () => void;
}

export const Focusable = definePocketVaporComponent(
  (_props: FocusableProps, { attrs, slots }: VaporCtx) =>
    createPrimitiveNode("view", attrs, slots, { extra: { focusable: true } }),
  NO_FALLTHROUGH,
);

export interface FocusScopeProps extends ViewProps, FocusScopeOptions {
  active?: boolean | (() => boolean);
}

export const FocusScope = definePocketVaporComponent((_props: FocusScopeProps, { attrs, slots }: VaporCtx) => {
  let root: NodeMirror | undefined;
  const node = createPrimitiveNode("view", attrs, slots, {
    omit: ["active", "autoFocus", "restoreFocus"],
    onNode(next) {
      root = next;
    },
  });
  createEffect(() => {
    if (!root || !resolveActive(attrs.active)) return;
    const dispose = pushFocusScope(root, {
      autoFocus: booleanOption(attrs.autoFocus),
      restoreFocus: booleanOption(attrs.restoreFocus),
    });
    onCleanup(dispose);
  });
  return node;
}, NO_FALLTHROUGH);

export interface FocusGridProps extends ViewProps, FocusGridOptions {
  active?: boolean | (() => boolean);
}

export const FocusGrid = definePocketVaporComponent((_props: FocusGridProps, { attrs, slots }: VaporCtx) => {
  let root: NodeMirror | undefined;
  const node = createPrimitiveNode("view", attrs, slots, {
    omit: ["active", "columns", "wrap"],
    onNode(next) {
      root = next;
    },
  });
  createEffect(() => {
    if (!root || !resolveActive(attrs.active)) return;
    const dispose = pushFocusGrid(root, {
      columns: valueOf(attrs.columns) as number,
      wrap: booleanOption(attrs.wrap),
    });
    onCleanup(dispose);
  });
  return node;
}, NO_FALLTHROUGH);

export interface ActionHandlerProps extends ButtonPressOptions {
  button: number;
  onPress: (pressed: number, buttons: number) => void;
  children?: VNodeChild;
}

export const ActionHandler = definePocketVaporComponent((_props: ActionHandlerProps, { attrs, slots }: VaporCtx) => {
  onButtonPress(
    valueOf(attrs.button) as number,
    (pressed, buttons) => callbackOf<ActionHandlerProps["onPress"]>(attrs.onPress)?.(pressed, buttons),
    {
      allowWhenBlocked: booleanOption(attrs.allowWhenBlocked),
      active: () => resolveActive(attrs.active),
    },
  );
  return defaultBlock(slots) ?? createCommentNode("action");
}, NO_FALLTHROUGH);

export interface PortalProps {
  children?: VNodeChild;
}

function createPortalRoot(): { marker: NodeMirror; host: NodeMirror; root: RenderRoot } {
  const marker = createCommentNode("portal");
  const host = createElement("view");
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
  return { marker, host, root: createRenderRoot(host) };
}

export const Portal = definePocketVaporComponent((_props: PortalProps, { slots }: { slots: SlotBag }) => {
  const state = createPortalRoot();
  renderEffect(() => {
    state.root.update(defaultBlock(slots));
  });
  onCleanup(() => {
    state.root.dispose();
    if (state.host.parent) detachNode(state.host.parent, state.host);
  });
  return state.marker;
}, NO_FALLTHROUGH);

export interface ModalProps {
  class?: string;
  panelClass?: string;
  open?: boolean | (() => boolean);
  children?: VNodeChild;
}

export const Modal = definePocketVaporComponent((_props: ModalProps, { attrs, slots }: VaporCtx) => {
  const state = createPortalRoot();
  const frame = createElement("view");
  const backdrop = createElement("view");
  const panel = createElement("view");
  let unblockButtons: (() => void) | undefined;

  setProp(frame, "class", attrs.class ?? "absolute inset-0 z-50 flex-col items-center justify-center", undefined);
  setProp(backdrop, "class", "absolute inset-0 bg-slate-950", undefined);
  setProp(backdrop, "style", { opacity: 0 }, undefined);
  setProp(
    panel,
    "class",
    attrs.panelClass ?? "flex-col gap-2 w-[328] p-3 rounded-xl shadow-lg bg-white border-slate-200",
    undefined,
  );
  setProp(panel, "style", { opacity: 0, translateY: 0, scale: 1 }, undefined);
  insertNode(frame, backdrop);
  insertNode(frame, panel);
  state.root.update(frame);
  insertBlock(slotDefault(slots), panel);

  createEffect(() => {
    const visible = resolveActive(attrs.open);
    if (visible && !unblockButtons) {
      unblockButtons = pushButtonHandlerBlock();
    } else if (!visible && unblockButtons) {
      unblockButtons();
      unblockButtons = undefined;
    }
    setProp(backdrop, "style", { opacity: visible ? 0.62 : 0 }, undefined);
    setProp(panel, "style", { opacity: visible ? 1 : 0, translateY: 0, scale: 1 }, undefined);
    onCleanup(() => unblockButtons?.());
  });
  onCleanup(() => {
    unblockButtons?.();
    state.root.dispose();
    if (state.host.parent) detachNode(state.host.parent, state.host);
  });
  return state.marker;
}, NO_FALLTHROUGH);

export interface ActionBarProps extends ViewProps {}

export const ActionBar = definePocketVaporComponent((_props: ActionBarProps, { attrs, slots }: VaporCtx) => {
  const state = createPortalRoot();
  const bar = createPrimitiveNode("view", attrs, slots, {
    extra: () => ({
      class:
        attrs.class ??
        "absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200",
    }),
  });
  state.root.update(bar);
  onCleanup(() => {
    state.root.dispose();
    if (state.host.parent) detachNode(state.host.parent, state.host);
  });
  return state.marker;
}, NO_FALLTHROUGH);
