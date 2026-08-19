// WebSocket Client SDK (`@pocketjs/framework/net/websocket`) + deterministic
// sim host (hosts/sim/ws.ts): handshake delivery order, text/binary messages,
// control frames, backpressure/drain, close handshake, terminate, handshake
// failures and synchronous refusals.

import { afterEach, describe, expect, test } from "bun:test";

import { NET_ERROR } from "../contracts/spec/net.ts";
import { NetworkError } from "../framework/src/net/index.ts";
import { connect, type WebSocket, type WsOps } from "../framework/src/net/websocket.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createSimWsHost } from "../hosts/sim/ws.ts";

function mount(ns: WsOps): void {
  (globalThis as { ws?: WsOps }).ws = ns;
}

afterEach(() => {
  delete (globalThis as { ws?: WsOps }).ws;
});

async function ticks(host: { tick(): void }, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    host.tick();
    runServicePumps();
    for (let j = 0; j < 8; j++) await Promise.resolve();
  }
}

describe("websocket SDK + deterministic sim host", () => {
  test("open runs readyState → open handler → resolve, in that order", async () => {
    const host = createSimWsHost({ "ws://echo.test/socket": { protocol: "telemetry.v1" } });
    mount(host.ns);
    const order: string[] = [];
    let opened: WebSocket | null = null;
    const promise = connect("ws://echo.test/socket", {
      protocols: ["telemetry.v1", "other"],
      socket: {
        open(socket) {
          order.push(`open:${socket.readyState}:${socket.protocol}`);
          opened = socket;
        },
      },
    }).then((socket) => {
      order.push("resolved");
      return socket;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    await ticks(host);
    const socket = await promise;
    expect(socket).toBe(opened!);
    expect(order).toEqual(["open:open:telemetry.v1", "resolved"]);
    expect(socket.url).toBe("ws://echo.test/socket");
    expect(socket.readyState).toBe("open");
    expect(socket.bufferedAmount).toBe(0);
  });

  test("text and binary messages round-trip; binary arrives as an owned Uint8Array", async () => {
    const host = createSimWsHost({ "ws://echo.test/socket": {} });
    mount(host.ns);
    const received: (string | Uint8Array)[] = [];
    const promise = connect("ws://echo.test/socket", {
      socket: {
        message(_socket, data) {
          received.push(data);
        },
      },
    });
    await ticks(host);
    const socket = await promise;
    expect(socket.send("héllo")).toEqual({ status: "accepted", needsDrain: false });
    const payload = new Uint8Array([1, 2, 3]);
    expect(socket.send(payload)).toEqual({ status: "accepted", needsDrain: false });
    payload[0] = 9; // snapshot at send()
    await ticks(host);
    expect(received.length).toBe(2);
    expect(received[0]).toBe("héllo");
    expect([...(received[1] as Uint8Array)]).toEqual([1, 2, 3]);
    expect(host.log).toContain("send 1 text 6");
  });

  test("ping/pong control frames and the 125-byte cap", async () => {
    const host = createSimWsHost({ "ws://echo.test/socket": {} });
    mount(host.ns);
    const pongs: number[] = [];
    const pings: number[] = [];
    const promise = connect("ws://echo.test/socket", {
      socket: {
        pong(_s, data) {
          pongs.push(data.length);
        },
        ping(_s, data) {
          pings.push(data.length);
        },
      },
    });
    await ticks(host);
    const socket = await promise;
    expect(socket.ping(new Uint8Array(3))).toBe(true);
    expect(() => socket.ping(new Uint8Array(126))).toThrow(NetworkError);
    host.peer("ws://echo.test/socket").ping(new Uint8Array(2));
    await ticks(host);
    expect(pongs).toEqual([3]);
    expect(pings).toEqual([2]);
  });

  test("backpressure returns without accepting; drain fires once", async () => {
    const host = createSimWsHost({ "ws://echo.test/socket": { sendWindowBytes: 4, onMessage: () => undefined } });
    mount(host.ns);
    let drains = 0;
    const promise = connect("ws://echo.test/socket", {
      socket: {
        drain() {
          drains++;
        },
      },
    });
    await ticks(host);
    const socket = await promise;
    expect(socket.send("abc")).toEqual({ status: "accepted", needsDrain: false });
    expect(socket.bufferedAmount).toBe(3);
    expect(socket.send("de")).toEqual({ status: "backpressure" });
    await ticks(host);
    expect(drains).toBe(1);
    expect(socket.bufferedAmount).toBe(0);
    expect(socket.send("de")).toEqual({ status: "accepted", needsDrain: false });
    await ticks(host);
    expect(drains).toBe(1); // not re-armed
  });

  test("close handshake: closing → close handler with the peer's code", async () => {
    const host = createSimWsHost({ "ws://echo.test/socket": {} });
    mount(host.ns);
    const closes: [number, string][] = [];
    const promise = connect("ws://echo.test/socket", {
      socket: {
        close(_s, code, reason) {
          closes.push([code, reason]);
        },
      },
    });
    await ticks(host);
    const socket = await promise;
    expect(() => socket.close(1001)).toThrow(NetworkError);
    socket.close(4000, "bye");
    expect(socket.readyState).toBe("closing");
    expect(socket.send("x")).toEqual({ status: "closed" });
    await ticks(host);
    expect(socket.readyState).toBe("closed");
    expect(closes).toEqual([[4000, "bye"]]);
    expect(host.live()).toBe(0);
  });

  test("peer close and transport loss report error then close", async () => {
    const host = createSimWsHost({ "ws://a.test/": {}, "ws://b.test/": {} });
    mount(host.ns);
    const events: string[] = [];
    const handlers = (tag: string) => ({
      error(_s: WebSocket, error: NetworkError) {
        events.push(`${tag}:error:${error.code}`);
      },
      close(_s: WebSocket, code: number) {
        events.push(`${tag}:close:${code}`);
      },
    });
    const a = connect("ws://a.test/", { socket: handlers("a") });
    const b = connect("ws://b.test/", { socket: handlers("b") });
    await ticks(host);
    await a;
    await b;
    host.peer("ws://a.test/").close(1000, "done");
    host.peer("ws://b.test/").drop();
    await ticks(host);
    expect(events).toEqual(["a:close:1000", "b:error:closed", "b:close:1006"]);
    expect(host.live()).toBe(0);
  });

  test("terminate aborts without a Close frame", async () => {
    const host = createSimWsHost({ "ws://echo.test/socket": {} });
    mount(host.ns);
    const closes: [number, string][] = [];
    const promise = connect("ws://echo.test/socket", {
      socket: {
        close(_s, code, reason) {
          closes.push([code, reason]);
        },
      },
    });
    await ticks(host);
    const socket = await promise;
    socket.terminate();
    await ticks(host);
    expect(closes).toEqual([[1006, ""]]);
    expect(socket.readyState).toBe("closed");
  });

  test("handshake failure rejects connect and calls no handler", async () => {
    const host = createSimWsHost({
      "ws://deny.test/": { error: { code: "websocket_handshake_failed", message: "403", status: 403 } },
    });
    mount(host.ns);
    let handlerCalls = 0;
    const promise = connect("ws://deny.test/", {
      socket: {
        error() {
          handlerCalls++;
        },
        close() {
          handlerCalls++;
        },
      },
    });
    await ticks(host);
    const error = await promise.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "websocket_handshake_failed", category: "protocol", reasonCode: 403 });
    expect(handlerCalls).toBe(0);
    expect(host.live()).toBe(0);
  });

  test("synchronous refusals", async () => {
    const host = createSimWsHost({ "ws://echo.test/socket": {} });
    mount(host.ns);
    await expect(connect("wss://echo.test/socket", { socket: {} })).rejects.toMatchObject({ code: NET_ERROR.unsupported });
    await expect(connect("http://echo.test/socket", { socket: {} })).rejects.toMatchObject({ code: NET_ERROR.invalidRequest });
    await expect(connect("ws://echo.test/socket#frag", { socket: {} })).rejects.toMatchObject({ code: NET_ERROR.invalidRequest });
    await expect(connect("ws://echo.test/socket", { protocols: ["a", "a"], socket: {} })).rejects.toMatchObject({ code: NET_ERROR.invalidRequest });
    await expect(connect("ws://echo.test/socket", { headers: { Host: "x" }, socket: {} })).rejects.toMatchObject({ code: NET_ERROR.invalidRequest });
    await expect(connect("ws://other.test/", { socket: {} })).rejects.toMatchObject({ code: NET_ERROR.permissionDenied });
    expect(host.live()).toBe(0);
  });
});
