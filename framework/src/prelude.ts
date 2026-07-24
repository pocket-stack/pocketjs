// Runtime globals that must exist before Vue Vapor scheduler modules evaluate.

import { installVueVaporDom } from "./vue-vapor-dom.ts";

if (typeof (globalThis as { queueMicrotask?: unknown }).queueMicrotask !== "function") {
  (globalThis as { queueMicrotask?: (fn: () => void) => void }).queueMicrotask = (
    fn: () => void,
  ) => {
    Promise.resolve().then(fn);
  };
}

if (typeof (globalThis as { setTimeout?: unknown }).setTimeout !== "function") {
  (globalThis as unknown as { setTimeout?: (fn: () => void, delay?: number) => number }).setTimeout = (
    fn: () => void,
  ) => {
    queueMicrotask(fn);
    return 0;
  };
}

if (typeof (globalThis as { clearTimeout?: unknown }).clearTimeout !== "function") {
  (globalThis as { clearTimeout?: (id: number) => void }).clearTimeout = () => {};
}

if (typeof (globalThis as { console?: unknown }).console !== "object") {
  (globalThis as unknown as { console?: Record<string, (...args: unknown[]) => void> }).console = {};
}
{
  // QuickJS's js_std_add_helpers ships console.log only; Vue's error
  // handler calls console.error unconditionally. Fill any missing level,
  // defaulting to the host's log (or a no-op) so console.* never throws.
  const c = (globalThis as unknown as { console: Record<string, ((...args: unknown[]) => void) | undefined> }).console;
  for (const level of ["log", "warn", "error"] as const) {
    if (typeof c[level] !== "function") c[level] = c.log ?? (() => {});
  }
}

installVueVaporDom();
