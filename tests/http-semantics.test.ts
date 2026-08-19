// The SDK, the sim host and the browser dev host against the shared HTTP
// semantics vectors (contracts/spec/vectors/http-semantics.json): method
// acceptance, core-owned request headers, null-body statuses and the
// redirect status table. engine/net (pnet_unit_test) and the Rust core run
// the same file.
import { afterEach, describe, expect, test } from "bun:test";

import {
  HTTP_BODYLESS_STATUS,
  HTTP_NULL_BODY_STATUS,
  HTTP_REDIRECT_ANY_TO_GET_STATUS,
  HTTP_REDIRECT_POST_TO_GET_STATUS,
  HTTP_REDIRECT_STATUS,
  NET_ERROR,
} from "../contracts/spec/net.ts";
import { fetch as pocketFetch, Request, Response, type NetOps } from "../framework/src/net/http.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createSimNetHost } from "../hosts/sim/net.ts";
// @ts-expect-error — the browser dev host is plain ESM without declarations.
import { createNetHost as createWebNetHost } from "../hosts/web/net.js";

interface Vectors {
  readonly methods: readonly { method: string; accepted: boolean }[];
  readonly requestHeaders: readonly { name: string; coreOwned: boolean }[];
  readonly status: readonly { status: number; bodylessFraming: boolean; nullBody: boolean }[];
  readonly redirect: readonly {
    status: number;
    method: string;
    followed: boolean;
    nextMethod?: string;
    keepBody?: boolean;
  }[];
}

const vectors = (await Bun.file(new URL("../contracts/spec/vectors/http-semantics.json", import.meta.url)).json()) as Vectors;

afterEach(() => {
  delete (globalThis as { net?: NetOps }).net;
});

async function ticks(host: { tick(): void }, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    host.tick();
    runServicePumps();
    for (let j = 0; j < 8; j++) await Promise.resolve();
  }
}

describe("http semantics vectors", () => {
  test("methods: the SDK accepts or refuses before the host; the sim and web hosts decide the same at start()", async () => {
    const seen: string[] = [];
    const host = createSimNetHost({
      "http://example.test/m": (request) => {
        seen.push(request.method);
        return { body: "ok" };
      },
    });
    (globalThis as { net?: NetOps }).net = host.ns;
    for (const v of vectors.methods) {
      if (v.accepted) {
        const pending = pocketFetch("http://example.test/m", { method: v.method });
        await ticks(host);
        expect((await pending).status, v.method).toBe(200);
      } else {
        await expect(pocketFetch("http://example.test/m", { method: v.method }), v.method).rejects.toMatchObject({
          code: NET_ERROR.invalidRequest,
        });
      }
      // The hosts' own check (the SDK normalizes standard tokens, so feed
      // them the raw token): valid-but-forbidden tokens refuse with
      // invalid_request, accepted tokens start.
      const meta = JSON.stringify({ url: "http://example.test/m", method: v.method, headers: {} });
      const simHandle = host.ns.start(meta, null);
      expect(simHandle > 0, `sim ${v.method}`).toBe(v.accepted);
      if (simHandle > 0) host.ns.cancel(simHandle);
      const web = createWebNetHost(async () => new globalThis.Response("x")) as { ns: NetOps };
      const webHandle = web.ns.start(meta, null);
      expect(webHandle > 0, `web ${v.method}`).toBe(v.accepted);
      if (webHandle > 0) web.ns.cancel(webHandle);
    }
    // One fetch through the SDK plus one raw start() per accepted token.
    expect(seen.length).toBe(2 * vectors.methods.filter((v) => v.accepted).length);
    await ticks(host, 2);
  });

  test("request headers: core-owned names are silently dropped on a Request, others kept", () => {
    for (const v of vectors.requestHeaders) {
      const request = new Request("http://example.test/", { headers: { [v.name]: "value" } });
      expect(request.headers.has(v.name.toLowerCase()), v.name).toBe(!v.coreOwned);
    }
  });

  test("statuses: a Response refuses a body exactly for the null-body set; framing constants agree", () => {
    for (const v of vectors.status) {
      // App-constructed responses take 200..599 (1xx exist only on the wire).
      if (v.status >= 200 && v.nullBody) {
        expect(() => new Response("x", { status: v.status }), String(v.status)).toThrow();
        expect(new Response(null, { status: v.status }).status).toBe(v.status);
      } else if (v.status >= 200) {
        expect(new Response("x", { status: v.status }).status).toBe(v.status);
      }
      const framingBodyless = (v.status >= 100 && v.status < 200) || (HTTP_BODYLESS_STATUS as readonly number[]).includes(v.status);
      expect(framingBodyless, `framing ${v.status}`).toBe(v.bodylessFraming);
      expect((HTTP_NULL_BODY_STATUS as readonly number[]).includes(v.status), `null ${v.status}`).toBe(v.nullBody);
    }
  });

  test("redirects: the followed set and the method rewrite table", () => {
    for (const v of vectors.redirect) {
      const followed = (HTTP_REDIRECT_STATUS as readonly number[]).includes(v.status);
      expect(followed, String(v.status)).toBe(v.followed);
      if (followed) {
        expect(Response.redirect("http://example.test/next", v.status).status).toBe(v.status);
        const toGet = ((HTTP_REDIRECT_ANY_TO_GET_STATUS as readonly number[]).includes(v.status) && v.method !== "HEAD") ||
          ((HTTP_REDIRECT_POST_TO_GET_STATUS as readonly number[]).includes(v.status) && v.method === "POST");
        expect(toGet ? "GET" : v.method, `${v.status} ${v.method}`).toBe(v.nextMethod!);
        expect(!toGet, `${v.status} ${v.method} body`).toBe(v.keepBody!);
      } else {
        expect(() => Response.redirect("http://example.test/next", v.status)).toThrow();
      }
    }
  });
});
