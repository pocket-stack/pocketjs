// @pocketjs/framework/net/websocket — WebSocket Client over the
// `globalThis.ws` boundary (contracts/spec/ws.ts). `connect()` resolves after
// the RFC 6455 opening handshake; messages, control frames, drain and close
// arrive as handler calls inside the framework service pump, in the order the
// core delivered them. Handlers return void; a thrown handler exception is a
// guest execution error, not a NetworkError.

import { NET_ERROR } from "../../../contracts/spec/net.ts";
import {
  WS_BLOB_KEY,
  WS_CONTROL_PAYLOAD_MAX,
  WS_FORBIDDEN_HEADERS,
  WS_MAX_CONNECT_MS,
  WS_MAX_MESSAGE_BYTES,
  WS_MAX_RECEIVE_QUEUE_BYTES,
  WS_MAX_RECEIVE_QUEUE_MESSAGES,
  WS_MAX_SEND_QUEUE_BYTES,
  WS_OPCODE,
  WS_SEND_ACCEPTED,
  WS_SEND_ACCEPTED_HIGH_WATER,
  WS_SEND_BACKPRESSURE,
  WS_SEND_CLOSED,
  WS_SEND_INVALID,
  WS_SPEC_MAJOR,
  type WsConnectMeta,
} from "../../../contracts/spec/ws.ts";
import { base64ToBytes, stringToUtf8 } from "../bytes.ts";
import { snapshotData, type NetworkData } from "./body.ts";
import { createBinding, integerOption, limitNumber, type EventRecord } from "./binding.ts";
import { NetworkError, errorFromLastError, normalizeErrorCode } from "./errors.ts";
import { URL } from "./url.ts";
import type { TlsOptions } from "./types.ts";

const PROTOCOL = "websocket" as const;

export type WebSocketReadyState = "connecting" | "open" | "closing" | "closed";

export type WebSocketSendResult =
  | { status: "accepted"; needsDrain: boolean }
  | { status: "backpressure" }
  | { status: "closed" };

export interface WebSocketHandlers {
  open?(socket: WebSocket): void;
  message?(socket: WebSocket, data: string | Uint8Array): void;
  drain?(socket: WebSocket): void;
  ping?(socket: WebSocket, data: Uint8Array): void;
  pong?(socket: WebSocket, data: Uint8Array): void;
  close?(socket: WebSocket, code: number, reason: string): void;
  error?(socket: WebSocket, error: NetworkError): void;
}

export interface WebSocketConnectOptions {
  headers?: Readonly<Record<string, string>>;
  protocols?: readonly string[];
  tls?: TlsOptions;
  timeouts?: { connectMs?: number; closeMs?: number };
  limits?: {
    maxMessageBytes?: number;
    receiveQueueBytes?: number;
    receiveQueueMessages?: number;
    sendQueueBytes?: number;
  };
  socket: WebSocketHandlers;
}

export interface WsOps {
  connect(metaJson: string): number;
  send(handle: number, opcode: number, payload: string | ArrayBuffer | null): number;
  receiveInto(handle: number, into: ArrayBuffer, offset: number, length: number): number;
  close(handle: number, code?: number, reason?: string): number;
  terminate(handle: number): void;
  bufferedAmount(handle: number): number;
  poll(): string | undefined;
  lastError(): string;
  limits(): string;
}

interface SocketState {
  handle: number;
  socket: WebSocketImpl;
  handlers: WebSocketHandlers;
  resolve: ((socket: WebSocket) => void) | null;
  reject: ((error: NetworkError) => void) | null;
}

const sockets = new Map<number, SocketState>();

