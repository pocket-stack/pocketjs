// HTTP Client SDK (`@pocketjs/framework/net/http` fetch) + deterministic sim
// host (hosts/sim/net.ts): tick-boundary delivery, streaming bodies through
// readInto, aggregate helpers, cancellation, error mapping and the support
// module (URL, Headers, AbortController, NetworkError).

import { afterEach, describe, expect, test } from "bun:test";

import { NET_ERROR } from "../contracts/spec/net.ts";
import { fetch as pocketFetch, Headers, Request, Response, type NetOps } from "../framework/src/net/http.ts";
import { AbortController, NetworkError, URL, getNetworkLimits } from "../framework/src/net/index.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createSimNetHost } from "../hosts/sim/net.ts";

function mount(ns: NetOps): void {
  (globalThis as { net?: NetOps }).net = ns;
}

afterEach(() => {
  delete (globalThis as { net?: NetOps }).net;
});

/** Run `n` host ticks, each followed by the framework service pump and a
 * microtask drain (the job drain of that tick). */
async function ticks(host: { tick(): void }, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    host.tick();
    runServicePumps();
    // Promise reactions of this tick's deliveries.
    for (let j = 0; j < 8; j++) await Promise.resolve();
  }
}

describe("net SDK + deterministic sim host", () => {
  test("fetch resolves only after a tick boundary and keeps polling lazy", async () => {
    const host = createSimNetHost({
      "http://example.test/message": {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"message":"你好"}',
      },
    });
    mount(host.ns);

    runServicePumps();
    expect(host.pollCalls()).toBe(0); // no pending handle: no native poll

    let settled = false;
    const promise = pocketFetch("http://example.test/message").then((response) => {
      settled = true;
      return response;
    });
    runServicePumps();
    await Promise.resolve();
    expect(settled).toBe(false); // transport has not crossed a tick boundary
    expect(host.pollCalls()).toBe(1);

    await ticks(host);
    const response = await promise;
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.url).toBe("http://example.test/message");
    const json = response.json<{ message: string }>();
    await ticks(host);
    expect(await json).toEqual({ message: "你好" });
    expect(response.bodyUsed).toBe(true);
    expect(host.live()).toBe(0);

    const pollsAfterSettle = host.pollCalls();
    runServicePumps();
    runServicePumps();
    expect(host.pollCalls()).toBe(pollsAfterSettle); // pump unregistered itself
  });

  test("bodies stream through readInto across ticks with backpressure", async () => {
    const host = createSimNetHost({
      "http://example.test/stream": {
        body: ["abc", "def", "ghi", "jkl"],
        chunkTicks: 1,
        length: null,
      },
    });
    mount(host.ns);
    const promise = pocketFetch("http://example.test/stream");
    await ticks(host); // head + first chunk
    const response = await promise;
    expect(response.headers.has("content-length")).toBe(false);
    const seen: string[] = [];
    const reader = (async () => {
      for await (const chunk of response.body!) seen.push(new TextDecoder().decode(chunk));
    })();
    for (let i = 0; i < 6; i++) await ticks(host);
    await reader;
    expect(seen).toEqual(["abc", "def", "ghi", "jkl"]);
    expect(host.live()).toBe(0);
  });

  test("readInto: one pending read, empty destination rejected, EOF only as {0,true}", async () => {
    const host = createSimNetHost({ "http://example.test/two": { body: ["12", "34"], chunkTicks: 1 } });
    mount(host.ns);
    const promise = pocketFetch("http://example.test/two");
    await ticks(host);
    const response = await promise;
    const body = response.body!;
    await expect(body.readInto(new Uint8Array(0))).rejects.toMatchObject({ code: NET_ERROR.invalidRequest });
    const buf = new Uint8Array(8);
    const first = await body.readInto(buf);
    expect(first).toEqual({ bytes: 2, done: false });
    const second = body.readInto(buf.subarray(2));
    await expect(body.readInto(new Uint8Array(1))).rejects.toMatchObject({ code: NET_ERROR.busy });
    await ticks(host);
    // The last bytes and `end` land in the same batch: the read that took
    // the bytes reports done only once EOF was observed, so the next read
    // is the {0,true} EOF marker.
    expect((await second).bytes).toBe(2);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("1234");
    expect(await body.readInto(buf)).toEqual({ bytes: 0, done: true });
    // The stream is locked: text() must fail with invalid_state.
    await expect(response.text()).rejects.toMatchObject({ code: NET_ERROR.invalidState });
  });

  test("aggregate helpers cancel past their limit with response_too_large", async () => {
    const host = createSimNetHost({
      "http://example.test/big": { body: "x".repeat(2048), length: null, chunkTicks: 0 },
    });
    mount(host.ns);
    const promise = pocketFetch("http://example.test/big", { limits: { aggregateBytes: 1024 } });
    await ticks(host);
    const response = await promise;
    const text = response.text();
    await ticks(host, 2);
    await expect(text).rejects.toMatchObject({ code: NET_ERROR.responseTooLarge });
    expect(host.log.some((l) => l.startsWith("cancel"))).toBe(true);
    await ticks(host);
    expect(host.live()).toBe(0);
  });

  test("known Content-Length above the limit fails before reading", async () => {
    const host = createSimNetHost({ "http://example.test/len": { body: "x".repeat(4096) } });
    mount(host.ns);
    const promise = pocketFetch("http://example.test/len", { limits: { aggregateBytes: 100 } });
    await ticks(host);
    const response = await promise;
    const bytes = response.arrayBuffer();
    await ticks(host, 2);
    await expect(bytes).rejects.toBeInstanceOf(NetworkError);
  });

  test("clone tees the body; both branches read the same bytes", async () => {
    const host = createSimNetHost({ "http://example.test/clone": { body: ["hello ", "world"], chunkTicks: 1 } });
    mount(host.ns);
    const promise = pocketFetch("http://example.test/clone");
    await ticks(host);
    const original = await promise;
    const copy = original.clone();
    const a = original.text();
    const b = copy.text();
    await ticks(host, 4);
    expect(await a).toBe("hello world");
    expect(await b).toBe("hello world");
    expect(() => original.clone()).toThrow(NetworkError);
  });

  test("clone's tee is a hard bound: the lagging branch never holds more than the aggregate limit", async () => {
    // 3 KiB body in 1 KiB chunks, a 2 KiB aggregate limit: the branch that
    // is not read may buffer at most 2 KiB; the reading branch then waits
    // (backpressure on the source) until the other branch drains.
    const chunk = "x".repeat(1024);
    const host = createSimNetHost({ "http://example.test/tee": { body: [chunk, chunk, chunk], chunkTicks: 1 } });
    mount(host.ns);
    const promise = pocketFetch("http://example.test/tee", { limits: { aggregateBytes: 2048 } });
    await ticks(host);
    const original = await promise;
    const copy = original.clone();
    const reader = original.body!;
    // TeeBranch (the runtime class behind the clone's BodyStream) exposes
    // its backlog; the test reads it through the class, not the public type.
    const lagging = copy.body as unknown as import("../framework/src/net/body.ts").TeeBranch;
    let read = 0;
    const sink = new Uint8Array(256);
    // Drive the leading branch as fast as the sim delivers.
    const pump = (async () => {
      for (;;) {
        const { bytes, done } = await reader.readInto(sink);
        read += bytes;
        if (done) break;
      }
    })();
    await ticks(host, 6);
    // The leading branch is throttled by the bound: it cannot run ahead of
    // the lagging branch by more than 2 KiB, whatever the source offers.
    expect(read).toBeLessThanOrEqual(2048);
    expect(lagging.available()).toBeLessThanOrEqual(2048);
    expect(lagging.available()).toBe(read);
    // Draining the lagging branch releases the leading one.
    const drained = lagging.readInto(new Uint8Array(4096));
    await ticks(host, 6);
    expect((await drained).bytes).toBeGreaterThan(0);
    await pump;
    expect(read).toBe(3072);
    await lagging.cancel();
    await ticks(host, 2);
  });

  test("HEAD and 204 responses have a null body and retire on end", async () => {
    const host = createSimNetHost({
      "http://example.test/head": { status: 200, headers: { "content-length": "42" }, length: 42, body: "" },
      "http://example.test/nocontent": { status: 204, body: "" },
    });
    mount(host.ns);
    const head = pocketFetch("http://example.test/head", { method: "HEAD" });
    const none = pocketFetch("http://example.test/nocontent");
    await ticks(host);
    expect((await head).body).toBeNull();
    expect((await none).body).toBeNull();
    expect((await none).status).toBe(204);
    expect(await (await head).text()).toBe("");
    expect(host.live()).toBe(0);
  });

  test("errors map onto NetworkError with the stable code and category", async () => {
    const host = createSimNetHost({
      "http://example.test/dns": { error: { code: "dns", message: "no such host" } },
      "http://example.test/late": { body: ["ab", "cd"], chunkTicks: 1, error: { code: "closed", message: "peer reset", afterHeaders: true } },
    });
    mount(host.ns);
    const failing = pocketFetch("http://example.test/dns");
    await ticks(host);
    const error = await failing.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ code: "dns", category: "resolver", operation: "fetch", protocol: "http", temporary: true });

    const late = pocketFetch("http://example.test/late");
    await ticks(host);
    const response = await late;
    const text = response.text();
    await ticks(host, 3);
    await expect(text).rejects.toMatchObject({ code: "closed", category: "runtime" });
    expect(host.live()).toBe(0);
  });

  test("synchronous refusals reject without touching the pump", async () => {
    const host = createSimNetHost({});
    mount(host.ns);
    await expect(pocketFetch("http://example.test/none")).rejects.toMatchObject({ code: NET_ERROR.permissionDenied });
    await expect(pocketFetch("https://example.test/tls")).rejects.toMatchObject({ code: NET_ERROR.unsupported });
    await expect(pocketFetch("ftp://example.test/x")).rejects.toMatchObject({ code: NET_ERROR.invalidRequest });
    await expect(pocketFetch("http://example.test/x", { method: "TRACE" })).rejects.toMatchObject({ code: NET_ERROR.invalidRequest });
    await expect(pocketFetch("http://example.test/x", { method: "GET", body: "nope" })).rejects.toMatchObject({ code: NET_ERROR.invalidRequest });
    await expect(pocketFetch("http://user:pw@example.test/x")).rejects.toMatchObject({ code: NET_ERROR.invalidRequest });
    expect(host.pollCalls()).toBe(0);
    runServicePumps();
    expect(host.pollCalls()).toBe(0);
  });

  test("the namespace missing yields unavailable, not a crash", async () => {
    await expect(pocketFetch("http://example.test/x")).rejects.toMatchObject({ code: NET_ERROR.unavailable });
    expect(getNetworkLimits().httpClient).toBeNull();
  });

  test("AbortSignal cancels; the terminal event settles at the next tick", async () => {
    const host = createSimNetHost({ "http://example.test/slow": { body: "later", delayTicks: 5 } });
    mount(host.ns);
    const controller = new AbortController();
    const promise = pocketFetch("http://example.test/slow", { signal: controller.signal });
    await ticks(host);
    controller.abort();
    let settled = false;
    promise.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // nothing settles inside abort()
    await ticks(host);
    await expect(promise).rejects.toMatchObject({ code: NET_ERROR.cancelled });
    expect(host.live()).toBe(0);
    // Already-aborted signals refuse synchronously.
    const done = new AbortController();
    done.abort();
    await expect(pocketFetch("http://example.test/slow", { signal: done.signal })).rejects.toMatchObject({ code: NET_ERROR.cancelled });
  });

  test("request bodies cross as one borrowed snapshot; headers reach the host lowercased", async () => {
    let seen: { method: string; body: Uint8Array; headers: Record<string, string> } | null = null;
    const host = createSimNetHost({
      "http://example.test/echo": (request) => {
        seen = { method: request.method, body: request.body, headers: { ...request.headers } };
        return { status: 201, body: request.body };
      },
    });
    mount(host.ns);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const promise = pocketFetch("http://example.test/echo", {
      method: "post",
      body: bytes,
      headers: { "X-Trace": "  abc  ", Host: "evil.test", Cookie: "a=1" },
    });
    bytes[0] = 99; // after start(): the snapshot is unaffected
    await ticks(host);
    const response = await promise;
    expect(seen!.method).toBe("POST");
    expect([...seen!.body]).toEqual([1, 2, 3, 4]);
    expect(seen!.headers["x-trace"]).toBe("abc");
    expect(seen!.headers.host).toBeUndefined(); // core-owned header dropped by the request guard
    expect(seen!.headers.cookie).toBe("a=1"); // explicit cookies are allowed
    const echoed = response.arrayBuffer();
    await ticks(host);
    expect([...new Uint8Array(await echoed)]).toEqual([1, 2, 3, 4]);
  });

  test("getNetworkLimits reflects the mounted module", () => {
    const host = createSimNetHost({});
    mount(host.ns);
    const limits = getNetworkLimits();
    expect(limits.httpClient?.specMajor).toBe(2);
    expect(limits.httpClient?.features).toEqual([]);
    expect(limits.websocketClient).toBeNull();
    expect(Object.isFrozen(limits)).toBe(true);
  });
});

