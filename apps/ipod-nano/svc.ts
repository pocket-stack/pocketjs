// Host media protocol for the iPod nano demo.
//
// The PocketJS guest owns UI/navigation state; Pocket Stage owns local files,
// decoding and the audio device. They exchange newline-delimited JSON over the
// existing HostOps service queue. File paths and compressed audio bytes never
// enter QuickJS.
//
// guest -> host
//   {t:"media", op:"play"|"toggle"|"pause"|"resume"|"next"|"previous", index?}
//
// host -> guest
//   {t:"media.hello", tracks:[...], index, playing, positionMs, durationMs}
//   {t:"media.state", index, playing, positionMs, durationMs, error?}

import { getOps } from "@pocketjs/framework";

// Must match `media.channel` in the Stage package's profile.json
// (engine/pocket3d/examples/handheld/assets/ipod-nano-2). The host only allows the
// exact package-authored channel through svcOpen; a rename there without a
// matching change here silently downgrades the demo to its offline mock.
// tests/ipod-nano.test.ts pins the pair together.
export const NANO_AUDIO_SERVICE = "ipod-nano";

export type NanoMediaOperation =
  | "play"
  | "toggle"
  | "pause"
  | "resume"
  | "next"
  | "previous";

export interface NanoAudioCommand {
  readonly t: "media";
  readonly op: NanoMediaOperation;
  readonly index?: number;
}

export interface NanoMediaTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly durationMs: number;
}

export type NanoAudioEvent =
  | {
      readonly t: "media.hello";
      readonly tracks: readonly NanoMediaTrack[];
      readonly index: number;
      readonly playing: boolean;
      readonly positionMs: number;
      readonly durationMs: number;
    }
  | {
      readonly t: "media.state";
      readonly index: number;
      readonly playing: boolean;
      readonly positionMs: number;
      readonly durationMs: number;
      readonly error?: string;
    };

export interface NanoAudioServiceOps {
  svcOpen?(app: string): boolean;
  svcPoll?(): string | undefined;
  svcSend?(line: string): void;
}

export interface NanoAudioService {
  poll(): NanoAudioEvent[];
  send(command: NanoAudioCommand): void;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function parseTrack(value: unknown): NanoMediaTrack | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const track = value as Record<string, unknown>;
  if (
    typeof track.id !== "string" ||
    track.id.length === 0 ||
    typeof track.title !== "string" ||
    typeof track.artist !== "string" ||
    !finiteNonNegative(track.durationMs)
  ) {
    return null;
  }
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    durationMs: track.durationMs,
  };
}

/** Parse one host line. Unknown or malformed messages are ignored. */
export function parseNanoAudioEvent(line: string): NanoAudioEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.t !== "media.hello" && event.t !== "media.state") return null;
  if (
    !nonNegativeIndex(event.index) ||
    typeof event.playing !== "boolean" ||
    !finiteNonNegative(event.positionMs) ||
    !finiteNonNegative(event.durationMs)
  ) {
    return null;
  }

  if (event.t === "media.hello") {
    if (!Array.isArray(event.tracks) || event.tracks.length === 0) return null;
    const tracks: NanoMediaTrack[] = [];
    for (const value of event.tracks) {
      const track = parseTrack(value);
      if (!track) return null;
      tracks.push(track);
    }
    if (event.index >= tracks.length) return null;
    return {
      t: "media.hello",
      tracks,
      index: event.index,
      playing: event.playing,
      positionMs: event.positionMs,
      durationMs: event.durationMs,
    };
  }

  if (event.error !== undefined && typeof event.error !== "string") return null;
  return {
    t: "media.state",
    index: event.index,
    playing: event.playing,
    positionMs: event.positionMs,
    durationMs: event.durationMs,
    ...(event.error === undefined ? {} : { error: event.error }),
  };
}

/** Parse a newline-delimited host batch, retaining only valid protocol lines. */
export function parseNanoAudioBatch(batch: string | undefined): NanoAudioEvent[] {
  if (!batch) return [];
  const events: NanoAudioEvent[] = [];
  for (const line of batch.split("\n")) {
    if (line === "") continue;
    const event = parseNanoAudioEvent(line);
    if (event) events.push(event);
  }
  return events;
}

/** Feature-detect the service transport. null activates the deterministic mock. */
export function connectNanoAudioService(
  ops: NanoAudioServiceOps = getOps(),
): NanoAudioService | null {
  if (!ops.svcOpen || !ops.svcPoll || !ops.svcSend) return null;
  if (!ops.svcOpen(NANO_AUDIO_SERVICE)) return null;
  const poll = ops.svcPoll.bind(ops);
  const send = ops.svcSend.bind(ops);
  return {
    poll: () => parseNanoAudioBatch(poll()),
    send: (command) => send(JSON.stringify(command)),
  };
}
