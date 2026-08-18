import type {
  NetworkData,
  NetworkLimitOverrides,
  TlsOptions,
} from "./index.ts";
import {
  AbortController,
  AbortSignal,
  NetworkError,
  URL,
} from "./index.ts";
import { unsupportedNetworkPromise } from "./internal.ts";
import type { WebSocketUpgrade } from "./websocket.ts";
import {
  abortSignalAborted,
  addAbortAlgorithm,
  createDependentAbortSignal,
} from "./abort.ts";
import {
  BodyController,
  bodyFromBinding,
  extractBody,
  HTTP_BODY_CHUNK_BYTES,
  HTTP_BODY_HELPER_BYTES,
  HTTP_BODY_TEE_BRANCH_BYTES,
  ownedUint8ArrayBuffer,
  snapshotUint8Array,
} from "./http-body.ts";
import type {
  BodyStream as HttpBodyStream,
  HttpBodyLimits,
} from "./http-body.ts";
import {
  getHttpClientBinding,
  NetworkV1CommandOpcode,
  NetworkV1EventCode,
} from "./http-binding.ts";
import {
  canonicalizeHttpUrl,
  type CanonicalHttpUrl,
} from "./http-url.ts";
import { decodeUtf8 } from "./utf8.ts";
import type {
  HttpBindingHeader,
  HttpClientPrivateBinding,
  HttpClientBindingOperation,
  HttpRequestErrorEvent,
  HttpRequestStartCommand,
  HttpResponseHeadersEvent,
  OperationCancelCommand,
} from "./http-binding.ts";

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
export type { BodyStream } from "./http-body.ts";

export type HeadersInit =
  | Headers
  | Record<string, string>
  | Iterable<readonly [string, string]>;

export type BodyInit =
  | NetworkData
  | HttpBodyStream
  | AsyncIterable<Uint8Array>
  | null;
export type RequestRedirect = "follow" | "manual" | "error";

export interface HttpTimeouts {
  readonly connect?: number;
  readonly headers?: number;
  readonly idle?: number;
  readonly total?: number;
}

export interface RequestInit {
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit;
  readonly signal?: AbortSignal;
  readonly redirect?: RequestRedirect;
  readonly timeouts?: HttpTimeouts;
  readonly maxRedirects?: number;
  readonly tls?: TlsOptions;
  readonly limits?: NetworkLimitOverrides;
  readonly ref?: boolean;
}

export interface ResponseInit {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: HeadersInit;
}

type HeadersGuard = "none" | "request" | "response" | "immutable";

interface HeaderEntry {
  readonly name: string;
  readonly value: string;
}

interface HeadersState {
  guard: HeadersGuard;
  readonly list: HeaderEntry[];
  byteLimit: number;
}

const functionCall = Function.prototype.call;
const bindCall = <Args extends unknown[], Result>(
  operation: (...args: Args) => Result,
): ((receiver: unknown, ...args: Args) => Result) =>
  functionCall.bind(operation) as (receiver: unknown, ...args: Args) => Result;
const arrayIncludes = bindCall(Array.prototype.includes);
const arrayIsArray = Array.isArray;
const arrayJoin = bindCall(Array.prototype.join);
const arrayPush = bindCall(Array.prototype.push);
const arraySort = bindCall(Array.prototype.sort);
const arraySplice = bindCall(Array.prototype.splice);
const jsonStringify = JSON.stringify;
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectKeys = Object.keys;
const numberIsFinite = Number.isFinite;
const numberIsInteger = Number.isInteger;
const numberIsSafeInteger = Number.isSafeInteger;
const mathMin = Math.min;
const PromiseIntrinsic = Promise;
const promiseResolve = Promise.resolve;
const promiseThen = Promise.prototype.then;
const reflectApply = Reflect.apply;
const regExpTest = bindCall(RegExp.prototype.test);
const setHas = bindCall(Set.prototype.has);
const stringCharCodeAt = bindCall(String.prototype.charCodeAt);
const stringIncludes = bindCall(String.prototype.includes);
const stringReplace = bindCall(String.prototype.replace) as unknown as (
  receiver: string,
  pattern: string | RegExp,
  replacement: string,
) => string;
const stringStartsWith = bindCall(String.prototype.startsWith);
const stringToLowerCase = bindCall(String.prototype.toLowerCase);
const stringToUpperCase = bindCall(String.prototype.toUpperCase);
const webIdlBoolean = Boolean;
const webIdlNumber = Number;
const webIdlString = String;
const mathTrunc = Math.trunc;

const headerStates = new WeakMap<Headers, HeadersState>();
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_HEADER_COUNT = 128;
const HTTP_HEADER_BYTES = 64 * 1024;
const FORBIDDEN_REQUEST_NAMES = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);
const FORBIDDEN_RESPONSE_NAMES = new Set(["set-cookie", "set-cookie2"]);
const NORMALIZED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface EffectiveHttpSdkLimits {
  readonly headerBytes: number;
  readonly body: Readonly<HttpBodyLimits>;
}

const UNBOUND_HTTP_SDK_LIMITS: Readonly<EffectiveHttpSdkLimits> = objectFreeze({
  headerBytes: HTTP_HEADER_BYTES,
  body: objectFreeze({
    bufferedBytes: HTTP_BODY_HELPER_BYTES,
    chunkBytes: HTTP_BODY_CHUNK_BYTES,
    teeBranchBytes: HTTP_BODY_TEE_BRANCH_BYTES,
  }),
});

function admittedLimitDefault(
  binding: HttpClientPrivateBinding,
  name: string,
): number {
  const values = binding.httpClientLimits.values;
  for (let index = 0; index < values.length; index++) {
    const entry = values[index]!;
    if (entry.name === name) return entry.default;
  }
  throw new TypeError(`PocketJS HTTP client binding is missing ${name}`);
}

function effectiveHttpSdkLimits(
  binding: HttpClientPrivateBinding | undefined = getHttpClientBinding(),
): Readonly<EffectiveHttpSdkLimits> {
  if (!binding) return UNBOUND_HTTP_SDK_LIMITS;
  const bufferedBytes = mathMin(
    admittedLimitDefault(binding, "http.bufferedBodyBytes"),
    HTTP_BODY_HELPER_BYTES,
  );
  const chunkBytes = mathMin(
    admittedLimitDefault(binding, "http.maxBodyChunkBytes"),
    HTTP_BODY_CHUNK_BYTES,
  );
  return objectFreeze({
    headerBytes: mathMin(
      admittedLimitDefault(binding, "http.headerBytes"),
      HTTP_HEADER_BYTES,
    ),
    body: objectFreeze({
      bufferedBytes,
      chunkBytes,
      teeBranchBytes: mathMin(
        bufferedBytes,
        HTTP_BODY_TEE_BRANCH_BYTES,
        chunkBytes * 4,
      ),
    }),
  });
}

function headersState(headers: Headers): HeadersState {
  const state = headerStates.get(headers);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}

function hasNormalizedHeader(headers: Headers, name: string): boolean {
  for (const entry of headersState(headers).list) {
    if (entry.name === name) return true;
  }
  return false;
}

function byteString(value: unknown, label: string): string {
  const string = webIdlString(value);
  for (let index = 0; index < string.length; index++) {
    if (stringCharCodeAt(string, index) > 0xff) {
      throw new TypeError(`${label} contains a character outside ByteString`);
    }
  }
  return string;
}

function normalizeHeaderName(value: unknown): string {
  const name = byteString(value, "HTTP header name");
  if (!regExpTest(HTTP_TOKEN, name)) throw new TypeError(`Invalid HTTP header name: ${name}`);
  return stringToLowerCase(name);
}

function normalizeHeaderValue(value: unknown): string {
  const raw = byteString(value, "HTTP header value");
  const normalized = stringReplace(raw, /^[\t\n\r ]+|[\t\n\r ]+$/g, "");
  if (regExpTest(/[\0\r\n]/, normalized)) throw new TypeError("Invalid HTTP header value");
  return normalized;
}

