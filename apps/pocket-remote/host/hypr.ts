// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/host/hypr.ts — Hyprland over its two Unix sockets:
// requests (`j/clients`, `dispatch ...`) on .socket.sock, the event stream
// on .socket2.sock. Plus the pure reduction from Hyprland's JSON to the
// remote's snapshot, which is what the tests exercise.

import { connect, type Socket } from "node:net";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  clipTitle,
  type HostState,
  type Layout,
  type WinInfo,
  WINDOWS_MAX,
  type WsInfo,
} from "../protocol.ts";

// ---------------------------------------------------------------------------
// Hyprland JSON shapes (the fields the daemon reads)
// ---------------------------------------------------------------------------

export interface HyprMonitor {
  id: number;
  name: string;
  width: number;
  height: number;
  scale: number;
  x: number;
  y: number;
  focused: boolean;
  activeWorkspace: { id: number; name: string };
  specialWorkspace?: { id: number; name: string };
}

export interface HyprWorkspace {
  id: number;
  name: string;
  monitor: string;
  monitorID?: number;
  windows: number;
  tiledLayout?: string;
}

export interface HyprClient {
  address: string;
  mapped: boolean;
  hidden: boolean;
  at: [number, number];
  size: [number, number];
  workspace: { id: number; name: string };
  floating: boolean;
  monitor: number;
  class: string;
  title: string;
  initialClass: string;
  pinned: boolean;
  fullscreen: number;
  focusHistoryID: number;
}

export interface HyprActiveWindow {
  address?: string;
}

/**
 * Reduce Hyprland's state to the remote's snapshot: the focused monitor's
 * geometry in logical pixels, its active workspace, every ordinary workspace,
 * and the windows — most recently focused first, clipped to WINDOWS_MAX so
 * the line stays under the device's poll cap.
 */
/**
 * A title as a person would read it: without the program's own name tacked
 * on the end. Browsers and editors append " - Chromium", " — Zed", "- NVIM";
 * the tile already says which program it is.
 */
