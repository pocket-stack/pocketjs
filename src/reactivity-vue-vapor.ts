// PocketJS signal-shaped API backed by Vue reactivity for Vapor renderEffects.

import {
  computed,
  onMounted,
  onScopeDispose,
  shallowRef,
  watchEffect,
  type Ref,
} from "vue";

export type Accessor<T> = () => T;
export type Setter<T> = (value: T | ((prev: T) => T)) => void;
export type Cleanup = () => void;

let currentCleanup: ((fn: Cleanup) => void) | null = null;

export function createSignal<T>(initial: T): [Accessor<T>, Setter<T>] {
  const ref = shallowRef(initial) as Ref<T>;
  return [
    () => ref.value,
    (value) => {
      ref.value = typeof value === "function" ? (value as (prev: T) => T)(ref.value) : value;
    },
  ];
}

export function createMemo<T>(fn: () => T): Accessor<T> {
  const value = computed(fn);
  return () => value.value;
}

export function createEffect(fn: () => void | Cleanup): void {
  watchEffect(
    (registerCleanup) => {
      const prev = currentCleanup;
      currentCleanup = registerCleanup;
      try {
        const cleanup = fn();
        if (typeof cleanup === "function") registerCleanup(cleanup);
      } finally {
        currentCleanup = prev;
      }
    },
    { flush: "sync" },
  );
}

export function onMount(fn: () => void | Cleanup): void {
  let cleanup: void | Cleanup;
  onMounted(() => {
    cleanup = fn();
  });
  onScopeDispose(() => {
    if (typeof cleanup === "function") cleanup();
  }, true);
}

export function onCleanup(fn: Cleanup): void {
  if (currentCleanup) currentCleanup(fn);
  else onScopeDispose(fn, true);
}

export function batch<T>(fn: () => T): T {
  return fn();
}

export function untrack<T>(fn: () => T): T {
  return fn();
}