const ws = createBinding<WsOps>({
  name: "ws",
  protocol: PROTOCOL,
  specMajor: WS_SPEC_MAJOR,
  requiredOps: ["connect", "send", "receiveInto", "close", "terminate", "bufferedAmount", "poll", "lastError", "limits"],
  dispatch: dispatchWsEvent,
  onProtocolFailure(ops, error) {
    for (const [handle, s] of [...sockets]) {
      ops.terminate(handle);
      terminate(s, error, 1006, "", false, true);
    }
  },
});

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export class WebSocket {
  readonly url: string;
  protected _protocol = "";
  protected _readyState: WebSocketReadyState = "connecting";
  protected readonly handle: number;
  protected readonly ops: WsOps;
  protected readonly limitMessage: number;

  /** @internal */
  constructor(url: string, handle: number, ops: WsOps, limitMessage: number) {
    this.url = url;
    this.handle = handle;
    this.ops = ops;
    this.limitMessage = limitMessage;
  }

  get protocol(): string {
    return this._protocol;
  }

  get readyState(): WebSocketReadyState {
    return this._readyState;
  }

  get bufferedAmount(): number {
    if (this._readyState === "closed") return 0;
    const n = this.ops.bufferedAmount(this.handle);
    return n < 0 ? 0 : n;
  }

  private sendFrame(opcode: number, data: NetworkData | undefined, operation: string): number {
    if (this._readyState !== "open") return WS_SEND_CLOSED;
    let payload: string | ArrayBuffer | null = null;
    if (data !== undefined) {
      if (typeof data === "string") {
        if (opcode !== WS_OPCODE.text) {
          const bytes = stringToUtf8(data);
          payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        } else {
          payload = data;
        }
      } else {
        const bytes = snapshotData(data, operation, PROTOCOL);
        payload = bytes.buffer as ArrayBuffer;
      }
    }
    return this.ops.send(this.handle, opcode, payload);
  }

  send(data: NetworkData): WebSocketSendResult {
    const opcode = typeof data === "string" ? WS_OPCODE.text : WS_OPCODE.binary;
    const rc = this.sendFrame(opcode, data, "send");
    if (rc === WS_SEND_ACCEPTED) return { status: "accepted", needsDrain: false };
    if (rc === WS_SEND_ACCEPTED_HIGH_WATER) return { status: "accepted", needsDrain: true };
    if (rc === WS_SEND_BACKPRESSURE) return { status: "backpressure" };
    if (rc === WS_SEND_INVALID) {
      const size = typeof data === "string" ? stringToUtf8(data).length : (data as ArrayBufferView).byteLength ?? (data as ArrayBuffer).byteLength;
      throw new NetworkError(
        size > this.limitMessage ? NET_ERROR.messageTooLarge : NET_ERROR.invalidRequest,
        size > this.limitMessage ? `message exceeds ${this.limitMessage} bytes` : "invalid message",
        { operation: "send", protocol: PROTOCOL },
      );
    }
    return { status: "closed" };
  }

  ping(data?: NetworkData): boolean {
    return this.control(WS_OPCODE.ping, data, "ping");
  }

  pong(data?: NetworkData): boolean {
    return this.control(WS_OPCODE.pong, data, "pong");
  }

  private control(opcode: number, data: NetworkData | undefined, operation: string): boolean {
    const rc = this.sendFrame(opcode, data, operation);
    if (rc === WS_SEND_INVALID) {
      throw new NetworkError(NET_ERROR.invalidRequest, `${operation} payload exceeds ${WS_CONTROL_PAYLOAD_MAX} bytes`, {
        operation,
        protocol: PROTOCOL,
      });
    }
    return rc === WS_SEND_ACCEPTED || rc === WS_SEND_ACCEPTED_HIGH_WATER;
  }

  close(code?: number, reason?: string): void {
    if (this._readyState !== "open") return;
    if (code !== undefined && (!Number.isInteger(code) || (code !== 1000 && (code < 3000 || code > 4999)))) {
      throw new NetworkError(NET_ERROR.invalidRequest, "close code must be 1000 or 3000-4999", {
        operation: "close",
        protocol: PROTOCOL,
      });
    }
    if (reason !== undefined && stringToUtf8(reason).length > 123) {
      throw new NetworkError(NET_ERROR.invalidRequest, "close reason exceeds 123 bytes", {
        operation: "close",
        protocol: PROTOCOL,
      });
    }
    const rc = this.ops.close(this.handle, code, reason);
    if (rc === 0) this._readyState = "closing";
  }

  terminate(): void {
    if (this._readyState === "closed") return;
    this.ops.terminate(this.handle);
    // The terminal event arrives next tick; commands stop being accepted now.
    if (this._readyState === "open" || this._readyState === "connecting") this._readyState = "closing";
  }
}

class WebSocketImpl extends WebSocket {
  __setOpen(protocol: string): void {
    this._protocol = protocol;
    this._readyState = "open";
  }
  __setClosed(): void {
    this._readyState = "closed";
  }
}

function terminate(
  s: SocketState,
  error: NetworkError | null,
  code: number,
  reason: string,
  clean: boolean,
  callClose: boolean,
): void {
  if (!sockets.has(s.handle)) return;
  sockets.delete(s.handle);
  ws.release();
  if (s.reject) {
    // Handshake never completed: only the connect Promise observes it.
    const reject = s.reject;
    s.reject = null;
    s.resolve = null;
    s.socket.__setClosed();
    reject(error ?? new NetworkError(NET_ERROR.closed, "socket closed before open", { operation: "connect", protocol: PROTOCOL }));
    return;
  }
  s.socket.__setClosed();
  if (error && s.handlers.error) s.handlers.error(s.socket, error);
  if (callClose && s.handlers.close) s.handlers.close(s.socket, code, reason);
}

