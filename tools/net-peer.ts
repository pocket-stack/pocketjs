// tools/net-peer.ts — the independent HTTP + WebSocket peer for the network
// hardware smoke (hosts/esp-idf/examples/net-smoke). Runs on the workstation
// with Bun; the boards reach it over the LAN. It is deliberately a different
// implementation from the PocketJS core, so the smoke tests the wire against
// an independent peer instead of the same code on both ends.
//
//   bun tools/net-peer.ts [--http=8790] [--ws=8791] [--host=0.0.0.0]
//
// Routes: /hello /echo (POST) /json /stream (chunked) /redirect (302 → /hello)
//         /big?bytes=N /slow?ms=N /status ; anything else → 404.
// WebSocket: /echo echoes text and binary, negotiates "smoke.v1".

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"] as const;
}));
const httpPort = Number(args.get("http") ?? 8790);
const wsPort = Number(args.get("ws") ?? 8791);
const host = args.get("host") ?? "0.0.0.0";

let requests = 0;
const log = (line: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

const http = Bun.serve({
  hostname: host,
  port: httpPort,
  async fetch(request, server) {
    requests++;
    const url = new URL(request.url);
    const remote = server.requestIP(request);
    log(`${remote?.address ?? "?"} ${request.method} ${url.pathname}${url.search}`);
    switch (url.pathname) {
      case "/hello":
        return new Response(`hello from net-peer #${requests}\n`, { headers: { "content-type": "text/plain" } });
      case "/echo": {
        const body = new Uint8Array(await request.arrayBuffer());
        return new Response(body, {
          headers: {
            "content-type": request.headers.get("content-type") ?? "application/octet-stream",
            "x-echo-bytes": String(body.byteLength),
          },
        });
      }
      case "/json":
        return Response.json({ peer: "net-peer", requests, now: Date.now() });
      case "/stream": {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 5; i++) {
              controller.enqueue(new TextEncoder().encode(`chunk-${i};`));
              await Bun.sleep(30);
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/plain" } });
      }
      case "/redirect":
        return new Response(null, { status: 302, headers: { location: "/hello" } });
      case "/big": {
        const bytes = Math.min(4 * 1024 * 1024, Math.max(1, Number(url.searchParams.get("bytes") ?? 100000)));
        const body = new Uint8Array(bytes);
        for (let i = 0; i < bytes; i++) body[i] = 97 + ((i / 1000) | 0) % 26;
        return new Response(body, { headers: { "content-type": "application/octet-stream" } });
      }
      case "/slow": {
        const ms = Math.min(60000, Number(url.searchParams.get("ms") ?? 2000));
        await Bun.sleep(ms);
        return new Response("slow\n");
      }
      case "/status":
        return Response.json({ requests, uptimeMs: Math.round(performance.now()) });
      default:
        return new Response("not found\n", { status: 404 });
    }
  },
});

const ws = Bun.serve({
  hostname: host,
  port: wsPort,
  fetch(request, server) {
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const selected = protocols.includes("smoke.v1") ? "smoke.v1" : undefined;
    const upgraded = server.upgrade(request, {
      headers: selected ? { "sec-websocket-protocol": selected } : {},
      data: { remote: server.requestIP(request)?.address ?? "?" },
    });
    if (upgraded) return undefined as unknown as Response;
    return new Response("websocket only\n", { status: 426 });
  },
  websocket: {
    open(socket) {
      log(`ws open from ${(socket.data as { remote: string }).remote}`);
    },
    message(socket, message) {
      if (typeof message === "string") {
        log(`ws text ${JSON.stringify(message).slice(0, 60)}`);
        socket.send(message);
      } else {
        log(`ws binary ${message.byteLength} bytes`);
        socket.send(message);
      }
    },
    close(_socket, code, reason) {
      log(`ws close ${code} ${reason}`);
    },
  },
});

log(`net-peer http://${host}:${http.port}  ws://${host}:${ws.port}`);
