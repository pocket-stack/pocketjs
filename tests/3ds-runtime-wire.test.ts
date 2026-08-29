import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import {
  POCKET_RUNTIME_ACK_BYTES,
  POCKET_RUNTIME_FRAME_HEADER_BYTES,
  POCKET_RUNTIME_MAX_FRAME_BYTES,
  POCKET_RUNTIME_MAX_CTRL_BYTES,
  POCKET_RUNTIME_MSG,
  POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8,
  POCKET_RUNTIME_TOKEN_BYTES,
  POCKET_RUNTIME_WIRE_MAGIC,
  PocketRuntimeFrameDecoder,
  decodePocketRuntimeAck,
  decodePocketRuntimeScreenshotBegin,
  encodePocketRuntimeFrame,
  encodePocketRuntimeHello,
  encodePocketRuntimePackageBegin,
  encodePocketRuntimePackageChunk,
  pocketPackageFooterHash,
} from "../contracts/spec/pocket-runtime-wire.ts";
import {
  PocketRuntimeClient,
  combinePocketRuntimeScreens,
  decodePocketRuntimeSurface,
} from "../tools/3ds-runtime-client.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Nintendo 3DS Pocket Runtime wire", () => {
  test("keeps TypeScript and C protocol constants byte-exact", () => {
    const header = readFileSync(join(ROOT, "hosts/3ds/src/dev_protocol.h"), "utf8");
    expect(header).toContain("#define POCKET_RUNTIME_WIRE_MAGIC 0x54524b50u");
    expect(header).toContain("#define POCKET_RUNTIME_WIRE_PORT 8131u");
    expect(header).toContain("#define POCKET_RUNTIME_TOKEN_BYTES 32u");
    expect(header).toContain("#define POCKET_RUNTIME_MAX_FRAME_BYTES (64u * 1024u)");
    expect(header).toContain("#define POCKET_RUNTIME_MAX_CTRL_BYTES (16u * 1024u)");
    expect(POCKET_RUNTIME_WIRE_MAGIC).toBe(0x54524b50);
    expect(POCKET_RUNTIME_TOKEN_BYTES).toBe(32);
    expect(POCKET_RUNTIME_MAX_CTRL_BYTES).toBe(16 * 1024);
  });

  test("authenticates an exact 32-byte pairing token and decodes the ack", () => {
    const token = Uint8Array.from({ length: 32 }, (_, index) => index);
    const hello = encodePocketRuntimeHello(token);
    expect(hello.length).toBe(40);
    expect([...hello.slice(8)]).toEqual([...token]);

    const ack = new Uint8Array(POCKET_RUNTIME_ACK_BYTES);
    const view = new DataView(ack.buffer);
    view.setUint32(0, POCKET_RUNTIME_WIRE_MAGIC, true);
    view.setUint8(4, 1);
    view.setUint16(6, 8, true);
    view.setUint32(8, 7, true);
    view.setUint32(12, 1, true);
    view.setBigUint64(16, 0xe01adc15327d4203n, true);
    expect(decodePocketRuntimeAck(ack)).toEqual({
      accepted: true,
      status: 0,
      hostAbi: 8,
      generation: 7,
      flags: 1,
      activeHash: 0xe01adc15327d4203n,
    });
  });

  test("incrementally decodes ordered control and binary frames", () => {
    const control = encodePocketRuntimeFrame(
      POCKET_RUNTIME_MSG.ctrl,
      new TextEncoder().encode('{"t":"getTree"}'),
    );
    const begin = encodePocketRuntimeFrame(
      POCKET_RUNTIME_MSG.packageBegin,
      encodePocketRuntimePackageBegin(390200, 0xe01adc15327d4203n),
    );
    const bytes = new Uint8Array(control.length + begin.length);
    bytes.set(control);
    bytes.set(begin, control.length);
    const decoder = new PocketRuntimeFrameDecoder();
    expect(decoder.push(bytes.slice(0, 3))).toEqual([]);
    expect(decoder.push(bytes.slice(3, control.length + 2))).toHaveLength(1);
    const frames = decoder.push(bytes.slice(control.length + 2));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(POCKET_RUNTIME_MSG.packageBegin);
    expect(decoder.pendingBytes).toBe(0);

    const tooLarge = new Uint8Array(POCKET_RUNTIME_FRAME_HEADER_BYTES);
    new DataView(tooLarge.buffer).setUint32(4, POCKET_RUNTIME_MAX_FRAME_BYTES + 1, true);
    expect(() => new PocketRuntimeFrameDecoder().push(tooLarge)).toThrow("advertises");
    const reserved = new Uint8Array(POCKET_RUNTIME_FRAME_HEADER_BYTES);
    reserved[2] = 1;
    expect(() => new PocketRuntimeFrameDecoder().push(reserved)).toThrow("reserved");
  });

  test("package chunks carry an absolute offset before bulk bytes", () => {
    const payload = encodePocketRuntimePackageChunk(0x12345678, Uint8Array.of(1, 2, 3));
    expect(new DataView(payload.buffer).getUint32(0, true)).toBe(0x12345678);
    expect([...payload.slice(4)]).toEqual([1, 2, 3]);
  });

  test("decodes rotated BGR surfaces and combines both screens into PNG", () => {
    const top = Uint8Array.of(3, 2, 1, 6, 5, 4); // two vertical BGR pixels
    expect([...decodePocketRuntimeSurface(top, 1, 2)]).toEqual([
      4, 5, 6, 255,
      1, 2, 3, 255,
    ]);
    const begin = new Uint8Array(24);
    const data = new DataView(begin.buffer);
    data.setUint32(0, 12, true);
    data.setUint16(4, 1, true);
    data.setUint16(6, 2, true);
    data.setUint16(8, 1, true);
    data.setUint16(10, 1, true);
    data.setUint8(12, POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8);
    data.setUint32(16, 6, true);
    data.setUint32(20, 3, true);
    const metadata = decodePocketRuntimeScreenshotBegin(begin);
    const png = combinePocketRuntimeScreens(metadata, top, Uint8Array.of(9, 8, 7));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });

  test("the host C implementation accepts the same transcript", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-3ds-dev-protocol-"));
    temporary.push(directory);
    const binary = join(directory, "protocol-test");
    const compiler = Bun.which("cc");
    expect(compiler).not.toBeNull();
    const compile = Bun.spawnSync([
      compiler!,
      "-std=c11",
      `-I${join(ROOT, "hosts/3ds/src")}`,
      join(ROOT, "tests/fixtures/3ds-dev-protocol.c"),
      join(ROOT, "hosts/3ds/src/dev_protocol.c"),
      "-o",
      binary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  });

  test("the client survives fragmented handshake, uploads, control, and screenshot frames", async () => {
    const token = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    let peer: Socket | null = null;
    let incoming = new Uint8Array(0);
    let authenticated = false;
    const decoder = new PocketRuntimeFrameDecoder();
    const uploaded: Uint8Array[] = [];
    const server = createServer((socket) => {
      peer = socket;
      socket.on("data", (chunk: Buffer) => {
        const joined = new Uint8Array(incoming.length + chunk.length);
        joined.set(incoming);
        joined.set(chunk, incoming.length);
        incoming = joined;
        if (!authenticated) {
          if (incoming.length < 40) return;
          expect([...incoming.slice(8, 40)]).toEqual([...token]);
          incoming = incoming.slice(40);
          authenticated = true;
          const ack = new Uint8Array(POCKET_RUNTIME_ACK_BYTES);
          const data = new DataView(ack.buffer);
          data.setUint32(0, POCKET_RUNTIME_WIRE_MAGIC, true);
          data.setUint8(4, 1);
          data.setUint16(6, 8, true);
          socket.write(ack.slice(0, 5));
          setTimeout(() => socket.write(ack.slice(5)), 5);
        }
        for (const frame of decoder.push(incoming)) {
          incoming = new Uint8Array(0);
          if (frame.type === POCKET_RUNTIME_MSG.packageChunk) uploaded.push(frame.payload.slice(4));
          if (frame.type === POCKET_RUNTIME_MSG.packageCommit) {
            const packageBytes = Buffer.concat(uploaded.map((bytes) => Buffer.from(bytes)));
            const hash = pocketPackageFooterHash(packageBytes).toString(16).padStart(16, "0");
            const line = new TextEncoder().encode(
              JSON.stringify({ t: "runtime.install", phase: "accepted", hash }),
            );
            socket.write(encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.ctrl, line));
          }
          if (frame.type === POCKET_RUNTIME_MSG.ctrl) {
            const command = JSON.parse(new TextDecoder().decode(frame.payload));
            if (command.t !== "screenshot") continue;
            const begin = new Uint8Array(24);
            const data = new DataView(begin.buffer);
            data.setUint32(0, 77, true);
            data.setUint16(4, 1, true);
            data.setUint16(6, 2, true);
            data.setUint16(8, 1, true);
            data.setUint16(10, 1, true);
            data.setUint8(12, POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8);
            data.setUint32(16, 6, true);
            data.setUint32(20, 3, true);
            const top = Uint8Array.of(0, 0, 255, 0, 255, 0);
            const auxiliary = Uint8Array.of(255, 0, 0);
            const chunk = (offset: number, bytes: Uint8Array) => {
              const payload = new Uint8Array(4 + bytes.length);
              new DataView(payload.buffer).setUint32(0, offset, true);
              payload.set(bytes, 4);
              return payload;
            };
            const end = new Uint8Array(4);
            new DataView(end.buffer).setUint32(0, 77, true);
            socket.write(Buffer.concat([
              encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.screenshotBegin, begin),
              encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.screenshotChunk, chunk(0, top), 0),
              encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.screenshotChunk, chunk(0, auxiliary), 1),
              encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.screenshotEnd, end),
            ].map((bytes) => Buffer.from(bytes))));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    const client = new PocketRuntimeClient({
      host: "127.0.0.1",
      port: address.port,
      token,
      timeoutMs: 2_000,
    });
    try {
      await client.connect();
      const packageBytes = new Uint8Array(70_000);
      new DataView(packageBytes.buffer).setBigUint64(
        packageBytes.length - 8,
        0x0102030405060708n,
        true,
      );
      const accepted = client.waitForCtrl(
        (message) => message.t === "runtime.install" && message.phase === "accepted",
      );
      await client.install(packageBytes);
      expect((await accepted).hash).toBe("0102030405060708");
      const screenshot = client.waitForScreenshot();
      await client.sendCtrl({ t: "screenshot" });
      const image = await screenshot;
      expect(image.frame).toBe(77);
      expect(image.png.subarray(1, 4).toString()).toBe("PNG");
    } finally {
      client.close();
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
