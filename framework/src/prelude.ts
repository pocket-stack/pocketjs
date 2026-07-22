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
  (globalThis as { setTimeout?: (fn: () => void, delay?: number) => number }).setTimeout = (
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
  (globalThis as unknown as { console?: Record<string, (...args: unknown[]) => void> }).console = {
    log() {},
    warn() {},
    error() {},
  };
}

installVueVaporDom();
