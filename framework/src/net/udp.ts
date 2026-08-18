import type {
  NetworkAddress,
  NetworkData,
  NetworkLimitOverrides,
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

export interface UdpPeer {
  readonly hostname: string;
  readonly port: number;
}

export interface UdpBindOptions {
  readonly hostname?: string;
  readonly port: number;
}

export interface UdpReceiveResult {
  readonly bytes: number;
  readonly datagramBytes: number;
  readonly remoteAddress: NetworkAddress;
  readonly truncated: boolean;
}

export interface UdpDatagram {
  readonly data: NetworkData;
  readonly address?: NetworkAddress;
}

export interface UdpSocketHandlers {
  readonly data?: (
    socket: UdpSocket,
    data: Uint8Array,
    remoteAddress: NetworkAddress,
  ) => void;
  readonly drain?: (socket: UdpSocket) => void;
  readonly error?: (
    socket: UdpSocket,
    error: import("./index.ts").NetworkError,
  ) => void;
}

export interface UdpSocketOptions {
  readonly bind?: UdpBindOptions;
  readonly connect?: UdpPeer;
  readonly limits?: NetworkLimitOverrides;
  readonly ref?: boolean;
  /** Omit handlers to select pull-based `receiveInto()` mode. */
  readonly socket?: UdpSocketHandlers;
}

export interface UdpSocket {
  readonly localAddress: NetworkAddress;
  readonly remoteAddress?: NetworkAddress;
  readonly droppedDatagrams: number;
  receiveInto(destination: Uint8Array): Promise<UdpReceiveResult>;
  send(data: NetworkData): boolean;
  send(data: NetworkData, address: NetworkAddress): boolean;
  sendMany(datagrams: readonly UdpDatagram[]): number;
  close(): void;
  ref(): this;
  unref(): this;
}

export function udpSocket(_options: UdpSocketOptions): Promise<UdpSocket> {
  return unsupportedNetworkPromise("udp.udpSocket", "udp");
}
