// @pocketjs/framework/net/http — HTTP Client (`fetch`) and HTTP Server
// (`serve`) over the `globalThis.net` / `globalThis.httpd` boundaries
// (contracts/spec/net.ts, contracts/spec/httpd.ts). Object shapes follow the
// WHATWG Fetch standard, with these PocketJS deviations: body locking, repeat
// consumption and detached input fail with a stable NetworkError; every
// network, permission, timeout and resource failure is a NetworkError too.
//
// Delivery: `fetch()` resolves when the response head is visible at a tick
// boundary; the body streams through `Response.body` (a BodyStream over the
// module's `readInto` op). `serve()` delivers each request from the same
// service pump and writes the handler's Response through `respond`/`write`.

import {
  HTTP_CORE_OWNED_REQUEST_HEADERS,
  HTTP_NULL_BODY_STATUS,
  HTTP_REDIRECT_STATUS,
  NET_DEFAULT_AGGREGATE_BYTES,
  NET_DEFAULT_QUEUE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
  NET_ERROR,
  NET_MAX_AGGREGATE_BYTES,
  NET_MAX_HEADER_BYTES,
  NET_MAX_HEADERS,
  NET_MAX_QUEUE_BYTES,
  NET_MAX_REDIRECTS,
  NET_MAX_REQUEST_BYTES,
  NET_MAX_TIMEOUT_MS,
  NET_METHODS_FORBIDDEN,
  NET_SPEC_MAJOR,
  type NetStartMeta,
} from "../../../contracts/spec/net.ts";
import {
  HTTPD_MAX_BACKLOG,
  HTTPD_MAX_CONNECTIONS,
  HTTPD_MAX_INFLIGHT,
  HTTPD_MAX_REQUEST_QUEUE_BYTES,
  HTTPD_MAX_SEND_QUEUE_BYTES,
  HTTPD_MAX_TIMEOUT_MS,
  HTTPD_SEND_ACCEPTED,
  HTTPD_SEND_BACKPRESSURE,
  HTTPD_SEND_INVALID,
  HTTPD_SEND_INVALID_REQUEST,
  HTTPD_SPEC_MAJOR,
  type HttpdListenMeta,
  type HttpdRespondMeta,
} from "../../../contracts/spec/httpd.ts";
import { stringToUtf8 } from "../bytes.ts";
import { AbortController, AbortSignal, isAbortSignalLike, type AbortSignalLike } from "./abort.ts";
import {
  BaseBody,
  MemoryBody,
  NativeBody,
  bodyFromInput,
  teeBody,
  type BodyStream,
  type NetworkData,
} from "./body.ts";
import { createBinding, integerOption, limitNumber, type EventRecord } from "./binding.ts";
import { NetworkError, errorFromLastError, normalizeErrorCode } from "./errors.ts";
import { URL } from "./url.ts";
import type { TlsOptions } from "./types.ts";

export type { BodyStream, BodyReadResult, NetworkData } from "./body.ts";

const PROTOCOL = "http" as const;

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export type HeadersInit = Headers | Record<string, string> | Iterable<readonly [string, string]>;

type HeadersGuard = "none" | "request" | "response" | "immutable";

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Request headers the core owns (framing, connection control, upgrade). An
 * app cannot set them; the Fetch request guard is otherwise not applied so
 * explicit `Cookie`, `Origin`, `User-Agent` etc. work on every host. */
const CORE_OWNED_REQUEST_HEADERS = new Set<string>(HTTP_CORE_OWNED_REQUEST_HEADERS);

function normalizeHeaderValue(value: string): string {
  // HTTP whitespace: tab, LF, CR, space.
  return String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
}

function invalidHeader(message: string): NetworkError {
  return new NetworkError(NET_ERROR.invalidRequest, message, { operation: "headers", protocol: PROTOCOL });
}

export class Headers {
  private readonly map = new Map<string, string[]>();
  private guard: HeadersGuard = "none";

  constructor(init?: HeadersInit) {
    this.fill(init);
  }

  /** @internal Append every pair of `init` under the current guard. */
  fill(init: HeadersInit | undefined | null): this {
    if (init === undefined || init === null) return this;
    if (init instanceof Headers) {
      for (const [name, values] of init.map) for (const v of values) this.append(name, v);
      return this;
    }
    if (typeof init === "object" && Symbol.iterator in init) {
      for (const pair of init as Iterable<readonly [string, string]>) {
        if (!pair || typeof pair !== "object" || (pair as readonly string[]).length !== 2) {
          throw invalidHeader("header pairs must have exactly two items");
        }
        this.append(pair[0], pair[1]);
      }
      return this;
    }
    if (typeof init === "object") {
      for (const name of Object.keys(init as Record<string, string>)) {
        this.append(name, (init as Record<string, string>)[name]);
      }
      return this;
    }
    throw invalidHeader("unsupported HeadersInit");
  }

  /** @internal */
  __setGuard(guard: HeadersGuard): this {
    this.guard = guard;
    return this;
  }

  /** @internal */
  __guard(): HeadersGuard {
    return this.guard;
  }

  private checkMutable(): void {
    if (this.guard === "immutable") throw new TypeError("Headers are immutable");
  }

  private accept(name: string): boolean {
    return this.guard !== "request" || !CORE_OWNED_REQUEST_HEADERS.has(name);
  }

  private static validate(rawName: string, rawValue: string): [string, string] {
    const name = String(rawName).toLowerCase();
    if (!TOKEN.test(name)) throw invalidHeader(`invalid header name "${rawName}"`);
    const value = normalizeHeaderValue(rawValue);
    if (/[\0\r\n]/.test(value)) throw invalidHeader(`invalid header value for "${rawName}"`);
    return [name, value];
  }

  append(rawName: string, rawValue: string): void {
    this.checkMutable();
    const [name, value] = Headers.validate(rawName, rawValue);
    if (!this.accept(name)) return;
    const list = this.map.get(name);
    if (list) list.push(value);
    else this.map.set(name, [value]);
  }

  set(rawName: string, rawValue: string): void {
    this.checkMutable();
    const [name, value] = Headers.validate(rawName, rawValue);
    if (!this.accept(name)) return;
    this.map.set(name, [value]);
  }

  delete(rawName: string): void {
    this.checkMutable();
    const [name] = Headers.validate(rawName, "");
    if (!this.accept(name)) return;
    this.map.delete(name);
  }

