// Vue-facing public component API.

import {
  Fragment,
  defineComponent as vueDefineComponent,
  h,
  onMounted,
  onUnmounted,
  onUpdated,
  ref,
  type VNodeChild,
} from "vue";
import { ENUMS, SCREEN_H, SCREEN_W } from "../spec/spec.ts";
import { pushButtonHandlerBlock, onButtonPress, type ButtonPressOptions } from "./frame.ts";
import { pushFocusGrid, pushFocusScope, type FocusGridOptions, type FocusScopeOptions } from "./input.ts";
import { getOverlayRoot } from "./overlay.ts";
import {
  createElement,
  createRenderRoot,
  detachNode,
  insertNode,
  setProp,
  type NodeMirror,
  type RenderRoot,
} from "./renderer.ts";
import {
  createEffect,
  createRuntimeInstance,
  onCleanup,
  onMount,
  runCleanups,
  runEffects,
  runMounts,
  useRuntimeSlot,
  withRuntime,
  type RuntimeInstance,
} from "./runtime.ts";

export type { NodeMirror } from "./renderer.ts";

type StyleObject = Record<string, number | string>;
type NodeRef = ((node: NodeMirror | null) => void) | { current: NodeMirror | null } | undefined;
type ComponentFn<P> = (props: P) => VNodeChild;

function assignRef(refValue: NodeRef, node: NodeMirror | null): void {
  if (!refValue) return;
  if (typeof refValue === "function") refValue(node);
  else refValue.current = node;
}

function propsProxy<P extends object>(
  attrs: Record<string, unknown>,
  slots: Record<string, ((...args: unknown[]) => VNodeChild) | undefined>,
): P {
  return new Proxy({} as P, {
    get(_target, key) {
      if (key === "children") return slots.default?.();
      return attrs[key as string];
    },
    has(_target, key) {
      return key === "children" || key in attrs;
    },
    ownKeys() {
      return [...new Set([...Reflect.ownKeys(attrs), "children"])];
    },
    getOwnPropertyDescriptor(_target, key) {
      if (key === "children" || key in attrs) {
        return { enumerable: true, configurable: true };
      }
      return undefined;
    },
  });
}

export function defineComponent<P extends object>(fn: ComponentFn<P>) {
  return vueDefineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      const tick = ref(0);
      const instance: RuntimeInstance = createRuntimeInstance(() => {
        tick.value++;
      });
      const proxied = propsProxy<P>(attrs, slots);
      onMounted(() => {
        runMounts(instance);
        runEffects(instance);
      });
      onUpdated(() => {
        runMounts(instance);
        runEffects(instance);
      });
      onUnmounted(() => runCleanups(instance));
      return () => {
        tick.value;
        return withRuntime(instance, () => fn(proxied));
      };
    },
  });
}

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

function primitive(tag: "view" | "text" | "image") {
  return vueDefineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => {
        const { nodeRef, className, ...rest } = attrs as Record<string, unknown>;
        const props = { ...rest, class: attrs.class ?? className, ref: nodeRef as NodeRef };
        return h(tag, props, slots.default?.());
      };
    },
  });
}

export const View = primitive("view");
export const Text = primitive("text");
export const Image = primitive("image");

export const Show = vueDefineComponent({
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () => (attrs.when ? slots.default?.(attrs.when) : attrs.fallback ?? null);
  },
});

interface ForItemProps<T> {
  item: T;
  index: number;
  render: (item: T, index: () => number) => VNodeChild;
}

const ForItem = defineComponent(<T,>(props: ForItemProps<T>) => (
  <>{props.render(props.item, () => props.index)}</>
));

function itemKey<T>(item: T, index: number): string | number {
  if (item && typeof item === "object" && "id" in item) {
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  if (typeof item === "string" || typeof item === "number") return item;
  return index;
}

export const For = vueDefineComponent({
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () => {
      const each = (attrs.each ?? []) as readonly unknown[];
      const render = slots.default as ((item: unknown, index: () => number) => VNodeChild) | undefined;
      if (!render) return null;
      return each.map((item, index) =>
        h(ForItem, {
          key: itemKey(item, index),
          item,
          index,
          render,
        }),
      );
    };
  },
});

export const Match = vueDefineComponent({
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () => (attrs.when ? slots.default?.() : null);
  },
});

