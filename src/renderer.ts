// Lightweight React-compatible JSX renderer over the native `ui.*` tree.
//
// The PSP path cannot afford react-reconciler's update machinery inside
// QuickJS, so the default React-compatible engine consumes React-shaped JSX elements
// directly and lets PocketJS own the native tree lifecycle.

import {
  applyProps,
  clearContainer,
  createElement as createNativeElement,
  createTextNode,
  detachNode,
  getFirstChild,
  getNextSibling,
  getParentNode,
  insertNode,
  isTextNode,
  missCounters,
  registerTexture,
  release,
  removeNode,
  replaceText,
  resetRendererState,
  resetTextures,
  retain,
  rootMirror,
  runSweep,
  setProp,
  setStyleResolver,
  type HostProps,
  type NodeMirror,
} from "./native-tree.ts";
import {
  createRuntimeInstance,
  runCleanups,
  runEffects,
  runMounts,
  withRuntime,
  type RuntimeInstance,
} from "./runtime.ts";

export {
  createTextNode,
  detachNode,
  getFirstChild,
  getNextSibling,
  getParentNode,
  insertNode,
  isTextNode,
  missCounters,
  registerTexture,
  release,
  replaceText,
  resetRendererState,
  resetTextures,
  retain,
  rootMirror,
  runSweep,
  setProp,
  setStyleResolver,
  type NodeMirror,
};

const REACT_ELEMENT = Symbol.for("react.element");
const REACT_FRAGMENT = Symbol.for("react.fragment");
const REACT_FORWARD_REF = Symbol.for("react.forward_ref");

interface VNode {
  $$typeof?: symbol;
  type?: unknown;
  key?: string | number | null;
  ref?: unknown;
  props?: HostProps;
}

interface ComponentSlot {
  instance: RuntimeInstance;
  active: boolean;
}

interface RenderState {
  root: NodeMirror;
  current: unknown;
  components: Map<string, ComponentSlot>;
  scheduled: boolean;
  disposed: boolean;
  updateNow(node: unknown): void;
  requestUpdate(): void;
}

export interface RenderRoot {
  update(node: unknown): void;
  dispose(): void;
}

export function createElement(type: string): NodeMirror {
  return createNativeElement(type);
}

function isVNode(value: unknown): value is VNode {
  return !!value && typeof value === "object" && (value as VNode).$$typeof === REACT_ELEMENT;
}

function childrenToArray(value: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (child: unknown) => {
    if (child == null || typeof child === "boolean") return;
    if (Array.isArray(child)) {
      for (let i = 0; i < child.length; i++) visit(child[i]);
      return;
    }
    out.push(child);
  };
  visit(value);
  return out;
}

function pathFor(parent: string, child: unknown, index: number): string {
  if (isVNode(child) && (child.key || child.key === 0)) {
    return `${parent}/k:${String(child.key)}`;
  }
  return `${parent}/i:${index}`;
}

function assignRef(ref: unknown, node: NodeMirror | null): void {
  if (!ref) return;
  if (typeof ref === "function") {
    (ref as (node: NodeMirror | null) => void)(node);
    return;
  }
  if (typeof ref === "object" && "current" in ref) {
    (ref as { current: NodeMirror | null }).current = node;
  }
}

function cleanHostProps(props: HostProps): HostProps {
  const out: HostProps = {};
  for (const key in props) {
    if (key === "children" || key === "key" || key === "ref") continue;
    out[key] = props[key];
  }
  return out;
}

function componentSlot(state: RenderState, path: string): RuntimeInstance {
  let slot = state.components.get(path);
  if (!slot) {
    slot = {
      instance: createRuntimeInstance(() => state.requestUpdate()),
      active: false,
    };
    state.components.set(path, slot);
  }
  slot.active = true;
  return slot.instance;
}

function callComponent(type: unknown, props: HostProps, ref: unknown): unknown {
  if (typeof type === "function") {
    return (type as (props: HostProps) => unknown)(ref ? { ...props, ref } : props);
  }
  if (
    type &&
    typeof type === "object" &&
    (type as { $$typeof?: symbol }).$$typeof === REACT_FORWARD_REF
  ) {
    const render = (type as { render: (props: HostProps, ref: unknown) => unknown }).render;
    return render(props, ref);
  }
  throw new Error("PocketJS: unsupported JSX component type");
}

