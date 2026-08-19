// The sim hosts enforce a Build Plan network policy the way the native cores
// do: the connect rule and insecureTransport before any route lookup (and
// before the pump sees a handle), the listen rule before bind, the redirect
// target again. The policies are the shared vectors' documents, so the same
// decisions the C and Rust cores pin here arrive at the SDK as
// `permission_denied`.

import { afterEach, describe, expect, test } from "bun:test";

import { NET_ERROR } from "../contracts/spec/net.ts";
import { canonicalNetworkPolicyJson, parseNetworkPolicyJson } from "../contracts/spec/network-policy.ts";
import { fetch as pocketFetch, Response, serve, type HttpdOps, type NetOps } from "../framework/src/net/http.ts";
import { connect, type WsOps } from "../framework/src/net/websocket.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createSimHttpdHost } from "../hosts/sim/httpd.ts";
import { createSimNetHost } from "../hosts/sim/net.ts";
import { createSimWsHost } from "../hosts/sim/ws.ts";

const vectors = (await Bun.file(new URL("../contracts/spec/vectors/network-policy.json", import.meta.url)).json()) as {
  policies: Record<string, unknown>;
};
const standard = parseNetworkPolicyJson(JSON.stringify(vectors.policies.standard));
const secureOnly = parseNetworkPolicyJson(JSON.stringify(vectors.policies["secure-only"]));

type Globals = { net?: NetOps; ws?: WsOps; httpd?: HttpdOps };
afterEach(() => {
  const g = globalThis as Globals;
  delete g.net;
  delete g.ws;
  delete g.httpd;
});

async function ticks(host: { tick(): void }, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    host.tick();
    runServicePumps();
    for (let j = 0; j < 12; j++) await Promise.resolve();
  }
}

describe("sim hosts enforce the plan's network policy", () => {
  test("net: connect rule + insecureTransport decide before routes; the pump never sees a refused handle", async () => {
    const routes = {
      "http://localhost:8050/ok": { body: "ok" },
      "http://localhost:9000/no": { body: "never" },
      "http://192.168.1.20:8080/ip": { body: "ip" },
      "http://192.168.1.21:8080/other": { body: "never" },
    };
    const host = createSimNetHost(routes, { policy: canonicalNetworkPolicyJson(standard) });
    (globalThis as Globals).net = host.ns;

    const ok = pocketFetch("http://localhost:8050/ok");
    await ticks(host);
    expect((await ok).status).toBe(200);
    const ip = pocketFetch("http://192.168.1.20:8080/ip");
    await ticks(host);
    expect((await ip).status).toBe(200);

    const polls = host.pollCalls();
    // Routed, but outside the policy: refused synchronously.
    await expect(pocketFetch("http://localhost:9000/no")).rejects.toMatchObject({ code: NET_ERROR.permissionDenied });
    await expect(pocketFetch("http://192.168.1.21:8080/other")).rejects.toMatchObject({ code: NET_ERROR.permissionDenied });
    await expect(pocketFetch("http://LOCALHOST:8101/x")).rejects.toMatchObject({ code: NET_ERROR.permissionDenied });
    runServicePumps();
    expect(host.pollCalls()).toBe(polls);
    expect(host.log.filter((line) => line.startsWith("start"))).toHaveLength(2);
  });

  test("net: insecureTransport=false refuses a matched plaintext rule", async () => {
    const host = createSimNetHost(
      { "http://api.example.com/x": { body: "x" } },
      { policy: secureOnly },
    );
    (globalThis as Globals).net = host.ns;
    await expect(pocketFetch("http://api.example.com/x")).rejects.toMatchObject({ code: NET_ERROR.permissionDenied });
    // Without a policy the same host answers (routes are the allowlist).
    const open = createSimNetHost({ "http://api.example.com/x": { body: "x" } });
    (globalThis as Globals).net = open.ns;
    const response = pocketFetch("http://api.example.com/x");
    await ticks(open);
    expect((await response).status).toBe(200);
  });

  test("net: a redirect target outside the policy fails the exchange with permission_denied", async () => {
    const host = createSimNetHost(
      {
        "http://localhost:8050/go": { url: "http://localhost:9000/landed", redirected: true, body: "landed" },
        "http://localhost:8051/go": { url: "http://localhost:8052/landed", redirected: true, body: "landed" },
      },
      { policy: standard },
    );
    (globalThis as Globals).net = host.ns;
    const refused = pocketFetch("http://localhost:8050/go");
    const followed = pocketFetch("http://localhost:8051/go");
    await ticks(host, 2);
    await expect(refused).rejects.toMatchObject({ code: NET_ERROR.permissionDenied });
    const response = await followed;
    expect(response.redirected).toBe(true);
    expect(response.url).toBe("http://localhost:8052/landed");
  });

  test("ws: the connect rule is checked before the peer table", async () => {
    const host = createSimWsHost(
      { "ws://echo.example.com/s": {}, "ws://other.example.com/s": {} },
      { policy: standard },
    );
    (globalThis as Globals).ws = host.ns;
    await expect(connect("ws://other.example.com/s", { socket: {} })).rejects.toMatchObject({ code: NET_ERROR.permissionDenied });
    const opening = connect("ws://echo.example.com/s", { socket: {} });
    await ticks(host);
    const socket = await opening;
    expect(socket.readyState).toBe("open");
    socket.terminate();
    await ticks(host);
  });

  test("httpd: listen tuples decide bind; ephemeral only matches port 0", async () => {
    const host = createSimHttpdHost({ policy: standard });
    (globalThis as Globals).httpd = host.ns;
    await expect(serve({ hostname: "0.0.0.0", port: 8081, fetch: () => new Response("x") }))
      .rejects.toMatchObject({ code: NET_ERROR.permissionDenied });
    await expect(serve({ hostname: "127.0.0.1", port: 8080, fetch: () => new Response("x") }))
      .rejects.toMatchObject({ code: NET_ERROR.permissionDenied });
    const listening = serve({ hostname: "0.0.0.0", port: 8080, fetch: () => new Response("x") });
    const ephemeral = serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    await ticks(host);
    const server = await listening;
    expect(server.port).toBe(8080);
    const eph = await ephemeral;
    expect(eph.port).toBeGreaterThan(0);
    server.stop();
    eph.stop();
    await ticks(host);
  });
});
