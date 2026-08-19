// @pocketjs/framework/net — the network support module. It provides the
// public types, `AbortController`/`AbortSignal`, `URL`, the `NetworkError`
// class (usable with `instanceof`) and the read-only `getNetworkLimits()`
// snapshot. Importing it assembles no I/O capability; the protocol modules
// live at `@pocketjs/framework/net/http` and `@pocketjs/framework/net/websocket`
// and share these object identities. See docs/NET.md.

import { HTTPD_SPEC_MAJOR, type HttpdLimits } from "../../../contracts/spec/httpd.ts";
import { NET_SPEC_MAJOR, type NetLimits } from "../../../contracts/spec/net.ts";
import { WS_SPEC_MAJOR, type WsLimits } from "../../../contracts/spec/ws.ts";
import type { NetworkLimits } from "./types.ts";

export { AbortController, AbortSignal, AbortError } from "./abort.ts";
export { NetworkError } from "./errors.ts";
export type { NetworkErrorCategory, NetworkProtocol } from "./errors.ts";
export { URL } from "./url.ts";
export type { BodyStream, BodyReadResult } from "./body.ts";
export type { NetworkAddress, NetworkData, NetworkLimits, TlsOptions } from "./types.ts";

/** Read one namespace's `limits()` without touching the protocol modules. */
function readLimits<T>(name: string, specMajor: number): Readonly<T> | null {
  const ns = (globalThis as Record<string, unknown>)[name];
  if (!ns || typeof ns !== "object" || typeof (ns as { limits?: unknown }).limits !== "function") return null;
  try {
    const parsed = JSON.parse((ns as { limits(): string }).limits()) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || parsed.specMajor !== specMajor) return null;
    return Object.freeze({ ...parsed }) as Readonly<T>;
  } catch {
    return null;
  }
}

/** A frozen snapshot of the mounted modules' effective limits and features.
 * This is a capability/profile query — it never negotiates anything. Modules
 * the host did not mount (or mounted at another spec major) read as null. */
export function getNetworkLimits(): NetworkLimits {
  return Object.freeze({
    httpClient: readLimits<NetLimits>("net", NET_SPEC_MAJOR),
    httpServer: readLimits<HttpdLimits>("httpd", HTTPD_SPEC_MAJOR),
    websocketClient: readLimits<WsLimits>("ws", WS_SPEC_MAJOR),
  });
}
