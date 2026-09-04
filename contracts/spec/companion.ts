// contracts/spec/companion.ts — the COMPANION protocol.
//
// A companion is a process on the same network (a Mac, a Linux box, a phone
// with a real CPU) that lends a Pocket guest the work the guest must not do
// itself: file trees, databases, HTTP, text layout, indexing. The guest keeps
// one thread and one tick; every call to a companion is a JSON line out and,
// on a later tick, a JSON line back. Nothing here can block the guest.
//
// The protocol rides the svc mailbox (spec ops 30–32: svcOpen / svcPoll /
// svcSend), so it inherits the transports that mailbox already has — a PKNT
// TCP link with UDP beacon discovery on the consoles, usbhostfs on the PSP, a
// file pair in the sim — and adds one layer on top: requests with ids,
// replies that may span several lines, and named event topics.
//
// Every shape below is shared by the guest SDK (framework/src/companion*.ts),
// the companion library (tools/companion-host.ts) and the deterministic sim
// pair (hosts/sim/companion.ts). Change it here or nowhere.
//
// ── Records ────────────────────────────────────────────────────────────────
//
//   guest → companion
//     {"t":"hello","proto":1,"session":N,"device":"3ds-dev"}
//         Once per connection. `session` is drawn afresh by every guest boot,
//         so a companion tells a hot-pushed guest from a reconnecting one.
//     {"q":ID,"m":"method","p":PARAMS}       request
//     {"c":ID}                                cancel — the guest no longer
//                                             wants the reply; the companion
//                                             may skip the work
//     {"s":"topic","on":1|0}                  subscribe / unsubscribe
//
//   companion → guest
//     {"t":"hello","proto":1,"name":"…"}      answers the guest hello
//     {"r":ID,"ok":RESULT} | {"r":ID,"err":"…"}
//                                             a reply that fits one line
//     {"r":ID,"i":K,"n":N,"s":"…"}            chunk K of N; the concatenated
//                                             `s` strings are the JSON of a
//                                             one-line reply body
//     {"e":"topic","d":DATA}                  an event on a subscribed topic
//
// ── Limits — these are the architecture ────────────────────────────────────
//
// The guest's per-frame cost is bounded by construction, not by discipline:
//
//   - one svcPoll per frame delivers at most SVC_POLL_BUF (8 KiB) of complete
//     lines, so the guest never parses more than that of fresh text per tick;
//   - a line is at most COMPANION_LINE_BYTES so two fit one poll with room
//     for the frame header;
//   - a reply reassembled from chunks is at most COMPANION_REPLY_BYTES, so
//     one JSON.parse of a finished reply is bounded too. A companion that
//     has more to say pages: the limit is enforced where the reply is built,
//     and a method that overflows it fails loudly instead of stalling a
//     device it never sees.
//
// Requests are idempotent by contract. A reconnect re-sends every request
// still pending and re-subscribes every topic; a reply to a superseded or
// cancelled request is dropped on arrival. That is what lets a query be a
// resource — "the latest reply for this key" — instead of a stream the app
// has to fence with generation counters.

import { SVC_POLL_BUF } from "./spec.ts";

export const COMPANION_PROTO = 1;

/** Max bytes of one JSON line on the mailbox, newline excluded. The svc
 *  transport caps a line at SVC_POLL_BUF; this leaves headroom for a
 *  second short line in the same poll. */
export const COMPANION_LINE_BYTES = 6144;

/** Max bytes of a reply body (`{"ok":…}` / `{"err":…}`) after chunks are
 *  joined — the ceiling on one unit of guest work. */
export const COMPANION_REPLY_BYTES = 32 * 1024;

/** Max bytes of one event body. Events are never chunked: an event that
 *  needs more is a query the guest should make. */
export const COMPANION_EVENT_BYTES = COMPANION_LINE_BYTES;

/** Requests a guest may hold open at once; call() rejects past it. A live
 *  query holds at most one, so this only guards a runaway loop. */
export const COMPANION_MAX_PENDING = 64;

/** Each chunk line carries this much of the body; the JSON envelope around
 *  it stays well under COMPANION_LINE_BYTES even after escaping. */
export const COMPANION_CHUNK_BYTES = 4096;

if (COMPANION_LINE_BYTES >= SVC_POLL_BUF) {
  throw new Error("companion: COMPANION_LINE_BYTES must stay under SVC_POLL_BUF");
}

// ── Guest → companion ──────────────────────────────────────────────────────