function dispatchWsEvent(event: EventRecord, ops: WsOps): void {
  const handle = event.h;
  if (typeof handle !== "number") return;
  const s = sockets.get(handle);
  if (!s) return;
  switch (event.t) {
    case "open": {
      const protocol = typeof event.protocol === "string" ? event.protocol : "";
      s.socket.__setOpen(protocol);
      const resolve = s.resolve;
      s.resolve = null;
      s.reject = null;
      if (s.handlers.open) s.handlers.open(s.socket);
      if (resolve) resolve(s.socket);
      return;
    }
    case "message": {
      if (!s.handlers.message) {
        // Still dequeue binary payloads so the native queue drains.
        if (event.kind === "binary" && typeof event.bytes === "number") {
          const scratch = new ArrayBuffer(Math.max(0, event.bytes));
          ops.receiveInto(handle, scratch, 0, scratch.byteLength);
        }
        return;
      }
      if (event.kind === "text") {
        s.handlers.message(s.socket, typeof event.text === "string" ? event.text : "");
        return;
      }
      if (event.kind === "binary" && typeof event.bytes === "number" && event.bytes >= 0) {
        const bytes = new Uint8Array(event.bytes);
        const got = ops.receiveInto(handle, bytes.buffer as ArrayBuffer, 0, bytes.length);
        if (got !== bytes.length) {
          ops.terminate(handle);
          terminate(
            s,
            new NetworkError(NET_ERROR.protocol, "binary message transfer failed", { operation: "message", protocol: PROTOCOL }),
            1006,
            "",
            false,
            true,
          );
          return;
        }
        s.handlers.message(s.socket, bytes);
      }
      return;
    }
    case "ping":
    case "pong": {
      const handler = event.t === "ping" ? s.handlers.ping : s.handlers.pong;
      if (!handler) return;
      const payload = event.payload as Record<string, unknown> | undefined;
      const b64 = payload && typeof payload === "object" ? payload[WS_BLOB_KEY] : undefined;
      handler(s.socket, typeof b64 === "string" ? base64ToBytes(b64) : new Uint8Array(0));
      return;
    }
    case "drain":
      if (s.handlers.drain) s.handlers.drain(s.socket);
      return;
    case "error": {
      const error = new NetworkError(
        normalizeErrorCode(event.code),
        typeof event.message === "string" && event.message ? event.message : String(event.code),
        {
          operation: s.reject ? "connect" : "socket",
          protocol: PROTOCOL,
          causeCode: typeof event.causeCode === "string" ? event.causeCode : undefined,
          reasonCode: typeof event.status === "number" ? event.status : undefined,
        },
      );
      if (s.reject) {
        terminate(s, error, 1006, "", false, false);
        return;
      }
      // After open, `close` follows; report the error now, close on arrival.
      if (s.handlers.error) s.handlers.error(s.socket, error);
      s.handlers = { ...s.handlers, error: undefined };
      return;
    }
    case "close": {
      const code = typeof event.code === "number" ? event.code : 1005;
      const reason = typeof event.reason === "string" ? event.reason : "";
      terminate(s, null, code, reason, event.clean === true, true);
      return;
    }
    default:
      return;
  }
}

/** Open a WebSocket. Resolves with the socket after the handshake; failures
 * before `open` only reject the Promise. */
