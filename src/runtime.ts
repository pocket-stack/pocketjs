// Tiny component-local hook runtime shared by the React-compatible and Vue adapters.
//
// It keeps PocketJS's existing signal-shaped app API independent from any
// framework-specific state API, while React-compatible/Vue adapters still own JSX reconciliation.

export type Accessor<T> = () => T;
export type Setter<T> = (value: T | ((prev: T) => T)) => void;
export type Cleanup = () => void;

type SlotKind =
  | "signal"
  | "memo"
  | "mount"
  | "effect"
  | "cleanup"
  | "frame"
  | "press"
  | "portal";

interface HookSlot {
  kind: SlotKind;
  value?: unknown;
  cleanup?: Cleanup;
  fn?: () => unknown;
  mounted?: boolean;
}

export interface RuntimeInstance {
  slots: HookSlot[];
  cursor: number;
  invalidate: () => void;
}

let current: RuntimeInstance | null = null;
let runningEffect: HookSlot | null = null;

export function createRuntimeInstance(invalidate: () => void): RuntimeInstance {
  return { slots: [], cursor: 0, invalidate };
}

export function withRuntime<T>(instance: RuntimeInstance, fn: () => T): T {
  const prev = current;
  current = instance;
  instance.cursor = 0;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

function requireRuntime(name: string): RuntimeInstance {
  if (!current) {
    throw new Error(`PocketJS: ${name} must run inside defineComponent()`);
  }
  return current;
}

export function useRuntimeSlot<T extends object>(
  kind: SlotKind,
  init: () => T,
): T {
  const instance = requireRuntime(kind);
  const index = instance.cursor++;
  let slot = instance.slots[index];
  if (!slot) {
    slot = { kind, value: init() };
    instance.slots[index] = slot;
  } else if (slot.kind !== kind) {
    throw new Error(`PocketJS: hook order changed (${slot.kind} -> ${kind})`);
  }
  return slot.value as T;
}

function useSlot(kind: SlotKind): HookSlot {
  const instance = requireRuntime(kind);
  const index = instance.cursor++;
  let slot = instance.slots[index];
  if (!slot) {
    slot = { kind };
    instance.slots[index] = slot;
  } else if (slot.kind !== kind) {
    throw new Error(`PocketJS: hook order changed (${slot.kind} -> ${kind})`);
  }
  return slot;
}

export function createSignal<T>(initial: T): [Accessor<T>, Setter<T>] {
  const instance = requireRuntime("createSignal");
  const slot = useSlot("signal");
  if (!("value" in slot)) slot.value = initial;
  const get = () => slot.value as T;
  const set: Setter<T> = (value) => {
    const before = slot.value as T;
    const next = typeof value === "function" ? (value as (prev: T) => T)(before) : value;
    if (Object.is(before, next)) return;
    slot.value = next;
    instance.invalidate();
  };
  return [get, set];
}

export function createMemo<T>(fn: () => T): Accessor<T> {
  const slot = useSlot("memo");
  slot.fn = fn;
  return () => (slot.fn as () => T)();
}

export function onMount(fn: () => void | Cleanup): void {
  const slot = useSlot("mount");
  slot.fn = fn;
}

export function createEffect(fn: () => void | Cleanup): void {
  const slot = useSlot("effect");
  slot.fn = fn;
}

export function onCleanup(fn: Cleanup): void {
  if (runningEffect) {
    const prev = runningEffect.cleanup;
    runningEffect.cleanup = prev
      ? () => {
          prev();
          fn();
        }
      : fn;
    return;
  }
  const slot = useSlot("cleanup");
  if (!slot.cleanup) slot.cleanup = fn;
}

export function runMounts(instance: RuntimeInstance): void {
  for (const slot of instance.slots) {
    if (!slot || slot.kind !== "mount" || slot.mounted || !slot.fn) continue;
    slot.mounted = true;
    const cleanup = slot.fn();
    if (typeof cleanup === "function") slot.cleanup = cleanup as Cleanup;
  }
}

export function runEffects(instance: RuntimeInstance): void {
  for (const slot of instance.slots) {
    if (!slot || slot.kind !== "effect" || !slot.fn) continue;
    slot.cleanup?.();
    slot.cleanup = undefined;
    runningEffect = slot;
    try {
      const cleanup = slot.fn();
      if (typeof cleanup === "function") slot.cleanup = cleanup as Cleanup;
    } finally {
      runningEffect = null;
    }
  }
}

export function runCleanups(instance: RuntimeInstance): void {
  for (const slot of instance.slots) {
    if (!slot) continue;
    slot.cleanup?.();
    slot.cleanup = undefined;
    slot.mounted = false;
  }
}

export function batch<T>(fn: () => T): T {
  return fn();
}

export function untrack<T>(fn: () => T): T {
  return fn();
}