  get(rawName: string): string | null {
    const [name] = Headers.validate(rawName, "");
    const list = this.map.get(name);
    if (!list) return null;
    return list.join(", ");
  }

  has(rawName: string): boolean {
    const [name] = Headers.validate(rawName, "");
    return this.map.has(name);
  }

  getSetCookie(): string[] {
    return [...(this.map.get("set-cookie") ?? [])];
  }

  private sortedEntries(): [string, string][] {
    const names = [...this.map.keys()].sort();
    const out: [string, string][] = [];
    for (const name of names) {
      const values = this.map.get(name)!;
      if (name === "set-cookie") for (const v of values) out.push([name, v]);
      else out.push([name, values.join(", ")]);
    }
    return out;
  }

  *entries(): IterableIterator<[string, string]> {
    yield* this.sortedEntries();
  }
  *keys(): IterableIterator<string> {
    for (const [k] of this.sortedEntries()) yield k;
  }
  *values(): IterableIterator<string> {
    for (const [, v] of this.sortedEntries()) yield v;
  }
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }
  forEach(callback: (value: string, name: string, headers: Headers) => void, thisArg?: unknown): void {
    for (const [name, value] of this.sortedEntries()) callback.call(thisArg, value, name, this);
  }

  /** @internal Wire form: one value per name (repeats combined), set-cookie
   * combined with ", " as well because request meta is a flat object. */
  __toRecord(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, values] of this.map) out[name] = values.join(", ");
    return out;
  }

  /** @internal Approximate encoded size for the limits check. */
  __byteSize(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const [name, values] of this.map) {
      count++;
      bytes += stringToUtf8(name).length + stringToUtf8(values.join(", ")).length + 4;
    }
    return { count, bytes };
  }

  /** @internal */
  static __fromRecord(record: Record<string, unknown>, guard: HeadersGuard): Headers {
    const h = new Headers();
    for (const name of Object.keys(record)) {
      const value = record[name];
      if (Array.isArray(value)) {
        for (const v of value) h.appendUnchecked(name, String(v));
      } else {
        h.appendUnchecked(name, String(value));
      }
    }
    return h.__setGuard(guard);
  }

  private appendUnchecked(name: string, value: string): void {
    const key = name.toLowerCase();
    if (!TOKEN.test(key)) return;
    const list = this.map.get(key);
    if (list) list.push(value);
    else this.map.set(key, [value]);
  }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type RequestRedirect = "follow" | "manual" | "error";
export type BodyInit = NetworkData | BodyStream | AsyncIterable<Uint8Array> | null;

export interface RequestTimeouts {
  connectMs?: number;
  headersMs?: number;
  idleMs?: number;
  totalMs?: number;
}

export interface RequestLimits {
  /** Native receive queue (backpressure window) for the response body. */
  queueBytes?: number;
  /** Total response body cap; exceeding it fails with response_too_large. */
  maxBodyBytes?: number;
  /** Cap for text()/json()/arrayBuffer() on the response. */
  aggregateBytes?: number;
}

export interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  signal?: AbortSignal | AbortSignalLike | null;
  redirect?: RequestRedirect;
  timeouts?: RequestTimeouts;
  maxRedirects?: number;
  tls?: TlsOptions;
  limits?: RequestLimits;
}

const STANDARD_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

function normalizeMethod(raw: unknown): string {
  const method = String(raw ?? "GET");
  if (!TOKEN.test(method)) {
    throw new NetworkError(NET_ERROR.invalidRequest, `invalid method "${method}"`, {
      operation: "fetch",
      protocol: PROTOCOL,
    });
  }
  const upper = method.toUpperCase();
  if ((NET_METHODS_FORBIDDEN as readonly string[]).includes(upper)) {
    throw new NetworkError(NET_ERROR.invalidRequest, `method ${upper} is not allowed`, {
      operation: "fetch",
      protocol: PROTOCOL,
    });
  }
  return STANDARD_METHODS.has(upper) ? upper : method;
}

function parseAbsoluteUrl(input: string | URL, operation: string): URL {
  try {
    const url = input instanceof URL ? new URL(input.href) : new URL(String(input));
    if (url.username || url.password) {
      throw new NetworkError(NET_ERROR.invalidRequest, "URL must not carry credentials", {
        operation,
        protocol: PROTOCOL,
      });
    }
    return url;
  } catch (error) {
    if (error instanceof NetworkError) throw error;
    throw new NetworkError(NET_ERROR.invalidRequest, `invalid URL: ${String(input)}`, {
      operation,
      protocol: PROTOCOL,
    });
  }
}

