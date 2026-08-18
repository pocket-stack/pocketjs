import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bodyFromBinding,
  type BodyController,
  type BodyStream,
  extractBody,
} from "../framework/src/net/http-body.ts";

async function captureReadFault(controller: BodyController): Promise<unknown> {
  try {
    await controller.stream.readInto(new Uint8Array(4));
  } catch (error) {
    return error;
  }
  throw new Error("expected HTTP body read to fail");
}

function rejectOwnCall<T extends Function>(operation: T): T {
  Object.defineProperty(operation, "call", {
    configurable: true,
    value() {
      throw new Error("user function .call must not be read");
    },
  });
  return operation;
}

describe("HTTP body iterator records", () => {
  test("snapshots the iterator factory, next, and return getters once", async () => {
    let iteratorFactoryReads = 0;
    let iteratorFactoryCalls = 0;
    let nextReads = 0;
    let nextCalls = 0;
    let returnReads = 0;
    let returnCalls = 0;
    let factoryReceiver: unknown;
    let nextReceiver: unknown;
    let returnReceiver: unknown;

    const iterator = Object.create(null) as AsyncIterator<Uint8Array>;
    Object.defineProperties(iterator, {
      next: {
        get() {
          nextReads++;
          if (nextReads !== 1) throw new Error("next getter read twice");
          return rejectOwnCall(async function (this: unknown) {
            nextReceiver = this;
            nextCalls++;
            return { value: new Uint8Array([1, 2]), done: false };
          });
        },
      },
      return: {
        get() {
          returnReads++;
          if (returnReads !== 1) throw new Error("return getter read twice");
          return rejectOwnCall(async function (this: unknown) {
            returnReceiver = this;
            returnCalls++;
            return { value: undefined, done: true };
          });
        },
      },
    });

    const iterable = Object.create(null) as AsyncIterable<Uint8Array>;
    Object.defineProperty(iterable, Symbol.asyncIterator, {
      get() {
        iteratorFactoryReads++;
        if (iteratorFactoryReads !== 1) throw new Error("iterator getter read twice");
        return rejectOwnCall(function (this: unknown) {
          factoryReceiver = this;
          iteratorFactoryCalls++;
          return iterator;
        });
      },
    });

    const controller = extractBody(iterable).controller;
    expect(iteratorFactoryReads).toBe(1);
    expect(await controller.stream.readInto(new Uint8Array(2))).toEqual({
      bytes: 2,
      done: false,
    });
    await controller.stream.cancel("stop");
    await controller.stream.cancel("ignored");

    expect(iteratorFactoryCalls).toBe(1);
    expect(nextReads).toBe(1);
    expect(nextCalls).toBe(1);
    expect(returnReads).toBe(1);
    expect(returnCalls).toBe(1);
    expect(factoryReceiver).toBe(iterable);
    expect(nextReceiver).toBe(iterator);
    expect(returnReceiver).toBe(iterator);
  });
});

