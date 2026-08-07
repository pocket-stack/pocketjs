// PocketJS net SDK — a deliberately small, bounded fetch over globalThis.net.
// The native contract lives in contracts/spec/net.ts. This file is framework
// neutral and serves ./net, ./vue-vapor/net and ./octane/net.

import {
  NET_DEFAULT_RESPONSE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
  NET_ERROR,
  NET_MAX_HEADER_BYTES,
  NET_MAX_HEADERS,
  NET_MAX_REQUEST_BYTES,
  NET_MAX_RESPONSE_BYTES,
  NET_MAX_TIMEOUT_MS,
  NET_METHODS,
  type NetErrorCode,
  type NetMethod,
} from "../../contracts/spec/net.ts";
import { registerServicePump } from "./services.ts";

export {
  NET_DEFAULT_RESPONSE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
  NET_MAX_REQUEST_BYTES,
  NET_MAX_RESPONSE_BYTES,
  NET_MAX_TIMEOUT_MS,
  NET_METHODS,
};
export type { NetErrorCode, NetMethod };

export interface NetOps {
  /** Request body is borrowed for this synchronous call. */
  start(metaJson: string, body: ArrayBuffer): number;
  /** Copy a completed body into an exactly-sized buffer, exactly once. */
  take(handle: number, into: ArrayBuffer): number;
  cancel(handle: number): void;
  /** One JSON array containing the entire event batch visible this tick. */
  poll(): string | undefined;
  lastError(): string;
}

export interface FetchOptions {
  method?: NetMethod;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array | ArrayBuffer;
  /** 1..120000; defaults to 30000. Enforced by the native transport. */
  timeoutMs?: number;
  /** Whole response-body cap; defaults to 128 KiB, absolute max 256 KiB. */
  maxBytes?: number;
}

export class NetError extends Error {
  readonly code: NetErrorCode;

  constructor(code: NetErrorCode, message: string) {
    super(message);
    this.name = "NetError";
    this.code = code;
  }
}

export class PocketResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly ok: boolean;
  private readonly data: Uint8Array;

  constructor(
    status: number,
    url: string,
    headers: Readonly<Record<string, string>>,
    body: ArrayBuffer,
  ) {
    this.status = status;
    this.url = url;
    this.headers = Object.freeze({ ...headers });
    this.ok = status >= 200 && status < 300;
    this.data = new Uint8Array(body);
  }

  get byteLength(): number {
    return this.data.byteLength;
  }

  /** A copy, so response reads cannot mutate the body retained by this value. */
  async bytes(): Promise<Uint8Array> {
    return this.data.slice();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.slice().buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    return decodeUtf8(this.data);
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }
}

interface DoneEvent {
  t: "done";
  h: number;
  status: number;
  url: string;
  headers: Record<string, string>;
  bytes: number;
}

interface ErrorEvent {
  t: "error";
  h: number;
  code: NetErrorCode;
  message: string;
}

type NetEvent = DoneEvent | ErrorEvent;

interface Pending {
  readonly ops: NetOps;
  readonly resolve: (response: PocketResponse) => void;
  readonly reject: (error: NetError) => void;
}

const pending = new Map<number, Pending>();
let stopPump: (() => void) | null = null;
let activeOps: NetOps | null = null;

export function netHost(): NetOps | null {
  const ns = (globalThis as { net?: unknown }).net;
  if (!ns || typeof ns !== "object") return null;
  const ops = ns as Partial<NetOps>;
  return typeof ops.start === "function" &&
      typeof ops.take === "function" &&
      typeof ops.cancel === "function" &&
      typeof ops.poll === "function" &&
      typeof ops.lastError === "function"
    ? (ops as NetOps)
    : null;
}

function errorCode(value: unknown): NetErrorCode {
  const code = String(value);
  for (const known of Object.values(NET_ERROR)) {
    if (known === code) return known;
  }
  return NET_ERROR.other;
}