export function cleanTitle(title: string, windowClass: string): string {
  let out = title.trim();
  const name = windowClass.trim();
  if (!name) return out;
  const tail = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  for (const candidate of [name, tail]) {
    if (!candidate) continue;
    const pattern = new RegExp(`\\s*[-—–|]\\s*${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    out = out.replace(pattern, "");
  }
  return out.trim();
}

export function buildState(
  monitors: HyprMonitor[],
  workspaces: HyprWorkspace[],
  clients: HyprClient[],
  active: HyprActiveWindow | null,
): HostState {
  const monitor = monitors.find((m) => m.focused) ?? monitors[0];
  const scale = monitor && monitor.scale > 0 ? monitor.scale : 1;
  const monX = monitor?.x ?? 0;
  const monY = monitor?.y ?? 0;
  const mon = monitor
    ? { w: Math.round(monitor.width / scale), h: Math.round(monitor.height / scale), x: monX, y: monY }
    : { w: 1280, h: 800, x: 0, y: 0 };
  const activeWs = monitor?.activeWorkspace.id ?? 1;
  const special = monitor?.specialWorkspace && monitor.specialWorkspace.id !== 0;

  const ws: WsInfo[] = workspaces
    .filter((w) => w.id > 0)
    .sort((a, b) => a.id - b.id)
    .map((w) => ({ id: w.id, n: w.windows }));

  const layoutName = workspaces.find((w) => w.id === activeWs)?.tiledLayout;
  const layout: Layout = layoutName === "scrolling" ? "scrolling" : "dwindle";

  const win: WinInfo[] = clients
    .filter((c) => c.mapped && !c.hidden && c.workspace.id > 0)
    .sort((a, b) => a.focusHistoryID - b.focusHistoryID)
    .slice(0, WINDOWS_MAX)
    .map((c) => {
      const windowClass = c.class || c.initialClass || "?";
      const info: WinInfo = {
        a: c.address,
        c: windowClass,
        ti: clipTitle(cleanTitle(c.title || "", windowClass)),
        ws: c.workspace.id,
        x: Math.round(c.at[0] - monX),
        y: Math.round(c.at[1] - monY),
        w: Math.round(c.size[0]),
        h: Math.round(c.size[1]),
      };
      if (c.floating) info.f = 1;
      if (c.fullscreen === 1 || c.fullscreen === 2) info.fs = c.fullscreen;
      if (c.pinned) info.p = 1;
      return info;
    });

  const state: HostState = {
    t: "state",
    mon,
    ws,
    active: activeWs,
    focus: active?.address ?? null,
    win,
    layout,
  };
  if (special) state.special = 1;
  return state;
}

// ---------------------------------------------------------------------------
// sockets
// ---------------------------------------------------------------------------

/** Locate the running instance: $HYPRLAND_INSTANCE_SIGNATURE, else the one
 *  directory under $XDG_RUNTIME_DIR/hypr (a headless daemon has no session
 *  environment of its own). */
export function hyprDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  const base = join(runtime, "hypr");
  const signature = env.HYPRLAND_INSTANCE_SIGNATURE;
  if (signature) return join(base, signature);
  const entries = readdirSync(base).filter((entry) => !entry.startsWith("."));
  if (entries.length === 0) throw new Error(`no Hyprland instance under ${base}`);
  // Signatures end in _<startTime>_<pid>; the newest start time is the live one.
  entries.sort((a, b) => Number(b.split("_")[1] ?? 0) - Number(a.split("_")[1] ?? 0));
  return join(base, entries[0]!);
}

/** One request on .socket.sock; Hyprland answers and closes. */
export function hyprRequest(directory: string, command: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(join(directory, ".socket.sock"));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`hyprctl ${command}: timeout`));
    }, timeoutMs);
    socket.on("connect", () => socket.write(command));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export async function hyprJson<T>(directory: string, command: string): Promise<T> {
  const text = await hyprRequest(directory, `j/${command}`);
  return JSON.parse(text) as T;
}

/** Run one dispatcher given as a Lua expression (`hl.dsp...`): the request
 *  socket evaluates `hl.dispatch(<expr>)` and answers `ok`. */
export async function hyprDispatch(directory: string, lua: string): Promise<string> {
  return hyprRequest(directory, `dispatch ${lua}`);
}

/** Several dispatchers in one round trip, in order, as one Lua chunk. */
export async function hyprBatch(directory: string, luaDispatchers: string[]): Promise<string> {
  return hyprRequest(directory, `eval ${luaDispatchers.map((d) => `hl.dispatch(${d})`).join(" ")}`);
}

/** Lua for a window target by address (validated: `0x` + hex only). */
export function luaWindow(address: string): string | null {
  return /^0x[0-9a-f]+$/.test(address) ? `"address:${address}"` : null;
}

/** Lua for a workspace target: an id, or a relative step `e+1`/`e-1`. */
export function luaWorkspace(n: number, rel = false): string | null {
  if (!Number.isInteger(n)) return null;
  if (rel) return n === 0 ? null : `"e${n > 0 ? "+" : "-"}${Math.abs(n)}"`;
  return n >= 1 && n <= 10 ? `"${n}"` : null;
}

export async function snapshot(directory: string): Promise<HostState> {
  const [monitors, workspaces, clients, active] = await Promise.all([
    hyprJson<HyprMonitor[]>(directory, "monitors"),
    hyprJson<HyprWorkspace[]>(directory, "workspaces"),
    hyprJson<HyprClient[]>(directory, "clients"),
    hyprJson<HyprActiveWindow>(directory, "activewindow"),
  ]);
  return buildState(monitors, workspaces, clients, active && active.address ? active : null);
}

/** Event names on .socket2.sock that change what the remote shows. */
export const STATE_EVENTS = new Set([
  "workspace",
  "workspacev2",
  "focusedmon",
  "focusedmonv2",
  "activewindow",
  "activewindowv2",
  "fullscreen",
  "openwindow",
  "closewindow",
  "movewindow",
  "movewindowv2",
  "changefloatingmode",
  "createworkspace",
  "createworkspacev2",
  "destroyworkspace",
  "destroyworkspacev2",
  "activespecial",
  "activespecialv2",
  "windowtitle",
  "windowtitlev2",
  "pin",
  "configreloaded",
  "monitoradded",
  "monitorremoved",
]);

/** Parse one `EVENT>>DATA` line. */
export function parseEvent(line: string): { name: string; data: string } | null {
  const at = line.indexOf(">>");
  if (at < 0) return null;
  return { name: line.slice(0, at), data: line.slice(at + 2) };
}

/**
 * Subscribe to the event stream. `onEvent` fires per parsed line; the
 * connection is re-established after a drop with a short backoff so a
 * Hyprland restart does not orphan the daemon.
 */
export function watchEvents(
  directory: string,
  onEvent: (event: { name: string; data: string }) => void,
  onStatus: (message: string) => void = () => {},
): () => void {
  let socket: Socket | null = null;
  let stopped = false;
  let pending = "";
  const open = () => {
    if (stopped) return;
    socket = connect(join(directory, ".socket2.sock"));
    socket.on("connect", () => onStatus("events connected"));
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        const event = parseEvent(line);
        if (event) onEvent(event);
      }
    });
    const retry = () => {
      if (stopped) return;
      socket = null;
      onStatus("events dropped, retrying");
      setTimeout(open, 1000);
    };
    socket.on("error", retry);
    socket.on("close", () => {
      if (socket) retry();
    });
  };
  open();
  return () => {
    stopped = true;
    socket?.destroy();
    socket = null;
  };
}
