// Runtime scheduler globals shared by the Vue Vapor and Octane entries.
// QuickJS has no event loop: queueMicrotask lowers onto the promise job
// queue (drained by the host once per frame) and setTimeout degrades to a
// microtask — deterministic-clock apps use onFrame/after() instead.

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
  (globalThis as unknown as { console?: Record<string, (...args: unknown[]) => void> }).console = {
    log() {},
    warn() {},
    error() {},
  };
}