function settle(ev: NetEvent): void {
  const p = pending.get(ev.h);
  if (!p) return;
  pending.delete(ev.h);
  if (ev.t === "error") {
    p.reject(new NetError(errorCode(ev.code), String(ev.message || ev.code)));
  } else {
    if (
      !Number.isInteger(ev.status) ||
      ev.status < 100 ||
      ev.status > 599 ||
      typeof ev.url !== "string" ||
      typeof ev.headers !== "object" ||
      ev.headers === null ||
      !Number.isInteger(ev.bytes) ||
      ev.bytes < 0 ||
      ev.bytes > NET_MAX_RESPONSE_BYTES
    ) {
      p.ops.cancel(ev.h);
      p.reject(new NetError(NET_ERROR.protocol, "net: malformed done event"));
    } else {
      const body = new ArrayBuffer(ev.bytes);
      const copied = p.ops.take(ev.h, body);
      if (copied !== ev.bytes) {
        p.ops.cancel(ev.h);
        p.reject(new NetError(NET_ERROR.protocol, "net: response body transfer failed"));
      } else {
        p.resolve(new PocketResponse(ev.status, ev.url, ev.headers, body));
      }
    }
  }
  if (pending.size === 0 && stopPump) {
    stopPump();
    stopPump = null;
    activeOps = null;
  }
}

/** Internal module service hook. It performs exactly one native poll call and
 * only exists in the frame pump while at least one fetch is pending. */
export function __pumpNet(): void {
  if (pending.size === 0) return;
  const ops = activeOps;
  if (!ops) return;
  const batch = ops.poll();
  if (batch !== undefined) {
    let events: unknown = null;
    try {
      events = JSON.parse(batch);
    } catch {
      // handled as a protocol failure below
    }
    if (!Array.isArray(events)) {
      for (const [handle, p] of pending) {
        ops.cancel(handle);
        pending.delete(handle);
        p.reject(new NetError(NET_ERROR.protocol, "net: malformed event batch"));
      }
    } else {
      for (const event of events) {
        if (!event || typeof event !== "object") continue;
        const ev = event as Partial<NetEvent>;
        if (!Number.isInteger(ev.h) || (ev.t !== "done" && ev.t !== "error")) continue;
        settle(ev as NetEvent);
      }
    }
  }
  if (pending.size === 0 && stopPump) {
    stopPump();
    stopPump = null;
    activeOps = null;
  }
}

function reject(code: NetErrorCode, message: string): Promise<never> {
  return Promise.reject(new NetError(code, message));
}

function integerInRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new NetError(NET_ERROR.invalidRequest, `net: ${label} must be ${min}..${max}`);
  }
  return value;
}

function normalizeHeaders(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  let count = 0;
  let bytes = 0;
  for (const rawName of Object.keys(input ?? {})) {
    const name = rawName.toLowerCase();
    const value = String(input![rawName]);
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new NetError(NET_ERROR.invalidRequest, `net: invalid header ${rawName}`);
    }
    count++;
    bytes += utf8Length(name) + utf8Length(value) + 4;
    if (count > NET_MAX_HEADERS || bytes > NET_MAX_HEADER_BYTES) {
      throw new NetError(NET_ERROR.invalidRequest, "net: request headers exceed limits");
    }
    out[name] = value;
  }
  return out;
}

function requestBody(body: FetchOptions["body"]): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return encodeUtf8(body);
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  throw new NetError(NET_ERROR.invalidRequest, "net: body must be string or bytes");
}

/** The PocketJS HTTP client. It is fetch-shaped but intentionally not the
 * complete browser Fetch API: no streams, cookies, cache, Request, Signal or
 * implicit ambient authority. */