/** Fetch's header-value get/decode/split algorithm for method override guards. */
function splitHeaderValue(value: string): string[] {
  const values: string[] = [];
  let position = 0;
  let temporary = "";
  for (;;) {
    while (position < value.length && value[position] !== '"' && value[position] !== ",") {
      temporary += value[position++]!;
    }
    if (position < value.length && value[position] === '"') {
      temporary += value[position++]!;
      for (;;) {
        while (position < value.length && value[position] !== '"' && value[position] !== "\\") {
          temporary += value[position++]!;
        }
        if (position >= value.length) break;
        const quoteOrBackslash = value[position++]!;
        temporary += quoteOrBackslash;
        if (quoteOrBackslash === "\\" && position < value.length) {
          temporary += value[position++]!;
          continue;
        }
        break;
      }
      if (position < value.length) continue;
    }
    arrayPush(values, stringReplace(temporary, /^[\t ]+|[\t ]+$/g, ""));
    temporary = "";
    if (position >= value.length) return values;
    position++;
  }
}

function guardRejects(guard: HeadersGuard, name: string, value = ""): boolean {
  if (guard === "request") {
    if (setHas(FORBIDDEN_REQUEST_NAMES, name) ||
      stringStartsWith(name, "proxy-") ||
      stringStartsWith(name, "sec-")) return true;
    if (
      name === "x-http-method" ||
      name === "x-http-method-override" ||
      name === "x-method-override"
    ) {
      for (const method of splitHeaderValue(value)) {
        if (arrayIncludes(["CONNECT", "TRACE", "TRACK"], stringToUpperCase(method))) {
          return true;
        }
      }
      return false;
    }
    return false;
  }
  return guard === "response" && setHas(FORBIDDEN_RESPONSE_NAMES, name);
}

function assertMutable(state: HeadersState): void {
  if (state.guard === "immutable") throw new TypeError("Headers are immutable");
}

function assertHeaderBudget(entries: readonly HeaderEntry[], byteLimit: number): void {
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.name.length + entry.value.length + 4;
  }
  if (entries.length > HTTP_HEADER_COUNT || bytes > byteLimit) {
    throw new NetworkError("HTTP headers exceed the SDK safety ceiling", {
      category: "runtime",
      code: "resource_limit",
      operation: "http.Headers",
      protocol: "http",
    });
  }
}

function appendHeader(
  state: HeadersState,
  nameValue: unknown,
  valueValue: unknown,
  bypassGuard = false,
): void {
  const name = normalizeHeaderName(nameValue);
  const value = normalizeHeaderValue(valueValue);
  assertMutable(state);
  if (!bypassGuard && guardRejects(state.guard, name, value)) return;
  assertHeaderBudget([...state.list, { name, value }], state.byteLimit);
  arrayPush(state.list, { name, value });
}

