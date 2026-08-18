import type {
  NetworkAddress,
  NetworkData,
  NetworkLimitOverrides,
  TlsOptions,
  URL,
} from "./index.ts";
import type { HeadersInit, Request } from "./http.ts";
import {
  unsupportedNetworkOperation,
  unsupportedNetworkPromise,
} from "./internal.ts";

export {
  AbortController,
  AbortSignal,
  NetworkError,
  URL,
} from "./index.ts";
export type {
  NetworkAddress,
  NetworkData,
  NetworkErrorCategory,
  NetworkErrorCode,
  NetworkErrorOptions,
  NetworkLimit,
  NetworkLimitOverrides,
  NetworkLimits,
  NetworkProtocol,
  NetworkRole,
  TlsOptions,
} from "./index.ts";

export type WebSocketReadyState = "connecting" | "open" | "closing" | "closed";

export type WebSocketSendResult =
  | { readonly status: "accepted"; readonly bytes: number; readonly needsDrain: boolean }
  | { readonly status: "backpressure"; readonly bytes: 0 }
  | { readonly status: "closed"; readonly bytes: 0 };

export interface WebSocket {
  readonly readyState: WebSocketReadyState;
  readonly bufferedAmount: number;
  send(data: NetworkData): WebSocketSendResult;
  ping(data?: NetworkData): boolean;
  pong(data?: NetworkData): boolean;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ref(): this;
  unref(): this;
}

export interface WebSocketHandlers {
  readonly open?: (socket: WebSocket) => void;
  readonly message?: (socket: WebSocket, data: string | Uint8Array) => void;
  readonly drain?: (socket: WebSocket) => void;
  readonly ping?: (socket: WebSocket, data: Uint8Array) => void;
  readonly pong?: (socket: WebSocket, data: Uint8Array) => void;
  readonly close?: (socket: WebSocket, code: number, reason: string) => void;
  readonly error?: (socket: WebSocket, error: import("./index.ts").NetworkError) => void;
}

export interface WebSocketConnectOptions {
  readonly headers?: HeadersInit;
  readonly protocols?: readonly string[];
  readonly tls?: TlsOptions;
  readonly timeout?: number;
  readonly limits?: NetworkLimitOverrides;
  readonly ref?: boolean;
  readonly socket: WebSocketHandlers;
}

export interface WebSocketServeOptions {
  readonly hostname?: string;
  readonly port: number;
  readonly tls?: TlsOptions;
  readonly limits?: NetworkLimitOverrides;
  readonly ref?: boolean;
  readonly socket: WebSocketHandlers;
}

export interface WebSocketUpgradeOptions {
  readonly protocols?: readonly string[];
  readonly socket: WebSocketHandlers;
}

/** Opaque one-use result consumed by the HTTP server binding. */
export interface WebSocketUpgrade {
  readonly protocol?: string;
}

export interface WebSocketServerStopOptions {
  readonly graceful?: boolean;
  readonly timeout?: number;
}

export interface WebSocketServer {
  readonly address: NetworkAddress;
  stop(options?: WebSocketServerStopOptions): Promise<void>;
  ref(): this;
  unref(): this;
}

export function connect(
  _url: string | URL,
  _options: WebSocketConnectOptions,
): Promise<WebSocket> {
  return unsupportedNetworkPromise("websocket.connect", "websocket");
}

export function serve(_options: WebSocketServeOptions): Promise<WebSocketServer> {
  return unsupportedNetworkPromise("websocket.serve", "websocket");
}

export function upgrade(
  _request: Request,
  _options: WebSocketUpgradeOptions,
): WebSocketUpgrade {
  throw unsupportedNetworkOperation("websocket.upgrade", "websocket");
}
