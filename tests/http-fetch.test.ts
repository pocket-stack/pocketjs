import { describe, expect, test } from "bun:test";

import * as http from "../framework/src/net/http.ts";
import {
  Headers,
  NetworkError,
  Request,
  Response as PocketResponse,
} from "../framework/src/net/http.ts";
import {
  getHttpClientBinding,
  installHttpClientBindingForTesting,
  NETWORK_V1_ABI_MAJOR,
  NETWORK_V1_ABI_MINOR,
  NetworkV1CommandOpcode,
  NetworkV1EventCode,
} from "../framework/src/net/http-binding.ts";
import type {
  HttpClientPrivateBinding,
  HttpRequestStartCommand,
} from "../framework/src/net/http-binding.ts";
import { extractBody } from "../framework/src/net/http-body.ts";
import type { BodyStream } from "../framework/src/net/http-body.ts";

const HTTP_FEATURE = "network.http.client";
const TLS_FEATURE = "network.http.client.tls";

interface WptAllowlist {
  readonly status: string;
  readonly fetchSnapshot: string;
  readonly wptSnapshot: string;
  readonly cases: readonly {
    readonly path: string;
    readonly sourceSha256: string;
    readonly tests: readonly string[];
  }[];
}

const WPT_ALLOWLIST = await Bun.file(
  new URL("./http-fetch-wpt-allowlist.json", import.meta.url),
).json() as WptAllowlist;

test("pins the staged Fetch/WPT allowlist snapshots", () => {
  expect(WPT_ALLOWLIST).toMatchObject({
    status: "staged-partial-port",
    fetchSnapshot: "586cd2a44c2a865b37c166dc0740f3fb8bb220d6",
    wptSnapshot: "6437d68e10721ed4b9b68101ec1ab1a1b67a3995",
  });
  expect(WPT_ALLOWLIST.cases.map((entry) => [entry.path, entry.sourceSha256])).toEqual([
    [
      "fetch/api/headers/header-setcookie.any.js",
      "b587804553ca837bf953fea9b40c94237af803710f56f45e98750b450da42be2",
    ],
    [
      "fetch/api/headers/headers-combine.any.js",
      "8bc26fcc318dc1fb0d0b60f2a4dd6d5fdaa8ac2e148d20856f6186b5d4f4971d",
    ],
    [
      "fetch/api/headers/headers-errors.any.js",
      "4b4b9c8d9b72a52c5200feaa67f018cc91d05e9ee0c98a2a18ad56f44873047b",
    ],
    [
      "fetch/api/headers/headers-normalize.any.js",
      "8f914199d80ed14cd5dec7992464a10981e0b5b74fd26b70768f04f1fd1fb4c1",
    ],
  ]);
});

function frozenBinding(
  start: HttpClientPrivateBinding["start"],
  features: readonly string[] = [HTTP_FEATURE],
  alpnProtocols?: readonly string[],
  limitDefaults: Readonly<Partial<Record<
    | "http.bufferedBodyBytes"
    | "http.headerBytes"
    | "http.maxBodyChunkBytes"
    | "http.maxOperations"
    | "runtime.nativeBufferBytes",
    number
  >>> = {},
): HttpClientPrivateBinding {
  const featureSet = Object.freeze([...features]);
  const values = Object.freeze([
    Object.freeze({
      name: "http.bufferedBodyBytes",
      default: limitDefaults["http.bufferedBodyBytes"] ?? 8 * 1024 * 1024,
      hard: 8 * 1024 * 1024,
      minimum: 1,
    }),
    Object.freeze({
      name: "http.headerBytes",
      default: limitDefaults["http.headerBytes"] ?? 64 * 1024,
      hard: 64 * 1024,
      minimum: 1,
    }),
    Object.freeze({
      name: "http.maxBodyChunkBytes",
      default: limitDefaults["http.maxBodyChunkBytes"] ?? 64 * 1024,
      hard: 64 * 1024,
      minimum: 1,
    }),
    Object.freeze({
      name: "http.maxOperations",
      default: limitDefaults["http.maxOperations"] ?? 8,
      hard: 8,
      minimum: 1,
    }),
    Object.freeze({
      name: "runtime.nativeBufferBytes",
      default: limitDefaults["runtime.nativeBufferBytes"] ?? 512 * 1024,
      hard: 512 * 1024,
      minimum: 1,
    }),
  ]);
  return Object.freeze({
    abiMajor: NETWORK_V1_ABI_MAJOR,
    abiMinor: NETWORK_V1_ABI_MINOR,
    featureSet,
    httpClientLimits: Object.freeze({ values, features: featureSet }),
    ...(alpnProtocols === undefined
      ? {}
      : { alpnProtocols: Object.freeze([...alpnProtocols]) }),
    start,
  });
}

function okOperation(
  command: HttpRequestStartCommand,
  overrides: Partial<{
    status: number;
    statusText: string;
    headers: readonly { name: string; value: string }[];
    url: string;
    redirected: boolean;
    body: BodyStream | null;
    bufferedBodyBytes: number;
  }> = {},
  cancel: () => void = () => {},
) {
  return {
    response: Promise.resolve({
      eventCode: NetworkV1EventCode.HttpResponseHeaders as const,
      operationId: command.operationId,
      status: 200,
      statusText: "OK",
      headers: [],
      url: command.url,
      redirected: false,
      ...overrides,
    }),
    cancel,
  };
}

function streamFromBytes(bytes: Uint8Array): BodyStream {
  let offset = 0;
  let cancelled = false;
  return {
    async readInto(destination) {
      if (cancelled || offset === bytes.byteLength) return { bytes: 0, done: true };
      const count = Math.min(destination.byteLength, bytes.byteLength - offset);
      destination.set(bytes.subarray(offset, offset + count));
      offset += count;
      return { bytes: count, done: false };
    },
    async cancel() {
      cancelled = true;
      offset = bytes.byteLength;
    },
    async *[Symbol.asyncIterator]() {
      const destination = new Uint8Array(64);
      for (;;) {
        const result = await this.readInto(destination);
        if (result.done) return;
        yield destination.slice(0, result.bytes);
      }
    },
  };
}

function streamFromText(value: string): BodyStream {
  return streamFromBytes(new TextEncoder().encode(value));
}

