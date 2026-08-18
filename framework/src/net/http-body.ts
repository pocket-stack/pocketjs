import { NetworkError } from "./index.ts";
import { encodeUtf8 } from "./utf8.ts";

/**
 * SDK-side ceilings used before a Host-admitted limit table is attached.
 * Targets may only lower these values through the private binding metadata.
 */
export const HTTP_BODY_CHUNK_BYTES = 64 * 1024;
export const HTTP_BODY_TEE_BRANCH_BYTES = 256 * 1024;
export const HTTP_BODY_HELPER_BYTES = 8 * 1024 * 1024;
const HTTP_BUFFERED_BODY_INPUT_BYTES = 8 * 1024 * 1024;
const HTTP_BODY_EMPTY_CHUNK_LIMIT = 1024;
const HTTP_BODY_CLONE_BRANCHES = 8;
const HTTP_BODY_TEE_SEGMENT_SLOTS = 5;

export interface HttpBodyLimits {
  /** Maximum bytes retained by a buffered input or aggregation helper. */
  readonly bufferedBytes: number;
  /** Maximum single source/read credit exposed inside the Guest. */
  readonly chunkBytes: number;
  /** Maximum queued bytes for either live tee branch. */
  readonly teeBranchBytes: number;
}

export interface BodyStream extends AsyncIterable<Uint8Array> {
  readInto(destination: Uint8Array): Promise<{ bytes: number; done: boolean }>;
  cancel(reason?: unknown): Promise<void>;
}

export interface HttpBodyProducer {
  pull(maxBytes: number): Promise<Uint8Array | null>;
  cancel(reason?: unknown): Promise<void>;
}

interface BodyCloneGroup {
  branches: number;
  readonly controllers: Set<BodyController>;
  readonly terminalCallbacks: Set<() => void>;
}

interface BodySource {
  pull(maxBytes: number): Promise<Uint8Array | null>;
  cancel(reason?: unknown): Promise<void>;
  onTerminal?(callback: () => void): () => void;
}

const Uint8ArrayIntrinsic = Uint8Array;
const PromiseIntrinsic = Promise;
const SetIntrinsic = Set;
const ArrayBufferIntrinsic = ArrayBuffer;
const TypeErrorIntrinsic = TypeError;
const reflectApply = Reflect.apply;
const mathMin = Math.min;
const mathMax = Math.max;
const numberIsSafeInteger = Number.isSafeInteger;
const objectFreeze = Object.freeze;
const asyncIteratorSymbol = Symbol.asyncIterator;
const typedArrayPrototype = Object.getPrototypeOf(Uint8ArrayIntrinsic.prototype) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;
const typedArrayTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteLength",
)!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteOffset",
)!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "buffer",
)!.get!;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBufferIntrinsic.prototype,
  "byteLength",
)!.get!;
const uint8ArraySet = Uint8ArrayIntrinsic.prototype.set;
const uint8ArraySubarray = Uint8ArrayIntrinsic.prototype.subarray;
const uint8ArraySlice = Uint8ArrayIntrinsic.prototype.slice;
const arrayBufferIsView = ArrayBufferIntrinsic.isView;
const setAdd = SetIntrinsic.prototype.add;
const setDelete = SetIntrinsic.prototype.delete;
const setClear = SetIntrinsic.prototype.clear;
const setForEach = SetIntrinsic.prototype.forEach;
const setSize = Object.getOwnPropertyDescriptor(SetIntrinsic.prototype, "size")!.get!;
const promiseResolve = PromiseIntrinsic.resolve;
const promiseThen = PromiseIntrinsic.prototype.then;
const promiseAllSettled = PromiseIntrinsic.allSettled;

export const DEFAULT_HTTP_BODY_LIMITS: Readonly<HttpBodyLimits> = objectFreeze({
  bufferedBytes: HTTP_BUFFERED_BODY_INPUT_BYTES,
  chunkBytes: HTTP_BODY_CHUNK_BYTES,
  teeBranchBytes: HTTP_BODY_TEE_BRANCH_BYTES,
});

function ignoreBodyRejection(value: unknown): void {
  const promise = reflectApply(promiseResolve, PromiseIntrinsic, [value]);
  void reflectApply(promiseThen, promise, [undefined, () => undefined]);
}

function byteLengthOf(value: Uint8Array): number {
  return reflectApply(typedArrayByteLength, value, []) as number;
}

function subarrayOf(value: Uint8Array, start: number, end?: number): Uint8Array {
  return reflectApply(
    uint8ArraySubarray,
    value,
    end === undefined ? [start] : [start, end],
  );
}

function sliceOf(value: Uint8Array, start: number, end?: number): Uint8Array {
  return reflectApply(
    uint8ArraySlice,
    value,
    end === undefined ? [start] : [start, end],
  );
}

function addSetValue<T>(set: Set<T>, value: T): void {
  reflectApply(setAdd, set, [value]);
}

function deleteSetValue<T>(set: Set<T>, value: T): boolean {
  return reflectApply(setDelete, set, [value]) as boolean;
}

function clearSetValues<T>(set: Set<T>): void {
  reflectApply(setClear, set, []);
}

function setValueCount<T>(set: Set<T>): number {
  return reflectApply(setSize, set, []) as number;
}

function snapshotSetValues<T>(set: Set<T>): T[] {
  const values: T[] = [];
  reflectApply(setForEach, set, [
    (value: T) => {
      values[values.length] = value;
    },
  ]);
  return values;
}

interface IntrinsicViewSnapshot {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
}

function intrinsicUint8ArraySnapshot(
  value: unknown,
  label: string,
): IntrinsicViewSnapshot {
  let tag: unknown;
  let snapshot: IntrinsicViewSnapshot;
  try {
    tag = reflectApply(typedArrayTag, value, []);
    snapshot = intrinsicViewSnapshot(value as ArrayBufferView);
  } catch {
    throw new TypeErrorIntrinsic(`${label} must be a Uint8Array`);
  }
  if (tag !== "Uint8Array") {
    throw new TypeErrorIntrinsic(`${label} must be a Uint8Array`);
  }
  return snapshot;
}

