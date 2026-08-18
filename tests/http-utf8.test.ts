import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeUtf8, encodeUtf8 } from "../framework/src/net/utf8.ts";

function encoded(value: string, maximumBytes = 1024): number[] | null {
  const bytes = encodeUtf8(value, maximumBytes);
  return bytes === null ? null : Array.from(bytes);
}

describe("PocketJS HTTP UTF-8 codec", () => {
  test("encodes scalar values and replaces unpaired surrogates", () => {
    expect(encoded("A\u00a2\u20ac\ud83d\ude00")).toEqual([
      0x41,
      0xc2, 0xa2,
      0xe2, 0x82, 0xac,
      0xf0, 0x9f, 0x98, 0x80,
    ]);
    expect(encoded("A\ud800B\udc00C")).toEqual([
      0x41,
      0xef, 0xbf, 0xbd,
      0x42,
      0xef, 0xbf, 0xbd,
      0x43,
    ]);
    expect(encoded("", 0)).toEqual([]);
    expect(encoded("\u20ac", 2)).toBeNull();
    expect(encoded("\u20ac", 3)).toEqual([0xe2, 0x82, 0xac]);
  });

  test("decodes scalar values with default replacement and BOM behavior", () => {
    expect(decodeUtf8(new Uint8Array([
      0x41,
      0xc2, 0xa2,
      0xe2, 0x82, 0xac,
      0xf0, 0x9f, 0x98, 0x80,
    ]), 10)).toBe("A\u00a2\u20ac\ud83d\ude00");
    expect(decodeUtf8(
      new Uint8Array([0xef, 0xbb, 0xbf, 0x41]),
      4,
    )).toBe("A");
    expect(decodeUtf8(new Uint8Array([
      0xef, 0xbb, 0xbf,
      0xef, 0xbb, 0xbf,
      0x41,
    ]), 7)).toBe("\ufeffA");
    expect(decodeUtf8(new Uint8Array([
      0x61,
      0xef, 0xbb, 0xbf,
      0x62,
    ]), 5)).toBe("a\ufeffb");
    expect(decodeUtf8(new Uint8Array(), 0)).toBe("");
    expect(decodeUtf8(new Uint8Array([0x61]), 0)).toBeNull();
  });

  test("uses maximal-subpart replacement for malformed input", () => {
    const cases: readonly [readonly number[], string][] = [
      [[0xe2, 0x28, 0xa1], "\ufffd(\ufffd"],
      [[0xe2, 0x82, 0x28], "\ufffd("],
      [[0xe0, 0x80, 0x80], "\ufffd\ufffd\ufffd"],
      [[0xf0, 0x90, 0x80, 0x41], "\ufffdA"],
      [[0x80, 0xc0, 0xaf], "\ufffd\ufffd\ufffd"],
      [[0xed, 0xa0, 0x80], "\ufffd\ufffd\ufffd"],
      [[0xf4, 0x90, 0x80, 0x80], "\ufffd\ufffd\ufffd\ufffd"],
      [[0xe2, 0x82], "\ufffd"],
    ];
    for (const [bytes, expected] of cases) {
      expect(decodeUtf8(new Uint8Array(bytes), bytes.length)).toBe(expected);
    }
  });
});