const WPT_PORTED_CASES: Readonly<Record<string, () => void>> = Object.freeze({
  "Headers.prototype.get combines set-cookie headers in order": () => {
    const headers = new Headers([
      ["set-cookie", "foo=bar"],
      ["Set-Cookie", "fizz=buzz; domain=example.com"],
    ]);
    expect(headers.get("set-cookie")).toBe("foo=bar, fizz=buzz; domain=example.com");
  },
  "Headers iterator does not combine set-cookie headers": () => {
    expect([...new Headers([
      ["set-cookie", "foo=bar"],
      ["Set-Cookie", "fizz=buzz; domain=example.com"],
    ])]).toEqual([
      ["set-cookie", "foo=bar"],
      ["set-cookie", "fizz=buzz; domain=example.com"],
    ]);
  },
  "Headers iterator preserves set-cookie ordering": () => {
    expect([...new Headers([
      ["set-cookie", "z=z"],
      ["set-cookie", "a=a"],
      ["set-cookie", "n=n"],
    ])]).toEqual([
      ["set-cookie", "z=z"],
      ["set-cookie", "a=a"],
      ["set-cookie", "n=n"],
    ]);
  },
  "Headers.prototype.getSetCookie with multiple headers": () => {
    expect(new Headers([
      ["set-cookie", "foo=bar"],
      ["Set-Cookie", "fizz=buzz; domain=example.com"],
    ]).getSetCookie()).toEqual(["foo=bar", "fizz=buzz; domain=example.com"]);
  },
  "Set-Cookie is a forbidden response header": () => {
    const response = new PocketResponse();
    response.headers.append("Set-Cookie", "foo=bar");
    expect(response.headers.getSetCookie()).toEqual([]);
  },
  "Create headers using same name for different values": () => {
    const headers = new Headers([
      ["single", "singleValue"],
      ["double", "doubleValue1"],
      ["double", "doubleValue2"],
    ]);
    expect(headers.get("single")).toBe("singleValue");
    expect(headers.get("double")).toBe("doubleValue1, doubleValue2");
  },
  "Iterate combined values": () => {
    expect([...new Headers([["1", "a"], ["1", "b"]])]).toEqual([["1", "a, b"]]);
  },
  "Iterate combined values in sorted order": () => {
    expect([...new Headers([["2", "a"], ["1", "b"], ["2", "b"]])]).toEqual([
      ["1", "b"],
      ["2", "a, b"],
    ]);
  },
  "Create headers giving an array having one string as init argument": () => {
    expect(() => new Headers([["name"] as unknown as [string, string]])).toThrow(TypeError);
  },
  "Create headers giving an array having three strings as init argument": () => {
    expect(() => new Headers([
      ["invalid", "one", "two"] as unknown as [string, string],
    ])).toThrow(TypeError);
  },
  "Headers forEach throws if argument is not callable": () => {
    expect(() => new Headers([["name", "value"]]).forEach(undefined as never))
      .toThrow(TypeError);
  },
  "Create headers with not normalized values": () => {
    const headers = new Headers({ name1: " space ", name2: "\ttab\t", name4: "\r\n newLine" });
    expect([...headers]).toEqual([
      ["name1", "space"],
      ["name2", "tab"],
      ["name4", "newLine"],
    ]);
  },
  "Check append method with not normalized values": () => {
    const headers = new Headers();
    headers.append("name", "\t value \t");
    expect(headers.get("name")).toBe("value");
  },
  "Check set method with not normalized values": () => {
    const headers = new Headers();
    headers.set("name", "\r\n\tvalue\n");
    expect(headers.get("name")).toBe("value");
  },
});

describe("pinned WPT header subset", () => {
  for (const source of WPT_ALLOWLIST.cases) {
    for (const title of source.tests) {
      const implementation = WPT_PORTED_CASES[title];
      test(`${source.path}: ${title}`, () => {
        expect(implementation).toBeFunction();
        implementation!();
      });
    }
  }
  test("contains no unreferenced local ports", () => {
    const selected = new Set(WPT_ALLOWLIST.cases.flatMap((entry) => entry.tests));
    expect(Object.keys(WPT_PORTED_CASES).sort()).toEqual([...selected].sort());
  });
});

