// @pocketjs/framework/launcher — the guest side of app switching
// (spec ops 39..41, docs/LAUNCHER.md).
//
// Multi-app hosts embed several bundles and swap the whole guest between
// them; these wrappers expose the table, the switch request, and the frozen
// frame the SELECT summon captured. Every accessor degrades on hosts
// without the ops (single-app EBOOTs, web, vita): appTable() -> null,
// launchApp() -> false, frozenShot() -> -1 — so a launcher bundle stays
// admissible anywhere and just renders its empty state.

import { getOps } from "./host.ts";

/** One embedded bundle, as the host reports it (registry order). */
export interface AppEntry {
  /** dist output name — the appLaunch() key (e.g. "cafe-main"). */
  output: string;
  /** Manifest id (e.g. "dev.pocket-stack.cafe"). */
  id: string;
  /** Manifest title, for display. */
  title: string;
  /** PocketJS package or a native Rockbox .rock plugin. Older hosts omit it. */
  kind?: "pocket" | "rockbox";
  /** Absolute on-volume .rock path for native entries. */
  path?: string;
}

export interface AppTable {
  apps: AppEntry[];
  /** Output name of the running bundle. */
  current: string;
  /** The app interrupted by the last SELECT summon; null after a cold boot
   *  or an explicit launch. Resume = launchApp(resume) — a fresh relaunch,
   *  never a thaw (docs/LAUNCHER.md: there is no suspend in this protocol). */
  resume: string | null;
}

/** Whether the active host can switch apps at all. */
export function launcherActive(): boolean {
  const ops = getOps();
  return typeof ops.appTable === "function" || typeof ops.pocketrockCall === "function";
}

/** The embedded bundle table, or null on hosts without app switching. */
export function appTable(): AppTable | null {
  const ops = getOps();
  const raw = ops.appTable?.() ??
    ops.pocketrockCall?.("launcher", "appTable", "{}");
  if (!raw) return null;
  const parsed = JSON.parse(raw) as AppTable;
  return { apps: parsed.apps ?? [], current: parsed.current ?? "", resume: parsed.resume ?? null };
}

/** Request a whole-guest switch. True = scheduled (the host swaps after the
 *  current frame presents); false = unknown output or no switching host. */
export function launchApp(output: string): boolean {
  return (getOps().appLaunch?.(output) ?? 0) !== 0;
}

/** Launch an installed .pocket package by manifest id. The host saves Shell
 * state, destroys the current realm, then creates exactly one app realm. */
export function launchPackage(id: string): boolean {
  const call = getOps().pocketrockCall;
  if (!call) return launchApp(id);
  const result = JSON.parse(call("launcher", "launchPackage", JSON.stringify({ id }))) as {
    ok?: boolean;
  };
  return result.ok === true;
}

/** Exit the foreground app back to the embedded Shell, optionally replacing
 * its small serialized navigation state. */
export function exitToSystem(sessionState?: unknown): boolean {
  const call = getOps().pocketrockCall;
  if (!call) return false;
  const result = JSON.parse(
    call("launcher", "exitToSystem", JSON.stringify({ sessionState })),
  ) as { ok?: boolean };
  return result.ok === true;
}

/** Session state restored into a newly-created Shell realm. */
export function restoreSessionState<T = unknown>(): T | null {
  const call = getOps().pocketrockCall;
  if (!call) return null;
  const result = JSON.parse(call("launcher", "restoreSessionState", "{}")) as {
    state?: T | null;
  };
  return result.state ?? null;
}

/** Cold-switch to Rockbox's native plugin loader. PocketRock destroys the JS
 * realm and releases its whole 16MiB arena before plugin_load(). */
export function launchNativePlugin(path: string, parameter?: string): boolean {
  const call = getOps().pocketrockCall;
  if (!call) return false;
  const result = JSON.parse(
    call("launcher", "launchNativePlugin", JSON.stringify({ path, parameter })),
  ) as { ok?: boolean };
  return result.ok === true;
}

/** Texture handle of the summon's frozen frame (256×128 PSM_8888), -1 when
 *  none was captured. Bind it under a name with the renderer's
 *  registerTexture(key, handle) and reference it as <Image src={key}>. */
export function frozenShot(): number {
  return getOps().appShot?.() ?? -1;
}