export class Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly signal: AbortSignal | AbortSignalLike;
  readonly redirect: RequestRedirect;
  readonly timeouts: Readonly<RequestTimeouts>;
  readonly maxRedirects: number;
  readonly tls: Readonly<TlsOptions> | undefined;
  readonly limits: Readonly<RequestLimits>;
  private _body: BaseBody | AsyncIterable<Uint8Array> | null;
  private streamUsed = false;

  constructor(input: string | URL | Request, init: RequestInit = {}) {
    let url: URL;
    let method = "GET";
    let headers: Headers | undefined;
    let body: BaseBody | AsyncIterable<Uint8Array> | null = null;
    let signal: AbortSignal | AbortSignalLike | undefined;
    let redirect: RequestRedirect = "follow";
    let timeouts: RequestTimeouts = {};
    let maxRedirects = NET_MAX_REDIRECTS;
    let tls: TlsOptions | undefined;
    let limits: RequestLimits = {};

    if (input instanceof Request) {
      url = new URL(input.url);
      method = input.method;
      headers = new Headers().__setGuard("request").fill(input.headers);
      signal = input.signal;
      redirect = input.redirect;
      timeouts = { ...input.timeouts };
      maxRedirects = input.maxRedirects;
      tls = input.tls ? { ...input.tls } : undefined;
      limits = { ...input.limits };
      if (init.body === undefined && input._body) {
        if (input.bodyUsed) {
          throw new NetworkError(NET_ERROR.invalidState, "input request body is already used", {
            operation: "Request",
            protocol: PROTOCOL,
          });
        }
        body = input._body;
        input.streamUsed = true;
      }
    } else {
      url = parseAbsoluteUrl(input, "Request");
    }

    if (init.method !== undefined) method = normalizeMethod(init.method);
    if (init.headers !== undefined) {
      // Wire headers delivered by the server core arrive immutable and are
      // adopted as-is; anything app-supplied goes through the request guard.
      headers =
        init.headers instanceof Headers && init.headers.__guard() === "immutable"
          ? init.headers
          : new Headers().__setGuard("request").fill(init.headers);
    }
    if (init.signal !== undefined && init.signal !== null) {
      if (!isAbortSignalLike(init.signal)) {
        throw new NetworkError(NET_ERROR.invalidRequest, "signal must be an AbortSignal", {
          operation: "Request",
          protocol: PROTOCOL,
        });
      }
      signal = init.signal;
    }
    if (init.redirect !== undefined) {
      if (init.redirect !== "follow" && init.redirect !== "manual" && init.redirect !== "error") {
        throw new NetworkError(NET_ERROR.invalidRequest, "redirect must be follow, manual or error", {
          operation: "Request",
          protocol: PROTOCOL,
        });
      }
      redirect = init.redirect;
    }
    if (init.timeouts !== undefined) {
      timeouts = {};
      for (const key of ["connectMs", "headersMs", "idleMs", "totalMs"] as const) {
        const v = init.timeouts[key];
        if (v !== undefined) timeouts[key] = integerOption(v, `timeouts.${key}`, 1, NET_MAX_TIMEOUT_MS, "Request", PROTOCOL);
      }
    }
    if (init.maxRedirects !== undefined) {
      maxRedirects = integerOption(init.maxRedirects, "maxRedirects", 0, NET_MAX_REDIRECTS, "Request", PROTOCOL);
    }
    if (init.tls !== undefined) tls = { ...init.tls };
    if (init.limits !== undefined) {
      limits = {};
      if (init.limits.queueBytes !== undefined) {
        limits.queueBytes = integerOption(init.limits.queueBytes, "limits.queueBytes", 1, NET_MAX_QUEUE_BYTES, "Request", PROTOCOL);
      }
      if (init.limits.maxBodyBytes !== undefined) {
        limits.maxBodyBytes = integerOption(init.limits.maxBodyBytes, "limits.maxBodyBytes", 0, 2 ** 31 - 1, "Request", PROTOCOL);
      }
      if (init.limits.aggregateBytes !== undefined) {
        limits.aggregateBytes = integerOption(init.limits.aggregateBytes, "limits.aggregateBytes", 1, NET_MAX_AGGREGATE_BYTES, "Request", PROTOCOL);
      }
    }
    if (init.body !== undefined) body = bodyFromInput(init.body, "Request", PROTOCOL);
    if (body !== null && (method === "GET" || method === "HEAD")) {
      throw new NetworkError(NET_ERROR.invalidRequest, `${method} cannot have a body`, {
        operation: "Request",
        protocol: PROTOCOL,
      });
    }

    this.url = url.href;
    this.method = method;
    this.headers = headers ?? new Headers().__setGuard("request");
    this.signal = signal ?? new AbortSignal();
    this.redirect = redirect;
    this.timeouts = Object.freeze(timeouts);
    this.maxRedirects = maxRedirects;
    this.tls = tls ? Object.freeze(tls) : undefined;
    this.limits = Object.freeze(limits);
    this._body = body;
  }

  get body(): BodyStream | null {
    if (this._body === null) return null;
    if (this._body instanceof BaseBody) return this._body;
    // Async iterables are exposed as-is (they carry no lock state).
    return this._body as unknown as BodyStream;
  }

  get bodyUsed(): boolean {
    if (this._body instanceof BaseBody) return this._body.bodyUsed;
    return this.streamUsed;
  }

  /** @internal */
  get __bodySource(): BaseBody | AsyncIterable<Uint8Array> | null {
    return this._body;
  }

  clone(): Request {
    if (this.bodyUsed) {
      throw new NetworkError(NET_ERROR.invalidState, "cannot clone a used request", {
        operation: "clone",
        protocol: PROTOCOL,
      });
    }
    let bodyForCopy: BodyInit | undefined;
    if (this._body instanceof MemoryBody) bodyForCopy = this._body.fork() as unknown as BodyStream;
    else if (this._body instanceof BaseBody) {
      const [a, b] = teeBody(this._body, PROTOCOL, aggregateLimit(this.limits));
      this._body = a;
      bodyForCopy = b;
    } else if (this._body !== null) {
      throw new NetworkError(NET_ERROR.invalidState, "cannot clone a request with an iterator body", {
        operation: "clone",
        protocol: PROTOCOL,
      });
    }
    return new Request(this, bodyForCopy === undefined ? {} : { body: bodyForCopy });
  }

  private aggregate(): BaseBody {
    if (this._body instanceof BaseBody) return this._body;
    if (this._body === null) return new MemoryBody(new Uint8Array(0), PROTOCOL);
    throw new NetworkError(NET_ERROR.invalidState, "iterator bodies cannot be aggregated", {
      operation: "arrayBuffer",
      protocol: PROTOCOL,
    });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.aggregate().collect(aggregateLimit(this.limits), "arrayBuffer");
    return bytes.slice().buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    return this.aggregate().collectText(aggregateLimit(this.limits), "text");
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }
}