export const Switch = vueDefineComponent({
  inheritAttrs: false,
  setup(_props, { slots }) {
    return () => slots.default?.().find((child) => child && typeof child === "object");
  },
});

export const Index = For;

function resolveActive(active: boolean | (() => boolean) | undefined): boolean {
  if (typeof active === "function") return active();
  return active ?? true;
}

export interface ScreenProps extends ViewProps {}

export function Screen(props: ScreenProps): VNodeChild {
  return (
    <View
      {...props}
      class={props.class ?? "relative flex-col w-full h-full bg-slate-50 overflow-hidden"}
    />
  );
}

export interface FocusableProps extends ViewProps {
  onPress?: () => void;
}

export function Focusable(props: FocusableProps): VNodeChild {
  return <View {...props} focusable />;
}

export interface FocusScopeProps extends ViewProps, FocusScopeOptions {
  active?: boolean | (() => boolean);
}

export const FocusScope = defineComponent<FocusScopeProps>((props) => {
  let root: NodeMirror | undefined;
  const viewProps = () => {
    const { active: _active, autoFocus: _autoFocus, restoreFocus: _restoreFocus, nodeRef: _nodeRef, ...rest } =
      props as FocusScopeProps;
    return rest;
  };
  createEffect(() => {
    if (!root || !resolveActive(props.active)) return;
    const dispose = pushFocusScope(root, {
      autoFocus: props.autoFocus,
      restoreFocus: props.restoreFocus,
    });
    onCleanup(dispose);
  });
  return (
    <View
      {...viewProps()}
      nodeRef={(node) => {
        root = node ?? undefined;
        assignRef(props.nodeRef, node);
      }}
    />
  );
});

export interface FocusGridProps extends ViewProps, FocusGridOptions {
  active?: boolean | (() => boolean);
}

export const FocusGrid = defineComponent<FocusGridProps>((props) => {
  let root: NodeMirror | undefined;
  const viewProps = () => {
    const { active: _active, columns: _columns, wrap: _wrap, nodeRef: _nodeRef, ...rest } =
      props as FocusGridProps;
    return rest;
  };
  createEffect(() => {
    if (!root || !resolveActive(props.active)) return;
    const dispose = pushFocusGrid(root, {
      columns: props.columns,
      wrap: props.wrap,
    });
    onCleanup(dispose);
  });
  return (
    <View
      {...viewProps()}
      nodeRef={(node) => {
        root = node ?? undefined;
        assignRef(props.nodeRef, node);
      }}
    />
  );
});

export interface ActionHandlerProps extends ButtonPressOptions {
  button: number;
  onPress: (pressed: number, buttons: number) => void;
  children?: VNodeChild;
}

export const ActionHandler = defineComponent<ActionHandlerProps>((props) => {
  onButtonPress(props.button, props.onPress, {
    allowWhenBlocked: props.allowWhenBlocked,
    active: props.active,
  });
  return <>{props.children ?? null}</>;
});

export interface PortalProps {
  children?: VNodeChild;
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
    state.root?.update(h(Fragment, null, props.children));
  });

  return null;
});

export interface ModalProps {
  class?: string;
  panelClass?: string;
  open?: boolean | (() => boolean);
  children?: VNodeChild;
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

  return (
    <View class={props.class ?? "absolute inset-0 z-50 flex-col items-center justify-center"}>
      <View
        nodeRef={(node) => {
          backdrop = node ?? undefined;
        }}
        class="absolute inset-0 bg-slate-950"
        style={{ opacity: 0 }}
      />
      <FocusScope
        active={open}
        nodeRef={(node) => {
          panel = node ?? undefined;
        }}
        class={
          props.panelClass ??
          "flex-col gap-2 w-[328] p-3 rounded-xl shadow-lg bg-white border-slate-200"
        }
        style={{ opacity: 0, translateY: 0, scale: 1 }}
      >
        {props.children}
      </FocusScope>
    </View>
  );
});

export function Modal(props: ModalProps): VNodeChild {
  return (
    <Portal>
      <ModalFrame {...props} />
    </Portal>
  );
}

export interface ActionBarProps extends ViewProps {}

export function ActionBar(props: ActionBarProps): VNodeChild {
  return (
    <Portal>
      <View
        {...props}
        class={
          props.class ??
          "absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200"
        }
      />
    </Portal>
  );
}
