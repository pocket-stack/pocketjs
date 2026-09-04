// Companion protocol + SDK tests. No sockets: the sim pair joins a guest's
// svc trio to a host object in one process and keeps the transport's one
// observable property — a line the companion sends during frame N is
// visible to svcPoll only after tick(). The load-bearing assertions are the
// bounds: one poll per pump under SVC_POLL_BUF, a reply ceiling enforced
// where the reply is built, and replies for keys the app moved past never
// reaching a signal.

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";

import {
  COMPANION_LINE_BYTES,
  COMPANION_MAX_PENDING,
  COMPANION_REPLY_BYTES,
  encodeEventLine,
  encodeReplyLines,
  parseLines,
  utf8Length,
  type CompanionReplyBody,
} from "../contracts/spec/companion.ts";
import { SVC_POLL_BUF } from "../contracts/spec/spec.ts";
import {
  encodeBeacon,
  encodeFrame,
  encodeHelloAck,
  FrameParser,
  parseBeacon,
  parseHello,
  WIRE_MSG,
} from "../contracts/spec/svc-wire.ts";
import { createCompanionCore } from "../framework/src/companion-core.ts";
import { createChannel, createCompanion, createQuery } from "../framework/src/companion.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createSimCompanionPair } from "../hosts/sim/companion.ts";
import { createCompanionHost, type CompanionHost, type CompanionMethod } from "../tools/companion-host.ts";

function vaultHost(extra: Record<string, CompanionMethod> = {}): CompanionHost {
  return createCompanionHost({
    app: "vault",
    name: "test-mac",
    methods: {
      echo: (params) => params,
      big: ({ bytes }: { bytes: number }) => "x".repeat(bytes),
      fail: () => {
        throw new Error("no such note");
      },
      ...extra,
    },
  });
}