function aggregateLimit(limits: RequestLimits | undefined): number {
  return limits?.aggregateBytes ?? Math.min(NET_DEFAULT_AGGREGATE_BYTES, hostAggregateDefault());
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface ResponseInit {
  status?: number;
  statusText?: string;
  headers?: HeadersInit;
}

const REASON_PHRASES: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

const NULL_BODY_STATUS = new Set<number>(HTTP_NULL_BODY_STATUS);

interface ResponseInternal {
  url: string;
  redirected: boolean;
  aggregateBytes: number;
}

export class Response {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly url: string;
  readonly redirected: boolean;
  private _body: BaseBody | AsyncIterable<Uint8Array> | null;
  private readonly aggregateBytes: number;
  private streamUsed = false;

  constructor(body: BodyInit = null, init: ResponseInit = {}, internal?: ResponseInternal) {
    const status = init.status ?? 200;
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      // The constructor is the app-facing one; network responses use the
      // internal path which accepts the full 1xx-5xx range.
      if (!internal || !Number.isInteger(status) || status < 100 || status > 599) {
        throw new NetworkError(NET_ERROR.invalidRequest, "status must be an integer from 200 through 599", {
          operation: "Response",
          protocol: PROTOCOL,
        });
      }
    }
    const statusText = init.statusText === undefined ? "" : String(init.statusText);
    if (/[\r\n\0]/.test(statusText)) {
      throw new NetworkError(NET_ERROR.invalidRequest, "invalid statusText", {
        operation: "Response",
        protocol: PROTOCOL,
      });
    }
    this.status = status;
    this.statusText = statusText;
    this.headers = init.headers instanceof Headers && internal ? init.headers : new Headers(init.headers);
    this.headers.__setGuard(internal ? "immutable" : "response");
    this.url = internal?.url ?? "";
    this.redirected = internal?.redirected ?? false;
    this.aggregateBytes = internal?.aggregateBytes ?? aggregateLimit(undefined);
    let source = bodyFromInput(body, "Response", PROTOCOL);
    if (source !== null && NULL_BODY_STATUS.has(status)) {
      throw new NetworkError(NET_ERROR.invalidRequest, `status ${status} cannot have a body`, {
        operation: "Response",
        protocol: PROTOCOL,
      });
    }
    if (source instanceof MemoryBody && !internal && typeof body === "string" && !this.headers.has("content-type")) {
      this.headers.set("content-type", "text/plain;charset=UTF-8");
    }
    if (source === null && !internal) source = null;
    this._body = source;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status <= 299;
  }

  get body(): BodyStream | null {
    if (this._body === null) return null;
    if (this._body instanceof BaseBody) return this._body;
    return this._body as unknown as BodyStream;
  }

  get bodyUsed(): boolean {
    if (this._body instanceof BaseBody) return this._body.bodyUsed;
    return this.streamUsed;
  }

  /** @internal */
  get __bodySource(): BaseBody | AsyncIterable<Uint8Array> | null {
    return this._body;
  }

  /** @internal */
  __markStreamUsed(): void {
    this.streamUsed = true;
  }

  clone(): Response {
    if (this.bodyUsed) {
      throw new NetworkError(NET_ERROR.invalidState, "cannot clone a used response", {
        operation: "clone",
        protocol: PROTOCOL,
      });
    }
    let bodyForCopy: BodyInit = null;
    if (this._body instanceof MemoryBody) bodyForCopy = this._body.fork() as unknown as BodyStream;
    else if (this._body instanceof BaseBody) {
      const [a, b] = teeBody(this._body, PROTOCOL, this.aggregateBytes);
      this._body = a;
      bodyForCopy = b;
    } else if (this._body !== null) {
      throw new NetworkError(NET_ERROR.invalidState, "cannot clone a response with an iterator body", {
        operation: "clone",
        protocol: PROTOCOL,
      });
    }
    return new Response(bodyForCopy, { status: this.status, statusText: this.statusText, headers: new Headers(this.headers) }, {
      url: this.url,
      redirected: this.redirected,
      aggregateBytes: this.aggregateBytes,
    });
  }

  private aggregate(): BaseBody {
    if (this._body instanceof BaseBody) return this._body;
    if (this._body === null) return new MemoryBody(new Uint8Array(0), PROTOCOL);
    throw new NetworkError(NET_ERROR.invalidState, "iterator bodies cannot be aggregated", {
      operation: "arrayBuffer",
      protocol: PROTOCOL,
    });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.aggregate().collect(this.aggregateBytes, "arrayBuffer");
    return bytes.slice().buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    return this.aggregate().collectText(this.aggregateBytes, "text");
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  static json(data: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(JSON.stringify(data), { ...init, headers });
  }

  static redirect(url: string | URL, status = 302): Response {
    if (!(HTTP_REDIRECT_STATUS as readonly number[]).includes(status)) {
      throw new NetworkError(NET_ERROR.invalidRequest, `redirect status must be one of ${HTTP_REDIRECT_STATUS.join(", ")}`, {
        operation: "Response.redirect",
        protocol: PROTOCOL,
      });
    }
    const target = url instanceof URL ? url.href : String(url);
    return new Response(null, { status, headers: { location: target } });
  }
}

// ---------------------------------------------------------------------------
// HTTP Client binding (`globalThis.net`)
// ---------------------------------------------------------------------------

export interface NetOps {
  start(metaJson: string, body: ArrayBuffer | null): number;
  cancel(handle: number): void;
  poll(): string | undefined;
  lastError(): string;
  readInto(handle: number, into: ArrayBuffer, offset: number, length: number): number;
  limits(): string;
}

interface PendingFetch {
  request: Request;
  resolve: (response: Response) => void;
  reject: (error: NetworkError) => void;
  body: NativeBody | null;
  settled: boolean;
  aggregateBytes: number;
  abortListener: (() => void) | null;
}

const pendingFetches = new Map<number, PendingFetch>();

const net = createBinding<NetOps>({
  name: "net",
  protocol: PROTOCOL,
  specMajor: NET_SPEC_MAJOR,
  requiredOps: ["start", "cancel", "poll", "lastError", "readInto", "limits"],
  dispatch: dispatchNetEvent,
  onProtocolFailure(ops, error) {
    for (const [handle, p] of [...pendingFetches]) {
      ops.cancel(handle);
      failFetch(handle, p, error);
    }
  },
});

function hostAggregateDefault(): number {
  const ops = net.ops();
  if (!ops) return NET_DEFAULT_AGGREGATE_BYTES;
  try {
    return limitNumber(net.limits(), "defaultAggregateBytes", NET_DEFAULT_AGGREGATE_BYTES);
  } catch {
    return NET_DEFAULT_AGGREGATE_BYTES;
  }
}

function retireFetch(handle: number, p: PendingFetch): void {
  pendingFetches.delete(handle);
  if (p.abortListener) {
    p.request.signal.removeEventListener?.("abort", p.abortListener);
    p.abortListener = null;
  }
  net.release();
}

function failFetch(handle: number, p: PendingFetch, error: NetworkError): void {
  retireFetch(handle, p);
  if (!p.settled) {
    p.settled = true;
    p.reject(error);
  }
  if (p.body) p.body.onError(error);
}

function dispatchNetEvent(event: EventRecord, ops: NetOps): void {
  const handle = event.h;
  if (typeof handle !== "number") return;
  const p = pendingFetches.get(handle);
  if (!p) return;
  switch (event.t) {
    case "headers": {
      if (p.settled) return;
      const status = event.status;
      const url = typeof event.url === "string" ? event.url : p.request.url;
      const headers = event.headers && typeof event.headers === "object" ? (event.headers as Record<string, unknown>) : {};
      if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
        ops.cancel(handle);
        failFetch(handle, p, new NetworkError(NET_ERROR.protocol, "malformed headers event", { operation: "fetch", protocol: PROTOCOL }));
        return;
      }
      const length = typeof event.length === "number" && event.length >= 0 ? event.length : -1;
      const nullBody = p.request.method === "HEAD" || NULL_BODY_STATUS.has(status);
      const body = nullBody
        ? null
        : new NativeBody(
            {
              pull: (dest) => ops.readInto(handle, dest.buffer as ArrayBuffer, dest.byteOffset, dest.byteLength),
              cancel: () => ops.cancel(handle),
            },
            PROTOCOL,
            length,
          );
      p.body = body;
      p.settled = true;
      const response = new Response(body as unknown as BodyStream, {
        status,
        statusText: "",
        headers: Headers.__fromRecord(headers, "immutable"),
      }, {
        url,
        redirected: event.redirected === true,
        aggregateBytes: p.aggregateBytes,
      });
      p.resolve(response);
      return;
    }
    case "readable":
      p.body?.onReadable(typeof event.avail === "number" ? event.avail : 0);
      return;
    case "end":
      retireFetch(handle, p);
      p.body?.onEnd();
      return;
    case "error": {
      const error = new NetworkError(
        normalizeErrorCode(event.code),
        typeof event.message === "string" && event.message ? event.message : String(event.code),
        {
          operation: "fetch",
          protocol: PROTOCOL,
          causeCode: typeof event.causeCode === "string" ? event.causeCode : undefined,
        },
      );
      failFetch(handle, p, error);
      return;
    }
    default:
      return;
  }
}