describe("net support module", () => {
  test("URL parses, resolves and normalizes the special schemes", () => {
    const u = new URL("HTTP://Example.TEST:80/a/./b/../c?q=1#frag");
    expect(u.href).toBe("http://example.test/a/c?q=1#frag");
    expect(u.protocol).toBe("http:");
    expect(u.hostname).toBe("example.test");
    expect(u.port).toBe("");
    expect(u.effectivePort).toBe(80);
    expect(u.origin).toBe("http://example.test");
    expect(new URL("https://h:8443/x").port).toBe("8443");
    expect(new URL("/other?y", "http://a.test/p/q").href).toBe("http://a.test/other?y");
    expect(new URL("rel", "http://a.test/p/q").href).toBe("http://a.test/p/rel");
    expect(new URL("//b.test/z", "http://a.test/p").href).toBe("http://b.test/z");
    expect(new URL("http://[::1]:8080/").host).toBe("[::1]:8080");
    expect(new URL("ws://h/a b").pathname).toBe("/a%20b");
    expect(URL.canParse("http://")).toBe(false);
    expect(URL.canParse("nope")).toBe(false);
    expect(() => new URL("http://exa mple.test/")).toThrow(TypeError);
    expect(new URL("mailto:someone@x").protocol).toBe("mailto:");
  });

  test("Headers normalizes, combines, sorts and splits Set-Cookie", () => {
    const h = new Headers([
      ["Content-Type", " text/plain "],
      ["set-cookie", "a=1"],
      ["Set-Cookie", "b=2"],
      ["accept", "x"],
    ]);
    h.append("Accept", "y");
    expect(h.get("accept")).toBe("x, y");
    expect(h.get("content-type")).toBe("text/plain");
    expect(h.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect([...h.keys()]).toEqual(["accept", "content-type", "set-cookie", "set-cookie"]);
    expect(() => h.set("bad name", "v")).toThrow(NetworkError);
    expect(() => h.set("x", "a\r\nb")).toThrow(NetworkError);
    h.delete("accept");
    expect(h.has("accept")).toBe(false);
  });

  test("Request/Response constructors validate and lock bodies", async () => {
    const request = new Request("http://a.test/x", { method: "post", body: "hi", headers: { "x-a": "1" } });
    expect(request.method).toBe("POST");
    expect(request.bodyUsed).toBe(false);
    const copy = request.clone();
    expect(await request.text()).toBe("hi");
    expect(request.bodyUsed).toBe(true);
    expect(await copy.text()).toBe("hi");
    await expect(request.text()).rejects.toMatchObject({ code: NET_ERROR.invalidState });
    expect(() => new Request("http://a.test/x", { redirect: "sometimes" as "follow" })).toThrow(NetworkError);

    const response = Response.json({ ok: true }, { status: 201 });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json<{ ok: boolean }>()).toEqual({ ok: true });
    expect(response.bodyUsed).toBe(true);
    const redirect = Response.redirect("http://b.test/", 307);
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("http://b.test/");
    expect(() => new Response("x", { status: 204 })).toThrow(NetworkError);
    expect(() => new Response(null, { status: 199 })).toThrow(NetworkError);
  });
});