function snapshotIteratorResult(
  value: unknown,
  label: string,
): { readonly done: boolean; readonly value: unknown } {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} returned an invalid result`);
  }
  const result = value as IteratorResult<unknown>;
  const done = webIdlBoolean(result.done);
  return { done, value: done ? undefined : result.value };
}

function fillHeaders(
  state: HeadersState,
  init: HeadersInit | undefined,
  bypassGuard = false,
): void {
  if (init === undefined) return;
  if (init instanceof Headers) {
    for (const entry of headersState(init).list) {
      appendHeader(state, entry.name, entry.value, bypassGuard);
    }
    return;
  }
  const iterator = (init as Partial<Iterable<unknown>>)[Symbol.iterator];
  if (typeof iterator === "function") {
    const outer = reflectApply(iterator, init, []) as Iterator<unknown>;
    const outerNext = typeof outer === "object" && outer !== null
      ? outer.next
      : undefined;
    if (typeof outerNext !== "function") {
      throw new TypeError("Headers initializer iterator is invalid");
    }
    try {
      for (;;) {
        const item = snapshotIteratorResult(
          reflectApply(outerNext, outer, []),
          "Headers initializer iterator",
        );
        if (item.done) break;
        const pairValue = item.value;
        if (typeof pairValue !== "object" || pairValue === null) {
          throw new TypeError("Each Headers initializer item must be an iterable pair");
        }
        const pairMethod = (pairValue as Partial<Iterable<unknown>>)[Symbol.iterator];
        if (typeof pairMethod !== "function") {
          throw new TypeError("Each Headers initializer item must be an iterable pair");
        }
        const pairIterator = reflectApply(pairMethod, pairValue, []) as Iterator<unknown>;
        const pairNext = typeof pairIterator === "object" && pairIterator !== null
          ? pairIterator.next
          : undefined;
        if (typeof pairNext !== "function") {
          throw new TypeError("Each Headers initializer pair iterator is invalid");
        }
        const first = snapshotIteratorResult(
          reflectApply(pairNext, pairIterator, []),
          "Headers initializer pair iterator",
        );
        const second = snapshotIteratorResult(
          reflectApply(pairNext, pairIterator, []),
          "Headers initializer pair iterator",
        );
        const extra = snapshotIteratorResult(
          reflectApply(pairNext, pairIterator, []),
          "Headers initializer pair iterator",
        );
        if (first.done || second.done || !extra.done) {
          const pairReturn = pairIterator.return;
          if (typeof pairReturn === "function") {
            reflectApply(pairReturn, pairIterator, []);
          }
          throw new TypeError("Each Headers initializer item must contain exactly two values");
        }
        appendHeader(state, first.value, second.value, bypassGuard);
      }
    } catch (error) {
      try {
        const outerReturn = outer.return;
        if (typeof outerReturn === "function") reflectApply(outerReturn, outer, []);
      } catch {
        // Iterator close cannot replace the conversion failure.
      }
      throw error;
    }
    return;
  }
  if (typeof init !== "object" || init === null) {
    throw new TypeError("Headers initializer must be a record or iterable");
  }
  for (const name of objectKeys(init)) {
    appendHeader(state, name, (init as Record<string, unknown>)[name], bypassGuard);
  }
}

function sortedCombinedHeaders(state: HeadersState): HeaderEntry[] {
  const names: string[] = [];
  const seen: Record<string, true> = objectCreate(null);
  for (const entry of state.list) {
    if (seen[entry.name]) continue;
    seen[entry.name] = true;
    arrayPush(names, entry.name);
  }
  arraySort(names);
  const result: HeaderEntry[] = [];
  for (const name of names) {
    const values: string[] = [];
    for (const entry of state.list) {
      if (entry.name === name) arrayPush(values, entry.value);
    }
    if (name === "set-cookie") {
      for (const value of values) arrayPush(result, { name, value });
    } else {
      arrayPush(result, { name, value: arrayJoin(values, ", ") });
    }
  }
  return result;
}

type HeaderIteratorKind = "entry" | "key" | "value";

class HeadersIterator<T extends [string, string] | string> implements IterableIterator<T> {
  #index = 0;

  constructor(
    private readonly headers: Headers,
    private readonly kind: HeaderIteratorKind,
  ) {}

  [Symbol.iterator](): IterableIterator<T> {
    return this;
  }

  next(): IteratorResult<T> {
    const entry = sortedCombinedHeaders(headersState(this.headers))[this.#index++];
    if (!entry) return { value: undefined, done: true };
    const value = this.kind === "entry"
      ? [entry.name, entry.value]
      : this.kind === "key"
        ? entry.name
        : entry.value;
    return { value: value as T, done: false };
  }
}

function createHeaders(
  init: HeadersInit | undefined,
  guard: HeadersGuard,
  byteLimit = effectiveHttpSdkLimits().headerBytes,
): Headers {
  const headers = new Headers();
  const state = headersState(headers);
  state.byteLimit = byteLimit;
  state.guard = guard === "immutable" ? "none" : guard;
  fillHeaders(state, init);
  state.guard = guard;
  return headers;
}

function createBindingHeaders(
  entries: readonly HttpBindingHeader[],
  byteLimit: number,
): Headers {
  const headers = new Headers();
  const state = headersState(headers);
  state.byteLimit = byteLimit;
  for (const entry of entries) appendHeader(state, entry.name, entry.value, true);
  state.guard = "immutable";
  return headers;
}

function cloneHeaders(headers: Headers): Headers {
  const source = headersState(headers);
  const clone = new Headers();
  const target = headersState(clone);
  target.byteLimit = source.byteLimit;
  for (const entry of source.list) {
    arrayPush(target.list, { name: entry.name, value: entry.value });
  }
  target.guard = source.guard;
  return clone;
}

function bindingHeaders(headers: Headers): readonly HttpBindingHeader[] {
  const source = headersState(headers).list;
  const output = new Array<HttpBindingHeader>(source.length);
  for (let index = 0; index < source.length; index++) {
    const entry = source[index]!;
    output[index] = objectFreeze({ name: entry.name, value: entry.value });
  }
  return objectFreeze(output);
}

export class Headers implements Iterable<[string, string]> {
  constructor(init: HeadersInit | undefined = undefined) {
    const state: HeadersState = {
      guard: "none",
      list: [],
      byteLimit: effectiveHttpSdkLimits().headerBytes,
    };
    headerStates.set(this, state);
    fillHeaders(state, init);
  }

  append(name: string, value: string): void {
    appendHeader(headersState(this), name, value);
  }

  delete(nameValue: string): void {
    const state = headersState(this);
    const name = normalizeHeaderName(nameValue);
    assertMutable(state);
    if (guardRejects(state.guard, name)) return;
    for (let index = state.list.length - 1; index >= 0; index--) {
      if (state.list[index]!.name === name) arraySplice(state.list, index, 1);
    }
  }

  get(nameValue: string): string | null {
    const state = headersState(this);
    const name = normalizeHeaderName(nameValue);
    const values: string[] = [];
    for (const entry of state.list) {
      if (entry.name === name) arrayPush(values, entry.value);
    }
    return values.length === 0 ? null : arrayJoin(values, ", ");
  }

  has(nameValue: string): boolean {
    const state = headersState(this);
    const name = normalizeHeaderName(nameValue);
    for (const entry of state.list) {
      if (entry.name === name) return true;
    }
    return false;
  }

  set(nameValue: string, valueValue: string): void {
    const state = headersState(this);
    const name = normalizeHeaderName(nameValue);
    const value = normalizeHeaderValue(valueValue);
    assertMutable(state);
    if (guardRejects(state.guard, name, value)) return;
    const next: HeaderEntry[] = [];
    let inserted = false;
    for (const entry of state.list) {
      if (entry.name !== name) arrayPush(next, entry);
      else if (!inserted) {
        arrayPush(next, { name, value });
        inserted = true;
      }
    }
    if (!inserted) arrayPush(next, { name, value });
    assertHeaderBudget(next, state.byteLimit);
    arraySplice(state.list, 0, state.list.length, ...next);
  }

  entries(): IterableIterator<[string, string]> {
    headersState(this);
    return new HeadersIterator<[string, string]>(this, "entry");
  }

  keys(): IterableIterator<string> {
    headersState(this);
    return new HeadersIterator<string>(this, "key");
  }

  values(): IterableIterator<string> {
    headersState(this);
    return new HeadersIterator<string>(this, "value");
  }

  forEach(
    callback: (value: string, key: string, headers: Headers) => void,
    thisArg?: unknown,
  ): void {
    headersState(this);
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    for (const [name, value] of this.entries()) {
      reflectApply(callback, thisArg, [value, name, this]);
    }
  }

  getSetCookie(): string[] {
    const values: string[] = [];
    for (const entry of headersState(this).list) {
      if (entry.name === "set-cookie") arrayPush(values, entry.value);
    }
    return values;
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }
}

interface RequestExtensions {
  readonly timeouts?: Readonly<HttpTimeouts>;
  readonly maxRedirects: number;
  readonly tls?: TlsOptions;
  readonly limits?: NetworkLimitOverrides;
  readonly ref: boolean;
}

interface RequestState extends RequestExtensions {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: BodyController | null;
  readonly signal: AbortSignal;
  readonly detachSignal: () => void;
  readonly redirect: RequestRedirect;
}

interface ResponseState {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: BodyController | null;
  readonly url: string;
  readonly redirected: boolean;
}

const requestStates = new WeakMap<Request, RequestState>();
const responseStates = new WeakMap<Response, ResponseState>();
const HTTP_LIMIT_OVERRIDE_COUNT = 32;
const HTTP_LIMIT_NAME_BYTES = 64;
const HTTP_TLS_CA_BYTES = 64 * 1024;
const HTTP_TLS_ALPN_COUNT = 16;
const HTTP_TLS_ALPN_BYTES = 1024;
const HTTP_TLS_SERVER_NAME_BYTES = 253;
const HTTP_TLS_CREDENTIAL_ID_BYTES = 128;
interface RequestInitSnapshot {
  readonly body: BodyInit | undefined;
  readonly headers: HeadersInit | undefined;
  readonly limits: NetworkLimitOverrides | undefined;
  readonly maxRedirects: number | undefined;
  readonly method: string | undefined;
  readonly redirect: RequestRedirect | undefined;
  readonly ref: boolean | undefined;
  readonly signal: AbortSignal | undefined;
  readonly timeouts: HttpTimeouts | undefined;
  readonly tls: TlsOptions | undefined;
}

interface ResponseInitSnapshot {
  readonly headers: HeadersInit | undefined;
  readonly status: unknown;
  readonly statusText: unknown;
}

/** WebIDL dictionaries read every recognized member exactly once, in order. */
function snapshotRequestInit(init: RequestInit | null | undefined): RequestInitSnapshot {
  if (init === undefined || init === null) {
    return {
      body: undefined,
      headers: undefined,
      limits: undefined,
      maxRedirects: undefined,
      method: undefined,
      redirect: undefined,
      ref: undefined,
      signal: undefined,
      timeouts: undefined,
      tls: undefined,
    };
  }
  const dictionary = Object(init) as RequestInit;
  return {
    body: dictionary.body,
    headers: dictionary.headers,
    limits: dictionary.limits,
    maxRedirects: dictionary.maxRedirects,
    method: dictionary.method,
    redirect: dictionary.redirect,
    ref: dictionary.ref,
    signal: dictionary.signal,
    timeouts: dictionary.timeouts,
    tls: dictionary.tls,
  };
}

function snapshotResponseInit(init: ResponseInit | null | undefined): ResponseInitSnapshot {
  if (init === undefined || init === null) {
    return { headers: undefined, status: undefined, statusText: undefined };
  }
  const dictionary = Object(init) as ResponseInit;
  return {
    headers: dictionary.headers,
    status: dictionary.status,
    statusText: dictionary.statusText,
  };
}

function requestState(request: Request): RequestState {
  const state = requestStates.get(request);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}

function responseState(response: Response): ResponseState {
  const state = responseStates.get(response);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}

function runtimeError(
  code: "aborted" | "invalid_state" | "resource_limit" | "unsupported" | "system_error",
  operation: string,
  message: string,
): NetworkError {
  return new NetworkError(message, {
    category: "runtime",
    code,
    operation,
    protocol: "http",
  });
}

function normalizeMethod(value: unknown): string {
  const method = byteString(value, "HTTP method");
  if (!regExpTest(HTTP_TOKEN, method)) throw new TypeError(`Invalid HTTP method: ${method}`);
  const upper = stringToUpperCase(method);
  if (upper === "CONNECT" || upper === "TRACE" || upper === "TRACK") {
    throw new TypeError(`Forbidden HTTP method: ${upper}`);
  }
  return setHas(NORMALIZED_METHODS, upper)
    ? upper
    : method;
}

function normalizeRedirect(value: unknown): RequestRedirect {
  const mode = webIdlString(value);
  if (mode === "follow" || mode === "manual" || mode === "error") return mode;
  throw new TypeError(`Invalid HTTP redirect mode: ${mode}`);
}

function normalizeTimeouts(value: HttpTimeouts | undefined): Readonly<HttpTimeouts> | undefined {
  if (value === undefined) return undefined;
  if (value === null) return objectFreeze({});
  const dictionary = Object(value) as HttpTimeouts;
  const snapshot = {
    connect: dictionary.connect,
    headers: dictionary.headers,
    idle: dictionary.idle,
    total: dictionary.total,
  };
  const output: Record<string, number> = {};
  for (const key of ["connect", "headers", "idle", "total"] as const) {
    const timeout = snapshot[key];
    if (timeout === undefined) continue;
    if (!numberIsSafeInteger(timeout) || timeout <= 0) {
      throw new TypeError(`HTTP ${key} timeout must be a positive safe integer`);
    }
    output[key] = timeout;
  }
  return objectFreeze(output);
}

function normalizeMaxRedirects(value: number | undefined): number {
  const result = value ?? 5;
  if (!numberIsSafeInteger(result) || result < 0 || result > 5) {
    throw new TypeError("HTTP maxRedirects must be an integer from 0 through 5");
  }
  return result;
}

function normalizeLimits(
  limits: NetworkLimitOverrides | undefined,
  binding: HttpClientPrivateBinding | undefined,
): NetworkLimitOverrides | undefined {
  if (limits === undefined) return undefined;
  if (typeof limits !== "object" || limits === null) {
    throw new TypeError("HTTP limits must be an object");
  }
  const output: Record<string, number> = objectCreate(null);
  let count = 0;
  for (const key of objectKeys(limits)) {
    count++;
    if (count > HTTP_LIMIT_OVERRIDE_COUNT) {
      throw new TypeError(`HTTP limits cannot exceed ${HTTP_LIMIT_OVERRIDE_COUNT} entries`);
    }
    if (
      key.length === 0 ||
      key.length > HTTP_LIMIT_NAME_BYTES ||
      !regExpTest(/^[A-Za-z][A-Za-z0-9._-]*$/, key)
    ) {
      throw new TypeError("HTTP limit name is invalid or exceeds the safety ceiling");
    }
    const value = limits[key];
    if (!numberIsSafeInteger(value) || value <= 0) {
      throw new TypeError(`HTTP limit ${key} must be a positive safe integer`);
    }
    if (binding) {
      let admitted: Readonly<{
        name: string;
        default: number;
        minimum: number;
      }> | undefined;
      const values = binding.httpClientLimits.values;
      for (let index = 0; index < values.length; index++) {
        if (values[index]!.name === key) {
          admitted = values[index]!;
          break;
        }
      }
      if (!admitted || value < admitted.minimum || value > admitted.default) {
        throw new TypeError(
          `HTTP limit ${key} is outside its admitted minimum/default range`,
        );
      }
    }
    output[key] = value;
  }
  return objectFreeze(output);
}

function normalizeTls(tls: TlsOptions | undefined): TlsOptions | undefined {
  if (tls === undefined) return undefined;
  if (tls === null) return objectFreeze({});
  const dictionary = Object(tls) as TlsOptions;
  const snapshot = {
    alpn: dictionary.alpn,
    ca: dictionary.ca,
    clientCertificate: dictionary.clientCertificate,
    credential: dictionary.credential,
    maxVersion: dictionary.maxVersion,
    minVersion: dictionary.minVersion,
    revocation: dictionary.revocation,
    serverName: dictionary.serverName,
    verification: dictionary.verification,
  };
  const minVersion = snapshot.minVersion;
  const maxVersion = snapshot.maxVersion;
  if (minVersion !== undefined && minVersion !== "1.2" && minVersion !== "1.3") {
    throw new TypeError("Invalid TLS minimum version");
  }
  if (maxVersion !== undefined && maxVersion !== "1.2" && maxVersion !== "1.3") {
    throw new TypeError("Invalid TLS maximum version");
  }
  if (minVersion === "1.3" && maxVersion === "1.2") {
    throw new TypeError("TLS minimum version exceeds maximum version");
  }
  let ca: Uint8Array | undefined;
  if (snapshot.ca !== undefined) {
    // Capture the intrinsic typed-array slots once; own accessors and custom
    // iterators cannot under-report the trust material's real size.
    try {
      ca = snapshotUint8Array(snapshot.ca, HTTP_TLS_CA_BYTES, "TLS custom CA");
    } catch (error) {
      if (error instanceof NetworkError && error.code === "resource_limit") {
        throw new TypeError(`TLS custom CA exceeds ${HTTP_TLS_CA_BYTES} bytes`);
      }
      throw error;
    }
  }
  if (
    snapshot.clientCertificate !== undefined &&
    snapshot.clientCertificate !== "none" &&
    snapshot.clientCertificate !== "optional" &&
    snapshot.clientCertificate !== "required"
  ) {
    throw new TypeError("Invalid TLS client certificate policy");
  }
  if (
    snapshot.verification !== undefined &&
    snapshot.verification !== "full" &&
    snapshot.verification !== "development-insecure"
  ) {
    throw new TypeError("Invalid TLS verification policy");
  }
  if (
    snapshot.revocation !== undefined &&
    snapshot.revocation !== "host-default" &&
    snapshot.revocation !== "required"
  ) {
    throw new TypeError("Invalid TLS revocation policy");
  }
  let alpn: string[] | undefined;
  if (snapshot.alpn !== undefined) {
    alpn = [];
    let totalBytes = 0;
    for (const token of snapshot.alpn) {
      if (alpn.length >= HTTP_TLS_ALPN_COUNT) {
        throw new TypeError(`TLS ALPN cannot exceed ${HTTP_TLS_ALPN_COUNT} tokens`);
      }
      const value = byteString(token, "TLS ALPN token");
      if (value.length === 0 || value.length > 255 || regExpTest(/[\0]/, value)) {
        throw new TypeError("Invalid TLS ALPN token");
      }
      totalBytes += value.length;
      if (totalBytes > HTTP_TLS_ALPN_BYTES) {
        throw new TypeError(`TLS ALPN exceeds ${HTTP_TLS_ALPN_BYTES} bytes`);
      }
      arrayPush(alpn, value);
    }
  }
  if (alpn && new Set(alpn).size !== alpn.length) {
    throw new TypeError("TLS ALPN tokens must be unique");
  }
  const serverName = snapshot.serverName === undefined
    ? undefined
    : byteString(snapshot.serverName, "TLS serverName");
  if (
    serverName !== undefined &&
    (serverName.length === 0 || serverName.length > HTTP_TLS_SERVER_NAME_BYTES)
  ) throw new TypeError("TLS serverName is empty or exceeds the safety ceiling");
  const credential = snapshot.credential === undefined
    ? undefined
    : byteString(snapshot.credential, "TLS credential id");
  if (
    credential !== undefined &&
    (credential.length === 0 ||
      credential.length > HTTP_TLS_CREDENTIAL_ID_BYTES ||
      !regExpTest(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, credential))
  ) throw new TypeError("TLS credential id is empty or exceeds the safety ceiling");
  return objectFreeze({
    ...(serverName === undefined ? {} : { serverName }),
    ...(minVersion === undefined ? {} : { minVersion }),
    ...(maxVersion === undefined ? {} : { maxVersion }),
    ...(alpn === undefined ? {} : { alpn: objectFreeze(alpn) }),
    ...(ca === undefined ? {} : { ca }),
    ...(credential === undefined ? {} : { credential }),
    ...(snapshot.clientCertificate === undefined
      ? {}
      : { clientCertificate: snapshot.clientCertificate }),
    ...(snapshot.verification === undefined
      ? {}
      : { verification: snapshot.verification }),
    ...(snapshot.revocation === undefined ? {} : { revocation: snapshot.revocation }),
  });
}

function requestExtensions(
  init: RequestInitSnapshot,
  inherited?: RequestState,
  binding: HttpClientPrivateBinding | undefined = getHttpClientBinding(),
): RequestExtensions {
  return {
    timeouts: init.timeouts === undefined
      ? inherited?.timeouts
      : normalizeTimeouts(init.timeouts),
    maxRedirects: init.maxRedirects === undefined
      ? inherited?.maxRedirects ?? 5
      : normalizeMaxRedirects(init.maxRedirects),
    tls: init.tls === undefined ? inherited?.tls : normalizeTls(init.tls),
    limits: init.limits === undefined
      ? inherited?.limits
      : normalizeLimits(init.limits, binding),
    ref: init.ref === undefined ? inherited?.ref ?? true : webIdlBoolean(init.ref),
  };
}

type ParsedAbsoluteUrl = CanonicalHttpUrl;

function parseAbsoluteUrl(input: string | URL): CanonicalHttpUrl {
  const source = input instanceof URL ? input.href : new URL(webIdlString(input)).href;
  if (source.length > 8192) {
    throw runtimeError(
      "resource_limit",
      "http.Request",
      "HTTP URL exceeds the 8192-byte SDK safety ceiling",
    );
  }
  return canonicalizeHttpUrl(source);
}

function newRequestFromState(state: RequestState): Request {
  const request = objectCreate(Request.prototype) as Request;
  requestStates.set(request, state);
  return request;
}

export class Request {
  constructor(
    input: string | URL | Request,
    init: RequestInit | null | undefined = undefined,
  ) {
    const binding = getHttpClientBinding();
    const sdkLimits = effectiveHttpSdkLimits(binding);
    const snapshot = snapshotRequestInit(init);
    const inherited = input instanceof Request ? requestState(input) : undefined;
    const method = normalizeMethod(snapshot.method ?? inherited?.method ?? "GET");
    const parsedInput = inherited === undefined
      ? parseAbsoluteUrl(input as string | URL)
      : undefined;
    const url = inherited?.url ?? `${parsedInput!.href}${parsedInput!.fragment}`;
    const redirect = normalizeRedirect(snapshot.redirect ?? inherited?.redirect ?? "follow");
    const sourceSignal = snapshot.signal ?? inherited?.signal;
    if (sourceSignal !== undefined && !(sourceSignal instanceof AbortSignal)) {
      throw new TypeError("HTTP Request signal must be a PocketJS AbortSignal");
    }
    const headers = snapshot.headers === undefined
      ? createHeaders(inherited?.headers, "request", sdkLimits.headerBytes)
      : createHeaders(snapshot.headers, "request", sdkLimits.headerBytes);
    const extensions = requestExtensions(snapshot, inherited, binding);

    // Fetch treats a null RequestInit body like no override; it does not erase
    // an input Request's body.
    const hasExplicitBody = snapshot.body !== undefined && snapshot.body !== null;
    const wouldHaveBody = hasExplicitBody || inherited?.body !== null &&
      inherited?.body !== undefined;
    if ((method === "GET" || method === "HEAD") && wouldHaveBody) {
      throw new TypeError(`${method} Request cannot have a body`);
    }
    let body: BodyController | null = null;
    let contentType: string | undefined;
    if (hasExplicitBody) {
      const extracted = extractBody(snapshot.body!, sdkLimits.body);
      body = extracted.controller;
      contentType = extracted.contentType;
    } else if (!hasExplicitBody && inherited?.body) {
      body = inherited.body.transfer();
    }
    if (contentType !== undefined && !hasNormalizedHeader(headers, "content-type")) {
      appendHeader(headersState(headers), "content-type", contentType);
    }
    const signalDependency = createDependentAbortSignal(sourceSignal);
    requestStates.set(this, {
      method,
      url,
      headers,
      body,
      signal: signalDependency.signal,
      detachSignal: signalDependency.detach,
      redirect,
      ...extensions,
    });
  }

  get method(): string {
    return requestState(this).method;
  }

  get url(): string {
    return requestState(this).url;
  }

  get headers(): Headers {
    return requestState(this).headers;
  }

  get body(): HttpBodyStream | null {
    return requestState(this).body?.stream ?? null;
  }

  get bodyUsed(): boolean {
    return requestState(this).body?.bodyUsed ?? false;
  }

  get signal(): AbortSignal {
    return requestState(this).signal;
  }

  get redirect(): RequestRedirect {
    return requestState(this).redirect;
  }

  clone(): Request {
    const state = requestState(this);
    const signalDependency = createDependentAbortSignal(state.signal);
    try {
      const cloneBody = state.body?.tee() ?? null;
      return newRequestFromState({
        ...state,
        headers: cloneHeaders(state.headers),
        body: cloneBody,
        signal: signalDependency.signal,
        detachSignal: signalDependency.detach,
      });
    } catch (error) {
      signalDependency.detach();
      throw error;
    }
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return consumeArrayBuffer(requestState(this).body, "http.Request.arrayBuffer");
  }

  text(): Promise<string> {
    return consumeText(requestState(this).body, "http.Request.text");
  }

  json(): Promise<unknown> {
    return consumeJson(requestState(this).body, "http.Request.json");
  }
}

function toUnsignedShort(value: unknown): number {
  const number = webIdlNumber(value);
  if (!numberIsFinite(number) || number === 0) return 0;
  const integer = mathTrunc(number);
  return ((integer % 0x1_0000) + 0x1_0000) % 0x1_0000;
}

function normalizeStatus(value: unknown): number {
  const status = value === undefined ? 200 : toUnsignedShort(value);
  if (status < 200 || status > 599) {
    throw new RangeError("HTTP Response status must be from 200 through 599");
  }
  return status;
}

function normalizeStatusText(value: unknown): string {
  if (value === undefined) return "";
  const text = byteString(value, "HTTP statusText");
  if (regExpTest(/[\0\r\n]/, text)) throw new TypeError("Invalid HTTP statusText");
  for (let index = 0; index < text.length; index++) {
    const code = stringCharCodeAt(text, index);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      throw new TypeError("Invalid HTTP statusText");
    }
  }
  return text;
}

function newResponseFromState(state: ResponseState): Response {
  const response = objectCreate(Response.prototype) as Response;
  responseStates.set(response, state);
  return response;
}

export class Response {
  constructor(body: BodyInit = null, init: ResponseInit | null = {}) {
    const sdkLimits = effectiveHttpSdkLimits();
    const snapshot = snapshotResponseInit(init);
    const status = normalizeStatus(snapshot.status);
    const statusText = normalizeStatusText(snapshot.statusText);
    const headers = createHeaders(snapshot.headers, "response", sdkLimits.headerBytes);
    let controller: BodyController | null = null;
    if (body !== null) {
      if (status === 204 || status === 205 || status === 304) {
        throw new TypeError(`HTTP status ${status} cannot have a body`);
      }
      const extracted = extractBody(body, sdkLimits.body);
      controller = extracted.controller;
      if (extracted.contentType !== undefined &&
        !hasNormalizedHeader(headers, "content-type")) {
        appendHeader(headersState(headers), "content-type", extracted.contentType);
      }
    }
    responseStates.set(this, {
      status,
      statusText,
      headers,
      body: controller,
      url: "",
      redirected: false,
    });
  }

  get status(): number {
    return responseState(this).status;
  }

  get statusText(): string {
    return responseState(this).statusText;
  }

  get ok(): boolean {
    const status = responseState(this).status;
    return status >= 200 && status <= 299;
  }

  get headers(): Headers {
    return responseState(this).headers;
  }

  get body(): HttpBodyStream | null {
    return responseState(this).body?.stream ?? null;
  }

  get bodyUsed(): boolean {
    return responseState(this).body?.bodyUsed ?? false;
  }

  get url(): string {
    return responseState(this).url;
  }

  get redirected(): boolean {
    return responseState(this).redirected;
  }

  clone(): Response {
    const state = responseState(this);
    const cloneBody = state.body?.tee() ?? null;
    return newResponseFromState({
      ...state,
      headers: cloneHeaders(state.headers),
      body: cloneBody,
    });
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return consumeArrayBuffer(responseState(this).body, "http.Response.arrayBuffer");
  }

  text(): Promise<string> {
    return consumeText(responseState(this).body, "http.Response.text");
  }

  json(): Promise<unknown> {
    return consumeJson(responseState(this).body, "http.Response.json");
  }

  static json(data: unknown, init: ResponseInit | null = {}): Response {
    const serialized = jsonStringify(data);
    if (serialized === undefined) {
      throw new TypeError("Response.json data is not JSON serializable");
    }
    const snapshot = snapshotResponseInit(init);
    const headers = new Headers(snapshot.headers);
    if (!hasNormalizedHeader(headers, "content-type")) {
      appendHeader(headersState(headers), "content-type", "application/json");
    }
    return new Response(serialized, {
      headers,
      status: snapshot.status as number | undefined,
      statusText: snapshot.statusText as string | undefined,
    });
  }

  static redirect(url: string | URL, status: number = 302): Response {
    const convertedStatus = toUnsignedShort(status);
    if (!setHas(REDIRECT_STATUSES, convertedStatus)) {
      throw new RangeError("Invalid HTTP redirect status");
    }
    const parsed = parseAbsoluteUrl(url);
    const sdkLimits = effectiveHttpSdkLimits();
    return newResponseFromState({
      status: convertedStatus,
      statusText: "",
      headers: createBindingHeaders([
        { name: "location", value: `${parsed.href}${parsed.fragment}` },
      ], sdkLimits.headerBytes),
      body: null,
      url: "",
      redirected: false,
    });
  }
}

async function consumeBytes(
  body: BodyController | null,
  operation: string,
): Promise<Uint8Array> {
  return body ? body.aggregate(operation) : new Uint8Array();
}

async function consumeArrayBuffer(
  body: BodyController | null,
  operation: string,
): Promise<ArrayBuffer> {
  return ownedUint8ArrayBuffer(await consumeBytes(body, operation));
}

async function consumeText(
  body: BodyController | null,
  operation: string,
): Promise<string> {
  const decoded = decodeUtf8(
    await consumeBytes(body, operation),
    HTTP_BODY_HELPER_BYTES,
  );
  if (decoded === null) {
    throw runtimeError(
      "resource_limit",
      operation,
      `Buffered HTTP body exceeds ${HTTP_BODY_HELPER_BYTES} bytes`,
    );
  }
  return decoded;
}

async function consumeJson(
  body: BodyController | null,
  operation: string,
): Promise<unknown> {
  return JSON.parse(await consumeText(body, operation));
}

export interface HttpServerStopOptions {
  readonly graceful?: boolean;
  readonly timeout?: number;
}

export interface HttpServer {
  readonly address: import("./index.ts").NetworkAddress;
  stop(options?: HttpServerStopOptions): Promise<void>;
  ref(): this;
  unref(): this;
}

export type HttpFetchResult = Response | WebSocketUpgrade;

export interface HttpServeOptions {
  readonly hostname?: string;
  readonly port: number;
  readonly tls?: TlsOptions;
  readonly limits?: NetworkLimitOverrides;
  readonly ref?: boolean;
  readonly fetch: (
    request: Request,
    server: HttpServer,
  ) => HttpFetchResult | Promise<HttpFetchResult>;
  readonly error?: (error: unknown) => Response | Promise<Response>;
}

let nextOperationId = 1;

function allocateOperationId(): number {
  if (nextOperationId > 0xffff_ffff) {
    throw runtimeError(
      "resource_limit",
      "http.fetch",
      "HTTP operation id space is exhausted for this runtime",
    );
  }
  const result = nextOperationId;
  nextOperationId++;
  return result;
}

function validateFetchUrl(url: string): ParsedAbsoluteUrl {
  let parsed: ParsedAbsoluteUrl;
  try {
    parsed = parseAbsoluteUrl(url);
  } catch {
    throw runtimeError(
      "invalid_state",
      "http.fetch",
      "HTTP fetch URL is malformed",
    );
  }
  if (parsed.scheme !== "http" && parsed.scheme !== "https") {
    throw runtimeError(
      "unsupported",
      "http.fetch",
      "HTTP fetch supports only absolute http: and https: URLs",
    );
  }
  if (`${parsed.href}${parsed.fragment}` !== url) {
    throw runtimeError(
      "invalid_state",
      "http.fetch",
      "HTTP fetch URL must be canonical",
    );
  }
  return parsed;
}

function abortError(): NetworkError {
  return runtimeError("aborted", "http.fetch", "HTTP request was aborted");
}

function unsupportedOption(message: string): never {
  throw runtimeError("unsupported", "http.fetch", message);
}

function requireFeature(
  binding: HttpClientPrivateBinding,
  feature: string,
  option: string,
): void {
  if (!arrayIncludes(binding.featureSet, feature)) {
    unsupportedOption(`${option} requires ${feature}`);
  }
}

function normalizeHostnameForComparison(hostname: string): string {
  return stringReplace(stringToLowerCase(hostname), /\.$/, "");
}

function preflightBindingFeatures(
  binding: HttpClientPrivateBinding,
  state: RequestState,
  parsed: ParsedAbsoluteUrl,
): void {
  requireFeature(binding, "network.http.client", "HTTP fetch");
  if (parsed.scheme === "http") {
    if (state.tls !== undefined) unsupportedOption("TLS options are invalid for plaintext HTTP");
    return;
  }

  requireFeature(binding, "network.http.client.tls", "HTTPS fetch");
  const tls = state.tls;
  if (!tls) return;
  if (tls.ca !== undefined) {
    requireFeature(
      binding,
      "network.http.client.tls.custom-ca",
      "TLS custom CA",
    );
  }
  if (tls.credential !== undefined) {
    requireFeature(
      binding,
      "network.http.client.tls.client-auth",
      "TLS client credential",
    );
  }
  if (tls.clientCertificate !== undefined) {
    unsupportedOption("TLS clientCertificate is a server-only option");
  }
  if (tls.alpn !== undefined) {
    requireFeature(binding, "network.http.client.tls.alpn", "TLS ALPN");
    if (!binding.alpnProtocols) {
      unsupportedOption("TLS ALPN token is not supported by the admitted provider");
    }
    for (const token of tls.alpn) {
      if (!arrayIncludes(binding.alpnProtocols, token)) {
        unsupportedOption("TLS ALPN token is not supported by the admitted provider");
      }
    }
  }
  if (tls.minVersion === "1.3") {
    requireFeature(binding, "network.http.client.tls.v1-3", "TLS 1.3 minimum");
  }
  if (tls.revocation === "required") {
    requireFeature(
      binding,
      "network.http.client.tls.revocation",
      "required TLS revocation",
    );
  }
  if (tls.verification === "development-insecure") {
    unsupportedOption(
      "development-insecure TLS verification requires Host development policy",
    );
  }
  if (
    tls.serverName !== undefined &&
    normalizeHostnameForComparison(tls.serverName) !==
      normalizeHostnameForComparison(parsed.hostname)
  ) {
    unsupportedOption("TLS serverName must equal the authorized URL hostname");
  }
}

const NETWORK_ERROR_CATEGORIES = new Set([
  "runtime",
  "resolver",
  "transport",
  "tls",
  "protocol",
]);
const HTTP_ERROR_CODES_BY_CATEGORY = objectFreeze({
  runtime: new Set([
    "aborted",
    "timed_out",
    "closed",
    "invalid_state",
    "busy",
    "resource_limit",
    "unsupported",
    "permission_denied",
    "system_error",
  ]),
  resolver: new Set(["dns_not_found", "dns_temporary_failure", "dns_refused"]),
  transport: new Set([
    "connection_refused",
    "connection_reset",
    "network_unreachable",
    "address_in_use",
    "broken_pipe",
  ]),
  tls: new Set([
    "tls_certificate_invalid",
    "tls_hostname_mismatch",
    "tls_handshake_failed",
    "tls_version_unsupported",
    "tls_alert",
  ]),
  protocol: new Set(["http_protocol_error", "message_too_large"]),
});

function isHttpCategoryCode(category: unknown, code: unknown): category is
  import("./index.ts").NetworkErrorCategory {
  return typeof category === "string" &&
    typeof code === "string" &&
    setHas(NETWORK_ERROR_CATEGORIES, category) &&
    setHas(
      HTTP_ERROR_CODES_BY_CATEGORY[
        category as keyof typeof HTTP_ERROR_CODES_BY_CATEGORY
      ],
      code,
    );
}

function bindingProtocolError(message: string): NetworkError {
  return new NetworkError(message, {
    category: "protocol",
    code: "http_protocol_error",
    operation: "http.fetch",
    protocol: "http",
  });
}

function safeCauseCode(value: unknown): value is string {
  return typeof value === "string" && regExpTest(/^[A-Za-z0-9_.:-]{1,64}$/, value);
}

function normalizeBindingAddress(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 253) {
    throw new TypeError("Invalid binding error address");
  }
  const authority = stringIncludes(value, ":") && !stringStartsWith(value, "[")
    ? `[${value}]`
    : value;
  const parsed = canonicalizeHttpUrl(`http://${authority}/`);
  return parsed.hostname;
}