describe("HTTP Headers snapshot", () => {
  test("normalizes, combines duplicates, separates Set-Cookie, and sorts iteration", () => {
    const headers = new Headers([
      ["Z-Last", "  z  "],
      ["X-Test", "one"],
      ["x-test", "two"],
      ["Set-Cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);

    expect(headers.get("X-Test")).toBe("one, two");
    expect(headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect([...headers]).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
      ["x-test", "one, two"],
      ["z-last", "z"],
    ]);
    expect([...headers.keys()]).toEqual(["set-cookie", "set-cookie", "x-test", "z-last"]);
    expect([...headers.values()]).toEqual(["a=1", "b=2", "one, two", "z"]);

    const receiver = { seen: [] as unknown[] };
    headers.forEach(function (this: typeof receiver, value, key, owner) {
      this.seen.push([key, value, owner]);
    }, receiver);
    expect(receiver.seen[0]).toEqual(["set-cookie", "a=1", headers]);

    const live = new Headers([["fizz", "buzz"], ["x-header", "test"]]);
    const iterator = live[Symbol.iterator]();
    expect(iterator.next().value).toEqual(["fizz", "buzz"]);
    live.append("set-cookie", "a=b");
    expect(iterator.next().value).toEqual(["set-cookie", "a=b"]);
    live.append("accept", "text/html");
    expect(iterator.next().value).toEqual(["set-cookie", "a=b"]);
    expect(iterator.next().value).toEqual(["x-header", "test"]);
  });

  test("validates names, values, pair arity, and fixed safety ceilings", () => {
    expect(() => new Headers({ "bad name": "x" })).toThrow(TypeError);
    expect(() => new Headers({ good: "x\r\ninjected: yes" })).toThrow(TypeError);
    expect(() => new Headers({ good: "snowman ☃" })).toThrow(TypeError);
    expect(() => new Headers([["only-one"] as unknown as [string, string]])).toThrow(
      /exactly two/,
    );
    expect(() => new Headers(["ab" as unknown as [string, string]])).toThrow(TypeError);

    const normalized = new Headers({
      foldedEdge: "\r\n\tvalue\n",
      deployedControl: "\t\f\tvalue\n",
    });
    expect(normalized.get("foldedEdge")).toBe("value");
    expect(normalized.get("deployedControl")).toBe("\f\tvalue");
    expect(() => new Headers([["a", "b", "c"] as unknown as [string, string]])).toThrow(
      /exactly two/,
    );

    const infinitePair = {
      *[Symbol.iterator]() {
        for (;;) yield "x";
      },
    };
    expect(() => new Headers([infinitePair as unknown as [string, string]])).toThrow(
      /exactly two/,
    );

    const tooMany = Array.from({ length: 129 }, (_, index) => [`x-${index}`, "v"] as const);
    expect(() => new Headers(tooMany)).toThrow(NetworkError);
    try {
      new Headers(tooMany);
    } catch (error) {
      expect(error).toMatchObject({ code: "resource_limit", operation: "http.Headers" });
    }
  });

  test("captures Headers iterator records and result fields once", () => {
    let outerNextGets = 0;
    let pairNextGets = 0;
    let doneGets = 0;
    let valueGets = 0;
    const pair = {
      [Symbol.iterator]() {
        let index = 0;
        return {
          get next() {
            pairNextGets++;
            return () => {
              const current = index++;
              return {
                get done() {
                  doneGets++;
                  return current >= 2;
                },
                get value() {
                  valueGets++;
                  return current === 0 ? "x-once" : "yes";
                },
              };
            };
          },
        };
      },
    };
    const init = {
      [Symbol.iterator]() {
        let emitted = false;
        return {
          get next() {
            outerNextGets++;
            return () => emitted
              ? { done: true, value: undefined }
              : (emitted = true, { done: false, value: pair });
          },
        };
      },
    };
    const headers = new Headers(init as Iterable<readonly [string, string]>);
    expect(headers.get("x-once")).toBe("yes");
    expect({ outerNextGets, pairNextGets, doneGets, valueGets }).toEqual({
      outerNextGets: 1,
      pairNextGets: 1,
      doneGets: 3,
      valueGets: 2,
    });

    let pairReturnGets = 0;
    let outerReturnGets = 0;
    const badPair = {
      [Symbol.iterator]() {
        let count = 0;
        return {
          next: () => ({ done: false, value: count++ }),
          get return() {
            pairReturnGets++;
            return () => ({ done: true, value: undefined });
          },
        };
      },
    };
    const badInit = {
      [Symbol.iterator]() {
        return {
          next: () => ({ done: false, value: badPair }),
          get return() {
            outerReturnGets++;
            return () => ({ done: true, value: undefined });
          },
        };
      },
    };
    expect(() => new Headers(badInit as Iterable<readonly [string, string]>))
      .toThrow(/exactly two/);
    expect({ pairReturnGets, outerReturnGets }).toEqual({
      pairReturnGets: 1,
      outerReturnGets: 1,
    });
  });

  test("applies request and response guards", () => {
    const request = new Request("https://example.test/", {
      headers: {
        host: "attacker.test",
        trailer: "x-checksum",
        "proxy-secret": "no",
        "sec-pocket": "no",
        "x-http-method-override": "GET, TRACE",
        "x-visible": "yes",
      },
    });
    expect([...request.headers]).toEqual([["x-visible", "yes"]]);
    request.headers.append("x-http-method-override", '"GET, TRACE"');
    expect(request.headers.get("x-http-method-override")).toBe('"GET, TRACE"');
    request.headers.append("x-http-method-override", '"GET, TRACE", TRACK');
    expect(request.headers.get("x-http-method-override")).toBe('"GET, TRACE"');
    request.headers.set("host", "still-no");
    expect(request.headers.has("host")).toBe(false);

    const response = new PocketResponse(null, {
      headers: [["set-cookie", "hidden=1"], ["x-visible", "yes"]],
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("x-visible")).toBe("yes");
  });

  test("keeps request guards and TLS admission on captured intrinsics", () => {
    const result = Bun.spawnSync([
      "bun",
      "tests/fixtures/http-hostile-intrinsics.ts",
    ], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });
});

describe("HTTP Request and Response objects", () => {
  test("constructs Request values, snapshots data windows, and transfers input bodies", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const request = new Request("HTTP://EXAMPLE.TEST:80?q=1#fragment", {
      method: "post",
      body: bytes.subarray(1, 3),
      redirect: "manual",
    });
    bytes.fill(9);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://example.test/?q=1#fragment");
    expect(request.redirect).toBe("manual");
    expect(request.bodyUsed).toBe(false);
    expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([1, 2]);
    expect(request.bodyUsed).toBe(true);

    const source = new Request("https://example.test/upload", {
      method: "POST",
      body: "payload",
    });
    const moved = new Request(source);
    expect(source.bodyUsed).toBe(true);
    await expect(source.text()).rejects.toMatchObject({ code: "invalid_state" });
    expect(await moved.text()).toBe("payload");

    const controller = new http.AbortController();
    const signalled = new Request("https://example.test/", { signal: controller.signal });
    const signalledClone = signalled.clone();
    expect(signalled.signal).not.toBe(controller.signal);
    expect(signalledClone.signal).not.toBe(signalled.signal);
    controller.abort("stop");
    expect(signalled.signal).toMatchObject({ aborted: true, reason: "stop" });
    expect(signalledClone.signal).toMatchObject({ aborted: true, reason: "stop" });
  });

  test("rejects invalid methods, body combinations, URLs, and dictionaries", () => {
    for (const method of ["CONNECT", "trace", "bad method"]) {
      expect(() => new Request("https://example.test/", { method })).toThrow(TypeError);
    }
    expect(() => new Request("https://example.test/", { body: "x" })).toThrow(TypeError);
    expect(() => new Request("http://")).toThrow(TypeError);
    expect(() => new Request("http://user:pass@example.test/")).toThrow(TypeError);
    expect(() => new Request("http://example.test:bad/")).toThrow(TypeError);
    expect(() => new Request("http://example.test:65536/")).toThrow(TypeError);
    expect(() => new Request("http://[::::]/")).toThrow(TypeError);
    expect(new Request("http://example.test/%zz").url)
      .toBe("http://example.test/%zz");
    expect(new Request("http://example.test/a/../b").url)
      .toBe("http://example.test/b");
    expect(new Request("http://café.test/").url)
      .toBe("http://xn--caf-dma.test/");
    expect(new Request("http://[2001:0DB8:0:0:0:0:0:1]:80/").url)
      .toBe("http://[2001:db8::1]/");
    expect(() => new Request("https://example.test/", { redirect: "elsewhere" as never }))
      .toThrow(TypeError);
    expect(() => new Request("https://example.test/", { maxRedirects: 6 })).toThrow(TypeError);
    expect(() => new Request("https://example.test/", {
      tls: { verification: "broken" as never },
    })).toThrow(TypeError);

    expect(() => new Request("https://example.test/", {
      tls: { ca: new Uint8Array(64 * 1024 + 1) },
    })).toThrow(/custom CA exceeds/);
    expect(() => new Request("https://example.test/", {
      tls: { alpn: Array.from({ length: 17 }, (_, index) => `p${index}`) },
    })).toThrow(/ALPN cannot exceed/);
    expect(() => new Request("https://example.test/", {
      tls: { serverName: "a".repeat(254) },
    })).toThrow(/serverName/);
    expect(() => new Request("https://example.test/", {
      tls: { credential: "c".repeat(257) },
    })).toThrow(/credential id/);
    expect(() => new Request("https://example.test/", {
      limits: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`limit-${index}`, 1]),
      ),
    })).toThrow(/cannot exceed 32/);
    expect(() => new Request("https://example.test/", {
      limits: { ["x".repeat(65)]: 1 },
    })).toThrow(/limit name/);
  });

  test("snapshots WebIDL dictionaries and intrinsic byte views exactly once", async () => {
    const reads = new Map<string, number>();
    const values: Record<string, unknown> = {
      body: null,
      headers: undefined,
      limits: undefined,
      maxRedirects: 2,
      method: "GET",
      redirect: { toString: () => "manual" },
      ref: true,
      signal: undefined,
      timeouts: undefined,
      tls: undefined,
    };
    const init: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(values)) {
      Object.defineProperty(init, name, {
        enumerable: true,
        get() {
          reads.set(name, (reads.get(name) ?? 0) + 1);
          return value;
        },
      });
    }
    const request = new Request("http://example.test/#kept", init as http.RequestInit);
    expect(request.url).toBe("http://example.test/#kept");
    expect(request.redirect).toBe("manual");
    expect([...reads.values()]).toEqual(Array<number>(Object.keys(values).length).fill(1));

    let bodyReads = 0;
    const hostile = Object.defineProperty({ method: "GET" }, "body", {
      get() {
        bodyReads++;
        return bodyReads === 1 ? "forbidden" : null;
      },
    });
    expect(() => new Request("http://example.test/", hostile)).toThrow(/cannot have a body/);
    expect(bodyReads).toBe(1);

    const oversized = new Uint8Array(64 * 1024 + 1);
    Object.defineProperty(oversized, "byteLength", { get: () => 1 });
    expect(() => new Request("https://example.test/", {
      tls: { ca: oversized },
    })).toThrow(/custom CA exceeds/);

    const bytes = new Uint8Array([1, 2, 3]);
    Object.defineProperty(bytes, Symbol.iterator, {
      get() {
        throw new Error("user iterator must not run");
      },
    });
    const response = new PocketResponse(bytes);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  test("preserves an input Request body when RequestInit.body is null", async () => {
    const source = new Request("http://example.test/upload", {
      method: "POST",
      body: "payload",
    });
    const moved = new Request(source, { body: null });
    expect(await moved.text()).toBe("payload");
    expect(source.bodyUsed).toBe(true);
  });

  test("uses fixed WebIDL constructor lengths and Response conversions", () => {
    expect(Headers.length).toBe(0);
    expect(Request.length).toBe(1);
    expect(new PocketResponse(null, null).status).toBe(200);
    expect(new PocketResponse(null, { status: "201" as unknown as number }).status).toBe(201);
    expect(new PocketResponse(null, { status: 201.9 }).status).toBe(201);
    expect(new PocketResponse(null, { status: 65_736 }).status).toBe(200);
    expect(PocketResponse.redirect("http://example.test/", "302" as unknown as number).status)
      .toBe(302);
  });

  test("keeps internal abort propagation ahead of throwing user listeners", () => {
    const controller = new http.AbortController();
    controller.signal.addEventListener("abort", () => {
      throw new Error("user listener");
    });
    Object.defineProperty(controller.signal, "addEventListener", {
      value: () => { throw new Error("overridden method"); },
    });
    const request = new Request("http://example.test/", { signal: controller.signal });
    expect(() => controller.abort("stop")).not.toThrow();
    expect(request.signal).toMatchObject({ aborted: true, reason: "stop" });
  });

  test("supports bounded helpers, JSON constructors, redirects, and null-body statuses", async () => {
    const response = new PocketResponse("hello", {
      status: 201,
      statusText: "Created",
    });
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    expect(await response.text()).toBe("hello");
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: "invalid_state" });

    const json = PocketResponse.json({ answer: 42 });
    expect(json.headers.get("content-type")).toBe("application/json");
    expect(await json.json()).toEqual({ answer: 42 });
    expect(() => PocketResponse.json(undefined)).toThrow(TypeError);
    await expect(new PocketResponse("not json").json()).rejects.toBeInstanceOf(SyntaxError);

    const redirect = PocketResponse.redirect("https://example.test/next", 307);
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("https://example.test/next");
    expect(() => redirect.headers.set("location", "https://attacker.test/"))
      .toThrow(TypeError);
    expect(() => PocketResponse.redirect("https://example.test/", 305)).toThrow(RangeError);
    expect(() => new PocketResponse("x", { status: 204 })).toThrow(TypeError);
    expect(() => new PocketResponse(null, { status: 199 })).toThrow(RangeError);
  });
});

