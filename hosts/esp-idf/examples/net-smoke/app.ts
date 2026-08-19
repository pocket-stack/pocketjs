// Network smoke app for the ESP-IDF hosts (AtomS3R / Tab5). Headless: no UI,
// only the frame transaction that delivers network completions.
//
// What it does, in order:
//   1. serve HTTP on :8080 (/hello, /echo, /json, /stream, /status)
//   2. against the Mac peer (tools/net-peer.ts): GET/POST/chunked/redirect/
//      big-body/404/timeout/permission cases + a WebSocket echo session
//   3. against the peer board (when configured): GET /hello + POST /echo, then
//      a periodic ping every ~2 s that keeps both boards talking
//
// The host injects `globalThis.__pocketSmoke` before evaluating the bundle.

import { after } from "@pocketjs/framework/clock";
import { mountHeadless } from "@pocketjs/framework/headless";
import { NetworkError, URL, getNetworkLimits } from "@pocketjs/framework/net";
import { fetch, Response, serve, type Request } from "@pocketjs/framework/net/http";
import { connect } from "@pocketjs/framework/net/websocket";

interface SmokeConfig {
  board: string;
  selfIp: string;
  peerHost: string;
  peerPort: number;
  macHost: string;
  macPort: number;
  macWsPort: number;
  ping: boolean;
  tls: boolean;
  tlsHost: string;
}

const cfg: SmokeConfig = (globalThis as { __pocketSmoke?: SmokeConfig }).__pocketSmoke ?? {
  board: "unknown",
  selfIp: "0.0.0.0",
  peerHost: "",
  peerPort: 8080,
  macHost: "",
  macPort: 8790,
  macWsPort: 8791,
  ping: true,
  tls: false,
  tlsHost: "example.com",
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`PASS ${name}${detail ? " " + detail : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`FAIL ${name}${detail ? " " + detail : ""}`);
  }
}

function describeError(error: unknown): string {
  if (error instanceof NetworkError) return `${error.code}(${error.category}): ${error.message}`;
  return String(error);
}

// QuickJS ships no TextEncoder/TextDecoder; the smoke only moves ASCII.
function asciiDecode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
function asciiEncode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

// --- 1. HTTP server -----------------------------------------------------------

let served = 0;
async function startServer(): Promise<void> {
  try {
    const server = await serve({
      hostname: "0.0.0.0",
      port: 8080,
      timeouts: { handlerMs: 10_000, keepAliveMs: 5_000 },
      async fetch(request: Request) {
        served++;
        const url = new URL(request.url);
        switch (url.pathname) {
          case "/hello":
            return new Response(`hello from ${cfg.board} (${cfg.selfIp}) #${served}`);
          case "/echo": {
            const body = await request.arrayBuffer();
            return new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "application/octet-stream", "x-echo-bytes": String(body.byteLength) } });
          }
          case "/json":
            return Response.json({ board: cfg.board, ip: cfg.selfIp, served, limits: getNetworkLimits().httpServer?.maxInflight });
          case "/stream": {
            async function* chunks(): AsyncGenerator<Uint8Array> {
              for (let i = 0; i < 5; i++) yield asciiEncode(`chunk-${i};`);
            }
            return new Response(chunks() as unknown as AsyncIterable<Uint8Array>, { headers: { "content-type": "text/plain" } });
          }
          case "/status":
            return Response.json({ passed, failed, failures, served });
          default:
            return new Response("not found", { status: 404 });
        }
      },
      error(error) {
        console.error("server handler error", describeError(error));
        return new Response("boom", { status: 500 });
      },
    });
    ok("serve listening", server.port === 8080, `at ${server.url}`);
  } catch (error) {
    ok("serve listening", false, describeError(error));
  }
}

// --- 2. HTTP client against the Mac peer -------------------------------------