function safeReasonCode(value: unknown): value is number {
  return numberIsInteger(value) && (value as number) >= 0 &&
    (value as number) <= 0xffff_ffff;
}

function publicBindingMessage(code: string): string {
  return `HTTP request failed with ${code}`;
}

function normalizeBindingError(error: unknown, operationId?: number): NetworkError {
  if (error instanceof NetworkError) {
    const snapshot = {
      address: error.address,
      category: error.category,
      causeCode: error.causeCode,
      code: error.code,
      operation: error.operation,
      port: error.port,
      protocol: error.protocol,
      reasonCode: error.reasonCode,
      temporary: error.temporary,
    };
    let address: string | undefined;
    try {
      address = normalizeBindingAddress(snapshot.address);
    } catch {
      return bindingProtocolError("Invalid NetworkError from private binding");
    }
    if (!(isHttpCategoryCode(snapshot.category, snapshot.code) &&
        typeof snapshot.operation === "string" &&
        snapshot.operation.length <= 64 &&
        typeof snapshot.temporary === "boolean" &&
        (snapshot.protocol === undefined || snapshot.protocol === "http") &&
        (snapshot.port === undefined ||
          (numberIsInteger(snapshot.port) && snapshot.port >= 1 && snapshot.port <= 65_535)) &&
        !(snapshot.port !== undefined && address === undefined) &&
        (snapshot.causeCode === undefined || safeCauseCode(snapshot.causeCode)) &&
        (snapshot.reasonCode === undefined || safeReasonCode(snapshot.reasonCode)))) {
      return bindingProtocolError("Invalid NetworkError from private binding");
    }
    return new NetworkError(publicBindingMessage(snapshot.code as string), {
      category: snapshot.category,
      code: snapshot.code,
      operation: "http.fetch",
      temporary: snapshot.temporary,
      address,
      port: snapshot.port,
      protocol: "http",
      causeCode: snapshot.causeCode,
      reasonCode: snapshot.reasonCode,
    });
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<HttpRequestErrorEvent>;
    const snapshot = {
      eventCode: candidate.eventCode,
      operationId: candidate.operationId,
      category: candidate.category,
      code: candidate.code,
      message: candidate.message,
      temporary: candidate.temporary,
      causeCode: candidate.causeCode,
      reasonCode: candidate.reasonCode,
    };
    if (snapshot.eventCode !== NetworkV1EventCode.HttpRequestError) {
      return new NetworkError("PocketJS HTTP binding failed", {
        category: "runtime",
        code: "system_error",
        operation: "http.fetch",
        protocol: "http",
      });
    }
    if (
      snapshot.operationId !== operationId ||
      !isHttpCategoryCode(snapshot.category, snapshot.code) ||
      typeof snapshot.message !== "string" ||
      (snapshot.temporary !== undefined && typeof snapshot.temporary !== "boolean") ||
      (snapshot.causeCode !== undefined && !safeCauseCode(snapshot.causeCode)) ||
      (snapshot.reasonCode !== undefined && !safeReasonCode(snapshot.reasonCode))
    ) {
      return bindingProtocolError("Invalid HTTP error event from private binding");
    }
    return new NetworkError(publicBindingMessage(snapshot.code as string), {
      category: snapshot.category,
      code: snapshot.code as import("./index.ts").NetworkErrorCode,
      operation: "http.fetch",
      temporary: snapshot.temporary,
      protocol: "http",
      causeCode: snapshot.causeCode,
      reasonCode: snapshot.reasonCode,
    });
  }
  return new NetworkError("PocketJS HTTP binding failed", {
    category: "runtime",
    code: "system_error",
    operation: "http.fetch",
    protocol: "http",
    causeCode: error instanceof Error ? "binding_exception" : undefined,
  });
}