function fetchLimits(): Record<string, unknown> {
  return net.limits();
}

/** The PocketJS HTTP client. */
export function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let request: Request;
  let ops: NetOps;
  let handle: number;
  let bodyBuffer: ArrayBuffer | null = null;
  try {
    request = input instanceof Request && init === undefined ? input : new Request(input, init);
    ops = net.require("fetch");
    const limits = fetchLimits();
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new NetworkError(NET_ERROR.invalidRequest, "url must be http: or https:", { operation: "fetch", protocol: PROTOCOL });
    }
    const features = Array.isArray(limits.features) ? (limits.features as unknown[]) : [];
    if (url.protocol === "https:" && !features.includes("tls")) {
      throw new NetworkError(NET_ERROR.unsupported, "this host does not provide network.http.client.tls", {
        operation: "fetch",
        protocol: PROTOCOL,
      });
    }
    if (request.signal.aborted) {
      throw new NetworkError(NET_ERROR.cancelled, "request was aborted", { operation: "fetch", protocol: PROTOCOL });
    }
    const source = request.__bodySource;
    if (source instanceof MemoryBody) {
      if (source.bodyUsed) {
        throw new NetworkError(NET_ERROR.invalidState, "request body is already used", { operation: "fetch", protocol: PROTOCOL });
      }
      const bytes = source.peek();
      const maxRequest = limitNumber(limits, "maxRequestBytes", NET_MAX_REQUEST_BYTES);
      if (bytes.length > maxRequest) {
        throw new NetworkError(NET_ERROR.resourceLimit, `request body exceeds ${maxRequest} bytes`, {
          operation: "fetch",
          protocol: PROTOCOL,
        });
      }
      bodyBuffer = bytes.slice().buffer as ArrayBuffer;
      void source.cancel(); // consumed by this fetch
    } else if (source !== null) {
      throw new NetworkError(NET_ERROR.unsupported, "streaming request bodies are not supported by this host yet", {
        operation: "fetch",
        protocol: PROTOCOL,
      });
    }
    const size = request.headers.__byteSize();
    if (size.count > limitNumber(limits, "maxHeaders", NET_MAX_HEADERS) || size.bytes > limitNumber(limits, "maxHeaderBytes", NET_MAX_HEADER_BYTES)) {
      throw new NetworkError(NET_ERROR.resourceLimit, "request headers exceed the host limits", { operation: "fetch", protocol: PROTOCOL });
    }
    if (request.tls) {
      const v = request.tls.verification;
      if (v !== undefined && v !== "full" && v !== "development-insecure") {
        throw new NetworkError(NET_ERROR.invalidRequest, "tls.verification must be full or development-insecure", {
          operation: "fetch",
          protocol: PROTOCOL,
        });
      }
      for (const key of ["ca", "credential", "alpn", "minVersion", "maxVersion", "clientCertificate", "revocation", "serverName"] as const) {
        if (request.tls[key] !== undefined) {
          throw new NetworkError(NET_ERROR.unsupported, `tls.${key} is not supported by this host`, { operation: "fetch", protocol: PROTOCOL });
        }
      }
    }
    const meta: NetStartMeta = {
      url: request.url,
      method: request.method,
      headers: request.headers.__toRecord(),
      queueBytes: request.limits.queueBytes ?? limitNumber(limits, "defaultQueueBytes", NET_DEFAULT_QUEUE_BYTES),
      redirect: request.redirect,
      maxRedirects: Math.min(request.maxRedirects, limitNumber(limits, "maxRedirects", NET_MAX_REDIRECTS)),
      timeouts: {
        connectMs: request.timeouts.connectMs ?? limitNumber(limits, "defaultTimeoutMs", NET_DEFAULT_TIMEOUT_MS),
        headersMs: request.timeouts.headersMs ?? limitNumber(limits, "defaultTimeoutMs", NET_DEFAULT_TIMEOUT_MS),
        idleMs: request.timeouts.idleMs ?? limitNumber(limits, "defaultTimeoutMs", NET_DEFAULT_TIMEOUT_MS),
        totalMs: request.timeouts.totalMs ?? limitNumber(limits, "maxTimeoutMs", NET_MAX_TIMEOUT_MS),
      },
    };
    if (request.limits.maxBodyBytes !== undefined) meta.maxBodyBytes = request.limits.maxBodyBytes;
    if (request.tls?.verification !== undefined) meta.tls = { verification: request.tls.verification };
    handle = ops.start(JSON.stringify(meta), bodyBuffer);
    if (!Number.isInteger(handle) || handle < 0) {
      throw errorFromLastError(ops.lastError(), "fetch", PROTOCOL);
    }
  } catch (error) {
    return Promise.reject(
      error instanceof NetworkError
        ? error
        : new NetworkError(NET_ERROR.invalidRequest, String(error), { operation: "fetch", protocol: PROTOCOL }),
    );
  }
  return new Promise<Response>((resolve, reject) => {
    const aggregateBytes = request.limits.aggregateBytes ?? Math.min(NET_DEFAULT_AGGREGATE_BYTES, hostAggregateDefault());
    const pending: PendingFetch = { request, resolve, reject, body: null, settled: false, aggregateBytes, abortListener: null };
    pendingFetches.set(handle, pending);
    net.retain();
    const onAbort = (): void => {
      // The terminal error{cancelled} settles the Promise at the next tick.
      ops.cancel(handle);
    };
    pending.abortListener = onAbort;
    request.signal.addEventListener("abort", onAbort);
  });
}

