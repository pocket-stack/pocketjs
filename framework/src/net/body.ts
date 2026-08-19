// BodyStream — the single-consumer byte stream every HTTP body uses.
// Three flavours share one
// public shape: bytes already in JS (request bodies built from NetworkData,
// Response bodies constructed by the app), bytes that live in a native queue
// and cross only through the module's `readInto` op (client responses,
// server requests), and the bounded tee behind `clone()`.
//
// Native-backed streams consume only bytes that became visible at the last
// tick boundary; a read that cannot be satisfied parks until the next
// `readable`/`end`/`error` event delivered by the service pump. At most one
// read is pending per stream; the aggregate helpers (`text()`, `json()`,
// `arrayBuffer()`) sit on top of the same path and cancel the handle with
// `response_too_large` past their limit.

import { NET_ERROR } from "../../../contracts/spec/net.ts";
import { stringToUtf8, utf8ToString } from "../bytes.ts";
import { NetworkError, type NetworkProtocol } from "./errors.ts";

export interface BodyReadResult {
  bytes: number;
  done: boolean;
}

export interface BodyStream extends AsyncIterable<Uint8Array> {
  readInto(destination: Uint8Array): Promise<BodyReadResult>;
  cancel(reason?: unknown): Promise<void>;
}

export type NetworkData = string | ArrayBuffer | ArrayBufferView;

/** Snapshot NetworkData into an owned Uint8Array (strings as UTF-8, views by
 * their current window). Detached buffers fail with `invalid_state`. */
export function snapshotData(data: NetworkData, operation: string, protocol: NetworkProtocol): Uint8Array {
  if (typeof data === "string") return stringToUtf8(data);
  if (data instanceof ArrayBuffer) {
    if (data.byteLength === 0 && isDetached(data)) {
      throw new NetworkError(NET_ERROR.invalidState, "buffer is detached", { operation, protocol });
    }
    return new Uint8Array(data.slice(0));
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    if (view.byteLength === 0 && isDetached(view.buffer as ArrayBuffer)) {
      throw new NetworkError(NET_ERROR.invalidState, "buffer is detached", { operation, protocol });
    }
    return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength).slice();
  }
  throw new NetworkError(NET_ERROR.invalidRequest, "body must be a string, ArrayBuffer or ArrayBufferView", {
    operation,
    protocol,
  });
}

function isDetached(buffer: ArrayBuffer): boolean {
  const b = buffer as ArrayBuffer & { detached?: boolean };
  if (typeof b.detached === "boolean") return b.detached;
  try {
    new Uint8Array(buffer);
    return false;
  } catch {
    return true;
  }
}

/** Common lock/consumption bookkeeping. */
abstract class BaseBody implements BodyStream {
  protected locked = false;
  protected consumed = false;
  protected readonly protocol: NetworkProtocol;

  constructor(protocol: NetworkProtocol) {
    this.protocol = protocol;
  }

  /** True once any reader, iterator or helper took the stream. */
  get bodyUsed(): boolean {
    return this.locked;
  }

  protected lock(operation: string): void {
    if (this.locked) {
      throw new NetworkError(NET_ERROR.invalidState, "body is already in use", {
        operation,
        protocol: this.protocol,
      });
    }
    this.locked = true;
  }