function snapshotResponseEvent(value: unknown): HttpResponseHeadersEvent {
  if (typeof value !== "object" || value === null) {
    throw bindingProtocolError("Invalid HTTP response event from private binding");
  }
  const event = value as Partial<HttpResponseHeadersEvent>;
  // Body is read last: if any earlier metadata getter fails, no response body
  // has been acquired and therefore none can be stranded by cleanup.
  const eventCode = event.eventCode;
  const operationId = event.operationId;
  const status = event.status;
  const statusText = event.statusText;
  const headersValue = event.headers;
  const url = event.url;
  const redirected = event.redirected;
  const bufferedBodyBytes = event.bufferedBodyBytes;
  if (!arrayIsArray(headersValue)) {
    throw bindingProtocolError("Invalid HTTP response headers from private binding");
  }
  const headerArray = headersValue as readonly HttpBindingHeader[];
  const headerCount = headerArray.length;
  if (!numberIsSafeInteger(headerCount) || headerCount > HTTP_HEADER_COUNT) {
    throw bindingProtocolError("Invalid HTTP response headers from private binding");
  }
  const headers: HttpBindingHeader[] = [];
  for (let index = 0; index < headerCount; index++) {
    const entry = headerArray[index];
    if (typeof entry !== "object" || entry === null) {
      throw bindingProtocolError("Invalid HTTP response header from private binding");
    }
    const name = entry.name;
    const headerValue = entry.value;
    if (typeof name !== "string" || typeof headerValue !== "string") {
      throw bindingProtocolError("HTTP binding headers must contain strings");
    }
    headers[headers.length] = objectFreeze({ name, value: headerValue });
  }
  const body = event.body;
  return objectFreeze({
    eventCode: eventCode as NetworkV1EventCode.HttpResponseHeaders,
    operationId: operationId as number,
    status: status as number,
    statusText: statusText as string,
    headers: objectFreeze(headers),
    url: url as string,
    redirected: redirected as boolean,
    ...(body === undefined ? {} : { body }),
    ...(bufferedBodyBytes === undefined ? {} : { bufferedBodyBytes }),
  });
}

