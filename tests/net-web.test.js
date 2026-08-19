import { expect, test } from "bun:test";

import { fetch as pocketFetch } from "../framework/src/net/http.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createNetHost } from "../hosts/web/net.js";

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("browser net adapter uses native fetch but delivers only at beginFrame", async () => {
  const calls = [];
  const host = createNetHost(async (url, options) => {
    calls.push({ url, options });
    return new Response("web transport", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });
  globalThis.net = host.ns;
  try {
    let settled = false;
    const promise = pocketFetch("https://example.test/web", {
      headers: { "x-test": "1" },
    }).then((response) => {
      settled = true;
      return response;
    });
    await Bun.sleep(5);
    runServicePumps();
    await Promise.resolve();
    expect(settled).toBe(false);

    host.beginFrame();
    runServicePumps();
    const response = await promise;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    const text = response.text();
    await Bun.sleep(5);
    host.beginFrame();
    runServicePumps();
    await settle();
    host.beginFrame();
    runServicePumps();
    expect(await text).toBe("web transport");
    expect(calls).toHaveLength(1);
    expect(calls[0].options.credentials).toBe("omit");
    expect(calls[0].options.redirect).toBe("manual");
    expect(calls[0].options.headers["x-test"]).toBe("1");
  } finally {
    host.reset();
    delete globalThis.net;
  }
});

test("browser net adapter enforces maxBodyBytes while reading", async () => {
  const host = createNetHost(async () => new Response("12345"));
  globalThis.net = host.ns;
  try {
    const promise = pocketFetch("https://example.test/large", { limits: { maxBodyBytes: 4 } });
    await Bun.sleep(5);
    host.beginFrame();
    runServicePumps();
    const response = await promise;
    const outcome = response.text().catch((error) => error);
    await Bun.sleep(5);
    host.beginFrame();
    runServicePumps();
    await settle();
    expect(await outcome).toMatchObject({ code: "response_too_large" });
  } finally {
    host.reset();
    delete globalThis.net;
  }
});

test("browser net adapter maps hidden redirects to unsupported", async () => {
  const host = createNetHost(async () => {
    const response = new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
    Object.defineProperty(response, "type", { value: "opaqueredirect" });
    return response;
  });
  globalThis.net = host.ns;
  try {
    const promise = pocketFetch("https://example.test/redirect");
    await Bun.sleep(5);
    host.beginFrame();
    runServicePumps();
    await expect(promise).rejects.toMatchObject({ code: "unsupported" });
  } finally {
    host.reset();
    delete globalThis.net;
  }
});