// ---------------------------------------------------------------------------
// HTTP Server binding (`globalThis.httpd`)
// ---------------------------------------------------------------------------

export interface HttpdOps {
  listen(metaJson: string): number;
  stop(handle: number, graceful: boolean, timeoutMs: number): number;
  respond(req: number, metaJson: string, body: ArrayBuffer | null): number;
  write(req: number, chunk: ArrayBuffer): number;
  endBody(req: number): number;
  readInto(req: number, into: ArrayBuffer, offset: number, length: number): number;
  abort(req: number): void;
  poll(): string | undefined;
  lastError(): string;
  limits(): string;
}

export interface HttpServeLimits {
  maxConnections?: number;
  maxInflight?: number;
  maxHeaderBytes?: number;
  maxBodyBytes?: number;
  requestQueueBytes?: number;
  sendQueueBytes?: number;
}

export interface HttpServeTimeouts {
  headerMs?: number;
  bodyIdleMs?: number;
  handlerMs?: number;
  keepAliveMs?: number;
  closeMs?: number;
}

export interface HttpServer {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
}

export interface HttpServeOptions {
  hostname: string;
  port: number;
  backlog?: number;
  tls?: { credential: string };
  limits?: HttpServeLimits;
  timeouts?: HttpServeTimeouts;
  fetch(request: Request, server: HttpServer): Response | Promise<Response>;
  error?(error: unknown): Response | Promise<Response> | void;
}

interface ServerState {
  handle: number;
  options: HttpServeOptions;
  server: HttpServerImpl;
  resolveListen: ((server: HttpServer) => void) | null;
  rejectListen: ((error: NetworkError) => void) | null;
  stopWaiters: { resolve: () => void; reject: (e: NetworkError) => void }[];
  secure: boolean;
}

interface ServerRequestState {
  server: ServerState;
  req: number;
  body: NativeBody | null;
  controller: AbortController;
  responded: boolean;
  terminal: boolean;
  drainWaiter: (() => void) | null;
}

const servers = new Map<number, ServerState>();
const serverRequests = new Map<number, ServerRequestState>();

const httpd = createBinding<HttpdOps>({
  name: "httpd",
  protocol: PROTOCOL,
  specMajor: HTTPD_SPEC_MAJOR,
  requiredOps: ["listen", "stop", "respond", "write", "endBody", "readInto", "abort", "poll", "lastError", "limits"],
  dispatch: dispatchHttpdEvent,
  onProtocolFailure(ops, error) {
    for (const [req, r] of [...serverRequests]) {
      ops.abort(req);
      finishServerRequest(r, error);
    }
    for (const [handle, s] of [...servers]) {
      ops.stop(handle, false, 0);
      failServer(s, error);
    }
  },
});

class HttpServerImpl implements HttpServer {
  hostname = "";
  port = 0;
  private readonly state: () => ServerState;

  constructor(state: () => ServerState) {
    this.state = state;
  }

  get url(): string {
    const host = this.hostname.includes(":") ? `[${this.hostname}]` : this.hostname;
    return `${this.state().secure ? "https" : "http"}://${host}:${this.port}/`;
  }

  stop(options: { graceful?: boolean; timeout?: number } = {}): Promise<void> {
    const s = this.state();
    const ops = httpd.ops();
    if (!ops || !servers.has(s.handle)) return Promise.resolve();
    const graceful = options.graceful ?? true;
    const timeout = options.timeout ?? 0;
    const rc = ops.stop(s.handle, graceful, timeout);
    if (rc < 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      s.stopWaiters.push({ resolve, reject });
    });
  }
}

function failServer(s: ServerState, error: NetworkError): void {
  if (!servers.has(s.handle)) return;
  servers.delete(s.handle);
  httpd.release();
  if (s.rejectListen) {
    const reject = s.rejectListen;
    s.rejectListen = null;
    s.resolveListen = null;
    reject(error);
  }
  for (const w of s.stopWaiters.splice(0)) w.reject(error);
}

function closeServer(s: ServerState): void {
  if (!servers.has(s.handle)) return;
  servers.delete(s.handle);
  httpd.release();
  for (const w of s.stopWaiters.splice(0)) w.resolve();
}

function finishServerRequest(r: ServerRequestState, error: NetworkError | null): void {
  if (r.terminal) return;
  r.terminal = true;
  serverRequests.delete(r.req);
  if (error) {
    r.body?.onError(error);
    r.controller.abort(error);
  } else {
    r.body?.onEnd();
  }
  const w = r.drainWaiter;
  r.drainWaiter = null;
  if (w) w();
}

function dispatchHttpdEvent(event: EventRecord, ops: HttpdOps): void {
  if (typeof event.req === "number" && event.t !== "request") {
    const r = serverRequests.get(event.req);
    if (!r) return;
    switch (event.t) {
      case "readable":
        r.body?.onReadable(typeof event.avail === "number" ? event.avail : 0);
        return;
      case "end":
        r.body?.onEnd();
        return;
      case "drain": {
        const w = r.drainWaiter;
        r.drainWaiter = null;
        if (w) w();
        return;
      }
      case "aborted": {
        const code = normalizeErrorCode(event.code);
        finishServerRequest(
          r,
          new NetworkError(code, `request ${code}`, { operation: "serve", protocol: PROTOCOL }),
        );
        return;
      }
      default:
        return;
    }
  }
  const handle = event.h;
  if (typeof handle !== "number") return;
  const s = servers.get(handle);
  if (!s) return;
  switch (event.t) {
    case "listening": {
      s.server.hostname = typeof event.address === "string" ? event.address : s.options.hostname;
      s.server.port = typeof event.port === "number" ? event.port : s.options.port;
      const resolve = s.resolveListen;
      s.resolveListen = null;
      s.rejectListen = null;
      if (resolve) resolve(s.server);
      return;
    }
    case "closed":
      closeServer(s);
      return;
    case "error": {
      const error = new NetworkError(
        normalizeErrorCode(event.code),
        typeof event.message === "string" && event.message ? event.message : String(event.code),
        { operation: "serve", protocol: PROTOCOL, causeCode: typeof event.causeCode === "string" ? event.causeCode : undefined },
      );
      if (s.rejectListen) failServer(s, error);
      // After listening, `closed` follows and resolves stop waiters; the
      // error itself has no app-visible surface beyond stop() rejecting.
      else {
        for (const w of s.stopWaiters.splice(0)) w.reject(error);
      }
      return;
    }
    case "request":
      deliverRequest(s, event, ops);
      return;
    default:
      return;
  }
}