function validateResponseEvent(
  event: HttpResponseHeadersEvent,
  operationId: number,
  requestMethod: string,
  sdkLimits: Readonly<EffectiveHttpSdkLimits>,
): void {
  if (
    event.eventCode !== NetworkV1EventCode.HttpResponseHeaders ||
    event.operationId !== operationId ||
    !numberIsInteger(event.status) ||
    event.status < 200 ||
    event.status > 599 ||
    typeof event.statusText !== "string" ||
    !arrayIsArray(event.headers) ||
    typeof event.url !== "string" ||
    typeof event.redirected !== "boolean"
  ) {
    throw new NetworkError("Invalid HTTP response event from private binding", {
      category: "protocol",
      code: "http_protocol_error",
      operation: "http.fetch",
      protocol: "http",
    });
  }
  if (
    event.body !== undefined &&
    event.body !== null &&
    (requestMethod === "HEAD" ||
      event.status === 204 ||
      event.status === 205 ||
      event.status === 304)
  ) {
    throw bindingProtocolError(
      "HTTP response event carries a body forbidden by its method or status",
    );
  }
  try {
    normalizeStatusText(event.statusText);
    const responseUrl = validateFetchUrl(event.url);
    if (responseUrl.hasFragment) throw new TypeError("Response URL contains a fragment");
  } catch {
    throw bindingProtocolError("Invalid HTTP response metadata from private binding");
  }
  if (
    event.bufferedBodyBytes !== undefined &&
    (!numberIsSafeInteger(event.bufferedBodyBytes) || event.bufferedBodyBytes <= 0 ||
      event.bufferedBodyBytes > sdkLimits.body.bufferedBytes)
  ) {
    throw new NetworkError("Invalid HTTP body limit from private binding", {
      category: "protocol",
      code: "http_protocol_error",
      operation: "http.fetch",
      protocol: "http",
    });
  }
}