test("HTTP text paths work without encoding globals or mutable intrinsics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketjs-http-utf8-"));
  const script = join(directory, "probe.ts");
  const resultPath = join(directory, "result.json");
  const stdoutPath = join(directory, "stdout.log");
  const stderrPath = join(directory, "stderr.log");
  const httpUrl = new URL("../framework/src/net/http.ts", import.meta.url).href;
  const codecUrl = new URL("../framework/src/net/utf8.ts", import.meta.url).href;
  const source = `
    const defineProperty = Object.defineProperty;
    defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    defineProperty(globalThis, "TextDecoder", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    const Uint8ArrayIntrinsic = Uint8Array;
    const [http, codec] = await Promise.all([
      import(${JSON.stringify(httpUrl)}),
      import(${JSON.stringify(codecUrl)}),
    ]);
    if (typeof globalThis.TextEncoder !== "undefined" ||
        typeof globalThis.TextDecoder !== "undefined") {
      throw new Error("encoding globals unexpectedly reappeared");
    }

    const descriptors = {
      apply: Object.getOwnPropertyDescriptor(Reflect, "apply"),
      charCodeAt: Object.getOwnPropertyDescriptor(String.prototype, "charCodeAt"),
      fromCharCode: Object.getOwnPropertyDescriptor(String, "fromCharCode"),
      isSafeInteger: Object.getOwnPropertyDescriptor(Number, "isSafeInteger"),
      join: Object.getOwnPropertyDescriptor(Array.prototype, "join"),
      uint8Array: Object.getOwnPropertyDescriptor(globalThis, "Uint8Array"),
    };
    let encodedBuffer;
    let decoded;
    let json;
    let directEncoded;
    try {
      const poisoned = () => { throw new Error("poisoned intrinsic used"); };
      defineProperty(Reflect, "apply", { ...descriptors.apply, value: poisoned });
      defineProperty(String.prototype, "charCodeAt", {
        ...descriptors.charCodeAt,
        value: poisoned,
      });
      defineProperty(String, "fromCharCode", {
        ...descriptors.fromCharCode,
        value: poisoned,
      });
      defineProperty(Number, "isSafeInteger", {
        ...descriptors.isSafeInteger,
        value: poisoned,
      });
      defineProperty(Array.prototype, "join", {
        ...descriptors.join,
        value: poisoned,
      });
      defineProperty(globalThis, "Uint8Array", {
        ...descriptors.uint8Array,
        value: function PoisonedUint8Array() {
          throw new Error("poisoned Uint8Array used");
        },
      });

      encodedBuffer = new Uint8ArrayIntrinsic(
        await new http.Response("A\\ud800\\ud83d\\udca9").arrayBuffer(),
      );
      decoded = await new http.Response(new Uint8ArrayIntrinsic([
        0xef, 0xbb, 0xbf, 0x61, 0xe2, 0x28, 0xa1,
      ])).text();
      json = await new http.Response(new Uint8ArrayIntrinsic([
        0xef, 0xbb, 0xbf, 0x7b, 0x22, 0x6f, 0x6b, 0x22,
        0x3a, 0x74, 0x72, 0x75, 0x65, 0x7d,
      ])).json();
      directEncoded = codec.encodeUtf8("\\udc00", 3);
    } finally {
      defineProperty(Reflect, "apply", descriptors.apply);
      defineProperty(String.prototype, "charCodeAt", descriptors.charCodeAt);
      defineProperty(String, "fromCharCode", descriptors.fromCharCode);
      defineProperty(Number, "isSafeInteger", descriptors.isSafeInteger);
      defineProperty(Array.prototype, "join", descriptors.join);
      defineProperty(globalThis, "Uint8Array", descriptors.uint8Array);
    }
    await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
      encoded: Array.from(encodedBuffer),
      decoded,
      json,
      directEncoded: Array.from(directEncoded),
    }));
  `;

  try {
    await Bun.write(script, source);
    const child = Bun.spawn({
      cmd: ["bun", script],
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([
      Bun.file(stdoutPath).text(),
      Bun.file(stderrPath).text(),
    ]);
    expect(
      exitCode,
      `exit=${exitCode} signal=${String(child.signalCode)}\n${stdout}\n${stderr}`,
    ).toBe(0);
    expect(await Bun.file(resultPath).json()).toEqual({
      encoded: [
        0x41,
        0xef, 0xbf, 0xbd,
        0xf0, 0x9f, 0x92, 0xa9,
      ],
      decoded: "a\ufffd(\ufffd",
      json: { ok: true },
      directEncoded: [0xef, 0xbf, 0xbd],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