export function connect(url: string | URL, options: WebSocketConnectOptions): Promise<WebSocket> {
  let ops: WsOps;
  let handle: number;
  let href: string;
  let maxMessage = WS_MAX_MESSAGE_BYTES;
  try {
    if (!options || typeof options !== "object" || !options.socket || typeof options.socket !== "object") {
      throw new NetworkError(NET_ERROR.invalidRequest, "connect() requires socket handlers", { operation: "connect", protocol: PROTOCOL });
    }
    ops = ws.require("connect");
    const limits = ws.limits();
    let parsed: URL;
    try {
      parsed = url instanceof URL ? new URL(url.href) : new URL(String(url));
    } catch {
      throw new NetworkError(NET_ERROR.invalidRequest, `invalid URL: ${String(url)}`, { operation: "connect", protocol: PROTOCOL });
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new NetworkError(NET_ERROR.invalidRequest, "url must be ws: or wss:", { operation: "connect", protocol: PROTOCOL });
    }
    if (parsed.hash) {
      throw new NetworkError(NET_ERROR.invalidRequest, "WebSocket URLs cannot carry a fragment", { operation: "connect", protocol: PROTOCOL });
    }
    if (parsed.username || parsed.password) {
      throw new NetworkError(NET_ERROR.invalidRequest, "URL must not carry credentials", { operation: "connect", protocol: PROTOCOL });
    }
    const features = Array.isArray(limits.features) ? (limits.features as unknown[]) : [];
    if (parsed.protocol === "wss:" && !features.includes("tls")) {
      throw new NetworkError(NET_ERROR.unsupported, "this host does not provide network.websocket.client.tls", {
        operation: "connect",
        protocol: PROTOCOL,
      });
    }
    href = parsed.href;
    const meta: WsConnectMeta = { url: href };
    if (options.protocols !== undefined) {
      const seen = new Set<string>();
      const list: string[] = [];
      for (const p of options.protocols) {
        if (typeof p !== "string" || !TOKEN.test(p) || seen.has(p)) {
          throw new NetworkError(NET_ERROR.invalidRequest, `invalid subprotocol "${String(p)}"`, { operation: "connect", protocol: PROTOCOL });
        }
        seen.add(p);
        list.push(p);
      }
      if (list.length) meta.protocols = list;
    }
    if (options.headers !== undefined) {
      const headers: Record<string, string> = {};
      for (const rawName of Object.keys(options.headers)) {
        const name = rawName.toLowerCase();
        const value = String(options.headers[rawName]).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
        if (!TOKEN.test(name) || /[\0\r\n]/.test(value)) {
          throw new NetworkError(NET_ERROR.invalidRequest, `invalid header ${rawName}`, { operation: "connect", protocol: PROTOCOL });
        }
        if ((WS_FORBIDDEN_HEADERS as readonly string[]).includes(name)) {
          throw new NetworkError(NET_ERROR.invalidRequest, `header ${rawName} is owned by the WebSocket core`, {
            operation: "connect",
            protocol: PROTOCOL,
          });
        }
        headers[name] = value;
      }
      meta.headers = headers;
    }
    if (options.timeouts !== undefined) {
      meta.timeouts = {};
      if (options.timeouts.connectMs !== undefined) {
        meta.timeouts.connectMs = integerOption(options.timeouts.connectMs, "timeouts.connectMs", 1, WS_MAX_CONNECT_MS, "connect", PROTOCOL);
      }
      if (options.timeouts.closeMs !== undefined) {
        meta.timeouts.closeMs = integerOption(options.timeouts.closeMs, "timeouts.closeMs", 1, WS_MAX_CONNECT_MS, "connect", PROTOCOL);
      }
    }
    maxMessage = limitNumber(limits, "maxMessageBytes", WS_MAX_MESSAGE_BYTES);
    if (options.limits !== undefined) {
      meta.limits = {};
      const l = options.limits;
      if (l.maxMessageBytes !== undefined) {
        meta.limits.maxMessageBytes = integerOption(l.maxMessageBytes, "limits.maxMessageBytes", 1, maxMessage, "connect", PROTOCOL);
        maxMessage = meta.limits.maxMessageBytes;
      }
      if (l.receiveQueueBytes !== undefined) {
        meta.limits.receiveQueueBytes = integerOption(l.receiveQueueBytes, "limits.receiveQueueBytes", 1, limitNumber(limits, "maxReceiveQueueBytes", WS_MAX_RECEIVE_QUEUE_BYTES), "connect", PROTOCOL);
      }
      if (l.receiveQueueMessages !== undefined) {
        meta.limits.receiveQueueMessages = integerOption(l.receiveQueueMessages, "limits.receiveQueueMessages", 1, limitNumber(limits, "maxReceiveQueueMessages", WS_MAX_RECEIVE_QUEUE_MESSAGES), "connect", PROTOCOL);
      }
      if (l.sendQueueBytes !== undefined) {
        meta.limits.sendQueueBytes = integerOption(l.sendQueueBytes, "limits.sendQueueBytes", 1, limitNumber(limits, "maxSendQueueBytes", WS_MAX_SEND_QUEUE_BYTES), "connect", PROTOCOL);
      }
    }
    if (options.tls !== undefined) {
      const v = options.tls.verification;
      if (v !== undefined && v !== "full" && v !== "development-insecure") {
        throw new NetworkError(NET_ERROR.invalidRequest, "tls.verification must be full or development-insecure", { operation: "connect", protocol: PROTOCOL });
      }
      for (const key of ["ca", "credential", "alpn", "minVersion", "maxVersion", "clientCertificate", "revocation", "serverName"] as const) {
        if (options.tls[key] !== undefined) {
          throw new NetworkError(NET_ERROR.unsupported, `tls.${key} is not supported by this host`, { operation: "connect", protocol: PROTOCOL });
        }
      }
      if (v !== undefined) meta.tls = { verification: v };
    }
    handle = ops.connect(JSON.stringify(meta));
    if (!Number.isInteger(handle) || handle < 0) throw errorFromLastError(ops.lastError(), "connect", PROTOCOL);
  } catch (error) {
    return Promise.reject(
      error instanceof NetworkError ? error : new NetworkError(NET_ERROR.invalidRequest, String(error), { operation: "connect", protocol: PROTOCOL }),
    );
  }
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocketImpl(href, handle, ops, maxMessage);
    sockets.set(handle, { handle, socket, handlers: options.socket, resolve, reject });
    ws.retain();
  });
}

/** @internal test hooks */
export const __websocket = { ws, sockets };