describe("bounded BodyStream behavior", () => {
  test("supports readInto and rejects empty, competing, or mixed readers", async () => {
    let release!: (value: IteratorResult<Uint8Array>) => void;
    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          next() {
            if (delivered) return Promise.resolve({ value: undefined, done: true as const });
            delivered = true;
            return new Promise<IteratorResult<Uint8Array>>((resolve) => {
              release = resolve;
            });
          },
        };
      },
    };
    const response = new PocketResponse(iterable);
    const destination = new Uint8Array(4);
    expect(response.body).not.toBeNull();
    await expect(response.body!.readInto(new Uint8Array())).rejects.toMatchObject({
      code: "invalid_state",
    });
    const pending = response.body!.readInto(destination);
    await expect(response.body!.readInto(destination)).rejects.toMatchObject({ code: "busy" });
    expect(() => response.body![Symbol.asyncIterator]()).toThrow(NetworkError);
    release({ value: new Uint8Array([1, 2]), done: false });
    expect(await pending).toEqual({ bytes: 2, done: false });
    expect([...destination.subarray(0, 2)]).toEqual([1, 2]);
    expect(await response.body!.readInto(destination)).toEqual({ bytes: 0, done: true });

    const hostileDestination = new Uint8Array(4);
    Object.defineProperties(hostileDestination, {
      byteLength: { get: () => { throw new Error("shadow byteLength"); } },
      buffer: { get: () => { throw new Error("shadow buffer"); } },
      byteOffset: { get: () => { throw new Error("shadow byteOffset"); } },
      set: { value: () => { throw new Error("shadow set"); } },
    });
    const hostileResponse = new PocketResponse("ok");
    expect(await hostileResponse.body!.readInto(hostileDestination)).toEqual({
      bytes: 2,
      done: false,
    });
    expect([hostileDestination[0], hostileDestination[1]]).toEqual([0x6f, 0x6b]);
  });

  test("rejects sequential and concurrent helper reuse", async () => {
    const sequential = new PocketResponse("value");
    expect(await sequential.text()).toBe("value");
    await expect(sequential.text()).rejects.toMatchObject({ code: "invalid_state" });

    const concurrent = new PocketResponse("value");
    const first = concurrent.text();
    await expect(concurrent.arrayBuffer()).rejects.toMatchObject({ code: "invalid_state" });
    expect(await first).toBe("value");

    const internal = extractBody("producer once").controller;
    const producer = internal.createProducer();
    expect(() => internal.createProducer()).toThrow(NetworkError);
    await producer.cancel();
  });

  test("tees two branches and backpressures a branch at the fixed ceiling", async () => {
    const small = new PocketResponse("clone me");
    const smallClone = small.clone();
    expect(await small.text()).toBe("clone me");
    expect(await smallClone.text()).toBe("clone me");
    expect(() => small.clone()).toThrow(NetworkError);

    const large = new PocketResponse(new Uint8Array(300_000));
    const lagging = large.clone();
    let settled = false;
    const aggregate = large.arrayBuffer().then((value) => {
      settled = true;
      return value;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    await lagging.body!.cancel();
    expect((await aggregate).byteLength).toBe(300_000);

    const bounded = new PocketResponse("bounded clones");
    const branches: PocketResponse[] = [bounded];
    for (let index = 0; index < 7; index++) branches.push(bounded.clone());
    expect(() => bounded.clone()).toThrow(NetworkError);
    try {
      bounded.clone();
    } catch (error) {
      expect(error).toMatchObject({ code: "resource_limit" });
    }
    await Promise.all(branches.map((branch) => branch.body!.cancel()));
  });

  test("calls an AsyncIterable return hook at most once on cancellation", async () => {
    let returns = 0;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ value: new Uint8Array([1]), done: false }),
          return: async () => {
            returns++;
            return { value: undefined, done: true };
          },
        };
      },
    };
    const response = new PocketResponse(body);
    await response.body!.readInto(new Uint8Array(1));
    await response.body!.cancel();
    await response.body!.cancel();
    expect(returns).toBe(1);
  });

  test("snapshots iterator and BodyStream result fields once", async () => {
    let valueReads = 0;
    let nextCalls = 0;
    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            nextCalls++;
            if (nextCalls > 1) return { value: undefined, done: true };
            return Object.defineProperty({ done: false }, "value", {
              get() {
                valueReads++;
                return new Uint8Array([7]);
              },
            }) as IteratorResult<Uint8Array>;
          },
        };
      },
    };
    expect(await new PocketResponse(iterable).text()).toBe("\u0007");
    expect(valueReads).toBe(1);

    let bytesReads = 0;
    let doneReads = 0;
    let emitted = false;
    const stream: BodyStream = {
      async readInto(destination) {
        if (emitted) return { bytes: 0, done: true };
        emitted = true;
        destination[0] = 9;
        return {
          get bytes() {
            bytesReads++;
            return 1;
          },
          get done() {
            doneReads++;
            return false;
          },
        };
      },
      async cancel() {},
      async *[Symbol.asyncIterator]() {},
    };
    expect([...new Uint8Array(await new PocketResponse(stream).arrayBuffer())]).toEqual([9]);
    expect(bytesReads).toBe(1);
    expect(doneReads).toBe(1);
  });

  test("coalesces one-byte sources under fixed aggregate and tee segment counts", async () => {
    let remaining = 20_000;
    const tiny: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        while (remaining-- > 0) yield new Uint8Array([0x61]);
      },
    };
    const response = new PocketResponse(tiny);
    const clone = response.clone();
    const [left, right] = await Promise.all([response.text(), clone.text()]);
    expect(left.length).toBe(20_000);
    expect(right).toBe(left);
  });
});

