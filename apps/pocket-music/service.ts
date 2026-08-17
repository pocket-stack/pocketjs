import { getOps } from "@pocketjs/framework";

export const POCKET_MUSIC_SERVICE = "pocket-music";

export type PocketMusicOperation =
  | "toggle"
  | "next"
  | "previous"
  | "stop"
  | "mute"
  | "volume-up"
  | "volume-down";

export interface PocketMusicTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly durationMs: number;
}

export interface PocketMusicState {
  readonly daemonConnected: boolean;
  readonly deviceConnected: boolean;
  readonly playerRunning: boolean;
  readonly playing: boolean;
  readonly positionMs: number;
  readonly volume: number;
  readonly sequence: number;
  readonly track?: PocketMusicTrack;
  readonly lastControl?: string;
  readonly error?: string;
}

export interface PocketMusicServiceOps {
  svcOpen?(app: string): boolean;
  svcPoll?(): string | undefined;
  svcSend?(line: string): void;
}

export interface PocketMusicConnection {
  poll(): PocketMusicState[];
  send(op: PocketMusicOperation): void;
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseTrack(value: unknown): PocketMusicTrack | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const track = value as Record<string, unknown>;
  if (
    typeof track.id !== "string" ||
    typeof track.title !== "string" ||
    typeof track.artist !== "string" ||
    typeof track.album !== "string" ||
    !nonNegative(track.durationMs)
  ) {
    return null;
  }
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs: track.durationMs,
  };
}

export function parsePocketMusicState(line: string): PocketMusicState | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.t !== "pocket-music.state") return null;
  if (
    typeof event.daemonConnected !== "boolean" ||
    typeof event.deviceConnected !== "boolean" ||
    typeof event.playerRunning !== "boolean" ||
    typeof event.playing !== "boolean" ||
    !nonNegative(event.positionMs) ||
    !nonNegative(event.volume) ||
    event.volume > 100 ||
    !Number.isInteger(event.sequence) ||
    (event.sequence as number) < 0
  ) {
    return null;
  }
  const track = parseTrack(event.track);
  if (track === null) return null;
  if (event.lastControl !== undefined && typeof event.lastControl !== "string") return null;
  if (event.error !== undefined && typeof event.error !== "string") return null;
  return {
    daemonConnected: event.daemonConnected,
    deviceConnected: event.deviceConnected,
    playerRunning: event.playerRunning,
    playing: event.playing,
    positionMs: event.positionMs,
    volume: event.volume,
    sequence: event.sequence as number,
    ...(track === undefined ? {} : { track }),
    ...(event.lastControl === undefined ? {} : { lastControl: event.lastControl as string }),
    ...(event.error === undefined ? {} : { error: event.error as string }),
  };
}

export function parsePocketMusicBatch(batch: string | undefined): PocketMusicState[] {
  if (!batch) return [];
  const states: PocketMusicState[] = [];
  for (const line of batch.split("\n")) {
    const state = parsePocketMusicState(line);
    if (state) states.push(state);
  }
  return states;
}

export function connectPocketMusic(
  ops: PocketMusicServiceOps = getOps(),
): PocketMusicConnection | null {
  if (!ops.svcOpen || !ops.svcPoll || !ops.svcSend) return null;
  if (!ops.svcOpen(POCKET_MUSIC_SERVICE)) return null;
  const poll = ops.svcPoll.bind(ops);
  const send = ops.svcSend.bind(ops);
  return {
    poll: () => parsePocketMusicBatch(poll()),
    send: (op) => send(JSON.stringify({ t: "pocket-music.command", op })),
  };
}