function deliverRequest(s: ServerState, event: EventRecord, ops: HttpdOps): void {
  const req = event.req;
  if (typeof req !== "number") return;
  const method = typeof event.method === "string" ? event.method : "GET";
  const target = typeof event.target === "string" ? event.target : "/";
  const headerRecord = event.headers && typeof event.headers === "object" ? (event.headers as Record<string, unknown>) : {};
  const headers = Headers.__fromRecord(headerRecord, "immutable");
  const length = typeof event.length === "number" && event.length >= 0 ? event.length : -1;
  const hasBody = length > 0 || (length < 0 && /chunked/i.test(headers.get("transfer-encoding") ?? ""));
  const secure = event.secure === true;
  const hostHeader = headers.get("host");
  const authority = hostHeader && /^[A-Za-z0-9.\-:[\]_%]+$/.test(hostHeader) ? hostHeader : `${s.server.hostname}:${s.server.port}`;
  let urlText = `${secure ? "https" : "http"}://${authority}${target.startsWith("/") ? target : "/" + target}`;
  if (!URL.canParse(urlText)) urlText = `${secure ? "https" : "http"}://${s.server.hostname}:${s.server.port}/`;

  const controller = new AbortController();
  const state: ServerRequestState = {
    server: s,
    req,
    body: null,
    controller,
    responded: false,
    terminal: false,
    drainWaiter: null,
  };
  const body = hasBody
    ? new NativeBody(
        {
          pull: (dest) => ops.readInto(req, dest.buffer as ArrayBuffer, dest.byteOffset, dest.byteLength),
          cancel: () => {
            // Cancelling the request body does not abort the exchange; the
            // core drains or closes after the response completes.
          },
        },
        PROTOCOL,
        length,
      )
    : null;
  state.body = body;
  serverRequests.set(req, state);

  const request = new Request(urlText, {
    method,
    headers, // wire headers: immutable, adopted as-is
    body: body as unknown as BodyStream,
    signal: controller.signal,
  });

  let result: Response | Promise<Response>;
  try {
    result = s.options.fetch(request, s.server);
  } catch (error) {
    void handleHandlerFailure(state, ops, error);
    return;
  }
  if (result instanceof Response) {
    void sendResponse(state, ops, result);
  } else if (result && typeof (result as Promise<Response>).then === "function") {
    (result as Promise<Response>).then(
      (response) => void sendResponse(state, ops, response),
      (error) => void handleHandlerFailure(state, ops, error),
    );
  } else {
    void handleHandlerFailure(state, ops, new TypeError("handler must return a Response"));
  }
}

async function handleHandlerFailure(state: ServerRequestState, ops: HttpdOps, error: unknown): Promise<void> {
  if (state.terminal || state.responded) {
    if (!state.terminal && state.responded) ops.abort(state.req);
    return;
  }
  const errorHandler = state.server.options.error;
  if (errorHandler) {
    try {
      const produced = await errorHandler(error);
      if (produced instanceof Response) {
        await sendResponse(state, ops, produced);
        return;
      }
    } catch {
      // fall through to the fixed 500
    }
  }
  await sendResponse(state, ops, new Response(null, { status: 500 }));
}

function respondMeta(response: Response, end: boolean, contentLength?: number): HttpdRespondMeta {
  const meta: HttpdRespondMeta = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers.__toRecord(),
    end,
  };
  if (contentLength !== undefined) meta.contentLength = contentLength;
  return meta;
}

function waitDrain(state: ServerRequestState): Promise<void> {
  return new Promise<void>((resolve) => {
    state.drainWaiter = resolve;
  });
}

async function sendResponse(state: ServerRequestState, ops: HttpdOps, response: Response): Promise<void> {
  if (state.terminal || state.responded) return;
  state.responded = true;
  const source = response.__bodySource;
  try {
    if (source === null || source instanceof MemoryBody) {
      const bytes = source ? source.peek() : new Uint8Array(0);
      const rc = ops.respond(state.req, JSON.stringify(respondMeta(response, true)), bytes.length ? (bytes.slice().buffer as ArrayBuffer) : null);
      if (rc === HTTPD_SEND_ACCEPTED) {
        if (source) void source.cancel();
        finishServerRequest(state, null);
        return;
      }
      if (rc === HTTPD_SEND_BACKPRESSURE) {
        // Too large for one send: stream it with a known length.
        const rc2 = ops.respond(state.req, JSON.stringify(respondMeta(response, false, bytes.length)), null);
        if (rc2 !== HTTPD_SEND_ACCEPTED) {
          finishServerRequest(state, sendError(rc2));
          return;
        }
        await writeAll(state, ops, bytes);
        if (source) void source.cancel();
        if (!state.terminal) {
          ops.endBody(state.req);
          finishServerRequest(state, null);
        }
        return;
      }
      finishServerRequest(state, sendError(rc));
      return;
    }
    // Streaming body (BodyStream or AsyncIterable).
    const known = source instanceof BaseBody ? source.knownLength() : -1;
    const rc = ops.respond(state.req, JSON.stringify(respondMeta(response, false, known >= 0 ? known : undefined)), null);
    if (rc !== HTTPD_SEND_ACCEPTED) {
      finishServerRequest(state, sendError(rc));
      if (source instanceof BaseBody) void source.cancel();
      return;
    }
    response.__markStreamUsed();
    const iterable = source as AsyncIterable<Uint8Array>;
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) break;
        if (state.terminal) break;
        if (!(value instanceof Uint8Array)) throw new TypeError("body chunks must be Uint8Array");
        await writeAll(state, ops, value);
      }
    } finally {
      if (state.terminal) await iterator.return?.();
    }
    if (!state.terminal) {
      ops.endBody(state.req);
      finishServerRequest(state, null);
    }
  } catch (error) {
    if (!state.terminal) {
      ops.abort(state.req);
      finishServerRequest(
        state,
        error instanceof NetworkError ? error : new NetworkError(NET_ERROR.other, String(error), { operation: "serve", protocol: PROTOCOL }),
      );
    }
  }
}