test("HTTP body execution survives post-load call and Promise poisoning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketjs-http-body-intrinsics-"));
  const resultPath = join(directory, "result.json");
  const bodyUrl = new URL("../framework/src/net/http-body.ts", import.meta.url).href;
  const source = `
    const body = await import(${JSON.stringify(bodyUrl)});
    const defineProperty = Object.defineProperty;
    const callDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "call");
    const resolveDescriptor = Object.getOwnPropertyDescriptor(Promise, "resolve");
    const thenDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
    const poisonedCall = () => { throw new Error("poisoned Function.prototype.call used"); };
    const poisonedResolve = () => { throw new Error("poisoned Promise.resolve used"); };
    const poisonedThen = () => { throw new Error("poisoned Promise.prototype.then used"); };
    let cancelCalls = 0;
    let readResult;
    let faultNames;
    let faultMessages;
    try {
      defineProperty(Function.prototype, "call", { ...callDescriptor, value: poisonedCall });
      defineProperty(Promise, "resolve", { ...resolveDescriptor, value: poisonedResolve });
      defineProperty(Promise.prototype, "then", { ...thenDescriptor, value: poisonedThen });

      const iterable = {
        [Symbol.asyncIterator]() {
          let delivered = false;
          return {
            async next() {
              if (delivered) return { value: undefined, done: true };
              delivered = true;
              return { value: new Uint8Array([0x61]), done: false };
            },
          };
        },
      };
      const controller = body.extractBody(iterable).controller;
      const destination = new Uint8Array(1);
      readResult = await controller.stream.readInto(destination);

      const faulty = {
        async readInto() { return { bytes: 0, done: false }; },
        async cancel() { cancelCalls++; },
        [Symbol.asyncIterator]() { throw new Error("unused"); },
      };
      const first = body.extractBody(faulty).controller;
      const second = first.tee();
      const faults = [];
      for (const branch of [first, second]) {
        try {
          await branch.stream.readInto(new Uint8Array(1));
        } catch (error) {
          faults.push(error);
        }
      }
      faultNames = faults.map((error) => error?.name);
      faultMessages = faults.map((error) => error?.message);
    } finally {
      defineProperty(Function.prototype, "call", callDescriptor);
      defineProperty(Promise, "resolve", resolveDescriptor);
      defineProperty(Promise.prototype, "then", thenDescriptor);
    }
    await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
      readResult,
      cancelCalls,
      faultNames,
      faultMessages,
    }));
  `;

  try {
    const script = join(directory, "body-intrinsics.ts");
    await Bun.write(script, source);
    const child = Bun.spawn([process.execPath, script], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(await Bun.file(resultPath).json()).toEqual({
      readResult: { bytes: 1, done: false },
      cancelCalls: 1,
      faultNames: ["NetworkError", "NetworkError"],
      faultMessages: [
        "HTTP BodyStream returned an invalid readInto result",
        "HTTP BodyStream returned an invalid readInto result",
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("HTTP body tee fault ownership", () => {
  const sourceFault = new Error("source fault");
  const cases: readonly {
    readonly title: string;
    readonly readInto: BodyStream["readInto"];
    readonly expected?: unknown;
  }[] = [
    {
      title: "zero-byte non-terminal read",
      readInto: async () => ({ bytes: 0, done: false }),
    },
    {
      title: "read beyond granted credit",
      readInto: async (destination) => ({ bytes: destination.byteLength + 1, done: false }),
    },
    {
      title: "invalid read result",
      readInto: async () => null as never,
    },
    {
      title: "source exception",
      readInto: async () => {
        throw sourceFault;
      },
      expected: sourceFault,
    },
  ];

  for (let index = 0; index < cases.length; index++) {
    const faultCase = cases[index]!;
    test(`cancels once and preserves ${faultCase.title}`, async () => {
      let cancelCalls = 0;
      let cancelReason: unknown;
      const cancellationFault = new Error("cancellation fault");
      const stream: BodyStream = {
        readInto: faultCase.readInto,
        async cancel(reason) {
          cancelCalls++;
          cancelReason = reason;
          throw cancellationFault;
        },
        [Symbol.asyncIterator]() {
          throw new Error("BodyStream iterator must not be used by the tee");
        },
      };
      const first = extractBody(stream).controller;
      const second = first.tee();

      const firstFault = await captureReadFault(first);
      const secondFault = await captureReadFault(second);

      expect(firstFault).toBe(faultCase.expected ?? secondFault);
      expect(secondFault).toBe(firstFault);
      expect(firstFault).not.toBe(cancellationFault);
      expect(cancelReason).toBe(firstFault);
      expect(cancelCalls).toBe(1);
    });
  }

  test("reuses bounded tee segments for one-byte chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-http-body-segments-"));
    const resultPath = join(directory, "result.json");
    const bodyUrl = new URL("../framework/src/net/http-body.ts", import.meta.url).href;
    const source = `
      const OriginalUint8Array = Uint8Array;
      let segmentAllocations = 0;
      globalThis.Uint8Array = new Proxy(OriginalUint8Array, {
        construct(target, argumentsList) {
          if (argumentsList[0] === 64 * 1024) segmentAllocations++;
          return Reflect.construct(target, argumentsList, target);
        },
      });
      const body = await import(${JSON.stringify(bodyUrl)});
      let remaining = 4096;
      const source = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (remaining-- === 0) return { value: undefined, done: true };
              return { value: new OriginalUint8Array([0x61]), done: false };
            },
          };
        },
      };
      const first = body.extractBody(source).controller;
      const second = first.tee();
      const outputs = await Promise.all([
        first.aggregate("http.body.test"),
        second.aggregate("http.body.test"),
      ]);
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
        firstBytes: outputs[0].byteLength,
        equal: outputs[1].every((value, index) => value === outputs[0][index]),
        segmentAllocations,
      }));
    `;

    try {
      const script = join(directory, "body-segments.ts");
      await Bun.write(script, source);
      const child = Bun.spawn([process.execPath, script], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const result = await Bun.file(resultPath).json();
      expect(result.firstBytes).toBe(4096);
      expect(result.equal).toBe(true);
      expect(result.segmentAllocations).toBeGreaterThan(0);
      expect(result.segmentAllocations).toBeLessThanOrEqual(6);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("admitted HTTP body limits", () => {
  const limits = Object.freeze({
    bufferedBytes: 6,
    chunkBytes: 2,
    teeBranchBytes: 4,
  });

  test("rejects buffered inputs and async chunks above admitted defaults", async () => {
    expect(() => extractBody("1234567", limits)).toThrow(/exceeds 6 bytes/);
    expect(() => extractBody(new Uint8Array(7), limits)).toThrow(/exceeds 6 bytes/);

    const iterable: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1, 2, 3]);
      },
    };
    const controller = extractBody(iterable, limits).controller;
    await expect(controller.stream.readInto(new Uint8Array(2))).rejects.toMatchObject({
      code: "resource_limit",
    });
  });

  test("uses admitted chunk credit and tee backpressure", async () => {
    const credits: number[] = [];
    const stream: BodyStream = {
      async readInto(destination) {
        credits.push(destination.byteLength);
        destination.fill(0x61);
        return { bytes: destination.byteLength, done: false };
      },
      async cancel() {},
      async *[Symbol.asyncIterator]() {},
    };
    const first = extractBody(stream, limits).controller;
    const second = first.tee();
    const destination = new Uint8Array(2);
    expect(await first.stream.readInto(destination)).toEqual({ bytes: 2, done: false });
    expect(await first.stream.readInto(destination)).toEqual({ bytes: 2, done: false });

    let settled = false;
    const blocked = first.stream.readInto(destination).then((result) => {
      settled = true;
      return result;
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    await second.stream.cancel("release backpressure");
    expect(await blocked).toEqual({ bytes: 2, done: false });
    expect(credits.length).toBeGreaterThan(0);
    expect(credits.every((credit) => credit <= 2)).toBe(true);
    await first.stream.cancel();
  });

  test("prefetches ignored small binding bodies without losing later reads", async () => {
    const bytes = new TextEncoder().encode("hey");
    let offset = 0;
    let reads = 0;
    const stream: BodyStream = {
      async readInto(destination) {
        reads++;
        if (offset === bytes.byteLength) return { bytes: 0, done: true };
        const count = Math.min(destination.byteLength, bytes.byteLength - offset);
        destination.set(bytes.subarray(offset, offset + count));
        offset += count;
        return { bytes: count, done: false };
      },
      async cancel() {},
      async *[Symbol.asyncIterator]() {},
    };
    const controller = bodyFromBinding(stream, limits);
    await Bun.sleep(0);
    expect(offset).toBe(bytes.byteLength);
    expect(reads).toBeGreaterThan(1);
    expect(new TextDecoder().decode(await controller.aggregate("http.body.test"))).toBe("hey");
  });

  test("stops ignored large binding bodies at the admitted prefetch window", async () => {
    let reads = 0;
    let cancels = 0;
    const stream: BodyStream = {
      async readInto(destination) {
        reads++;
        destination[0] = 0x61;
        return { bytes: 1, done: false };
      },
      async cancel() { cancels++; },
      async *[Symbol.asyncIterator]() {},
    };
    const controller = bodyFromBinding(stream, limits);
    await Bun.sleep(0);
    expect(reads).toBe(limits.teeBranchBytes);
    await controller.stream.cancel();
    expect(cancels).toBe(1);
  });
});