function responseFromBinding(
  event: HttpResponseHeadersEvent,
  sdkLimits: Readonly<EffectiveHttpSdkLimits>,
): Response {
  let headers: Headers;
  let body: BodyController | null = null;
  try {
    headers = createBindingHeaders(event.headers, sdkLimits.headerBytes);
    if (event.body !== undefined && event.body !== null) {
      const bufferedBytes = mathMin(
        event.bufferedBodyBytes ?? sdkLimits.body.bufferedBytes,
        sdkLimits.body.bufferedBytes,
      );
      body = bodyFromBinding(
        event.body,
        objectFreeze({
          ...sdkLimits.body,
          bufferedBytes,
          teeBranchBytes: mathMin(sdkLimits.body.teeBranchBytes, bufferedBytes),
        }),
      );
    }
  } catch {
    throw new NetworkError("Invalid HTTP metadata from private binding", {
      category: "protocol",
      code: "http_protocol_error",
      operation: "http.fetch",
      protocol: "http",
    });
  }
  return newResponseFromState({
    status: event.status,
    statusText: event.statusText,
    headers,
    body,
    url: event.url,
    redirected: event.redirected,
  });
}

function makeRequestCommand(state: RequestState, operationId: number): HttpRequestStartCommand {
  const wireUrl = parseAbsoluteUrl(state.url).href;
  return objectFreeze({
    opcode: NetworkV1CommandOpcode.HttpRequestStart,
    operationId,
    url: wireUrl,
    method: state.method,
    headers: bindingHeaders(state.headers),
    hasBody: state.body !== null,
    redirect: state.redirect,
    ...(state.timeouts === undefined ? {} : { timeouts: state.timeouts }),
    maxRedirects: state.maxRedirects,
    ...(state.tls === undefined ? {} : { tls: state.tls }),
    ...(state.limits === undefined ? {} : { limits: state.limits }),
    ref: state.ref,
  });
}

