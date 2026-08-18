import type {
  NetworkAddress,
  NetworkData,
  NetworkLimitOverrides,
  TlsOptions,
} from "./index.ts";
import { unsupportedNetworkPromise } from "./internal.ts";

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

export interface TcpReadResult {
  readonly bytes: number;
  readonly done: boolean;
}

export interface TcpSocket {
  readonly localAddress: NetworkAddress;
  readonly remoteAddress: NetworkAddress;
  readInto(destination: Uint8Array): Promise<TcpReadResult>;
  write(data: NetworkData): number;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  close(): void;
  terminate(): void;
  setTimeout(ms: number): this;
  setNoDelay(enabled: boolean): this;
  setKeepAlive(enabled: boolean, initialDelayMs?: number): this;
  ref(): this;
  unref(): this;
}

export interface TcpSocketHandlers {
  readonly open?: (socket: TcpSocket) => void;
  readonly data?: (socket: TcpSocket, data: Uint8Array) => void;
  readonly drain?: (socket: TcpSocket) => void;
  readonly timeout?: (socket: TcpSocket) => void;
  readonly end?: (socket: TcpSocket) => void;
  readonly close?: (
    socket: TcpSocket,
    error: import("./index.ts").NetworkError | null,
  ) => void;
  readonly error?: (
    socket: TcpSocket,
    error: import("./index.ts").NetworkError,
  ) => void;
}

export interface TcpTimeouts {
  readonly connect?: number;
  readonly idle?: number;
  readonly total?: number;
}

export interface TcpConnectOptions {
  readonly hostname: string;
  readonly port: number;
  readonly tls?: TlsOptions;
  readonly timeouts?: TcpTimeouts;
  readonly limits?: NetworkLimitOverrides;
  readonly ref?: boolean;
  /** Omit handlers to select pull-based `readInto()` mode. */
  readonly socket?: TcpSocketHandlers;
}

export interface TcpListenOptions {
  readonly hostname?: string;
  readonly port: number;
  readonly tls?: TlsOptions;
  readonly limits?: NetworkLimitOverrides;
  readonly ref?: boolean;
  /** Omit handlers to select pull-based `readInto()` mode for accepted sockets. */
  readonly socket?: TcpSocketHandlers;
}

export interface TcpListenerStopOptions {
  readonly graceful?: boolean;
  readonly timeout?: number;
}

export interface TcpListener {
  readonly address: NetworkAddress;
  stop(options?: TcpListenerStopOptions): Promise<void>;
  ref(): this;
  unref(): this;
}

export function connect(_options: TcpConnectOptions): Promise<TcpSocket> {
  return unsupportedNetworkPromise("tcp.connect", "tcp");
}

export function listen(_options: TcpListenOptions): Promise<TcpListener> {
  return unsupportedNetworkPromise("tcp.listen", "tcp");
}