export interface CompanionGuestHello {
  readonly t: "hello";
  readonly proto: number;
  /** Fresh per guest boot; lets the companion reset per-guest state. */
  readonly session: number;
  /** The guest's target id, for a companion that adapts its payloads. */
  readonly device?: string;
}

export interface CompanionRequest {
  readonly q: number;
  readonly m: string;
  readonly p?: unknown;
}

export interface CompanionCancel {
  readonly c: number;
}

export interface CompanionSubscribe {
  readonly s: string;
  readonly on: 0 | 1;
}

export type CompanionGuestLine =
  | CompanionGuestHello
  | CompanionRequest
  | CompanionCancel
  | CompanionSubscribe;

// ── Companion → guest ──────────────────────────────────────────────────────

export interface CompanionHostHello {
  readonly t: "hello";
  readonly proto: number;
  /** Human-readable companion name (the machine, usually). */
  readonly name: string;
}

export type CompanionReplyBody = { readonly ok: unknown } | { readonly err: string };

export type CompanionReply = { readonly r: number } & CompanionReplyBody;

export interface CompanionChunk {
  readonly r: number;
  readonly i: number;
  readonly n: number;
  readonly s: string;
}

export interface CompanionEvent {
  readonly e: string;
  readonly d: unknown;
}

export type CompanionHostLine = CompanionHostHello | CompanionReply | CompanionChunk | CompanionEvent;

// ── Shared helpers ─────────────────────────────────────────────────────────

/** UTF-8 length of a JS string without allocating the bytes. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Encode a reply as mailbox lines: one line when the body fits, else
 * ordered chunks whose `s` strings concatenate to the body's JSON. Throws
 * when the body exceeds COMPANION_REPLY_BYTES — the companion must page.
 */
export function encodeReplyLines(id: number, body: CompanionReplyBody): string[] {
  const whole = JSON.stringify({ r: id, ...body });
  if (utf8Length(whole) <= COMPANION_LINE_BYTES) return [whole];
  const bodyJson = JSON.stringify(body);
  const bytes = utf8Length(bodyJson);
  if (bytes > COMPANION_REPLY_BYTES) {
    throw new Error(
      `companion: reply ${id} is ${bytes} bytes; the ceiling is ${COMPANION_REPLY_BYTES} — page the result`,
    );
  }
  // Cut where the chunk's ESCAPED UTF-8 form reaches the budget — a quote
  // costs two bytes on the wire and an accented letter two or three, so
  // counting code units would overrun the line cap. Never cut a surrogate
  // pair.
  const parts: string[] = [];
  let start = 0;
  let cost = 0;
  for (let i = 0; i < bodyJson.length; i++) {
    const code = bodyJson.charCodeAt(i);
    let step: number;
    let units = 1;
    if (code === 0x22 || code === 0x5c) step = 2;
    else if (code < 0x20) step = code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    else if (code < 0x80) step = 1;
    else if (code < 0x800) step = 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < bodyJson.length) {
      step = 4;
      units = 2;
    } else if (code >= 0xd800 && code <= 0xdfff) step = 6; // a lone surrogate is escaped
    else step = 3;
    if (cost + step > COMPANION_CHUNK_BYTES && i > start) {
      parts.push(bodyJson.slice(start, i));
      start = i;
      cost = 0;
    }
    cost += step;
    i += units - 1;
  }
  parts.push(bodyJson.slice(start));
  return parts.map((s, i) => JSON.stringify({ r: id, i, n: parts.length, s }));
}

/** Encode an event line; throws when it would not fit one line. */
export function encodeEventLine(topic: string, data: unknown): string {
  const line = JSON.stringify({ e: topic, d: data });
  const bytes = utf8Length(line);
  if (bytes > COMPANION_EVENT_BYTES) {
    throw new Error(
      `companion: event "${topic}" is ${bytes} bytes; the ceiling is ${COMPANION_EVENT_BYTES} — publish a version and let the guest query`,
    );
  }
  return line;
}

/** Split a svcPoll batch into parsed lines, skipping malformed ones. */
export function parseLines<T>(batch: string): T[] {
  const out: T[] = [];
  let start = 0;
  while (start < batch.length) {
    let end = batch.indexOf("\n", start);
    if (end < 0) end = batch.length;
    if (end > start) {
      try {
        out.push(JSON.parse(batch.slice(start, end)) as T);
      } catch {
        // A torn or foreign line is not the guest's problem to repair.
      }
    }
    start = end + 1;
  }
  return out;
}
