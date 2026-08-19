// Deterministic virtual-clock WebSocket Client module (`globalThis.ws`,
// spec v2) for conformance tests. Peers are fixtures keyed by URL: they
// answer the handshake, echo or script messages, and every event becomes
// visible at the next tick(). Inject via bootWorld's extraGlobals:
// `{ ws: host.ns }`.

import { NET_ERROR, NET_TLS_MIN_VERSION } from "../../contracts/spec/net.ts";
import {
  WS_BLOB_KEY,
  WS_CONTROL_PAYLOAD_MAX,
  WS_DEFAULT_CLOSE_MS,
  WS_DEFAULT_CONNECT_MS,
  WS_MAX_CONNECT_MS,
  WS_MAX_EVENTS_PER_TICK,
  WS_MAX_HANDSHAKE_HEADERS,
  WS_MAX_HANDSHAKE_HEADER_BYTES,
  WS_MAX_MESSAGE_BYTES,
  WS_MAX_RECEIVE_QUEUE_BYTES,
  WS_MAX_RECEIVE_QUEUE_MESSAGES,
  WS_MAX_SEND_QUEUE_BYTES,
  WS_MAX_SOCKETS,
  WS_MAX_TICK_BYTES,
  WS_OPCODE,
  WS_SEND_ACCEPTED,
  WS_SEND_ACCEPTED_HIGH_WATER,
  WS_SEND_BACKPRESSURE,
  WS_SEND_CLOSED,
  WS_SEND_HIGH_WATER_BYTES,
  WS_SEND_INVALID,
  WS_SEND_LOW_WATER_BYTES,
  WS_SPEC_MAJOR,
  WS_SPEC_MINOR,
  type WsConnectMeta,
  type WsLimits,
} from "../../contracts/spec/ws.ts";
import { networkPolicyAllowsConnect } from "../../contracts/spec/network-policy.ts";
import { bytesToBase64, stringToUtf8, utf8ToString } from "../../framework/src/bytes.ts";
import type { WsOps } from "../../framework/src/net/websocket.ts";
import { simEndpoint, simPolicy, type SimHostOptions } from "./net.ts";

export interface SimWsPeer {
  /** Subprotocol the peer selects (default: first requested or ""). */
  protocol?: string;
  /** Ticks after connect before `open` (default 1). */
  delayTicks?: number;
  /** Fail the handshake instead of opening. */
  error?: { code: string; message: string; status?: number };
  /** Called for each text/binary message the app sends; the returned value
   * (if any) is sent back next tick. Default: echo. */
  onMessage?: (data: string | Uint8Array, peer: SimWsPeerControl) => string | Uint8Array | void;
  /** Bytes the peer's send window accepts before `send` reports backpressure
   * (default: the spec send queue). */
  sendWindowBytes?: number;
}

export interface SimWsPeerControl {
  /** Send a message to the app (visible next tick). */
  send(data: string | Uint8Array): void;
  ping(payload?: Uint8Array): void;
  /** Peer-initiated close handshake. */
  close(code?: number, reason?: string): void;
  /** Transport loss without a Close frame. */
  drop(): void;
}

interface Socket {
  handle: number;
  meta: WsConnectMeta;
  peer: SimWsPeer;
  openTick: number;
  open: boolean;
  closing: boolean;
  /** Queued events for this socket, released in order at tick(). */
  inbox: object[];
  outbound: Uint8Array[]; // messages awaiting receiveInto
  buffered: number;
  drainArmed: boolean;
  terminate: boolean;
  closeRequested: { code: number; reason: string } | null;
  closeTick: number;
  terminal: boolean;
  control: SimWsPeerControl;
}

export interface SimWsHost {
  readonly ns: WsOps;
  tick(): void;
  readonly log: string[];
  readonly live: () => number;
  /** Peer control for an open socket URL (first match). */
  peer(url: string): SimWsPeerControl;
}

export const SIM_WS_LIMITS: WsLimits = Object.freeze({
  specMajor: WS_SPEC_MAJOR,
  specMinor: WS_SPEC_MINOR,
  maxSockets: WS_MAX_SOCKETS,
  maxTlsInflight: 0,
  maxMessageBytes: WS_MAX_MESSAGE_BYTES,
  maxReceiveQueueBytes: WS_MAX_RECEIVE_QUEUE_BYTES,
  maxReceiveQueueMessages: WS_MAX_RECEIVE_QUEUE_MESSAGES,
  maxSendQueueBytes: WS_MAX_SEND_QUEUE_BYTES,
  sendHighWaterBytes: WS_SEND_HIGH_WATER_BYTES,
  sendLowWaterBytes: WS_SEND_LOW_WATER_BYTES,
  maxHandshakeHeaders: WS_MAX_HANDSHAKE_HEADERS,
  maxHandshakeHeaderBytes: WS_MAX_HANDSHAKE_HEADER_BYTES,
  maxEventsPerTick: WS_MAX_EVENTS_PER_TICK,
  maxTickBytes: WS_MAX_TICK_BYTES,
  defaultConnectMs: WS_DEFAULT_CONNECT_MS,
  maxConnectMs: WS_MAX_CONNECT_MS,
  defaultCloseMs: WS_DEFAULT_CLOSE_MS,
  tlsMinVersion: NET_TLS_MIN_VERSION,
  features: [],
});