function cancelCommand(operationId: number): OperationCancelCommand {
  return objectFreeze({
    opcode: NetworkV1CommandOpcode.OperationCancel,
    operationId,
  });
}

function snapshotBindingOperation(value: unknown): HttpClientBindingOperation {
  if (typeof value !== "object" || value === null) {
    throw runtimeError(
      "system_error",
      "http.fetch",
      "PocketJS HTTP binding returned an invalid operation",
    );
  }
  const candidate = value as Partial<HttpClientBindingOperation>;
  const cancel = candidate.cancel;
  const response = candidate.response;
  if (typeof cancel !== "function" || response === undefined) {
    throw runtimeError(
      "system_error",
      "http.fetch",
      "PocketJS HTTP binding returned an invalid operation",
    );
  }
  let normalizedResponse: Promise<HttpResponseHeadersEvent>;
  try {
    normalizedResponse = reflectApply(promiseThen, response, [
      (event: HttpResponseHeadersEvent) => event,
      (error: unknown) => { throw error; },
    ]) as Promise<HttpResponseHeadersEvent>;
  } catch {
    throw runtimeError(
      "system_error",
      "http.fetch",
      "PocketJS HTTP binding returned a non-Promise response",
    );
  }
  return objectFreeze({
    response: normalizedResponse,
    cancel: (command: OperationCancelCommand) => reflectApply(cancel, value, [command]),
  });
}

function ignoreRejectedPromise(value: unknown): void {
  try {
    const promise = reflectApply(promiseResolve, PromiseIntrinsic, [value]);
    void reflectApply(promiseThen, promise, [undefined, () => undefined]);
  } catch {
    // Cleanup failures are diagnostic-only.
  }
}

function bestEffortCancelProducer(
  producer: ReturnType<BodyController["createProducer"]> | null,
  reason: unknown,
): void {
  if (!producer) return;
  try {
    const cancel = producer.cancel;
    if (typeof cancel !== "function") return;
    ignoreRejectedPromise(reflectApply(cancel, producer, [reason]));
  } catch {
    // Producer cleanup failures are diagnostic-only.
  }
}

function bestEffortCancelBindingBody(
  event: HttpResponseHeadersEvent | undefined,
  reason: unknown,
): void {
  try {
    const body = event?.body;
    if (!body) return;
    const cancel = (body as Partial<HttpBodyStream>).cancel;
    if (typeof cancel !== "function") return;
    ignoreRejectedPromise(reflectApply(cancel, body, [reason]));
  } catch {
    // Binding cleanup failures are diagnostic-only.
  }
}

export async function fetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const binding = getHttpClientBinding();
  if (!binding) return unsupportedNetworkPromise("http.fetch", "http");

  const sdkLimits = effectiveHttpSdkLimits(binding);

  const request = new Request(input, init);
  const state = requestState(request);
  try {
    const parsedUrl = validateFetchUrl(state.url);
    preflightBindingFeatures(binding, state, parsedUrl);
    if (state.limits !== undefined) normalizeLimits(state.limits, binding);
    if (abortSignalAborted(state.signal)) throw abortError();
  } catch (error) {
    state.detachSignal();
    if (state.body) void state.body.cancel(error).catch(() => {});
    throw error;
  }

  let operationId: number;
  let producer: ReturnType<BodyController["createProducer"]> | null;
  try {
    operationId = allocateOperationId();
    producer = state.body?.createProducer() ?? null;
  } catch (error) {
    state.detachSignal();
    if (state.body) void state.body.cancel(error).catch(() => {});
    throw error;
  }
  let operation: HttpClientBindingOperation;
  try {
    operation = snapshotBindingOperation(binding.start(
      makeRequestCommand(state, operationId),
      producer,
      state.signal,
    ));
  } catch (error) {
    const normalized = normalizeBindingError(error, operationId);
    state.detachSignal();
    bestEffortCancelProducer(producer, normalized);
    throw normalized;
  }

  let rejectAbort!: (error: NetworkError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  let responseBody: BodyController | null = null;
  let cleaned = false;
  let cancelDispatched = false;
  let detachAbortAlgorithm = () => {};
  const dispatchCancel = () => {
    if (cancelDispatched) return;
    cancelDispatched = true;
    try {
      operation.cancel(cancelCommand(operationId));
    } catch {
      // Cancellation diagnostics cannot replace the stable public result.
    }
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    detachAbortAlgorithm();
    state.detachSignal();
  };
  const onAbort = () => {
    const error = abortError();
    dispatchCancel();
    if (responseBody) void responseBody.cancelGraph(error).catch(() => {});
    rejectAbort(error);
  };
  detachAbortAlgorithm = addAbortAlgorithm(state.signal, onAbort);

  let receivedEvent: HttpResponseHeadersEvent | undefined;
  try {
    const event = snapshotResponseEvent(await Promise.race([operation.response, aborted]));
    receivedEvent = event;
    if (abortSignalAborted(state.signal)) throw abortError();
    validateResponseEvent(event, operationId, state.method, sdkLimits);
    const response = responseFromBinding(event, sdkLimits);
    responseBody = responseState(response).body;
    if (abortSignalAborted(state.signal)) throw abortError();
    // A response-headers event claims the request-upload direction terminal.
    // The binding must already have stopped pull credit; this additionally
    // retires a Guest producer if a test seam or faulty Host left it live.
    bestEffortCancelProducer(producer, new NetworkError(
      "HTTP request upload ended when response headers arrived",
      {
        category: "runtime",
        code: "closed",
        operation: "http.fetch.upload",
        protocol: "http",
      },
    ));
    if (responseBody) responseBody.onTerminal(cleanup);
    else cleanup();
    return response;
  } catch (error) {
    cleanup();
    const normalized = normalizeBindingError(error, operationId);
    dispatchCancel();
    bestEffortCancelProducer(producer, normalized);
    bestEffortCancelBindingBody(receivedEvent, normalized);
    throw normalized;
  }
}

export function serve(_options: HttpServeOptions): Promise<HttpServer> {
  return unsupportedNetworkPromise("http.serve", "http");
}