function appendBuilt(parent: NodeMirror, nodes: NodeMirror[]): void {
  for (let i = 0; i < nodes.length; i++) insertNode(parent, nodes[i]);
}

function buildNode(value: unknown, path: string, state: RenderState): NodeMirror[] {
  if (value == null || typeof value === "boolean") return [];
  if (Array.isArray(value)) {
    const out: NodeMirror[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(...buildNode(value[i], pathFor(path, value[i], i), state));
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "number") {
    return [createTextNode(String(value))];
  }
  if (!isVNode(value)) {
    return [];
  }

  const type = value.type;
  const props = value.props ?? {};
  if (type === REACT_FRAGMENT) {
    const children = childrenToArray(props.children);
    const out: NodeMirror[] = [];
    for (let i = 0; i < children.length; i++) {
      out.push(...buildNode(children[i], pathFor(path, children[i], i), state));
    }
    return out;
  }

  if (typeof type === "string") {
    const node = createNativeElement(type);
    applyProps(node, cleanHostProps(props));
    const children = childrenToArray(props.children);
    for (let i = 0; i < children.length; i++) {
      appendBuilt(node, buildNode(children[i], pathFor(path, children[i], i), state));
    }
    assignRef(value.ref ?? props.nodeRef, node);
    return [node];
  }

  const instance = componentSlot(state, `${path}/c`);
  const rendered = withRuntime(instance, () => callComponent(type, props, value.ref));
  return buildNode(rendered, `${path}/r`, state);
}

function commit(state: RenderState, node: unknown): void {
  if (state.disposed) return;
  state.current = node;
  for (const slot of state.components.values()) slot.active = false;

  clearContainer(state.root);
  runSweep();
  appendBuilt(state.root, buildNode(node, "root", state));

  for (const [path, slot] of [...state.components]) {
    if (!slot.active) {
      runCleanups(slot.instance);
      state.components.delete(path);
    }
  }
  for (const slot of state.components.values()) runMounts(slot.instance);
  for (const slot of state.components.values()) runEffects(slot.instance);
}

export function createRenderRoot(root: NodeMirror): RenderRoot {
  const state: RenderState = {
    root,
    current: null,
    components: new Map(),
    scheduled: false,
    disposed: false,
    updateNow(node: unknown) {
      commit(state, node);
    },
    requestUpdate() {
      if (state.scheduled || state.disposed) return;
      state.scheduled = true;
      queueMicrotask(() => {
        state.scheduled = false;
        state.updateNow(state.current);
      });
    },
  };

  return {
    update(node: unknown) {
      state.updateNow(node);
    },
    dispose() {
      state.disposed = true;
      clearContainer(root);
      runSweep();
      for (const slot of state.components.values()) runCleanups(slot.instance);
      state.components.clear();
    },
  };
}

export function render(code: () => unknown, root: NodeMirror): () => void {
  const renderRoot = createRenderRoot(root);
  renderRoot.update(code());
  return () => renderRoot.dispose();
}

// Compatibility helpers retained for low-level tests and older handwritten
// renderer calls. JSX builds use the React-shaped element runtime directly.
export function createComponent<T>(Comp: (props: T) => unknown, props: T): unknown {
  return { $$typeof: REACT_ELEMENT, type: Comp, key: null, ref: null, props: props as HostProps };
}

export function effect<T>(fn: (prev?: T) => T, init?: T): void {
  fn(init);
}

export function memo<T>(fn: () => T): () => T {
  return fn;
}

export function insert(_parent: NodeMirror, _accessor: unknown, _marker?: NodeMirror | null): void {}
export function spread(node: NodeMirror, props: HostProps): void {
  applyProps(node, props);
}
export function mergeProps(...sources: unknown[]): unknown {
  return Object.assign({}, ...sources);
}
export function use(fn: (el: NodeMirror) => void, el: NodeMirror): void {
  fn(el);
}