export function fetch(url: string, options: FetchOptions = {}): Promise<PocketResponse> {
  const ops = netHost();
  if (!ops) return reject(NET_ERROR.unavailable, "net: host did not mount the net module");

  try {
    if (typeof url !== "string" || !/^https?:\/\/[^\s/]+(?:\/|$)/.test(url)) {
      throw new NetError(NET_ERROR.invalidRequest, "net: url must be absolute http:// or https://");
    }
    const method = options.method ?? "GET";
    if (!(NET_METHODS as readonly string[]).includes(method)) {
      throw new NetError(NET_ERROR.invalidRequest, `net: unsupported method ${String(method)}`);
    }
    const body = requestBody(options.body);
    if ((method === "GET" || method === "HEAD") && body.byteLength > 0) {
      throw new NetError(NET_ERROR.invalidRequest, `net: ${method} cannot have a body`);
    }
    if (body.byteLength > NET_MAX_REQUEST_BYTES) {
      throw new NetError(NET_ERROR.invalidRequest, "net: request body exceeds 64 KiB");
    }
    const timeoutMs = integerInRange(
      options.timeoutMs ?? NET_DEFAULT_TIMEOUT_MS,
      1,
      NET_MAX_TIMEOUT_MS,
      "timeoutMs",
    );
    const maxBytes = integerInRange(
      options.maxBytes ?? NET_DEFAULT_RESPONSE_BYTES,
      1,
      NET_MAX_RESPONSE_BYTES,
      "maxBytes",
    );
    const meta = JSON.stringify({
      url,
      method,
      headers: normalizeHeaders(options.headers),
      timeoutMs,
      maxBytes,
    });
    if (activeOps && activeOps !== ops) {
      throw new NetError(NET_ERROR.unavailable, "net: mounted host changed while requests are pending");
    }
    const handle = ops.start(meta, body.buffer as ArrayBuffer);
    if (!Number.isInteger(handle) || handle < 0) {
      const detail = ops.lastError() || "unavailable: request refused";
      const split = detail.indexOf(":");
      const code = errorCode(split < 0 ? NET_ERROR.other : detail.slice(0, split));
      const message = split < 0 ? detail : detail.slice(split + 1).trim();
      return reject(code, message);
    }
    return new Promise<PocketResponse>((resolve, rejectPending) => {
      pending.set(handle, { ops, resolve, reject: rejectPending });
      activeOps = ops;
      if (!stopPump) stopPump = registerServicePump(__pumpNet);
    });
  } catch (error) {
    return error instanceof NetError
      ? Promise.reject(error)
      : reject(NET_ERROR.invalidRequest, String(error));
  }
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i)!;
    if (code > 0xffff) i++;
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return n;
}

function encodeUtf8(s: string): Uint8Array {
  const out = new Uint8Array(utf8Length(s));
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let code = s.codePointAt(i)!;
    if (code > 0xffff) i++;
    else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out[o++] = code;
    else if (code < 0x800) {
      out[o++] = 0xc0 | (code >> 6);
      out[o++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[o++] = 0xe0 | (code >> 12);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    } else {
      out[o++] = 0xf0 | (code >> 18);
      out[o++] = 0x80 | ((code >> 12) & 0x3f);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const a = bytes[i++];
    if (a < 0x80) {
      out += String.fromCharCode(a);
      continue;
    }
    let code: number;
    let extra: number;
    if ((a & 0xe0) === 0xc0) {
      code = a & 0x1f;
      extra = 1;
    } else if ((a & 0xf0) === 0xe0) {
      code = a & 0x0f;
      extra = 2;
    } else if ((a & 0xf8) === 0xf0) {
      code = a & 0x07;
      extra = 3;
    } else throw new Error("net: response is not valid UTF-8");
    if (i + extra > bytes.length) throw new Error("net: response is not valid UTF-8");
    for (let k = 0; k < extra; k++) {
      const b = bytes[i++];
      if ((b & 0xc0) !== 0x80) throw new Error("net: response is not valid UTF-8");
      code = (code << 6) | (b & 0x3f);
    }
    if (
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff) ||
      (extra === 1 && code < 0x80) ||
      (extra === 2 && code < 0x800) ||
      (extra === 3 && code < 0x10000)
    ) throw new Error("net: response is not valid UTF-8");
    if (code < 0x10000) out += String.fromCharCode(code);
    else {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    }
  }
  return out;
}
