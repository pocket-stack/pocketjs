// Typed PocketRock SDK over Host ABI 10's single bounded JSON bridge.
// Calls are synchronous by design: Rockbox owns the underlying state and
// copies one bounded response into QuickJS. Lists are always paginated.

import { getOps } from "./host.ts";

export const ROCKBOX_PAGE_MAX = 64;

export interface PocketRockError {
  code: string;
  message: string;
}

interface ErrorEnvelope {
  error?: PocketRockError;
}

function invoke<T>(service: string, method: string, payload: unknown = {}): T {
  const call = getOps().pocketrockCall;
  if (!call) throw new Error("PocketRock services require Host ABI 10");
  const raw = call(service, method, JSON.stringify(payload));
  let decoded: T & ErrorEnvelope;
  try {
    decoded = JSON.parse(raw) as T & ErrorEnvelope;
  } catch {
    throw new Error(`PocketRock ${service}.${method}: malformed host response`);
  }
  if (decoded.error) {
    throw new Error(`PocketRock ${decoded.error.code}: ${decoded.error.message}`);
  }
  return decoded;
}

function pageSize(limit = ROCKBOX_PAGE_MAX): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > ROCKBOX_PAGE_MAX) {
    throw new RangeError(`PocketRock page limit must be 1..${ROCKBOX_PAGE_MAX}`);
  }
  return limit;
}

export interface PlaybackSnapshot {
  status: "stopped" | "playing" | "paused";
  index: number;
  path: string | null;
  title: string;
  artist: string;
  album: string;
  elapsedMs: number;
  durationMs: number;
  volume: number;
  repeat: string;
  shuffle: boolean;
}

export const playback = {
  snapshot: () => invoke<PlaybackSnapshot>("playback", "snapshot"),
  play: () => invoke<{ ok: boolean }>("playback", "play").ok,
  pause: () => invoke<{ ok: boolean }>("playback", "pause").ok,
  toggle: () => invoke<{ ok: boolean }>("playback", "toggle").ok,
  previous: () => invoke<{ ok: boolean }>("playback", "previous").ok,
  next: () => invoke<{ ok: boolean }>("playback", "next").ok,
  seek: (elapsedMs: number) => invoke<{ ok: boolean }>("playback", "seek", { elapsedMs }).ok,
  setVolume: (volume: number) => invoke<{ ok: boolean }>("playback", "setVolume", { volume }).ok,
  setRepeat: (repeat: string) => invoke<{ ok: boolean }>("playback", "setRepeat", { repeat }).ok,
  setShuffle: (shuffle: boolean) =>
    invoke<{ ok: boolean }>("playback", "setShuffle", { shuffle }).ok,
};

export type LibraryKind = "artists" | "albums" | "tracks" | "playlists";

export interface LibraryEntry {
  id: number;
  title: string;
  subtitle?: string;
  path?: string;
  trackCount?: number;
}

export interface Page<T> {
  items: T[];
  offset: number;
  total: number;
  scanning?: boolean;
}

export const library = {
  page(kind: LibraryKind, offset = 0, limit = ROCKBOX_PAGE_MAX, parentId?: number) {
    return invoke<Page<LibraryEntry>>("library", "page", {
      kind,
      offset: Math.max(0, Math.trunc(offset)),
      limit: pageSize(limit),
      parentId,
    });
  },
  rescan: () => invoke<{ ok: boolean }>("library", "rescan").ok,
};

export interface QueueEntry {
  index: number;
  path: string;
  title: string;
  artist?: string;
}

export const queue = {
  page: (offset = 0, limit = ROCKBOX_PAGE_MAX) =>
    invoke<Page<QueueEntry>>("queue", "page", {
      offset: Math.max(0, Math.trunc(offset)),
      limit: pageSize(limit),
    }),
  replace: (paths: readonly string[], startIndex = 0) =>
    invoke<{ ok: boolean }>("queue", "replace", { paths, startIndex }).ok,
  append: (paths: readonly string[]) => invoke<{ ok: boolean }>("queue", "append", { paths }).ok,
  remove: (index: number) => invoke<{ ok: boolean }>("queue", "remove", { index }).ok,
  move: (from: number, to: number) => invoke<{ ok: boolean }>("queue", "move", { from, to }).ok,
  play: (index: number) => invoke<{ ok: boolean }>("queue", "play", { index }).ok,
};

export interface SystemSnapshot {
  batteryPercent: number;
  batteryMinutes: number | null;
  charging: boolean;
  freeBytes: number;
  totalBytes: number;
  backlight: boolean;
  usb: "disconnected" | "connected" | "mass-storage";
}

export const system = {
  snapshot: () => invoke<SystemSnapshot>("system", "snapshot"),
  setBacklight: (enabled: boolean) =>
    invoke<{ ok: boolean }>("system", "setBacklight", { enabled }).ok,
  powerOff: () => invoke<{ ok: boolean }>("system", "powerOff").ok,
  reboot: () => invoke<{ ok: boolean }>("system", "reboot").ok,
};

/** Internal launcher transport, public so custom System shells can use it. */
export function pocketrockLauncherCall<T>(method: string, payload: unknown = {}): T {
  return invoke<T>("launcher", method, payload);
}