async function clientSuite(base: string, tag: string): Promise<void> {
  // plain GET
  try {
    const r = await fetch(`${base}/hello`);
    const text = await r.text();
    ok(`${tag} GET /hello`, r.status === 200 && text.length > 0, `${r.status} "${text.slice(0, 40)}"`);
  } catch (error) {
    ok(`${tag} GET /hello`, false, describeError(error));
  }
  // POST echo
  try {
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const r = await fetch(`${base}/echo`, { method: "POST", body: payload, headers: { "content-type": "application/octet-stream" } });
    const echoed = new Uint8Array(await r.arrayBuffer());
    let same = echoed.length === payload.length;
    for (let i = 0; same && i < echoed.length; i++) same = echoed[i] === payload[i];
    ok(`${tag} POST /echo 1 KiB`, r.status === 200 && same, `${r.status} ${echoed.length} bytes`);
  } catch (error) {
    ok(`${tag} POST /echo 1 KiB`, false, describeError(error));
  }
  // JSON
  try {
    const r = await fetch(`${base}/json`);
    const data = await r.json<{ board?: string }>();
    ok(`${tag} GET /json`, r.status === 200 && typeof data === "object", JSON.stringify(data).slice(0, 60));
  } catch (error) {
    ok(`${tag} GET /json`, false, describeError(error));
  }
  // streaming (chunked) via async iteration
  try {
    const r = await fetch(`${base}/stream`);
    let total = "";
    let chunks = 0;
    for await (const chunk of r.body!) {
      total += asciiDecode(chunk);
      chunks++;
    }
    ok(`${tag} GET /stream`, r.status === 200 && total.includes("chunk-4;"), `${chunks} reads, ${total.length} bytes`);
  } catch (error) {
    ok(`${tag} GET /stream`, false, describeError(error));
  }
  // 404 is a successful exchange
  try {
    const r = await fetch(`${base}/missing`);
    await r.text();
    ok(`${tag} GET /missing → 404`, r.status === 404, String(r.status));
  } catch (error) {
    ok(`${tag} GET /missing → 404`, false, describeError(error));
  }
}

async function macSuite(): Promise<void> {
  const base = `http://${cfg.macHost}:${cfg.macPort}`;
  await clientSuite(base, "mac");
  // redirect follow
  try {
    const r = await fetch(`${base}/redirect`);
    const text = await r.text();
    ok("mac redirect follow", r.status === 200 && r.redirected && text.length > 0, `${r.status} redirected=${r.redirected} url=${r.url}`);
  } catch (error) {
    ok("mac redirect follow", false, describeError(error));
  }
  // redirect manual
  try {
    const r = await fetch(`${base}/redirect`, { redirect: "manual" });
    await r.text();
    ok("mac redirect manual", r.status === 302, String(r.status));
  } catch (error) {
    ok("mac redirect manual", false, describeError(error));
  }
  // big body with backpressure through a small queue
  try {
    const t0 = Date.now();
    const r = await fetch(`${base}/big?bytes=200000`, { limits: { queueBytes: 8192 } });
    let total = 0;
    let checksum = 0;
    for await (const chunk of r.body!) {
      total += chunk.length;
      for (let i = 0; i < chunk.length; i += 97) checksum = (checksum + chunk[i]) & 0xffff;
    }
    const ms = Date.now() - t0;
    ok("mac GET /big 200 KB", r.status === 200 && total === 200000, `${total} bytes in ${ms} ms (${Math.round(total / 1024 / (ms / 1000))} KiB/s) checksum=${checksum}`);
  } catch (error) {
    ok("mac GET /big 200 KB", false, describeError(error));
  }
  // aggregate limit
  try {
    const r = await fetch(`${base}/big?bytes=100000`, { limits: { aggregateBytes: 4096 } });
    await r.text();
    ok("mac aggregate limit", false, "text() resolved");
  } catch (error) {
    ok("mac aggregate limit", error instanceof NetworkError && error.code === "response_too_large", describeError(error));
  }
  // timeout
  try {
    await fetch(`${base}/slow?ms=3000`, { timeouts: { headersMs: 500 } });
    ok("mac headers timeout", false, "resolved");
  } catch (error) {
    ok("mac headers timeout", error instanceof NetworkError && error.code === "timeout", describeError(error));
  }
  // permission: an endpoint outside the policy
  try {
    await fetch(`http://${cfg.macHost}:1/x`);
    ok("mac permission_denied", false, "resolved");
  } catch (error) {
    ok("mac permission_denied", error instanceof NetworkError && error.code === "permission_denied", describeError(error));
  }
  // connection refused on an allowed but closed port (macPort + 1 is the
  // WebSocket listener, so use macPort + 2)
  try {
    await fetch(`http://${cfg.macHost}:${cfg.macPort + 2}/x`);
    ok("mac connect refused", false, "resolved");
  } catch (error) {
    ok("mac connect refused", error instanceof NetworkError && error.code === "connect", describeError(error));
  }
  await wsSuite();
}

// --- WebSocket against the Mac peer -----------------------------------------