function intrinsicViewSnapshot(view: ArrayBufferView): IntrinsicViewSnapshot {
  try {
    return {
      buffer: reflectApply(typedArrayBuffer, view, []) as ArrayBuffer,
      byteOffset: reflectApply(typedArrayByteOffset, view, []) as number,
      byteLength: reflectApply(typedArrayByteLength, view, []) as number,
    };
  } catch {
    return {
      buffer: reflectApply(dataViewBuffer, view, []) as ArrayBuffer,
      byteOffset: reflectApply(dataViewByteOffset, view, []) as number,
      byteLength: reflectApply(dataViewByteLength, view, []) as number,
    };
  }
}

function copyIntrinsicBytes(snapshot: IntrinsicViewSnapshot): Uint8Array {
  const source = new Uint8ArrayIntrinsic(
    snapshot.buffer,
    snapshot.byteOffset,
    snapshot.byteLength,
  );
  const copy = new Uint8ArrayIntrinsic(snapshot.byteLength);
  reflectApply(uint8ArraySet, copy, [source]);
  return copy;
}

/** Snapshot a genuine Uint8Array without invoking user-visible getters or iteration. */
export function snapshotUint8Array(
  value: unknown,
  maximumBytes: number,
  label: string,
): Uint8Array {
  const snapshot = intrinsicUint8ArraySnapshot(value, label);
  if (snapshot.byteLength > maximumBytes) {
    throw bodyError(
      "resource_limit",
      "http.body",
      `${label} exceeds ${maximumBytes} bytes`,
    );
  }
  try {
    return copyIntrinsicBytes(snapshot);
  } catch {
    throw bodyError(
      "invalid_state",
      "http.body",
      `${label} uses a detached buffer`,
    );
  }
}

/** Return the backing buffer of an SDK-owned, exact-length byte array. */
export function ownedUint8ArrayBuffer(value: Uint8Array): ArrayBuffer {
  return reflectApply(typedArrayBuffer, value, []) as ArrayBuffer;
}

type ReaderKind = "readInto" | "iterator" | "helper" | "binding";