  abstract readInto(destination: Uint8Array): Promise<BodyReadResult>;
  abstract cancel(reason?: unknown): Promise<void>;
  /** Bytes known to arrive in total, or -1 when unknown. */
  abstract knownLength(): number;
  /** Bytes readable right now without waiting. */
  abstract available(): number;

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    // Async iteration takes the lock lazily on the first next() so that
    // `for await` over an already-locked body rejects rather than throws.
    const chunkBytes = 16 * 1024;
    let started = false;
    let finished = false;
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        if (finished) return { value: undefined, done: true };
        if (!started) {
          started = true;
          this.lock("iterate");
        }
        for (;;) {
          const size = Math.max(1, Math.min(chunkBytes, this.available() || chunkBytes));
          const chunk = new Uint8Array(size);
          const { bytes, done } = await this.readIntoLocked(chunk);
          if (bytes > 0) return { value: chunk.subarray(0, bytes), done: false };
          if (done) {
            finished = true;
            return { value: undefined, done: true };
          }
        }
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => {
        finished = true;
        await this.cancel();
        return { value: undefined, done: true };
      },
    };
  }

  /** readInto for a caller that already holds the lock. */
  protected abstract readIntoLocked(destination: Uint8Array): Promise<BodyReadResult>;

  /** Aggregate helper: whole body as bytes, bounded by `limitBytes`. */
  async collect(limitBytes: number, operation: string): Promise<Uint8Array> {
    this.lock(operation);
    const tooLarge = async (): Promise<never> => {
      await this.cancel();
      throw new NetworkError(NET_ERROR.responseTooLarge, `body exceeds ${limitBytes} bytes`, {
        operation,
        protocol: this.protocol,
      });
    };
    const known = this.knownLength();
    if (known > limitBytes) return tooLarge();
    if (known >= 0) {
      // Content-Length known: one exact allocation, filled as bytes arrive.
      const buffer = new Uint8Array(known);
      let filled = 0;
      let done = false;
      while (filled < known && !done) {
        const r = await this.readIntoLocked(buffer.subarray(filled));
        filled += r.bytes;
        done = r.done;
      }
      if (!done) {
        // The last bytes and the terminal event may land in different
        // ticks; observe EOF so the handle retires before we return.
        const probe = new Uint8Array(1);
        const r = await this.readIntoLocked(probe);
        if (r.bytes > 0) {
          await this.cancel();
          throw new NetworkError(NET_ERROR.protocol, "body exceeds its declared length", {
            operation,
            protocol: this.protocol,
          });
        }
      }
      return filled === known ? buffer : buffer.subarray(0, filled);
    }
    // Unknown length (chunked / close-delimited): grow geometrically.
    let buffer = new Uint8Array(Math.min(limitBytes, Math.max(this.available(), 8 * 1024)));
    let filled = 0;
    for (;;) {
      if (filled === buffer.length) {
        if (buffer.length >= limitBytes) return tooLarge();
        const grown = new Uint8Array(Math.min(limitBytes, Math.max(buffer.length * 2, filled + this.available())));
        grown.set(buffer);
        buffer = grown;
      }
      const r = await this.readIntoLocked(buffer.subarray(filled));
      filled += r.bytes;
      if (r.done) break;
    }
    return filled === buffer.length ? buffer : buffer.slice(0, filled);
  }

  async collectText(limitBytes: number, operation: string): Promise<string> {
    const bytes = await this.collect(limitBytes, operation);
    try {
      return utf8ToString(bytes);
    } catch {
      throw new NetworkError(NET_ERROR.protocol, "body is not valid UTF-8", {
        operation,
        protocol: this.protocol,
      });
    }
  }
}

/** Bytes already held in JS. */
export class MemoryBody extends BaseBody {
  private readonly bytes: Uint8Array;
  private offset = 0;
  private cancelled = false;

  constructor(bytes: Uint8Array, protocol: NetworkProtocol) {
    super(protocol);
    this.bytes = bytes;
  }

  /** The unread bytes; used by the modules to snapshot outbound bodies. */
  peek(): Uint8Array {
    return this.bytes.subarray(this.offset);
  }

  knownLength(): number {
    return this.bytes.length;
  }

  available(): number {
    return this.bytes.length - this.offset;
  }