function wsSuite(): Promise<void> {
  return new Promise<void>((resolve) => {
    const received: string[] = [];
    let binaryOk = false;
    let pongSeen = false;
    let done = false;
    const finish = (name: string, condition: boolean, detail: string): void => {
      if (done) return;
      done = true;
      ok(name, condition, detail);
      resolve();
    };
    connect(`ws://${cfg.macHost}:${cfg.macWsPort}/echo`, {
      protocols: ["smoke.v1"],
      timeouts: { connectMs: 5000 },
      socket: {
        open(socket) {
          console.log(`ws open protocol=${socket.protocol}`);
          socket.send("hello ws");
          socket.send(new Uint8Array([1, 2, 3, 4, 5]));
          socket.ping(new Uint8Array([9]));
        },
        message(socket, data) {
          if (typeof data === "string") {
            received.push(data);
          } else {
            binaryOk = data.length === 5 && data[0] === 1 && data[4] === 5;
          }
          if (received.length >= 1 && binaryOk && pongSeen) socket.close(1000, "done");
        },
        pong(socket, data) {
          pongSeen = data.length === 1 && data[0] === 9;
          if (received.length >= 1 && binaryOk && pongSeen) socket.close(1000, "done");
        },
        close(_socket, code, reason) {
          finish("mac websocket echo", received[0] === "hello ws" && binaryOk && pongSeen && code === 1000, `code=${code} reason=${reason}`);
        },
        error(_socket, error) {
          console.error("ws error", describeError(error));
        },
      },
    }).catch((error: unknown) => finish("mac websocket echo", false, describeError(error)));
    after(15, () => finish("mac websocket echo", false, "timed out"));
  });
}

// --- 3. Board-to-board ----------------------------------------------------------

let pings = 0;
let pingFailures = 0;
async function peerSuite(): Promise<void> {
  const base = `http://${cfg.peerHost}:${cfg.peerPort}`;
  await clientSuite(base, "peer");
}

function schedulePing(): void {
  after(2, async () => {
    try {
      const r = await fetch(`http://${cfg.peerHost}:${cfg.peerPort}/json`);
      const data = await r.json<{ board: string; served: number }>();
      pings++;
      if (pings % 5 === 1) console.log(`ping #${pings} → ${data.board} served=${data.served} (failures=${pingFailures}, our served=${served})`);
    } catch (error) {
      pingFailures++;
      console.error(`ping failed: ${describeError(error)}`);
    }
    schedulePing();
  });
}

// --- TLS (base .tls: host trust, SNI, hostname verification) --------------------

async function tlsSuite(): Promise<void> {
  const limits = getNetworkLimits();
  ok("tls advertised", limits.httpClient?.features.includes("tls") === true, JSON.stringify(limits.httpClient?.features));
  // positive control: a real public HTTPS host with a valid chain
  try {
    const r = await fetch(`https://${cfg.tlsHost}/`, { timeouts: { connectMs: 15000, headersMs: 15000 } });
    const text = await r.text();
    ok(`https ${cfg.tlsHost}`, r.status >= 200 && r.status < 500 && text.length >= 0, `${r.status} ${text.length} bytes`);
  } catch (error) {
    ok(`https ${cfg.tlsHost}`, false, describeError(error));
  }
  const expectTlsError = async (name: string, url: string, code: string): Promise<void> => {
    try {
      const r = await fetch(url, { timeouts: { connectMs: 15000, headersMs: 15000 } });
      await r.text();
      ok(name, false, `resolved ${r.status}`);
    } catch (error) {
      ok(name, error instanceof NetworkError && (error.code === code || error.category === "tls"), describeError(error));
    }
  };
  await expectTlsError("https expired cert", "https://expired.badssl.com/", "tls_certificate_invalid");
  await expectTlsError("https wrong host", "https://wrong.host.badssl.com/", "tls_hostname_mismatch");
  await expectTlsError("https self-signed", "https://self-signed.badssl.com/", "tls_certificate_invalid");
  await expectTlsError("https untrusted root", "https://untrusted-root.badssl.com/", "tls_certificate_invalid");
}

// --- main -----------------------------------------------------------------------

mountHeadless();

async function main(): Promise<void> {
  console.log(`net-smoke on ${cfg.board} ip=${cfg.selfIp} mac=${cfg.macHost || "-"} peer=${cfg.peerHost || "-"}`);
  const limits = getNetworkLimits();
  ok("limits mounted", !!limits.httpClient && !!limits.httpServer && !!limits.websocketClient, `httpClient.maxInflight=${limits.httpClient?.maxInflight}`);
  await startServer();
  if (cfg.tls) await tlsSuite();
  if (cfg.macHost) await macSuite();
  if (cfg.peerHost) {
    // Give the peer time to boot when both boards start together.
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const r = await fetch(`http://${cfg.peerHost}:${cfg.peerPort}/hello`, { timeouts: { connectMs: 2000 } });
        await r.text();
        break;
      } catch {
        await new Promise<void>((resolve) => after(2, resolve));
      }
    }
    await peerSuite();
    if (cfg.ping) schedulePing();
  }
  console.log(`SMOKE ${failed === 0 ? "PASS" : "FAIL"} ${passed}/${passed + failed}${failed ? " failed: " + failures.join(", ") : ""}`);
}

main().catch((error: unknown) => {
  console.error("smoke crashed", describeError(error));
  console.log(`SMOKE FAIL ${passed}/${passed + failed + 1}`);
});
