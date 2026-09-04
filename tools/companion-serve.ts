// tools/companion-serve.ts — put a companion host on the network the way
// the consoles' svc transport expects: one TCP listener speaking PKNT
// frames, one UDP beacon a second so a device can find the listener from
// the datagram's source address. The frame layout is contracts/spec/
// svc-wire.ts; the record layer is tools/companion-host.ts. Node and Bun
// both run this file.
//
// Per connection: the device's raw hello (magic, version, app id) is
// answered with the ack, then every ctrl frame is one JSON line for the
// session and every ping is echoed as a pong. Ten seconds of silence ends
// the connection — the device does the same, so a dead link is noticed on
// both ends within one timeout.
//
// WIRE_PORT is often held by another companion on the same machine; the
// listener then takes an ephemeral port and the beacon advertises whatever
// it got. A device on a broadcast-hostile network reads the port from
// `sdmc:/pocketjs/host.txt` instead (`a.b.c.d:port`).

import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import {
  encodeCtrl,
  encodeBeacon,
  encodeFrame,
  encodeHelloAck,
  FrameParser,
  parseHello,
  WIRE_BEACON_PORT,
  WIRE_MSG,
  WIRE_PORT,
} from "../contracts/spec/svc-wire.ts";
import type { CompanionHost, CompanionSession } from "./companion-host.ts";

export interface ServeCompanionOptions {
  /** TCP port to try first (default WIRE_PORT); 0 = ephemeral. */
  readonly port?: number;
  readonly beaconPort?: number;
  /** Extra beacon targets besides broadcast + loopback (a device's IP on
   *  a network that drops broadcasts). */
  readonly unicast?: readonly string[];
  /** Send the beacon (default true). */
  readonly beacon?: boolean;
  readonly silenceMs?: number;
  log?(line: string): void;
}

export interface CompanionServer {
  /** The port actually bound. */
  readonly port: number;
  /** Live device connections. */
  connections(): number;
  close(): Promise<void>;
}

const utf8d = new TextDecoder();

export async function serveCompanion(
  host: CompanionHost,
  options: ServeCompanionOptions = {},
): Promise<CompanionServer> {
  const log = options.log ?? ((line: string) => console.error(line));
  const silenceMs = options.silenceMs ?? 10_000;
  const sockets = new Set<Socket>();
  const server: Server = createServer();

  server.on("connection", (socket) => {
    const label = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`;
    sockets.add(socket);
    socket.setNoDelay(true);
    let pending = new Uint8Array(0);
    let parser: FrameParser | null = null;
    let session: CompanionSession | null = null;
    let lastRx = Date.now();

    const end = (why: string): void => {
      if (session) {
        session.close();
        session = null;
      }
      sockets.delete(socket);
      socket.destroy();
      log(`companion: ${label} closed (${why})`);
    };

    const silence = setInterval(() => {
      if (Date.now() - lastRx > silenceMs) end("silence");
    }, 1000);

    socket.on("data", (chunk: Buffer) => {
      lastRx = Date.now();
      let bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (!parser) {
        const merged = new Uint8Array(pending.length + bytes.length);
        merged.set(pending);
        merged.set(bytes, pending.length);
        pending = merged;
        let hello: { app: string; consumed: number } | null;
        try {
          hello = parseHello(pending);
        } catch (error) {
          end(error instanceof Error ? error.message : String(error));
          return;
        }
        if (!hello) return;
        if (hello.app !== host.app) {
          end(`hello for "${hello.app}", this companion is "${host.app}"`);
          return;
        }
        socket.write(encodeHelloAck());
        parser = new FrameParser();
        session = host.attach({
          label,
          send: (line) => {
            if (!socket.destroyed) socket.write(encodeCtrl(line));
          },
        });
        log(`companion: ${label} linked`);
        bytes = pending.subarray(hello.consumed);
        pending = new Uint8Array(0);
        if (bytes.length === 0) return;
      }
      let frames;
      try {
        frames = parser.push(bytes);
      } catch (error) {
        end(error instanceof Error ? error.message : String(error));
        return;
      }
      for (const frame of frames) {
        if (frame.type === WIRE_MSG.ctrl) {
          // One frame is one line on the device side; a trailing newline
          // from a lenient sender is harmless here.
          session?.receiveBatch(utf8d.decode(frame.payload));
        } else if (frame.type === WIRE_MSG.ping) {
          socket.write(encodeFrame(WIRE_MSG.pong, frame.payload));
        }
        // Other types (file, stream) are not the companion protocol's.
      }
    });
    socket.on("error", (error) => end(error.message));
    socket.on("close", () => {
      clearInterval(silence);
      if (sockets.has(socket)) end("peer closed");
    });
  });

  const port = await listen(server, options.port ?? WIRE_PORT);
  let beacon: UdpSocket | null = null;
  let beaconTimer: ReturnType<typeof setInterval> | null = null;
  if (options.beacon !== false) {
    beacon = createSocket("udp4");
    const beaconPort = options.beaconPort ?? WIRE_BEACON_PORT;
    const targets = ["255.255.255.255", "127.0.0.1", ...(options.unicast ?? [])];
    const datagram = encodeBeacon(host.app, host.name === "companion" ? hostname() : host.name, port);
    await new Promise<void>((resolve) => beacon!.bind(0, () => resolve()));
    beacon.setBroadcast(true);
    const tick = (): void => {
      for (const target of targets) {
        beacon!.send(datagram, beaconPort, target, () => {});
      }
    };
    tick();
    beaconTimer = setInterval(tick, 1000);
    beacon.on("error", (error) => log(`companion: beacon ${error.message}`));
  }
  log(`companion "${host.app}" listening on ${port}${beacon ? ", beacon on" : ""}`);

  return {
    port,
    connections: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        if (beaconTimer) clearInterval(beaconTimer);
        beacon?.close();
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

/** Bind, falling back to an ephemeral port when the preferred one is taken. */
function listen(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE" && port !== 0) {
        server.removeListener("error", onError);
        listen(server, 0).then(resolve, reject);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}
