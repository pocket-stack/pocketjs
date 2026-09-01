// No-op stand-in for `octane/profiling`, aliased in by the build for
// framework=octane bundles (framework/compiler/jsx-plugin.ts).
//
// Two reasons, both PSP-driven:
// 1. Memory — the real profiler records per-render bookkeeping into
//    module-level WeakMaps (`trackedComponents` is written even while the
//    profiler is stopped). The pinned QuickJS's new GC marks weak-record
//    VALUES strongly (js_map_mark is not ephemeron-aware), so entries whose
//    value closes over their key pin every render's owner graph: heavy demos
//    leaked ~50 objects per re-render until the fixed arena OOM'd
//    (music died at frame 58 of its capture window).
// 2. Time — with the profiler stubbed out, no per-render profiling work runs
//    inside the PSP frame budget at all.
//
// Keep the export surface in sync with octane/dist/profiling.js.

export function __profileBail(..._args: unknown[]): void {}
export function __profileBeginRender(
  ..._args: unknown[]
): null {
  return null;
}
export function __profileComponent<T>(component: T, ..._rest: unknown[]): T {
  return component;
}
export function __profileComponentSource(..._args: unknown[]): void {}
export function __profileEndRender(..._args: unknown[]): void {}
export function __profileHasComponentMetadata(..._args: unknown[]): boolean {
  return false;
}
export function __profileHook<T>(slot: T, ..._rest: unknown[]): T {
  return slot;
}
export function __profileResolveHook<T>(slot: T, ..._rest: unknown[]): T {
  return slot;
}
export function __profileSchedule(..._args: unknown[]): void {}
export function __profileTrackComponent(..._args: unknown[]): void {}

export const profiler = {
  start(_options?: unknown): void {},
  stop(): void {},
  clear(): void {},
  isActive(): boolean {
    return false;
  },
  exportTrace(): { events: never[] } {
    return { events: [] };
  },
  events(): never[] {
    return [];
  },
};