  readInto(destination: Uint8Array): Promise<BodyReadResult> {
    try {
      this.lockOnce("readInto");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.readIntoLocked(destination);
  }

  private lockOnce(operation: string): void {
    if (!this.consumed) {
      this.lock(operation);
      this.consumed = true;
    }
  }

  protected async readIntoLocked(destination: Uint8Array): Promise<BodyReadResult> {
    if (destination.length === 0) {
      throw new NetworkError(NET_ERROR.invalidRequest, "destination is empty", {
        operation: "readInto",
        protocol: this.protocol,
      });
    }
    if (this.cancelled) return { bytes: 0, done: true };
    const n = Math.min(destination.length, this.bytes.length - this.offset);
    destination.set(this.bytes.subarray(this.offset, this.offset + n));
    this.offset += n;
    return { bytes: n, done: this.offset >= this.bytes.length };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.locked = true;
    this.offset = this.bytes.length;
  }

  /** A second view of the same bytes (both start unread). */
  fork(): MemoryBody {
    return new MemoryBody(this.bytes, this.protocol);
  }
}

/** The native side of a queue-backed stream: one `readInto` op bound to a
 * handle, plus a way to cancel the handle. */
export interface NativeSource {
  /** Copy up to dest.length visible bytes into dest; -1 = handle gone. */
  pull(destination: Uint8Array): number;
  /** Ask the module to cancel the handle; the terminal event follows later. */
  cancel(reason: unknown): void;
}

/** Bytes that live in a native queue and cross through `readInto`. */
export class NativeBody extends BaseBody {
  private readonly source: NativeSource;
  private avail = 0;
  private ended = false;
  private failure: NetworkError | null = null;
  private terminal = false;
  private waiter: { resolve: (r: BodyReadResult) => void; reject: (e: unknown) => void; dest: Uint8Array } | null = null;
  private cancelWaiters: (() => void)[] = [];
  private cancelRequested = false;
  private readonly length: number;

  constructor(source: NativeSource, protocol: NetworkProtocol, knownLength: number) {
    super(protocol);
    this.source = source;
    this.length = knownLength;
  }

  knownLength(): number {
    return this.length;
  }

  available(): number {
    return this.avail;
  }

  /** True once end/error/cancel settled the native handle. */
  get isTerminal(): boolean {
    return this.terminal;
  }

