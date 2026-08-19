// HTTP Server SDK (`serve()` in `@pocketjs/framework/net/http`) + deterministic
// sim host (hosts/sim/httpd.ts): listen/stop lifecycle, request delivery in
// the service pump, streaming request bodies, one-shot and streamed responses
// through respond/write/endBody with drain, error handler fallbacks and
// aborted requests.

import { afterEach, describe, expect, test } from "bun:test";

import { NET_ERROR } from "../contracts/spec/net.ts";
import { Response, serve, type HttpdOps } from "../framework/src/net/http.ts";
import { NetworkError } from "../framework/src/net/index.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createSimHttpdHost } from "../hosts/sim/httpd.ts";

function mount(ns: HttpdOps): void {
  (globalThis as { httpd?: HttpdOps }).httpd = ns;
}

afterEach(() => {
  delete (globalThis as { httpd?: HttpdOps }).httpd;
});

async function ticks(host: { tick(): void }, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    host.tick();
    runServicePumps();
    for (let j = 0; j < 12; j++) await Promise.resolve();
  }
}

describe("httpd SDK + deterministic sim host", () => {
  test("serve resolves on listening; handlers answer in the same tick", async () => {
    const host = createSimHttpdHost();
    mount(host.ns);
    const seen: string[] = [];
    const listening = serve({
      hostname: "0.0.0.0",
      port: 8080,
      fetch(request) {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response("hello", { headers: { "x-served": "1" } });
      },
    });
    let settled = false;
    listening.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await ticks(host);
    const server = await listening;
    expect(server.port).toBe(8080);
    expect(server.url).toBe("http://0.0.0.0:8080/");

    const injected = host.inject({ method: "GET", target: "/hello?x=1" });
    await ticks(host);
    expect(seen).toEqual(["GET /hello"]);
    expect(injected.responded).toBe(true);
    expect(injected.complete).toBe(true);
    expect(injected.status).toBe(200);
    expect(injected.headers["x-served"]).toBe("1");
    expect(injected.headers["content-type"]).toBe("text/plain;charset=UTF-8");
    expect(injected.text()).toBe("hello");
    expect(host.live()).toBe(0);

    const stopped = server.stop({ graceful: true, timeout: 100 });
    await ticks(host);
    await stopped;
    expect(host.log.at(-1)).toBe("stop 1 true 100");
  });

  test("request bodies stream through readInto; async handlers respond later", async () => {
    const host = createSimHttpdHost();
    mount(host.ns);
    const listening = serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const text = await request.text();
        return Response.json({ echo: text, len: request.headers.get("content-length") });
      },
    });
    await ticks(host);
    const server = await listening;
    expect(server.port).toBeGreaterThanOrEqual(40000);
    const injected = host.inject({ method: "POST", target: "/echo", body: ["ab", "cd", "ef"], chunkTicks: 1 });
    await ticks(host, 5);
    expect(injected.complete).toBe(true);
    expect(JSON.parse(injected.text())).toEqual({ echo: "abcdef", len: "6" });
  });

  test("streamed responses use respond(end=false) + write + endBody and honour drain", async () => {
    const host = createSimHttpdHost();
    host.sendQueueBytes = 4;
    mount(host.ns);
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5, 6, 7]);
    }
    const listening = serve({
      hostname: "127.0.0.1",
      port: 9000,
      fetch() {
        return new Response(chunks() as unknown as AsyncIterable<Uint8Array>, { status: 200 });
      },
    });
    await ticks(host);
    await listening;
    const injected = host.inject({ target: "/stream" });
    await ticks(host, 6);
    expect(injected.complete).toBe(true);
    expect([...injected.body()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(host.log.filter((l) => l.startsWith("write")).length).toBe(2);
    expect(host.log.some((l) => l.startsWith("endBody"))).toBe(true);
  });

  test("a one-shot body that does not fit the send queue falls back to streaming", async () => {
    const host = createSimHttpdHost();
    host.sendQueueBytes = 5;
    mount(host.ns);
    const listening = serve({
      hostname: "127.0.0.1",
      port: 9001,
      fetch() {
        return new Response("0123456789");
      },
    });
    await ticks(host);
    await listening;
    const injected = host.inject({ target: "/big" });
    await ticks(host, 16);
    expect(injected.complete).toBe(true);
    expect(injected.contentLength).toBe(10);
    expect(injected.text()).toBe("0123456789");
  });

  test("handler failures go through error(); its failure yields a fixed 500", async () => {
    const host = createSimHttpdHost();
    mount(host.ns);
    let mode: "handled" | "unhandled" = "handled";
    const listening = serve({
      hostname: "127.0.0.1",
      port: 9002,
      fetch() {
        throw new Error("boom");
      },
      error(error) {
        if (mode === "unhandled") throw error;
        return new Response("recovered", { status: 502 });
      },
    });
    await ticks(host);
    await listening;
    const first = host.inject({ target: "/a" });
    await ticks(host, 2);
    expect(first.status).toBe(502);
    expect(first.text()).toBe("recovered");
    mode = "unhandled";
    const second = host.inject({ target: "/b" });
    await ticks(host, 2);
    expect(second.status).toBe(500);
    expect(second.text()).toBe("");
  });

  test("peer disconnect aborts the request signal; late responses are dropped", async () => {
    const host = createSimHttpdHost();
    mount(host.ns);
    let resolveLater: ((r: Response) => void) | null = null;
    let aborted = false;
    const listening = serve({
      hostname: "127.0.0.1",
      port: 9003,
      fetch(request) {
        request.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<Response>((resolve) => {
          resolveLater = resolve;
        });
      },
    });
    await ticks(host);
    await listening;
    const injected = host.inject({ target: "/slow" });
    await ticks(host);
    expect(resolveLater).not.toBeNull();
    injected.disconnect();
    await ticks(host);
    expect(aborted).toBe(true);
    expect(injected.aborted).toBe(NET_ERROR.closed);
    resolveLater!(new Response("too late"));
    await ticks(host);
    expect(injected.responded).toBe(false);
    expect(host.live()).toBe(0);
  });

  test("synchronous refusals and a missing namespace reject", async () => {
    await expect(serve({ hostname: "127.0.0.1", port: 1, fetch: () => new Response("x") })).rejects.toMatchObject({
      code: NET_ERROR.unavailable,
    });
    const host = createSimHttpdHost();
    mount(host.ns);
    await expect(
      serve({ hostname: "127.0.0.1", port: 443, tls: { credential: "c" }, fetch: () => new Response("x") }),
    ).rejects.toMatchObject({ code: NET_ERROR.unsupported });
    await expect(serve({ hostname: "127.0.0.1", port: 70000, fetch: () => new Response("x") })).rejects.toBeInstanceOf(NetworkError);
  });
});