function sendError(rc: number): NetworkError {
  const code = rc === HTTPD_SEND_INVALID_REQUEST ? NET_ERROR.closed : rc === HTTPD_SEND_INVALID ? NET_ERROR.invalidRequest : NET_ERROR.other;
  return new NetworkError(code, `respond failed (${rc})`, { operation: "serve", protocol: PROTOCOL });
}

async function writeAll(state: ServerRequestState, ops: HttpdOps, bytes: Uint8Array): Promise<void> {
  const listenQueue = state.server.options.limits?.sendQueueBytes;
  let chunkMax = Math.max(1, Math.min(16 * 1024, limitNumber(httpd.limits(), "sendLowWaterBytes", 16 * 1024), listenQueue ?? Infinity));
  let offset = 0;
  let refusedAt = -1;
  while (offset < bytes.length) {
    if (state.terminal) return;
    const end = Math.min(bytes.length, offset + chunkMax);
    const chunk = bytes.slice(offset, end).buffer as ArrayBuffer;
    const rc = ops.write(state.req, chunk);
    if (rc === HTTPD_SEND_ACCEPTED) {
      offset = end;
      refusedAt = -1;
      continue;
    }
    if (rc === HTTPD_SEND_BACKPRESSURE) {
      // Wait for the queue to drain; a chunk refused twice in a row is
      // larger than the free window, so shrink it before retrying.
      if (refusedAt === offset && chunkMax > 1) chunkMax = Math.max(1, chunkMax >> 2);
      refusedAt = offset;
      await waitDrain(state);
      continue;
    }
    throw sendError(rc);
  }
}

/** Start an HTTP server. Resolves once the listener is bound; rejects on any
 * bind, permission or TLS credential failure. */
export function serve(options: HttpServeOptions): Promise<HttpServer> {
  let ops: HttpdOps;
  let handle: number;
  const state: ServerState = {
    handle: -1,
    options,
    server: null as unknown as HttpServerImpl,
    resolveListen: null,
    rejectListen: null,
    stopWaiters: [],
    secure: options.tls !== undefined,
  };
  state.server = new HttpServerImpl(() => state);
  try {
    if (typeof options.fetch !== "function") {
      throw new NetworkError(NET_ERROR.invalidRequest, "serve() requires a fetch handler", { operation: "serve", protocol: PROTOCOL });
    }
    ops = httpd.require("serve");
    const limits = httpd.limits();
    const meta: HttpdListenMeta = {
      address: String(options.hostname),
      port: integerOption(options.port, "port", 0, 65535, "serve", PROTOCOL),
    };
    if (options.backlog !== undefined) meta.backlog = integerOption(options.backlog, "backlog", 1, HTTPD_MAX_BACKLOG, "serve", PROTOCOL);
    if (options.tls !== undefined) {
      const features = Array.isArray(limits.features) ? (limits.features as unknown[]) : [];
      if (!features.includes("tls")) {
        throw new NetworkError(NET_ERROR.unsupported, "this host does not provide network.http.server.tls", { operation: "serve", protocol: PROTOCOL });
      }
      if (typeof options.tls.credential !== "string" || !options.tls.credential) {
        throw new NetworkError(NET_ERROR.invalidRequest, "tls.credential must name a host credential", { operation: "serve", protocol: PROTOCOL });
      }
      meta.tls = { credential: options.tls.credential };
    }
    if (options.limits) {
      meta.limits = {};
      const l = options.limits;
      if (l.maxConnections !== undefined) meta.limits.maxConnections = integerOption(l.maxConnections, "limits.maxConnections", 1, HTTPD_MAX_CONNECTIONS, "serve", PROTOCOL);
      if (l.maxInflight !== undefined) meta.limits.maxInflight = integerOption(l.maxInflight, "limits.maxInflight", 1, HTTPD_MAX_INFLIGHT, "serve", PROTOCOL);
      if (l.maxHeaderBytes !== undefined) meta.limits.maxHeaderBytes = integerOption(l.maxHeaderBytes, "limits.maxHeaderBytes", 1, 2 ** 31 - 1, "serve", PROTOCOL);
      if (l.maxBodyBytes !== undefined) meta.limits.maxBodyBytes = integerOption(l.maxBodyBytes, "limits.maxBodyBytes", 0, 2 ** 31 - 1, "serve", PROTOCOL);
      if (l.requestQueueBytes !== undefined) meta.limits.requestQueueBytes = integerOption(l.requestQueueBytes, "limits.requestQueueBytes", 1, HTTPD_MAX_REQUEST_QUEUE_BYTES, "serve", PROTOCOL);
      if (l.sendQueueBytes !== undefined) meta.limits.sendQueueBytes = integerOption(l.sendQueueBytes, "limits.sendQueueBytes", 1, HTTPD_MAX_SEND_QUEUE_BYTES, "serve", PROTOCOL);
    }
    if (options.timeouts) {
      meta.timeouts = {};
      for (const key of ["headerMs", "bodyIdleMs", "handlerMs", "keepAliveMs", "closeMs"] as const) {
        const v = options.timeouts[key];
        if (v !== undefined) meta.timeouts[key] = integerOption(v, `timeouts.${key}`, 1, HTTPD_MAX_TIMEOUT_MS, "serve", PROTOCOL);
      }
    }
    handle = ops.listen(JSON.stringify(meta));
    if (!Number.isInteger(handle) || handle < 0) throw errorFromLastError(ops.lastError(), "serve", PROTOCOL);
  } catch (error) {
    return Promise.reject(
      error instanceof NetworkError ? error : new NetworkError(NET_ERROR.invalidRequest, String(error), { operation: "serve", protocol: PROTOCOL }),
    );
  }
  state.handle = handle;
  return new Promise<HttpServer>((resolve, reject) => {
    state.resolveListen = resolve;
    state.rejectListen = reject;
    servers.set(handle, state);
    httpd.retain();
  });
}

/** @internal test hooks */
export const __http = { net, httpd, pendingFetches, servers, serverRequests };