  readInto(destination: Uint8Array): Promise<BodyReadResult> {
    try {
      if (!this.consumed) {
        this.lock("readInto");
        this.consumed = true;
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.readIntoLocked(destination);
  }

  protected readIntoLocked(destination: Uint8Array): Promise<BodyReadResult> {
    if (destination.length === 0) {
      return Promise.reject(
        new NetworkError(NET_ERROR.invalidRequest, "destination is empty", {
          operation: "readInto",
          protocol: this.protocol,
        }),
      );
    }
    if (this.waiter) {
      return Promise.reject(
        new NetworkError(NET_ERROR.busy, "a read is already pending", {
          operation: "readInto",
          protocol: this.protocol,
        }),
      );
    }
    const immediate = this.tryRead(destination);
    if (immediate) return Promise.resolve(immediate);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<BodyReadResult>((resolve, reject) => {
      this.waiter = { resolve, reject, dest: destination };
    });
  }

  /** Satisfy a read from visible bytes; null when nothing is readable yet. */
  private tryRead(destination: Uint8Array): BodyReadResult | null {
    if (this.avail > 0) {
      const want = Math.min(destination.length, this.avail);
      const got = this.source.pull(destination.subarray(0, want));
      if (got < 0) {
        this.avail = 0;
        if (!this.ended && !this.failure) {
          this.failure = new NetworkError(NET_ERROR.closed, "body handle is gone", {
            operation: "readInto",
            protocol: this.protocol,
          });
        }
        if (this.failure) return null;
        return { bytes: 0, done: true };
      }
      this.avail -= got;
      if (got > 0 || this.avail === 0) {
        return { bytes: got, done: this.ended && this.avail === 0 };
      }
    }
    if (this.ended) return { bytes: 0, done: true };
    return null;
  }

  private settleWaiter(): void {
    const w = this.waiter;
    if (!w) return;
    const result = this.tryRead(w.dest);
    if (result) {
      this.waiter = null;
      w.resolve(result);
      return;
    }
    if (this.failure) {
      this.waiter = null;
      w.reject(this.failure);
    }
  }

  /** Module callbacks (service pump delivery). */
  onReadable(avail: number): void {
    if (this.terminal) return;
    this.avail = Math.max(0, avail | 0);
    this.settleWaiter();
  }

  onEnd(): void {
    if (this.terminal) return;
    this.ended = true;
    this.terminal = true;
    this.settleWaiter();
    this.flushCancelWaiters();
  }

  onError(error: NetworkError): void {
    if (this.terminal) return;
    this.terminal = true;
    if (this.cancelRequested && error.code === NET_ERROR.cancelled) {
      // A cancel we asked for: readers observe EOF, not an error.
      this.ended = true;
      this.avail = 0;
    } else {
      this.failure = error;
      this.avail = 0;
    }
    this.settleWaiter();
    this.flushCancelWaiters();
  }

  private flushCancelWaiters(): void {
    const waiters = this.cancelWaiters;
    this.cancelWaiters = [];
    for (const w of waiters) w();
  }

  cancel(reason?: unknown): Promise<void> {
    this.locked = true;
    if (!this.cancelRequested) {
      this.cancelRequested = true;
      // Even after `end`, tell the module so unread native bytes are freed;
      // on a retired handle the op is a no-op by contract.
      this.source.cancel(reason);
    }
    this.avail = 0;
    if (this.terminal) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.cancelWaiters.push(resolve);
    });
  }
}

/** Bounded tee for `clone()`: two branches over one source, each branch
 * buffering what the other consumed first, up to `limitBytes`. When a branch
 * falls behind by more than the limit, the leading branch waits (backpressure
 * on the source) until the lagging branch reads or cancels. */
export function teeBody(
  source: BaseBody,
  protocol: NetworkProtocol,
  limitBytes: number,
): [TeeBranch, TeeBranch] {
  const shared = new TeeShared(source, protocol, limitBytes);
  return [shared.branch(0), shared.branch(1)];
}

class TeeShared {
  readonly buffers: [Uint8Array[], Uint8Array[]] = [[], []];
  readonly buffered: [number, number] = [0, 0];
  readonly cancelled: [boolean, boolean] = [false, false];
  readonly waiters: [(() => void) | null, (() => void) | null] = [null, null];
  ended = false;
  failure: unknown = null;
  pulling: Promise<void> | null = null;
  readonly source: BaseBody;
  readonly protocol: NetworkProtocol;
  readonly limit: number;

  constructor(source: BaseBody, protocol: NetworkProtocol, limit: number) {
    this.source = source;
    this.protocol = protocol;
    this.limit = limit;
    this.source["lock"]("clone");
  }

  branch(index: 0 | 1): TeeBranch {
    return new TeeBranch(this, index);
  }

  wake(index: 0 | 1): void {
    const w = this.waiters[index];
    if (w) {
      this.waiters[index] = null;
      w();
    }
  }

  /** Bytes one more pull may add without pushing a live branch past the
   * limit: the branch that pulls has drained its own queue, so the bound is
   * the other branch's backlog. */
  room(): number {
    let backlog = 0;
    for (const i of [0, 1] as const) {
      if (!this.cancelled[i] && this.buffered[i] > backlog) backlog = this.buffered[i];
    }
    return Math.min(16 * 1024, this.limit - backlog);
  }