describe("companion spec", () => {
  test("a small reply is one line; a large one is ordered chunks under the line cap", () => {
    expect(encodeReplyLines(7, { ok: [1, 2, 3] })).toEqual(['{"r":7,"ok":[1,2,3]}']);

    const body: CompanionReplyBody = { ok: "é".repeat(9000) }; // 18 000 UTF-8 bytes
    const lines = encodeReplyLines(9, body);
    expect(lines.length).toBeGreaterThan(1);
    const parts: string[] = [];
    for (const line of lines) {
      expect(utf8Length(line)).toBeLessThanOrEqual(COMPANION_LINE_BYTES);
      const chunk = JSON.parse(line) as { r: number; i: number; n: number; s: string };
      expect(chunk.r).toBe(9);
      expect(chunk.n).toBe(lines.length);
      parts[chunk.i] = chunk.s;
    }
    expect(JSON.parse(parts.join(""))).toEqual(body);
  });

  test("a reply past the ceiling is refused where it is built", () => {
    expect(() => encodeReplyLines(1, { ok: "x".repeat(COMPANION_REPLY_BYTES + 1) })).toThrow(/page/);
    expect(() => encodeEventLine("t", "x".repeat(COMPANION_LINE_BYTES))).toThrow(/query/);
  });

  test("parseLines keeps the well-formed lines of a batch", () => {
    expect(parseLines('{"a":1}\n{bad\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("svc wire codec", () => {
  test("beacon round trip", () => {
    const beacon = parseBeacon(encodeBeacon("vault", "evan's Mac", 51234));
    expect(beacon).toEqual({ app: "vault", name: "evan's Mac", tcpPort: 51234 });
    expect(parseBeacon(new Uint8Array(4))).toBeNull();
  });

  test("frames reassemble across arbitrary chunk boundaries", () => {
    const a = encodeFrame(WIRE_MSG.ctrl, new TextEncoder().encode('{"q":1}'));
    const b = encodeFrame(WIRE_MSG.ping, new Uint8Array([1, 2, 3]));
    const stream = new Uint8Array(a.length + b.length);
    stream.set(a);
    stream.set(b, a.length);
    const parser = new FrameParser();
    const frames = [
      ...parser.push(stream.subarray(0, 3)),
      ...parser.push(stream.subarray(3, a.length + 5)),
      ...parser.push(stream.subarray(a.length + 5)),
    ];
    expect(frames.map((frame) => frame.type)).toEqual([WIRE_MSG.ctrl, WIRE_MSG.ping]);
    expect(new TextDecoder().decode(frames[0]!.payload)).toBe('{"q":1}');
    expect([...frames[1]!.payload]).toEqual([1, 2, 3]);
  });

  test("the device hello parses once whole and the ack echoes the magic", () => {
    const hello = new Uint8Array([0x50, 0x4b, 0x4e, 0x54, 1, 0, 5, ...new TextEncoder().encode("vault")]);
    expect(parseHello(hello.subarray(0, 9))).toBeNull();
    expect(parseHello(hello)).toEqual({ app: "vault", consumed: 12 });
    expect(() => parseHello(new Uint8Array([1, 2, 3, 4, 1, 0, 5, 0]))).toThrow(/magic/);
    expect([...encodeHelloAck().subarray(0, 5)]).toEqual([0x50, 0x4b, 0x4e, 0x54, 1]);
  });
});

describe("companion core over the sim pair", () => {
  test("a request goes out with the hello and its reply lands on a later pump", () => {
    const pair = createSimCompanionPair(vaultHost());
    const statuses: string[] = [];
    const core = createCompanionCore({
      app: "vault",
      device: "3ds-dev",
      ops: pair.ops,
      autoPump: false,
      onStatus: (status, name) => statuses.push(`${status}:${name}`),
    });
    const replies: CompanionReplyBody[] = [];
    core.request("echo", { n: 1 }, (body) => replies.push(body));
    expect(core.status()).toBe("searching");

    core.pump(); // link up: hello + the queued request go out
    expect(pair.sent().map((line) => JSON.parse(line))).toEqual([
      { t: "hello", proto: 1, session: expect.any(Number), device: "3ds-dev" },
      { q: 1, m: "echo", p: { n: 1 } },
    ]);
    expect(replies).toEqual([]); // nothing is read on the frame that asked

    pair.tick();
    core.pump();
    expect(statuses).toEqual(["linked:test-mac"]);
    expect(replies).toEqual([{ ok: { n: 1 } }]);
    expect(core.pendingCount()).toBe(0);
    core.dispose();
  });

  test("a method error is a reply, an unknown method too", () => {
    const pair = createSimCompanionPair(vaultHost());
    const core = createCompanionCore({ app: "vault", ops: pair.ops, autoPump: false });
    const replies: CompanionReplyBody[] = [];
    core.request("fail", null, (body) => replies.push(body));
    core.request("nope", null, (body) => replies.push(body));
    core.pump();
    pair.tick();
    core.pump();
    expect(replies).toEqual([{ err: "no such note" }, { err: 'unknown method "nope"' }]);
    core.dispose();
  });

  test("a cancelled request's reply is dropped and the companion sees the cancel", () => {
    let aborted = false;
    const pair = createSimCompanionPair(
      vaultHost({
        slow: (_params, ctx) => {
          ctx.signal.addEventListener("abort", () => (aborted = true));
          return new Promise((resolve) => setTimeout(() => resolve("late"), 0));
        },
      }),
    );
    const core = createCompanionCore({ app: "vault", ops: pair.ops, autoPump: false });
    let delivered = 0;
    const id = core.request("slow", null, () => (delivered += 1));
    core.pump();
    core.cancel(id);
    expect(pair.sent().at(-1)).toBe(`{"c":${id}}`);
    expect(aborted).toBe(true);
    pair.tick();
    core.pump();
    expect(delivered).toBe(0);
    expect(core.pendingCount()).toBe(0);
    core.dispose();
  });

  test("a chunked reply arrives under one poll per pump, each under SVC_POLL_BUF", () => {
    const pair = createSimCompanionPair(vaultHost());
    let polls = 0;
    let maxBatch = 0;
    const ops = {
      ...pair.ops,
      svcPoll: () => {
        const batch = pair.ops.svcPoll();
        if (batch !== undefined) {
          polls += 1;
          maxBatch = Math.max(maxBatch, utf8Length(batch));
        }
        return batch;
      },
    };
    const core = createCompanionCore({ app: "vault", ops, autoPump: false });
    const replies: CompanionReplyBody[] = [];
    const bytes = 20_000;
    core.request("big", { bytes }, (body) => replies.push(body));
    core.pump();
    pair.tick();
    let pumps = 0;
    while (replies.length === 0 && pumps < 20) {
      core.pump();
      pumps += 1;
    }
    expect(replies).toEqual([{ ok: "x".repeat(bytes) }]);
    expect(polls).toBeGreaterThan(1); // more lines than one poll carries
    expect(maxBatch).toBeLessThanOrEqual(SVC_POLL_BUF);
    core.dispose();
  });

  test("a reply past the ceiling becomes an error the guest can show", () => {
    const pair = createSimCompanionPair(vaultHost());
    const core = createCompanionCore({ app: "vault", ops: pair.ops, autoPump: false });
    const replies: CompanionReplyBody[] = [];
    core.request("big", { bytes: COMPANION_REPLY_BYTES + 100 }, (body) => replies.push(body));
    core.pump();
    pair.tick();
    core.pump();
    expect(replies.length).toBe(1);
    expect("err" in replies[0]! && replies[0].err).toMatch(/page/);
    core.dispose();
  });

  test("a reconnect re-sends the hello, the pending requests and the subscriptions", () => {
    const host = vaultHost();
    const pair = createSimCompanionPair(host);
    const events: unknown[] = [];
    const core = createCompanionCore({
      app: "vault",
      ops: pair.ops,
      autoPump: false,
      onEvent: (topic, data) => events.push([topic, data]),
    });
    core.pump();
    pair.tick();
    core.pump();
    expect(core.status()).toBe("linked");
    const unsubscribe = core.subscribe("vault.files");
    expect(pair.sent().at(-1)).toBe('{"s":"vault.files","on":1}');

    pair.disconnect();
    core.pump();
    expect(core.status()).toBe("searching");
    const replies: CompanionReplyBody[] = [];
    core.request("echo", "while down", (body) => replies.push(body));
    core.pump(); // still down: nothing can go out
    const before = pair.sent().length;

    pair.connect();
    core.pump();
    const resent = pair.sent().slice(before).map((line) => JSON.parse(line));
    expect(resent).toEqual([
      { t: "hello", proto: 1, session: expect.any(Number) },
      { q: 1, m: "echo", p: "while down" },
      { s: "vault.files", on: 1 },
    ]);
    pair.tick();
    core.pump();
    expect(replies).toEqual([{ ok: "while down" }]);

    host.publish("vault.files", { count: 3 });
    host.publish("vault.other", { count: 9 }); // not subscribed: never delivered
    pair.tick();
    core.pump();
    expect(events).toEqual([["vault.files", { count: 3 }]]);

    unsubscribe();
    expect(pair.sent().at(-1)).toBe('{"s":"vault.files","on":0}');
    host.publish("vault.files", { count: 4 });
    pair.tick();
    core.pump();
    expect(events.length).toBe(1);
    core.dispose();
  });

  test("the pending cap guards a runaway loop", () => {
    const pair = createSimCompanionPair(vaultHost());
    const core = createCompanionCore({ app: "vault", ops: pair.ops, autoPump: false });
    for (let i = 0; i < COMPANION_MAX_PENDING; i++) core.request("echo", i, () => {});
    expect(() => core.request("echo", -1, () => {})).toThrow(/pending/);
    core.dispose();
  });

  test("a host without the svc trio reads as absent and never pumps", () => {
    const core = createCompanionCore({ app: "vault", ops: null, autoPump: false });
    expect(core.status()).toBe("absent");
    core.pump();
    expect(core.status()).toBe("absent");
    core.dispose();
  });
});

describe("companion Solid shim", () => {
  test("a query follows its key: the superseded reply never reaches the signal", () => {
    const pair = createSimCompanionPair(vaultHost());
    createRoot((dispose) => {
      const mac = createCompanion({ app: "vault", ops: pair.ops });
      const [n, setN] = createSignal(1);
      const page = createQuery<{ n: number }>(mac, () => ["echo", { n: n() }]);
      expect(page()).toBeUndefined();
      expect(page.loading()).toBe(true);

      runServicePumps(); // frame 1: link up, request for n=1 goes out
      setN(2); // the key moves before the reply: cancel 1, ask 2
      expect(pair.sent().slice(-2)).toEqual(['{"c":1}', '{"q":2,"m":"echo","p":{"n":2}}']);
      pair.tick();
      runServicePumps(); // frame 2: the reply to 2 lands
      expect(page()).toEqual({ n: 2 });
      expect(page.loading()).toBe(false);
      expect(page.error()).toBeNull();
      expect(mac.status()).toBe("linked");
      expect(mac.name()).toBe("test-mac");

      // Stale-while-revalidate: the old page stays up while the next loads.
      setN(3);
      expect(page()).toEqual({ n: 2 });
      expect(page.loading()).toBe(true);
      pair.tick();
      runServicePumps();
      expect(page()).toEqual({ n: 3 });
      dispose();
    });
  });

  test("a query with a null key asks nothing; an error reply is readable", () => {
    const pair = createSimCompanionPair(vaultHost());
    createRoot((dispose) => {
      const mac = createCompanion({ app: "vault", ops: pair.ops });
      const [open, setOpen] = createSignal(false);
      const doc = createQuery<string>(mac, () => (open() ? ["fail", null] : null), { keep: false });
      runServicePumps();
      expect(pair.sent().length).toBe(1); // the hello only
      setOpen(true);
      pair.tick();
      runServicePumps();
      pair.tick();
      runServicePumps();
      expect(doc()).toBeUndefined();
      expect(doc.error()).toBe("no such note");
      dispose();
    });
  });

  test("call() settles on a later frame; a channel folds events into a signal", async () => {
    const host = vaultHost();
    const pair = createSimCompanionPair(host);
    await createRoot(async (dispose) => {
      const mac = createCompanion({ app: "vault", ops: pair.ops });
      const files = createChannel<number, { count: number }>(mac, "vault.files", 0, (_prev, event) => event.count);
      const promise = mac.call<string>("echo", "hi");
      runServicePumps();
      pair.tick();
      runServicePumps();
      await expect(promise).resolves.toBe("hi");

      host.publish("vault.files", { count: 12 });
      pair.tick();
      runServicePumps();
      expect(files()).toBe(12);
      dispose();
    });
  });
});