function bodyError(
  code: "busy" | "invalid_state" | "resource_limit",
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

function normalizedBodyLimits(
  input: Readonly<HttpBodyLimits> = DEFAULT_HTTP_BODY_LIMITS,
): Readonly<HttpBodyLimits> {
  const bufferedBytes = input.bufferedBytes;
  const chunkBytes = input.chunkBytes;
  const teeBranchBytes = input.teeBranchBytes;
  if (!numberIsSafeInteger(bufferedBytes) || bufferedBytes <= 0 ||
    !numberIsSafeInteger(chunkBytes) || chunkBytes <= 0 ||
    !numberIsSafeInteger(teeBranchBytes) || teeBranchBytes <= 0) {
    throw bodyError(
      "resource_limit",
      "http.body",
      "HTTP body limits must be positive safe integers",
    );
  }
  const effectiveBufferedBytes = mathMin(bufferedBytes, HTTP_BUFFERED_BODY_INPUT_BYTES);
  const effectiveChunkBytes = mathMin(chunkBytes, HTTP_BODY_CHUNK_BYTES);
  return objectFreeze({
    bufferedBytes: effectiveBufferedBytes,
    chunkBytes: effectiveChunkBytes,
    // Four fixed segments per branch bound both retained bytes and object count.
    teeBranchBytes: mathMin(
      teeBranchBytes,
      HTTP_BODY_TEE_BRANCH_BYTES,
      effectiveBufferedBytes,
      effectiveChunkBytes * (HTTP_BODY_TEE_SEGMENT_SLOTS - 1),
    ),
  });
}

function assertPositiveCapacity(maxBytes: number, operation: string): void {
  if (!numberIsSafeInteger(maxBytes) || maxBytes <= 0) {
    throw bodyError(
      "invalid_state",
      operation,
      "HTTP body capacity must be a positive safe integer",
    );
  }
}

function copyView(view: ArrayBufferView): Uint8Array {
  try {
    return copyIntrinsicBytes(intrinsicViewSnapshot(view));
  } catch {
    throw bodyError(
      "invalid_state",
      "http.body",
      "HTTP body input uses a detached buffer",
    );
  }
}

function copyArrayBuffer(buffer: ArrayBuffer): Uint8Array {
  try {
    const byteLength = reflectApply(arrayBufferByteLength, buffer, []) as number;
    return copyIntrinsicBytes({ buffer, byteOffset: 0, byteLength });
  } catch {
    throw bodyError(
      "invalid_state",
      "http.body",
      "HTTP body input uses a detached buffer",
    );
  }
}

class MemoryBodySource implements BodySource {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  async pull(maxBytes: number): Promise<Uint8Array | null> {
    const byteLength = byteLengthOf(this.bytes);
    if (this.#offset === byteLength) return null;
    const end = mathMin(byteLength, this.#offset + maxBytes);
    const result = subarrayOf(this.bytes, this.#offset, end);
    this.#offset = end;
    return result;
  }

  async cancel(): Promise<void> {
    this.#offset = byteLengthOf(this.bytes);
  }
}

class AsyncIterableBodySource implements BodySource {
  #iteratorRecord: BodyAsyncIteratorRecord | undefined;
  #remainder: Uint8Array | undefined;
  #done = false;
  #returnCalled = false;

  constructor(
    private readonly iterable: AsyncIterable<Uint8Array>,
    private readonly iteratorFactory: () => AsyncIterator<Uint8Array>,
    private readonly chunkBytes: number,
  ) {}

  async pull(maxBytes: number): Promise<Uint8Array | null> {
    if (this.#done) return null;
    if (this.#remainder) return this.#takeRemainder(maxBytes);

    this.#iteratorRecord ??= snapshotBodyAsyncIterator(
      reflectApply(this.iteratorFactory, this.iterable, []),
    );
    const iteratorRecord = this.#iteratorRecord;
    let emptyChunks = 0;
    for (;;) {
      const item = await reflectApply(iteratorRecord.next, iteratorRecord.iterator, []);
      if (typeof item !== "object" || item === null) {
        throw bodyError(
          "invalid_state",
          "http.body.pull",
          "HTTP async body iterator returned an invalid result",
        );
      }
      const done = !!item.done;
      if (done) {
        this.#done = true;
        return null;
      }
      const value = item.value;
      const chunk = snapshotUint8Array(value, this.chunkBytes, "HTTP body chunk");
      if (byteLengthOf(chunk) === 0) {
        emptyChunks++;
        if (emptyChunks > HTTP_BODY_EMPTY_CHUNK_LIMIT) {
          throw bodyError(
            "resource_limit",
            "http.body.pull",
            "HTTP async body produced too many empty chunks",
          );
        }
        continue;
      }
      this.#remainder = chunk;
      return this.#takeRemainder(maxBytes);
    }
  }

  async cancel(reason?: unknown): Promise<void> {
    if (this.#done || this.#returnCalled) return;
    this.#done = true;
    this.#remainder = undefined;
    const iteratorRecord = this.#iteratorRecord;
    if (!iteratorRecord?.returnMethod) return;
    this.#returnCalled = true;
    // A producer return failure is diagnostic-only and never replaces the
    // cancellation or transport failure which caused it.
    try {
      await reflectApply(iteratorRecord.returnMethod, iteratorRecord.iterator, [reason]);
    } catch {
      // Deliberately ignored at this public SDK boundary.
    }
  }

  #takeRemainder(maxBytes: number): Uint8Array {
    const remainder = this.#remainder!;
    const remainderLength = byteLengthOf(remainder);
    const count = mathMin(remainderLength, maxBytes);
    const result = subarrayOf(remainder, 0, count);
    this.#remainder = count === remainderLength
      ? undefined
      : subarrayOf(remainder, count);
    return result;
  }
}

interface BodyAsyncIteratorRecord {
  readonly iterator: object;
  readonly next: () => PromiseLike<IteratorResult<Uint8Array>> | IteratorResult<Uint8Array>;
  readonly returnMethod?: (
    reason?: unknown,
  ) => PromiseLike<IteratorResult<Uint8Array>> | IteratorResult<Uint8Array>;
}

function snapshotBodyAsyncIterator(iterator: unknown): BodyAsyncIteratorRecord {
  if ((typeof iterator !== "object" && typeof iterator !== "function") || iterator === null) {
    throw bodyError(
      "invalid_state",
      "http.body.pull",
      "HTTP async body returned an invalid iterator",
    );
  }
  const next = (iterator as { readonly next?: unknown }).next;
  const returnMethod = (iterator as { readonly return?: unknown }).return;
  if (typeof next !== "function" ||
    (returnMethod !== undefined && returnMethod !== null && typeof returnMethod !== "function")) {
    throw bodyError(
      "invalid_state",
      "http.body.pull",
      "HTTP async body returned an invalid iterator",
    );
  }
  return {
    iterator,
    next: next as BodyAsyncIteratorRecord["next"],
    ...(typeof returnMethod === "function"
      ? { returnMethod: returnMethod as NonNullable<BodyAsyncIteratorRecord["returnMethod"]> }
      : {}),
  };
}

class ExternalBodyStreamSource implements BodySource {
  #done = false;
  #cancelled = false;

  constructor(
    private readonly stream: BodyStream,
    private readonly readIntoMethod: BodyStream["readInto"],
    private readonly cancelMethod: BodyStream["cancel"],
  ) {}

  async pull(maxBytes: number): Promise<Uint8Array | null> {
    if (this.#done) return null;
    const destination = new Uint8ArrayIntrinsic(maxBytes);
    const result = await reflectApply(this.readIntoMethod, this.stream, [destination]);
    if (typeof result !== "object" || result === null) {
      throw bodyError(
        "invalid_state",
        "http.body.pull",
        "HTTP BodyStream returned an invalid readInto result",
      );
    }
    const bytes = result.bytes;
    const done = result.done;
    if (
      !numberIsSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > maxBytes ||
      typeof done !== "boolean" ||
      (done && bytes !== 0) ||
      (!done && bytes === 0)
    ) {
      throw bodyError(
        "invalid_state",
        "http.body.pull",
        "HTTP BodyStream returned an invalid readInto result",
      );
    }
    if (done) {
      this.#done = true;
      return null;
    }
    return subarrayOf(destination, 0, bytes);
  }

  async cancel(reason?: unknown): Promise<void> {
    if (this.#cancelled || this.#done) return;
    this.#cancelled = true;
    this.#done = true;
    await reflectApply(this.cancelMethod, this.stream, [reason]);
  }
}

/**
 * Eagerly advances a binding response within the admitted tee-sized window.
 * Small ignored responses therefore reach BODY_END and retire their native
 * operation; larger responses stop at a fixed byte/segment ceiling.
 */
class PrefetchBodySource implements BodySource {
  readonly #queue: TeeSegment[] = [];
  readonly #waiters = new SetIntrinsic<() => void>();
  readonly #terminalCallbacks = new SetIntrinsic<() => void>();
  readonly #chunkBytes: number;
  readonly #bufferLimit: number;
  #bufferedBytes = 0;
  #pump: Promise<void> | undefined;
  #done = false;
  #cancelled = false;
  #hasError = false;
  #error: unknown;
  #sourceTerminal = false;
  #cancelPromise: Promise<void> | undefined;

  constructor(
    private readonly source: BodySource,
    limits: Readonly<HttpBodyLimits>,
  ) {
    this.#chunkBytes = limits.chunkBytes;
    this.#bufferLimit = limits.teeBranchBytes;
    this.#schedulePump();
  }

  async pull(maxBytes: number): Promise<Uint8Array | null> {
    for (;;) {
      if (this.#queue.length > 0) {
        const chunk = this.#dequeue(maxBytes);
        this.#schedulePump();
        return chunk;
      }
      if (this.#hasError) throw this.#error;
      if (this.#done || this.#cancelled) return null;
      this.#schedulePump();
      await this.#waitForChange();
    }
  }

  cancel(reason?: unknown): Promise<void> {
    if (this.#cancelPromise) return this.#cancelPromise;
    if (this.#cancelled) return PromiseIntrinsic.resolve();
    const sourceNeedsCancel = !this.#done && !this.#hasError;
    this.#cancelled = true;
    this.#queue.length = 0;
    this.#bufferedBytes = 0;
    this.#notify();
    if (!sourceNeedsCancel) return PromiseIntrinsic.resolve();
    this.#cancelPromise = (async () => {
      try {
        await this.source.cancel(reason);
      } finally {
        this.#markSourceTerminal();
        this.#notify();
      }
    })();
    return this.#cancelPromise;
  }

  onTerminal(callback: () => void): () => void {
    if (this.#sourceTerminal) {
      callback();
      return () => {};
    }
    addSetValue(this.#terminalCallbacks, callback);
    return () => {
      deleteSetValue(this.#terminalCallbacks, callback);
    };
  }

  #dequeue(maxBytes: number): Uint8Array {
    const first = this.#queue[0]!;
    const available = first.end - first.start;
    const count = mathMin(available, maxBytes);
    const result = subarrayOf(first.bytes, first.start, first.start + count);
    first.start += count;
    this.#bufferedBytes -= count;
    if (first.start === first.end) {
      for (let index = 1; index < this.#queue.length; index++) {
        this.#queue[index - 1] = this.#queue[index]!;
      }
      this.#queue.length--;
    }
    return result;
  }

  #enqueue(chunk: Uint8Array): void {
    let offset = 0;
    const chunkLength = byteLengthOf(chunk);
    while (offset < chunkLength) {
      let tail = this.#queue[this.#queue.length - 1];
      if (!tail || tail.end === byteLengthOf(tail.bytes)) {
        if (this.#queue.length >= HTTP_BODY_TEE_SEGMENT_SLOTS) {
          throw bodyError(
            "resource_limit",
            "http.body.prefetch",
            "HTTP response prefetch exceeded its fixed segment slots",
          );
        }
        tail = {
          bytes: new Uint8ArrayIntrinsic(this.#chunkBytes),
          start: 0,
          end: 0,
        };
        this.#queue[this.#queue.length] = tail;
      }
      const count = mathMin(
        byteLengthOf(tail.bytes) - tail.end,
        chunkLength - offset,
      );
      reflectApply(uint8ArraySet, tail.bytes, [
        subarrayOf(chunk, offset, offset + count),
        tail.end,
      ]);
      tail.end += count;
      offset += count;
    }
    this.#bufferedBytes += chunkLength;
  }

  #schedulePump(): void {
    if (this.#pump || this.#done || this.#cancelled || this.#hasError ||
      this.#bufferedBytes >= this.#bufferLimit) return;
    this.#pump = (async () => {
      try {
        while (!this.#done && !this.#cancelled && !this.#hasError &&
          this.#bufferedBytes < this.#bufferLimit) {
          const credit = mathMin(
            this.#chunkBytes,
            this.#bufferLimit - this.#bufferedBytes,
          );
          const chunk = await this.source.pull(credit);
          if (this.#cancelled) break;
          if (chunk === null) {
            this.#done = true;
            this.#markSourceTerminal();
            break;
          }
          const length = byteLengthOf(chunk);
          if (length === 0 || length > credit) {
            throw bodyError(
              length > credit ? "resource_limit" : "invalid_state",
              "http.body.prefetch",
              "HTTP response source violated prefetch credit",
            );
          }
          this.#enqueue(chunk);
        }
      } catch (error) {
        if (!this.#cancelled) {
          this.#hasError = true;
          this.#error = error;
          this.#notify();
          try {
            await this.source.cancel(error);
          } catch {
            // The original body/credit failure remains authoritative.
          }
          this.#markSourceTerminal();
        }
      } finally {
        this.#pump = undefined;
        this.#notify();
      }
    })();
  }

  #waitForChange(): Promise<void> {
    return new PromiseIntrinsic((resolve) => addSetValue(this.#waiters, resolve));
  }

  #notify(): void {
    const waiters = snapshotSetValues(this.#waiters);
    clearSetValues(this.#waiters);
    for (let index = 0; index < waiters.length; index++) waiters[index]!();
  }

  #markSourceTerminal(): void {
    if (this.#sourceTerminal) return;
    this.#sourceTerminal = true;
    const callbacks = snapshotSetValues(this.#terminalCallbacks);
    clearSetValues(this.#terminalCallbacks);
    for (let index = 0; index < callbacks.length; index++) {
      try {
        callbacks[index]!();
      } catch {
        // Transport retirement remains authoritative over observer diagnostics.
      }
    }
  }
}

interface TeeSegment {
  readonly bytes: Uint8Array;
  start: number;
  end: number;
}

interface TeeBranchState {
  readonly queue: TeeSegment[];
  spare?: Uint8Array;
  bufferedBytes: number;
  cancelled: boolean;
}

interface TeeState {
  readonly source: BodySource;
  readonly branches: readonly [TeeBranchState, TeeBranchState];
  readonly waiters: Set<() => void>;
  readonly chunkBytes: number;
  readonly branchBytes: number;
  readPromise?: Promise<void>;
  done: boolean;
  hasError: boolean;
  error: unknown;
  sourceCancelCalled: boolean;
}

function newTeeBranchState(): TeeBranchState {
  return {
    queue: [],
    bufferedBytes: 0,
    cancelled: false,
  };
}

function notifyTee(state: TeeState): void {
  const waiters = snapshotSetValues(state.waiters);
  clearSetValues(state.waiters);
  for (let index = 0; index < waiters.length; index++) waiters[index]!();
}

function waitForTeeChange(state: TeeState): Promise<void> {
  return new PromiseIntrinsic((resolve) => addSetValue(state.waiters, resolve));
}

function dequeueTee(branch: TeeBranchState, maxBytes: number): Uint8Array {
  const first = branch.queue[0]!;
  const available = first.end - first.start;
  const count = mathMin(available, maxBytes);
  const result = subarrayOf(first.bytes, first.start, first.start + count);
  first.start += count;
  branch.bufferedBytes -= count;
  if (first.start === first.end) {
    for (let index = 1; index < branch.queue.length; index++) {
      branch.queue[index - 1] = branch.queue[index]!;
    }
    branch.queue.length--;
    if (branch.queue.length === 0) branch.spare = first.bytes;
  }
  return result;
}

function enqueueTee(state: TeeState, branch: TeeBranchState, chunk: Uint8Array): void {
  let offset = 0;
  const chunkLength = byteLengthOf(chunk);
  while (offset < chunkLength) {
    let tail = branch.queue[branch.queue.length - 1];
    if (!tail || tail.end === byteLengthOf(tail.bytes)) {
      if (branch.queue.length >= HTTP_BODY_TEE_SEGMENT_SLOTS) {
        throw bodyError(
          "resource_limit",
          "http.body.tee",
          "HTTP body tee exceeded its fixed segment slots",
        );
      }
      tail = {
        bytes: branch.spare ?? new Uint8ArrayIntrinsic(state.chunkBytes),
        start: 0,
        end: 0,
      };
      branch.spare = undefined;
      branch.queue[branch.queue.length] = tail;
    }
    const count = mathMin(byteLengthOf(tail.bytes) - tail.end, chunkLength - offset);
    reflectApply(uint8ArraySet, tail.bytes, [
      subarrayOf(chunk, offset, offset + count),
      tail.end,
    ]);
    tail.end += count;
    offset += count;
  }
  branch.bufferedBytes += chunkLength;
}

function recordTeeFault(state: TeeState, error: unknown): void {
  if (!state.hasError) {
    state.hasError = true;
    state.error = error;
  }
  if (state.sourceCancelCalled) return;
  state.sourceCancelCalled = true;
  try {
    ignoreBodyRejection(reflectApply(state.source.cancel, state.source, [state.error]));
  } catch {
    // The source contract fault remains authoritative.
  }
}

function fillTee(state: TeeState): Promise<void> | undefined {
  if (state.readPromise) return state.readPromise;
  const active: TeeBranchState[] = [];
  for (let index = 0; index < state.branches.length; index++) {
    const branch = state.branches[index]!;
    if (!branch.cancelled) active[active.length] = branch;
  }
  if (active.length === 0 || state.done || state.hasError) return;
  let credit = state.chunkBytes;
  for (let index = 0; index < active.length; index++) {
    credit = mathMin(
      credit,
      state.branchBytes - active[index]!.bufferedBytes,
    );
  }
  if (credit <= 0) return;

  state.readPromise = (async () => {
    try {
      const chunk = await state.source.pull(credit);
      if (chunk === null) {
        state.done = true;
      } else {
        const chunkLength = byteLengthOf(chunk);
        if (chunkLength === 0 || chunkLength > credit) {
          recordTeeFault(state, bodyError(
            chunkLength > credit ? "resource_limit" : "invalid_state",
            "http.body.tee",
            "HTTP body source violated bounded tee credit",
          ));
        } else {
          for (let index = 0; index < active.length; index++) {
            const branch = active[index]!;
            if (branch.cancelled) continue;
            enqueueTee(state, branch, chunk);
          }
        }
      }
    } catch (error) {
      recordTeeFault(state, error);
    } finally {
      state.readPromise = undefined;
      notifyTee(state);
    }
  })();
  return state.readPromise;
}

class TeeBodySource implements BodySource {
  constructor(
    private readonly state: TeeState,
    private readonly branchIndex: 0 | 1,
  ) {}

  async pull(maxBytes: number): Promise<Uint8Array | null> {
    const branch = this.state.branches[this.branchIndex];
    for (;;) {
      if (branch.cancelled) return null;
      if (branch.bufferedBytes > 0) {
        const chunk = dequeueTee(branch, maxBytes);
        notifyTee(this.state);
        return chunk;
      }
      if (this.state.hasError) throw this.state.error;
      if (this.state.done) return null;

      let activeCount = 0;
      let canRead = true;
      for (let index = 0; index < this.state.branches.length; index++) {
        const candidate = this.state.branches[index]!;
        if (candidate.cancelled) continue;
        activeCount++;
        if (candidate.bufferedBytes >= this.state.branchBytes) canRead = false;
      }
      canRead = activeCount > 0 && canRead;
      if (this.state.readPromise || canRead) {
        await fillTee(this.state);
        continue;
      }
      // The other live branch is at its fixed ceiling. Waiting here is the
      // required backpressure; consuming or cancelling that branch resumes us.
      await waitForTeeChange(this.state);
    }
  }

  async cancel(reason?: unknown): Promise<void> {
    const branch = this.state.branches[this.branchIndex];
    if (branch.cancelled) return;
    branch.cancelled = true;
    branch.queue.length = 0;
    branch.spare = undefined;
    branch.bufferedBytes = 0;
    notifyTee(this.state);
    if (
      !this.state.sourceCancelCalled &&
      this.state.branches[0].cancelled && this.state.branches[1].cancelled
    ) {
      this.state.sourceCancelCalled = true;
      await this.state.source.cancel(reason);
    }
  }
}

function teeBodySource(
  source: BodySource,
  limits: Readonly<HttpBodyLimits>,
): readonly [BodySource, BodySource] {
  const state: TeeState = {
    source,
    branches: [newTeeBranchState(), newTeeBranchState()],
    waiters: new SetIntrinsic(),
    chunkBytes: limits.chunkBytes,
    branchBytes: limits.teeBranchBytes,
    done: false,
    hasError: false,
    error: undefined,
    sourceCancelCalled: false,
  };
  return [new TeeBodySource(state, 0), new TeeBodySource(state, 1)];
}

class BodyAsyncIterator implements AsyncIterableIterator<Uint8Array> {
  #closed = false;

  constructor(private readonly controller: BodyController) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this;
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    if (this.#closed) return { value: undefined, done: true };
    const destination = new Uint8ArrayIntrinsic(this.controller.chunkBytes);
    const result = await this.controller.readInto("iterator", destination);
    if (result.done) {
      this.#closed = true;
      return { value: undefined, done: true };
    }
    return { value: sliceOf(destination, 0, result.bytes), done: false };
  }

  async return(): Promise<IteratorResult<Uint8Array>> {
    if (!this.#closed) {
      this.#closed = true;
      await this.controller.cancel();
    }
    return { value: undefined, done: true };
  }
}

class BodyStreamValue implements BodyStream {
  constructor(private readonly controller: BodyController) {}

  readInto(destination: Uint8Array): Promise<{ bytes: number; done: boolean }> {
    return this.controller.readInto("readInto", destination);
  }

  cancel(reason?: unknown): Promise<void> {
    return this.controller.cancel(reason);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this.controller.createIterator();
  }
}

export class BodyController {
  readonly stream: BodyStream;
  readonly aggregateLimit: number;
  readonly chunkBytes: number;
  readonly limits: Readonly<HttpBodyLimits>;
  #source: BodySource;
  #readerKind: ReaderKind | undefined;
  #pending = false;
  #used = false;
  #terminal = false;
  #cancelled = false;
  #iteratorCreated = false;
  #helperCreated = false;
  #producerCreated = false;
  #leftover: Uint8Array | undefined;
  readonly #cloneGroup: BodyCloneGroup;

  constructor(
    source: BodySource,
    limits: Readonly<HttpBodyLimits> = DEFAULT_HTTP_BODY_LIMITS,
    cloneGroup: BodyCloneGroup = {
      branches: 1,
      controllers: new SetIntrinsic(),
      terminalCallbacks: new SetIntrinsic(),
    },
  ) {
    this.limits = normalizedBodyLimits(limits);
    this.#source = source;
    this.#cloneGroup = cloneGroup;
    addSetValue(this.#cloneGroup.controllers, this);
    this.aggregateLimit = this.limits.bufferedBytes;
    this.chunkBytes = this.limits.chunkBytes;
    this.stream = new BodyStreamValue(this);
  }

  get bodyUsed(): boolean {
    return this.#used;
  }

  get unusable(): boolean {
    return this.#readerKind !== undefined || this.#used;
  }

  onTerminal(callback: () => void): () => void {
    const sourceTerminal = this.#source.onTerminal;
    if (sourceTerminal) {
      return reflectApply(sourceTerminal, this.#source, [callback]) as () => void;
    }
    if (setValueCount(this.#cloneGroup.controllers) === 0) {
      callback();
      return () => {};
    }
    addSetValue(this.#cloneGroup.terminalCallbacks, callback);
    return () => deleteSetValue(this.#cloneGroup.terminalCallbacks, callback);
  }

  async cancelGraph(reason?: unknown): Promise<void> {
    const controllers = snapshotSetValues(this.#cloneGroup.controllers);
    const cancellations: Promise<void>[] = [];
    for (let index = 0; index < controllers.length; index++) {
      cancellations[index] = controllers[index]!.cancel(reason);
    }
    const results = await reflectApply(promiseAllSettled, PromiseIntrinsic, [
      cancellations,
    ]);
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      if (result.status === "rejected") throw result.reason;
    }
  }

  createIterator(): AsyncIterableIterator<Uint8Array> {
    this.#claim("iterator");
    if (this.#iteratorCreated) {
      throw bodyError(
        "invalid_state",
        "http.body.iterator",
        "HTTP body already has an async iterator",
      );
    }
    this.#iteratorCreated = true;
    return new BodyAsyncIterator(this);
  }

  async readInto(
    kind: ReaderKind,
    destination: Uint8Array,
  ): Promise<{ bytes: number; done: boolean }> {
    let destinationSnapshot: IntrinsicViewSnapshot;
    try {
      destinationSnapshot = intrinsicUint8ArraySnapshot(
        destination,
        "HTTP body destination",
      );
      // Constructing an intrinsic view detects a detached backing buffer in
      // runtimes where the typed-array slot getters still report zero.
      new Uint8ArrayIntrinsic(
        destinationSnapshot.buffer,
        destinationSnapshot.byteOffset,
        destinationSnapshot.byteLength,
      );
    } catch {
      throw bodyError(
        "invalid_state",
        "http.body.readInto",
        "HTTP body destination uses a detached buffer",
      );
    }
    const destinationLength = destinationSnapshot.byteLength;
    if (destinationLength === 0) {
      throw bodyError(
        "invalid_state",
        "http.body.readInto",
        "HTTP body destination must not be empty",
      );
    }
    this.#claim(kind);
    this.#used = true;
    if (this.#pending) {
      throw bodyError(
        "busy",
        "http.body.readInto",
        "HTTP body already has a pending read",
      );
    }
    if (this.#terminal || this.#cancelled) return { bytes: 0, done: true };

    this.#pending = true;
    try {
      let emptyChunks = 0;
      for (;;) {
        if (this.#leftover) {
          const leftoverLength = byteLengthOf(this.#leftover);
          const count = mathMin(destinationLength, leftoverLength);
          reflectApply(uint8ArraySet, destination, [subarrayOf(this.#leftover, 0, count), 0]);
          this.#leftover = count === leftoverLength
            ? undefined
            : subarrayOf(this.#leftover, count);
          return { bytes: count, done: false };
        }
        const chunk = await this.#source.pull(
          mathMin(destinationLength, this.chunkBytes),
        );
        if (this.#cancelled) return { bytes: 0, done: true };
        if (chunk === null) {
          this.#markTerminal();
          return { bytes: 0, done: true };
        }
        const chunkLength = byteLengthOf(chunk);
        if (chunkLength === 0) {
          emptyChunks++;
          if (emptyChunks > HTTP_BODY_EMPTY_CHUNK_LIMIT) {
            throw bodyError(
              "resource_limit",
              "http.body.readInto",
              "HTTP body source produced too many empty chunks",
            );
          }
          continue;
        }
        if (chunkLength > this.chunkBytes) {
          throw bodyError(
            "resource_limit",
            "http.body.readInto",
            `HTTP body chunk exceeds ${this.chunkBytes} bytes`,
          );
        }
        const count = mathMin(destinationLength, chunkLength);
        reflectApply(uint8ArraySet, destination, [subarrayOf(chunk, 0, count), 0]);
        if (count < chunkLength) this.#leftover = subarrayOf(chunk, count);
        return { bytes: count, done: false };
      }
    } catch (error) {
      this.#markTerminal();
      try {
        ignoreBodyRejection(reflectApply(this.#source.cancel, this.#source, [error]));
      } catch {
        // The source error remains authoritative.
      }
      throw error;
    } finally {
      this.#pending = false;
    }
  }

  async cancel(reason?: unknown): Promise<void> {
    if (this.#cancelled || this.#terminal) return;
    this.#used = true;
    this.#cancelled = true;
    this.#leftover = undefined;
    try {
      await this.#source.cancel(reason);
    } finally {
      this.#markTerminal();
    }
  }

  createProducer(): HttpBodyProducer {
    if (this.#producerCreated) {
      throw bodyError(
        "invalid_state",
        "http.body.binding",
        "HTTP body already has a binding producer",
      );
    }
    this.#producerCreated = true;
    this.#claim("binding");
    return objectFreeze({
      pull: async (maxBytes: number) => {
        assertPositiveCapacity(maxBytes, "http.body.pull");
        const capacity = mathMin(maxBytes, this.chunkBytes);
        const destination = new Uint8ArrayIntrinsic(capacity);
        const result = await this.readInto("binding", destination);
        return result.done ? null : sliceOf(destination, 0, result.bytes);
      },
      cancel: (reason?: unknown) => this.cancel(reason),
    });
  }

  tee(): BodyController {
    if (this.unusable) {
      throw bodyError(
        "invalid_state",
        "http.body.clone",
        "Cannot clone a locked or consumed HTTP body",
      );
    }
    if (this.#cloneGroup.branches >= HTTP_BODY_CLONE_BRANCHES) {
      throw bodyError(
        "resource_limit",
        "http.body.clone",
        `HTTP body clone graph exceeds ${HTTP_BODY_CLONE_BRANCHES} branches`,
      );
    }
    this.#cloneGroup.branches++;
    const [first, second] = teeBodySource(this.#source, this.limits);
    this.#source = first;
    return new BodyController(second, this.limits, this.#cloneGroup);
  }

  transfer(): BodyController {
    if (this.unusable) {
      throw bodyError(
        "invalid_state",
        "http.Request",
        "Cannot construct from a locked or consumed Request body",
      );
    }
    const source = this.#source;
    const transferred = new BodyController(
      source,
      this.limits,
      this.#cloneGroup,
    );
    this.#readerKind = "binding";
    this.#used = true;
    this.#source = new MemoryBodySource(new Uint8ArrayIntrinsic());
    this.#markTerminal();
    return transferred;
  }

  async aggregate(operation: string): Promise<Uint8Array> {
    if (this.#helperCreated) {
      throw bodyError(
        "invalid_state",
        operation,
        "HTTP body was already consumed by an aggregation helper",
      );
    }
    this.#helperCreated = true;
    this.#claim("helper");
    const maximum = this.aggregateLimit;
    let output = new Uint8ArrayIntrinsic(mathMin(this.chunkBytes, maximum + 1));
    let total = 0;
    for (;;) {
      const outputLength = byteLengthOf(output);
      if (total === outputLength) {
        const nextLength = mathMin(
          maximum + 1,
          mathMax(outputLength + 1, outputLength * 2),
        );
        const grown = new Uint8ArrayIntrinsic(nextLength);
        reflectApply(uint8ArraySet, grown, [output]);
        output = grown;
      }
      const destination = subarrayOf(
        output,
        total,
        mathMin(byteLengthOf(output), total + this.chunkBytes),
      );
      const result = await this.readInto("helper", destination);
      if (result.done) break;
      total += result.bytes;
      if (total > maximum) {
        await this.cancel();
        throw bodyError(
          "resource_limit",
          operation,
          `HTTP body helper exceeds ${maximum} bytes`,
        );
      }
    }
    if (total === byteLengthOf(output)) return output;
    const exact = new Uint8ArrayIntrinsic(total);
    reflectApply(uint8ArraySet, exact, [subarrayOf(output, 0, total)]);
    return exact;
  }

  #claim(kind: ReaderKind): void {
    if (this.#readerKind === undefined) {
      this.#readerKind = kind;
      return;
    }
    if (this.#readerKind !== kind) {
      throw bodyError(
        "invalid_state",
        `http.body.${kind}`,
        "HTTP body is locked by another reader",
      );
    }
  }

  #markTerminal(): void {
    if (this.#terminal) return;
    this.#terminal = true;
    deleteSetValue(this.#cloneGroup.controllers, this);
    if (setValueCount(this.#cloneGroup.controllers) !== 0) return;
    const callbacks = snapshotSetValues(this.#cloneGroup.terminalCallbacks);
    clearSetValues(this.#cloneGroup.terminalCallbacks);
    for (let index = 0; index < callbacks.length; index++) callbacks[index]!();
  }
}

export interface ExtractedBody {
  readonly controller: BodyController;
  readonly contentType?: string;
}

function bufferedBodySource(
  bytes: Uint8Array,
  limits: Readonly<HttpBodyLimits>,
): BodyController {
  if (byteLengthOf(bytes) > limits.bufferedBytes) {
    throw bodyError(
      "resource_limit",
      "http.body",
      `Buffered HTTP body exceeds ${limits.bufferedBytes} bytes`,
    );
  }
  return new BodyController(new MemoryBodySource(bytes), limits);
}

function assertBufferedBodySize(byteLength: number, maximumBytes: number): void {
  if (byteLength > maximumBytes) {
    throw bodyError(
      "resource_limit",
      "http.body",
      `Buffered HTTP body exceeds ${maximumBytes} bytes`,
    );
  }
}

interface BodyStreamMethods {
  readonly readInto: BodyStream["readInto"];
  readonly cancel: BodyStream["cancel"];
}

interface BodyObjectMethodsSnapshot {
  readonly readInto: unknown;
  readonly cancel: unknown;
  readonly iteratorFactory: unknown;
}

function snapshotBodyObjectMethods(value: object): BodyObjectMethodsSnapshot {
  return {
    readInto: (value as Partial<BodyStream>).readInto,
    cancel: (value as Partial<BodyStream>).cancel,
    iteratorFactory: (value as Record<PropertyKey, unknown>)[asyncIteratorSymbol],
  };
}

function bodyStreamMethods(snapshot: BodyObjectMethodsSnapshot): BodyStreamMethods | null {
  return typeof snapshot.readInto === "function" &&
      typeof snapshot.cancel === "function" &&
      typeof snapshot.iteratorFactory === "function"
    ? {
        readInto: snapshot.readInto as BodyStream["readInto"],
        cancel: snapshot.cancel as BodyStream["cancel"],
      }
    : null;
}

export function extractBody(
  input: string | ArrayBuffer | ArrayBufferView | BodyStream | AsyncIterable<Uint8Array>,
  requestedLimits: Readonly<HttpBodyLimits> = DEFAULT_HTTP_BODY_LIMITS,
): ExtractedBody {
  const limits = normalizedBodyLimits(requestedLimits);
  if (typeof input === "string") {
    const bytes = encodeUtf8(input, limits.bufferedBytes);
    if (bytes === null) {
      throw bodyError(
        "resource_limit",
        "http.body",
        `Buffered HTTP body exceeds ${limits.bufferedBytes} bytes`,
      );
    }
    return {
      controller: bufferedBodySource(bytes, limits),
      contentType: "text/plain;charset=UTF-8",
    };
  }
  let arrayBufferLength: number | undefined;
  try {
    arrayBufferLength = reflectApply(arrayBufferByteLength, input, []) as number;
  } catch {
    arrayBufferLength = undefined;
  }
  if (arrayBufferLength !== undefined) {
    const buffer = input as ArrayBuffer;
    const byteLength = arrayBufferLength;
    assertBufferedBodySize(byteLength, limits.bufferedBytes);
    return {
      controller: bufferedBodySource(copyArrayBuffer(buffer), limits),
    };
  }
  if (reflectApply(arrayBufferIsView, ArrayBufferIntrinsic, [input])) {
    const snapshot = intrinsicViewSnapshot(input as ArrayBufferView);
    assertBufferedBodySize(snapshot.byteLength, limits.bufferedBytes);
    return {
      controller: bufferedBodySource(copyIntrinsicBytes(snapshot), limits),
    };
  }
  if (typeof input === "object" && input !== null) {
    const methodSnapshot = snapshotBodyObjectMethods(input);
    const methods = bodyStreamMethods(methodSnapshot);
    if (methods) {
      return {
        controller: new BodyController(
          new ExternalBodyStreamSource(
            input as BodyStream,
            methods.readInto,
            methods.cancel,
          ),
          limits,
        ),
      };
    }
    const iteratorFactory = methodSnapshot.iteratorFactory;
    if (typeof iteratorFactory !== "function") {
      throw new TypeErrorIntrinsic(
        "HTTP body must be a string, ArrayBuffer, ArrayBufferView, BodyStream, or AsyncIterable",
      );
    }
    return {
      controller: new BodyController(
        new AsyncIterableBodySource(
          input as AsyncIterable<Uint8Array>,
          iteratorFactory as () => AsyncIterator<Uint8Array>,
          limits.chunkBytes,
        ),
        limits,
      ),
    };
  }
  throw new TypeErrorIntrinsic(
    "HTTP body must be a string, ArrayBuffer, ArrayBufferView, BodyStream, or AsyncIterable",
  );
}

export function bodyFromBinding(
  input: BodyStream,
  limits: Readonly<HttpBodyLimits> = DEFAULT_HTTP_BODY_LIMITS,
): BodyController {
  if (typeof input !== "object" || input === null) {
    throw new TypeErrorIntrinsic("Private HTTP binding response body must be a BodyStream");
  }
  const methods = bodyStreamMethods(snapshotBodyObjectMethods(input));
  if (!methods) {
    throw new TypeErrorIntrinsic("Private HTTP binding response body must be a BodyStream");
  }
  return new BodyController(
    new PrefetchBodySource(
      new ExternalBodyStreamSource(input, methods.readInto, methods.cancel),
      normalizedBodyLimits(limits),
    ),
    limits,
  );
}