  /** Pull one chunk from the source into both branch buffers. The chunk is
   * sized to the remaining room so a branch's backlog never exceeds
   * `limit` (a hard bound, not "stop after crossing it"). */
  pull(): Promise<void> {
    if (this.pulling) return this.pulling;
    const room = this.room();
    if (room <= 0) return Promise.resolve(); // the caller is blocked; it waits
    this.pulling = (async () => {
      const chunk = new Uint8Array(room);
      try {
        const { bytes, done } = await this.source["readIntoLocked"](chunk);
        if (bytes > 0) {
          const data = chunk.slice(0, bytes);
          for (const i of [0, 1] as const) {
            if (this.cancelled[i]) continue;
            this.buffers[i].push(data);
            this.buffered[i] += bytes;
          }
        }
        if (done) this.ended = true;
      } catch (error) {
        this.failure = error;
      } finally {
        this.pulling = null;
        this.wake(0);
        this.wake(1);
      }
    })();
    return this.pulling;
  }

  /** The other branch is too far behind to pull more. */
  blocked(index: 0 | 1): boolean {
    const other = index === 0 ? 1 : 0;
    return !this.cancelled[other] && this.buffered[other] >= this.limit;
  }

  async cancelBranch(index: 0 | 1, reason: unknown): Promise<void> {
    this.cancelled[index] = true;
    this.buffers[index] = [];
    this.buffered[index] = 0;
    const other = index === 0 ? 1 : 0;
    this.wake(other);
    if (this.cancelled[other]) await this.source.cancel(reason);
  }
}

export class TeeBranch extends BaseBody {
  private readonly shared: TeeShared;
  private readonly index: 0 | 1;
  private consumedOnce = false;

  constructor(shared: TeeShared, index: 0 | 1) {
    super(shared.protocol);
    this.shared = shared;
    this.index = index;
  }

  knownLength(): number {
    return this.shared.source.knownLength();
  }

  available(): number {
    return this.shared.buffered[this.index];
  }

  readInto(destination: Uint8Array): Promise<BodyReadResult> {
    try {
      if (!this.consumedOnce) {
        this.lock("readInto");
        this.consumedOnce = true;
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.readIntoLocked(destination);
  }

  protected async readIntoLocked(destination: Uint8Array): Promise<BodyReadResult> {
    if (destination.length === 0) {
      throw new NetworkError(NET_ERROR.invalidRequest, "destination is empty", {
        operation: "readInto",
        protocol: this.protocol,
      });
    }
    const s = this.shared;
    for (;;) {
      if (s.cancelled[this.index]) return { bytes: 0, done: true };
      const queue = s.buffers[this.index];
      if (queue.length) {
        let filled = 0;
        while (queue.length && filled < destination.length) {
          const head = queue[0];
          const n = Math.min(head.length, destination.length - filled);
          destination.set(head.subarray(0, n), filled);
          filled += n;
          if (n === head.length) queue.shift();
          else queue[0] = head.subarray(n);
        }
        s.buffered[this.index] -= filled;
        s.wake(this.index === 0 ? 1 : 0);
        return { bytes: filled, done: s.ended && queue.length === 0 };
      }
      if (s.failure) throw s.failure;
      if (s.ended) return { bytes: 0, done: true };
      if (s.blocked(this.index)) {
        await new Promise<void>((resolve) => {
          s.waiters[this.index] = resolve;
        });
        continue;
      }
      await s.pull();
    }
  }

  cancel(reason?: unknown): Promise<void> {
    this.locked = true;
    return this.shared.cancelBranch(this.index, reason);
  }
}

/** Convert an app-supplied body input into a stream the module can use, or
 * null when there is no body. */
export function bodyFromInput(
  input: NetworkData | BodyStream | AsyncIterable<Uint8Array> | null | undefined,
  operation: string,
  protocol: NetworkProtocol,
): BaseBody | AsyncIterable<Uint8Array> | null {
  if (input === null || input === undefined) return null;
  if (input instanceof BaseBody) return input;
  if (typeof input === "string" || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    return new MemoryBody(snapshotData(input as NetworkData, operation, protocol), protocol);
  }
  if (typeof (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    return input as AsyncIterable<Uint8Array>;
  }
  throw new NetworkError(NET_ERROR.invalidRequest, "unsupported body type", { operation, protocol });
}

export { BaseBody };
