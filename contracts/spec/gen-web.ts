// Deterministic codegen: contracts/spec/net.ts -> hosts/web/net-spec.js — the
// plain-ESM mirror of the HTTP Client boundary for the browser dev host.
// hosts/web/*.js is served to the browser as-is (no bundler, no TypeScript),
// so the host cannot import the spec directly; it imports this generated
// module instead and tests/contract.ts byte-compares it.
//
// Run from PocketJS/:  bun contracts/spec/gen-web.ts   (or `bun run gen`)

import {
  HTTP_CORE_OWNED_REQUEST_HEADERS,
  HTTP_NULL_BODY_STATUS,
  HTTP_REDIRECT_STATUS,
  NET_DEFAULT_AGGREGATE_BYTES,
  NET_DEFAULT_QUEUE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
  NET_ERROR,
  NET_EVENT,
  NET_MAX_AGGREGATE_BYTES,
  NET_MAX_EVENTS_PER_TICK,
  NET_MAX_HEADER_BYTES,
  NET_MAX_HEADERS,
  NET_MAX_INFLIGHT,
  NET_MAX_QUEUE_BYTES,
  NET_MAX_REDIRECTS,
  NET_MAX_REQUEST_BYTES,
  NET_MAX_TICK_BYTES,
  NET_MAX_TIMEOUT_MS,
  NET_METHODS_FORBIDDEN,
  NET_SPEC_MAJOR,
  NET_SPEC_MINOR,
  NET_TLS_MIN_VERSION,
} from "./net.ts";

function js(value: unknown): string {
  return JSON.stringify(value);
}

export function generateWeb(): string {
  const L: string[] = [];
  const put = (s: string) => L.push(s);
  put("// GENERATED — do not edit; run `bun contracts/spec/gen-web.ts`.");
  put("// Plain-ESM mirror of contracts/spec/net.ts for the browser dev host");
  put("// (hosts/web/net.js). tests/contract.ts byte-compares this file.");
  put(`export const NET_SPEC_MAJOR = ${NET_SPEC_MAJOR};`);
  put(`export const NET_SPEC_MINOR = ${NET_SPEC_MINOR};`);
  put(`export const NET_MAX_INFLIGHT = ${NET_MAX_INFLIGHT};`);
  put(`export const NET_MAX_REQUEST_BYTES = ${NET_MAX_REQUEST_BYTES};`);
  put(`export const NET_DEFAULT_QUEUE_BYTES = ${NET_DEFAULT_QUEUE_BYTES};`);
  put(`export const NET_MAX_QUEUE_BYTES = ${NET_MAX_QUEUE_BYTES};`);
  put(`export const NET_DEFAULT_AGGREGATE_BYTES = ${NET_DEFAULT_AGGREGATE_BYTES};`);
  put(`export const NET_MAX_AGGREGATE_BYTES = ${NET_MAX_AGGREGATE_BYTES};`);
  put(`export const NET_MAX_EVENTS_PER_TICK = ${NET_MAX_EVENTS_PER_TICK};`);
  put(`export const NET_MAX_TICK_BYTES = ${NET_MAX_TICK_BYTES};`);
  put(`export const NET_MAX_HEADERS = ${NET_MAX_HEADERS};`);
  put(`export const NET_MAX_HEADER_BYTES = ${NET_MAX_HEADER_BYTES};`);
  put(`export const NET_DEFAULT_TIMEOUT_MS = ${NET_DEFAULT_TIMEOUT_MS};`);
  put(`export const NET_MAX_TIMEOUT_MS = ${NET_MAX_TIMEOUT_MS};`);
  put(`export const NET_MAX_REDIRECTS = ${NET_MAX_REDIRECTS};`);
  put(`export const NET_TLS_MIN_VERSION = ${js(NET_TLS_MIN_VERSION)};`);
  put(`export const NET_METHODS_FORBIDDEN = ${js(NET_METHODS_FORBIDDEN)};`);
  put(`export const HTTP_CORE_OWNED_REQUEST_HEADERS = ${js(HTTP_CORE_OWNED_REQUEST_HEADERS)};`);
  put(`export const HTTP_NULL_BODY_STATUS = ${js(HTTP_NULL_BODY_STATUS)};`);
  put(`export const HTTP_REDIRECT_STATUS = ${js(HTTP_REDIRECT_STATUS)};`);
  put(`export const NET_EVENT = ${js(NET_EVENT)};`);
  put(`export const NET_ERROR = ${js(NET_ERROR)};`);
  return L.join("\n") + "\n";
}

if (import.meta.main) {
  const out = new URL("../../hosts/web/net-spec.js", import.meta.url).pathname;
  await Bun.write(out, generateWeb());
  console.log(`wrote ${out}`);
}