export function createSimWsHost(peers: Readonly<Record<string, SimWsPeer>>, options: SimHostOptions = {}): SimWsHost {
  const policy = simPolicy(options);
  const sockets = new Map<number, Socket>();
  const events: object[] = [];
  const log: string[] = [];
  let nextHandle = 1;
  let now = 0;
  let lastError = "";

  const refuse = (code: string, message: string): number => {
    lastError = `${code}: ${message}`;
    return -1;
  };

  function queueMessage(s: Socket, data: string | Uint8Array): void {
    if (typeof data === "string") s.inbox.push({ t: "message", h: s.handle, kind: "text", text: data });
    else {
      s.outbound.push(data.slice());
      s.inbox.push({ t: "message", h: s.handle, kind: "binary", bytes: data.length });
    }
  }

  const ns: WsOps = {
    connect(metaJson) {
      let meta: WsConnectMeta;
      try {
        meta = JSON.parse(metaJson) as WsConnectMeta;
      } catch {
        return refuse(NET_ERROR.invalidRequest, "malformed connect metadata");
      }
      if (typeof meta.url !== "string" || !/^wss?:\/\//.test(meta.url)) {
        return refuse(NET_ERROR.invalidRequest, "url must be ws:// or wss://");
      }
      if (meta.url.startsWith("wss://")) return refuse(NET_ERROR.unsupported, "tls not provided");
      if (sockets.size >= WS_MAX_SOCKETS) return refuse(NET_ERROR.resourceLimit, "too many sockets");
      if (policy) {
        const endpoint = simEndpoint(meta.url);
        if (!endpoint || !networkPolicyAllowsConnect(policy, endpoint.protocol, endpoint.host, endpoint.port)) {
          return refuse(NET_ERROR.permissionDenied, "endpoint is not an allowed connect rule");
        }
      }
      const peer = peers[meta.url];
      if (!peer) return refuse(NET_ERROR.permissionDenied, `no peer for ${meta.url}`);
      const handle = nextHandle++;
      const socket: Socket = {
        handle,
        meta,
        peer,
        openTick: now + Math.max(1, peer.delayTicks ?? 1),
        open: false,
        closing: false,
        inbox: [],
        outbound: [],
        buffered: 0,
        drainArmed: false,
        terminate: false,
        closeRequested: null,
        closeTick: 0,
        terminal: false,
        control: null as unknown as SimWsPeerControl,
      };
      socket.control = {
        send: (data) => queueMessage(socket, data),
        ping: (payload) => {
          socket.inbox.push({ t: "ping", h: handle, payload: { [WS_BLOB_KEY]: bytesToBase64(payload ?? new Uint8Array(0)) } });
        },
        close: (code = 1000, reason = "") => {
          if (socket.terminal) return;
          socket.inbox.push({ t: "close", h: handle, code, reason, clean: true, local: false });
          socket.terminal = true;
        },
        drop: () => {
          if (socket.terminal) return;
          socket.inbox.push({ t: "error", h: handle, code: NET_ERROR.closed, message: "connection lost" });
          socket.inbox.push({ t: "close", h: handle, code: 1006, reason: "", clean: false, local: false });
          socket.terminal = true;
        },
      };
      sockets.set(handle, socket);
      log.push(`connect ${handle} ${meta.url}`);
      return handle;
    },
    send(handle, opcode, payload) {
      const s = sockets.get(handle);
      if (!s || !s.open || s.closing || s.terminal) return WS_SEND_CLOSED;
      const bytes = payload === null ? new Uint8Array(0) : typeof payload === "string" ? stringToUtf8(payload) : new Uint8Array(payload.slice(0));
      if (opcode === WS_OPCODE.ping || opcode === WS_OPCODE.pong) {
        if (bytes.length > WS_CONTROL_PAYLOAD_MAX) return WS_SEND_INVALID;
        if (opcode === WS_OPCODE.ping) s.inbox.push({ t: "pong", h: handle, payload: { [WS_BLOB_KEY]: bytesToBase64(bytes) } });
        log.push(`${opcode === WS_OPCODE.ping ? "ping" : "pong"} ${handle} ${bytes.length}`);
        return WS_SEND_ACCEPTED;
      }
      if (opcode !== WS_OPCODE.text && opcode !== WS_OPCODE.binary) return WS_SEND_INVALID;
      const maxMessage = s.meta.limits?.maxMessageBytes ?? WS_MAX_MESSAGE_BYTES;
      if (bytes.length > maxMessage) return WS_SEND_INVALID;
      const window = s.peer.sendWindowBytes ?? (s.meta.limits?.sendQueueBytes ?? WS_MAX_SEND_QUEUE_BYTES);
      if (s.buffered + bytes.length > window) {
        s.drainArmed = true;
        return WS_SEND_BACKPRESSURE;
      }
      s.buffered += bytes.length;
      const data = opcode === WS_OPCODE.text ? utf8ToString(bytes) : bytes;
      log.push(`send ${handle} ${opcode === WS_OPCODE.text ? "text" : "binary"} ${bytes.length}`);
      const reply = s.peer.onMessage ? s.peer.onMessage(data, s.control) : data;
      if (reply !== undefined) queueMessage(s, reply);
      const high = WS_SEND_HIGH_WATER_BYTES;
      const rc = s.buffered > high ? WS_SEND_ACCEPTED_HIGH_WATER : WS_SEND_ACCEPTED;
      if (rc === WS_SEND_ACCEPTED_HIGH_WATER) s.drainArmed = true;
      return rc;
    },
    receiveInto(handle, into, offset, length) {
      const s = sockets.get(handle);
      if (!s || !s.outbound.length) return -1;
      const head = s.outbound[0];
      if (length < head.length) return -1;
      new Uint8Array(into, offset, length).set(head);
      s.outbound.shift();
      return head.length;
    },
    close(handle, code, reason) {
      const s = sockets.get(handle);
      if (!s || !s.open || s.closing || s.terminal) return -1;
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) return WS_SEND_INVALID;
      if (reason !== undefined && stringToUtf8(reason).length > 123) return WS_SEND_INVALID;
      s.closing = true;
      s.closeRequested = { code: code ?? 1005, reason: reason ?? "" };
      s.closeTick = now + 1;
      log.push(`close ${handle} ${code ?? ""}`);
      return 0;
    },
    terminate(handle) {
      const s = sockets.get(handle);
      if (!s || s.terminal) return;
      s.terminate = true;
      log.push(`terminate ${handle}`);
    },
    bufferedAmount(handle) {
      const s = sockets.get(handle);
      return s ? s.buffered : -1;
    },
    poll() {
      return events.length ? JSON.stringify(events.splice(0)) : undefined;
    },
    lastError() {
      return lastError;
    },
    limits() {
      return JSON.stringify(SIM_WS_LIMITS);
    },
  };

  function tick(): void {
    now++;
    for (const s of [...sockets.values()]) {
      if (s.terminate) {
        sockets.delete(s.handle);
        if (!s.open) events.push({ t: "error", h: s.handle, code: NET_ERROR.cancelled, message: "terminated" });
        else events.push({ t: "close", h: s.handle, code: 1006, reason: "", clean: false, local: true });
        continue;
      }
      if (!s.open) {
        if (now < s.openTick) continue;
        if (s.peer.error) {
          sockets.delete(s.handle);
          events.push({ t: "error", h: s.handle, code: s.peer.error.code, message: s.peer.error.message, status: s.peer.error.status });
          continue;
        }
        s.open = true;
        const protocol = s.peer.protocol ?? (s.meta.protocols?.[0] ?? "");
        events.push({ t: "open", h: s.handle, protocol });
      }
      // The peer "consumed" what the app sent: release the send window.
      if (s.buffered > 0) {
        s.buffered = 0;
        if (s.drainArmed) {
          s.drainArmed = false;
          s.inbox.push({ t: "drain", h: s.handle });
        }
      }
      if (s.inbox.length) events.push(...s.inbox.splice(0));
      if (s.terminal) {
        sockets.delete(s.handle);
        continue;
      }
      if (s.closing && s.closeRequested && now >= s.closeTick) {
        sockets.delete(s.handle);
        events.push({ t: "close", h: s.handle, code: s.closeRequested.code === 1005 ? 1005 : s.closeRequested.code, reason: s.closeRequested.reason, clean: true, local: true });
      }
    }
  }

  return {
    ns,
    tick,
    log,
    live: () => sockets.size,
    peer(url) {
      for (const s of sockets.values()) if (s.meta.url === url) return s.control;
      throw new Error(`sim ws: no live socket for ${url}`);
    },
  };
}