describe("private lexical HTTP binding seam", () => {
  test("is absent from the public module and never reads or writes a global binding", async () => {
    expect("installHttpClientBindingForTesting" in http).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(globalThis, "__POCKET_NETWORK_BINDING_V1__"))
      .toBe(false);
    expect(Object.prototype.hasOwnProperty.call(globalThis, "net")).toBe(false);
    await expect(http.fetch("https://example.test/")).rejects.toMatchObject({
      code: "unsupported",
      operation: "http.fetch",
    });
  });

  test("requires one frozen ABI-compatible table and captures a safe snapshot", () => {
    const mutable = { ...frozenBinding(() => { throw new Error("unused"); }) };
    expect(() => installHttpClientBindingForTesting(mutable)).toThrow(/frozen/);

    const incomplete = frozenBinding(() => { throw new Error("unused"); });
    const incompleteLimits = Object.freeze({
      values: Object.freeze(incomplete.httpClientLimits.values.slice(1)),
      features: incomplete.httpClientLimits.features,
    });
    expect(() => installHttpClientBindingForTesting(Object.freeze({
      ...incomplete,
      httpClientLimits: incompleteLimits,
    }))).toThrow(/omit required http\.bufferedBodyBytes/);

    const binding = frozenBinding(() => { throw new Error("unused"); });
    const cleanup = installHttpClientBindingForTesting(binding);
    expect(getHttpClientBinding()).not.toBe(binding);
    expect(getHttpClientBinding()).toMatchObject({
      abiMajor: NETWORK_V1_ABI_MAJOR,
      abiMinor: NETWORK_V1_ABI_MINOR,
      featureSet: [HTTP_FEATURE],
    });
    expect(() => installHttpClientBindingForTesting(binding)).toThrow(/already installed/);
    cleanup();
    expect(getHttpClientBinding()).toBeUndefined();
  });

  test("rejects binding accessors without invoking them and bypasses a hostile call property", async () => {
    const base = frozenBinding((command) => okOperation(command));
    let limitsGetterCalls = 0;
    const accessorBinding = { ...base } as Record<PropertyKey, unknown>;
    Object.defineProperty(accessorBinding, "httpClientLimits", {
      enumerable: true,
      get() {
        limitsGetterCalls++;
        return base.httpClientLimits;
      },
    });
    Object.freeze(accessorBinding);
    expect(() => installHttpClientBindingForTesting(
      accessorBinding as unknown as HttpClientPrivateBinding,
    )).toThrow(/own data property/);
    expect(limitsGetterCalls).toBe(0);

    let callGetterCalls = 0;
    const start = ((command: HttpRequestStartCommand) => okOperation(command)) as
      HttpClientPrivateBinding["start"];
    Object.defineProperty(start, "call", {
      get() {
        callGetterCalls++;
        throw new Error("hostile Function.call getter must remain unreachable");
      },
    });
    const cleanup = installHttpClientBindingForTesting(frozenBinding(start));
    try {
      const response = await http.fetch("http://example.test/");
      expect(response.status).toBe(200);
      expect(callGetterCalls).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("marshals a numeric request command and wraps Host values in SDK identities", async () => {
    let seenCommand: HttpRequestStartCommand | undefined;
    let seenSignal: unknown;
    let uploaded: number[] = [];
    const binding = frozenBinding((command, producer, signal) => {
      seenCommand = command;
      seenSignal = signal;
      const operation = okOperation(command, {
        status: 404,
        statusText: "Not Found",
        headers: [
          { name: "set-cookie", value: "a=1" },
          { name: "set-cookie", value: "b=2" },
          { name: "x-source", value: "binding" },
        ],
        body: streamFromText("response body"),
      });
      const upload = (async () => {
        if (!producer) return;
        for (;;) {
          const chunk = await producer.pull(2);
          if (chunk === null) break;
          uploaded.push(...chunk);
        }
      })();
      return {
        ...operation,
        response: upload.then(() => operation.response),
      };
    }, [HTTP_FEATURE, TLS_FEATURE]);
    const cleanup = installHttpClientBindingForTesting(binding);
    try {
      const controller = new http.AbortController();
      const response = await http.fetch("https://example.test/upload#client-only", {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
        signal: controller.signal,
        headers: [["x-request", "yes"], ["trailer", "no"]],
      });
      await Bun.sleep(0);
      expect(seenCommand).toMatchObject({
        opcode: NetworkV1CommandOpcode.HttpRequestStart,
        url: "https://example.test/upload",
        method: "POST",
        hasBody: true,
        redirect: "follow",
        maxRedirects: 5,
        ref: true,
      });
      expect(Object.isFrozen(seenCommand)).toBe(true);
      expect(seenCommand!.headers).toEqual([
        { name: "x-request", value: "yes" },
      ]);
      expect(seenSignal).toBeInstanceOf(http.AbortSignal);
      expect(seenSignal).not.toBe(controller.signal);
      expect(uploaded).toEqual([1, 2, 3]);

      expect(response).toBeInstanceOf(PocketResponse);
      expect(response).not.toBeInstanceOf(globalThis.Response);
      expect(response.headers).toBeInstanceOf(Headers);
      expect(response.status).toBe(404);
      expect(response.ok).toBe(false);
      expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
      expect(() => response.headers.set("x-source", "changed")).toThrow(TypeError);
      expect(await response.text()).toBe("response body");
    } finally {
      cleanup();
    }
  });

  test("fails TLS feature and option preflight before calling start", async () => {
    const cases: Array<{
      features: readonly string[];
      url: string;
      tls?: http.TlsOptions;
      alpn?: readonly string[];
    }> = [
      { features: [HTTP_FEATURE], url: "https://example.test/" },
      {
        features: [HTTP_FEATURE, TLS_FEATURE],
        url: "https://example.test/",
        tls: { ca: new Uint8Array([1]) },
      },
      {
        features: [HTTP_FEATURE, TLS_FEATURE],
        url: "https://example.test/",
        tls: { credential: "device" },
      },
      {
        features: [HTTP_FEATURE, TLS_FEATURE],
        url: "https://example.test/",
        tls: { alpn: ["http/1.1"] },
        alpn: ["http/1.1"],
      },
      {
        features: [HTTP_FEATURE, TLS_FEATURE],
        url: "https://example.test/",
        tls: { minVersion: "1.3" },
      },
      {
        features: [HTTP_FEATURE, TLS_FEATURE],
        url: "https://example.test/",
        tls: { revocation: "required" },
      },
      {
        features: [HTTP_FEATURE, TLS_FEATURE],
        url: "https://example.test/",
        tls: { verification: "development-insecure" },
      },
      {
        features: [HTTP_FEATURE, TLS_FEATURE],
        url: "https://example.test/",
        tls: { serverName: "other.test" },
      },
      {
        features: [HTTP_FEATURE, TLS_FEATURE],
        url: "http://example.test/",
        tls: { verification: "full" },
      },
    ];

    for (const item of cases) {
      let starts = 0;
      const cleanup = installHttpClientBindingForTesting(frozenBinding(
        (command) => {
          starts++;
          return okOperation(command);
        },
        item.features,
        item.alpn,
      ));
      try {
        await expect(http.fetch(item.url, { tls: item.tls })).rejects.toMatchObject({
          code: "unsupported",
        });
        expect(starts).toBe(0);
      } finally {
        cleanup();
      }
    }
  });

  test("applies admitted header, body, and operation limits before Host start", async () => {
    let starts = 0;
    const cleanup = installHttpClientBindingForTesting(frozenBinding(
      (command) => {
        starts++;
        return okOperation(command);
      },
      [HTTP_FEATURE],
      undefined,
      {
        "http.bufferedBodyBytes": 8,
        "http.headerBytes": 24,
        "http.maxBodyChunkBytes": 4,
      },
    ));
    try {
      await expect(http.fetch("http://example.test/", {
        headers: [["x-large", "01234567890123456789"]],
      })).rejects.toMatchObject({ code: "resource_limit" });
      await expect(http.fetch("http://example.test/", {
        method: "POST",
        body: new Uint8Array(9),
      })).rejects.toMatchObject({ code: "resource_limit" });
      await expect(http.fetch("http://example.test/", {
        limits: { "http.maxBodyChunkBytes": 5 },
      })).rejects.toThrow(/admitted minimum\/default range/);
      await expect(http.fetch("http://example.test/", {
        limits: { "http.unknown": 1 },
      })).rejects.toThrow(/admitted minimum\/default range/);
      expect(starts).toBe(0);

      const response = await http.fetch("http://example.test/", {
        limits: { "http.maxBodyChunkBytes": 4 },
      });
      expect(response.status).toBe(200);
      expect(starts).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("lowers response helper credits and ceilings to admitted defaults", async () => {
    const observedCredits: number[] = [];
    let offset = 0;
    const body: BodyStream = {
      async readInto(destination) {
        observedCredits.push(destination.byteLength);
        if (offset === 7) return { bytes: 0, done: true };
        const count = Math.min(destination.byteLength, 7 - offset);
        destination.fill(0x61, 0, count);
        offset += count;
        return { bytes: count, done: false };
      },
      async cancel() {},
      async *[Symbol.asyncIterator]() {},
    };
    const cleanup = installHttpClientBindingForTesting(frozenBinding(
      (command) => okOperation(command, { body, bufferedBodyBytes: 6 }),
      [HTTP_FEATURE],
      undefined,
      {
        "http.bufferedBodyBytes": 6,
        "http.maxBodyChunkBytes": 2,
      },
    ));
    try {
      const response = await http.fetch("http://example.test/");
      await expect(response.text()).rejects.toMatchObject({ code: "resource_limit" });
      expect(observedCredits.length).toBeGreaterThan(0);
      expect(observedCredits.every((credit) => credit <= 2)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("bounds response helpers using Host metadata", async () => {
    const cleanup = installHttpClientBindingForTesting(frozenBinding((command) =>
      okOperation(command, {
        body: streamFromText("12345"),
        bufferedBodyBytes: 4,
      })));
    try {
      const response = await http.fetch("http://example.test/");
      await expect(response.text()).rejects.toMatchObject({ code: "resource_limit" });
    } finally {
      cleanup();
    }
  });

  test("cancels operation and both body directions after invalid binding metadata", async () => {
    let operationCancels = 0;
    let requestCancels = 0;
    let responseCancels = 0;
    const requestBody: BodyStream = {
      readInto: async () => new Promise(() => {}),
      cancel: async () => { requestCancels++; },
      async *[Symbol.asyncIterator]() {},
    };
    const responseBody: BodyStream = {
      readInto: async () => new Promise(() => {}),
      cancel: async () => { responseCancels++; },
      async *[Symbol.asyncIterator]() {},
    };
    const cleanup = installHttpClientBindingForTesting(frozenBinding((command) =>
      okOperation(command, {
        status: 99,
        body: responseBody,
      }, () => { operationCancels++; })));
    try {
      await expect(http.fetch("http://example.test/", {
        method: "POST",
        body: requestBody,
      })).rejects.toMatchObject({ code: "http_protocol_error" });
      await Bun.sleep(0);
      expect(operationCancels).toBe(1);
      expect(requestCancels).toBe(1);
      expect(responseCancels).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("snapshots response event fields once and rejects non-string headers", async () => {
    let statusReads = 0;
    let bodyReads = 0;
    const cleanup = installHttpClientBindingForTesting(frozenBinding((command) => ({
      response: Promise.resolve({
        eventCode: NetworkV1EventCode.HttpResponseHeaders,
        operationId: command.operationId,
        get status() {
          statusReads++;
          return statusReads === 1 ? 200 : 99;
        },
        statusText: "OK",
        headers: [],
        url: command.url,
        redirected: false,
        get body() {
          bodyReads++;
          return bodyReads === 1 ? null : streamFromText("hidden");
        },
      }),
      cancel() {},
    })));
    try {
      const response = await http.fetch("http://example.test/");
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
      expect(statusReads).toBe(1);
      expect(bodyReads).toBe(1);
    } finally {
      cleanup();
    }

    const badHeaderCleanup = installHttpClientBindingForTesting(frozenBinding((command) =>
      okOperation(command, {
        headers: [{ name: 123 as unknown as string, value: "no" }],
      })));
    try {
      await expect(http.fetch("http://example.test/")).rejects.toMatchObject({
        code: "http_protocol_error",
      });
    } finally {
      badHeaderCleanup();
    }
  });

  test("rejects and cancels binding bodies forbidden by HEAD and null-body statuses", async () => {
    for (const item of [
      { method: "HEAD", status: 200 },
      { method: "GET", status: 204 },
      { method: "GET", status: 205 },
      { method: "GET", status: 304 },
    ]) {
      let operationCancels = 0;
      let bodyCancels = 0;
      const body: BodyStream = {
        readInto: async () => new Promise(() => {}),
        cancel: async () => { bodyCancels++; },
        async *[Symbol.asyncIterator]() {},
      };
      const cleanup = installHttpClientBindingForTesting(frozenBinding((command) =>
        okOperation(command, {
          status: item.status,
          body,
        }, () => { operationCancels++; })));
      try {
        await expect(http.fetch("http://example.test/", { method: item.method }))
          .rejects.toMatchObject({ code: "http_protocol_error" });
        await Bun.sleep(0);
        expect(operationCancels).toBe(1);
        expect(bodyCancels).toBe(1);
      } finally {
        cleanup();
      }
    }
  });

  test("maps unknown error event strings to http_protocol_error", async () => {
    const cleanup = installHttpClientBindingForTesting(frozenBinding((command) => ({
      response: Promise.reject({
        eventCode: NetworkV1EventCode.HttpRequestError,
        operationId: command.operationId,
        category: "runtime",
        code: "made_up",
        message: "bad binding",
      }),
      cancel() {},
    })));
    try {
      await expect(http.fetch("http://example.test/")).rejects.toMatchObject({
        category: "protocol",
        code: "http_protocol_error",
      });
    } finally {
      cleanup();
    }
  });

  test("rejects protocol codes belonging to another network protocol", async () => {
    const cleanup = installHttpClientBindingForTesting(frozenBinding((command) => ({
      response: Promise.reject({
        eventCode: NetworkV1EventCode.HttpRequestError,
        operationId: command.operationId,
        category: "protocol",
        code: "mqtt_protocol_error",
        message: "wrong protocol",
      }),
      cancel() {},
    })));
    try {
      await expect(http.fetch("http://example.test/")).rejects.toMatchObject({
        code: "http_protocol_error",
      });
    } finally {
      cleanup();
    }
  });

  test("does not publish binding-provided error messages", async () => {
    const cleanup = installHttpClientBindingForTesting(frozenBinding((command) => ({
      response: Promise.reject({
        eventCode: NetworkV1EventCode.HttpRequestError,
        operationId: command.operationId,
        category: "transport",
        code: "connection_refused",
        message: "Authorization: secret-value",
        causeCode: "ECONNREFUSED",
      }),
      cancel() {},
    })));
    try {
      let failure: unknown;
      try {
        await http.fetch("http://example.test/");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "connection_refused",
        causeCode: "ECONNREFUSED",
      });
      expect(String((failure as Error).message)).not.toContain("secret-value");
    } finally {
      cleanup();
    }
  });

  test("normalizes bounded NetworkError metadata from the binding", async () => {
    const cleanup = installHttpClientBindingForTesting(frozenBinding(() => ({
      response: Promise.reject(new NetworkError("Cookie: secret-value", {
        category: "transport",
        code: "connection_refused",
        operation: "native.connect",
        temporary: true,
        address: "EXAMPLE.TEST.",
        port: 80,
        protocol: "http",
        causeCode: "ECONNREFUSED",
        reasonCode: 7,
      })),
      cancel() {},
    })));
    try {
      let failure: unknown;
      try {
        await http.fetch("http://example.test/");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        message: "HTTP request failed with connection_refused",
        operation: "http.fetch",
        temporary: true,
        address: "example.test",
        port: 80,
        causeCode: "ECONNREFUSED",
        reasonCode: 7,
      });
      expect(String((failure as Error).message)).not.toContain("secret-value");
    } finally {
      cleanup();
    }
  });

  test("rejects unsafe NetworkError metadata from the binding", async () => {
    const unsafe = new NetworkError("secret-value", {
      category: "transport",
      code: "connection_refused",
      operation: "native.connect",
      address: "Authorization: secret-value",
      port: 80,
    });
    (unsafe as unknown as { temporary: unknown }).temporary = "yes";
    const cleanup = installHttpClientBindingForTesting(frozenBinding(() => ({
      response: Promise.reject(unsafe),
      cancel() {},
    })));
    try {
      await expect(http.fetch("http://example.test/")).rejects.toMatchObject({
        code: "http_protocol_error",
        address: undefined,
      });
    } finally {
      cleanup();
    }
  });

  test("retires uploads when response headers arrive", async () => {
    let uploadCancels = 0;
    const requestBody: BodyStream = {
      readInto: async () => new Promise(() => {}),
      cancel: async () => { uploadCancels++; },
      async *[Symbol.asyncIterator]() {},
    };
    const cleanup = installHttpClientBindingForTesting(frozenBinding((command) =>
      okOperation(command)));
    try {
      await http.fetch("http://example.test/", {
        method: "POST",
        body: requestBody,
      });
      await Bun.sleep(0);
      expect(uploadCancels).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("keeps abort active until every cloned response branch terminates", async () => {
    let operationCancels = 0;
    let bodyCancels = 0;
    const responseBody: BodyStream = {
      readInto: async () => new Promise(() => {}),
      cancel: async () => { bodyCancels++; },
      async *[Symbol.asyncIterator]() {},
    };
    const cleanup = installHttpClientBindingForTesting(frozenBinding((command) =>
      okOperation(command, { body: responseBody }, () => { operationCancels++; })));
    try {
      const controller = new http.AbortController();
      const response = await http.fetch("http://example.test/", {
        signal: controller.signal,
      });
      const clone = response.clone();
      await response.body!.cancel();
      expect(operationCancels).toBe(0);
      expect(bodyCancels).toBe(0);

      controller.abort();
      await Bun.sleep(0);
      expect(operationCancels).toBe(1);
      expect(bodyCancels).toBe(1);
      expect(await clone.body!.readInto(new Uint8Array(1))).toEqual({
        bytes: 0,
        done: true,
      });
    } finally {
      cleanup();
    }
  });

  test("detaches abort propagation after a bodyless operation terminates", async () => {
    let bindingSignal: http.AbortSignal | undefined;
    let operationCancels = 0;
    const cleanup = installHttpClientBindingForTesting(frozenBinding((command, _body, signal) => {
      bindingSignal = signal;
      return okOperation(command, {}, () => { operationCancels++; });
    }));
    try {
      const controller = new http.AbortController();
      await http.fetch("http://example.test/", { signal: controller.signal });
      controller.abort();
      await Bun.sleep(0);
      expect(bindingSignal?.aborted).toBe(false);
      expect(operationCancels).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("dispatches numeric cancellation on AbortSignal", async () => {
    let cancelOpcode: number | undefined;
    let cancels = 0;
    const cleanup = installHttpClientBindingForTesting(frozenBinding((_command) => ({
      response: new Promise(() => {}),
      cancel(command) {
        cancels++;
        cancelOpcode = command.opcode;
      },
    })));
    try {
      const controller = new http.AbortController();
      const pending = http.fetch("http://example.test/", { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "aborted" });
      expect(cancelOpcode).toBe(NetworkV1CommandOpcode.OperationCancel);
      expect(cancels).toBe(1);
    } finally {
      cleanup();
    }
  });
});
