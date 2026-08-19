// NetworkError — the one public error class of the network modules.
// Codes are the stable strings
// of contracts/spec/net.ts NET_ERROR, shared by net, ws and httpd; the
// category is derived from the code, never sent by a host.

import { NET_ERROR, netErrorCategory, type NetErrorCode } from "../../../contracts/spec/net.ts";

export type NetworkErrorCategory = "runtime" | "resolver" | "transport" | "tls" | "protocol";
export type NetworkProtocol = "http" | "websocket" | "mqtt" | "tcp" | "udp";

export interface NetworkErrorInit {
  operation: string;
  temporary?: boolean;
  address?: string;
  port?: number;
  protocol?: NetworkProtocol;
  causeCode?: string;
  reasonCode?: number;
}

/** Codes a host may report as temporary conditions. */
const TEMPORARY = new Set<string>([
  NET_ERROR.dns,
  NET_ERROR.connect,
  NET_ERROR.timeout,
  NET_ERROR.busy,
  NET_ERROR.resourceLimit,
]);

export class NetworkError extends Error {
  readonly category: NetworkErrorCategory;
  readonly code: string;
  readonly operation: string;
  readonly temporary: boolean;
  readonly address?: string;
  readonly port?: number;
  readonly protocol?: NetworkProtocol;
  readonly causeCode?: string;
  readonly reasonCode?: number;

  constructor(code: string, message: string, init: NetworkErrorInit) {
    super(message);
    this.name = "NetworkError";
    this.code = code;
    this.category = netErrorCategory(code);
    this.operation = init.operation;
    this.temporary = init.temporary ?? TEMPORARY.has(code);
    if (init.address !== undefined) this.address = init.address;
    if (init.port !== undefined) this.port = init.port;
    if (init.protocol !== undefined) this.protocol = init.protocol;
    if (init.causeCode !== undefined) this.causeCode = init.causeCode;
    if (init.reasonCode !== undefined) this.reasonCode = init.reasonCode;
  }
}

const KNOWN_CODES = new Set<string>(Object.values(NET_ERROR));

/** Clamp a host-reported code onto the shared vocabulary. */
export function normalizeErrorCode(value: unknown): NetErrorCode {
  const code = String(value);
  return KNOWN_CODES.has(code) ? (code as NetErrorCode) : NET_ERROR.other;
}

/** Turn a namespace `lastError()` string (`code: message`) into an error. */
export function errorFromLastError(
  detail: string,
  operation: string,
  protocol: NetworkProtocol,
): NetworkError {
  const split = detail.indexOf(":");
  const code = normalizeErrorCode(split < 0 ? NET_ERROR.other : detail.slice(0, split));
  const message = split < 0 ? detail || "request refused" : detail.slice(split + 1).trim();
  return new NetworkError(code, message, { operation, protocol });
}
