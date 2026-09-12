import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  encodePocketRuntimePackageBegin,
  encodePocketRuntimePackageChunk,
  pocketPackageFooterHash,
  pocketRuntimeDeviceId,
  POCKET_RUNTIME_MAX_FRAME_BYTES,
  POCKET_RUNTIME_MSG,
} from "../contracts/spec/pocket-runtime-wire.ts";
import {
  discoverPocketRuntimes,
  PocketRuntimeClient,
  render3dsScreenshotPng,
} from "../tools/3ds-runtime-client.ts";

// One PKRT server (engine/runtime/dev_server.c) behind two socket pumps: the
// Nintendo 3DS one with libctru stubbed out and the POSIX one the UIKit shell
// uses. The desktop client drives both through the same scenario, so the
// hosts cannot drift apart in what a frame means.

const ROOT = new URL("..", import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), "pocket-runtime-server-"));
const children: Bun.Subprocess[] = [];
const clients: PocketRuntimeClient[] = [];
const token = Uint8Array.from({ length: 32 }, (_, index) => 0x40 + index);
const keyText = `${Buffer.from(token).toString("hex")}\n`;
const compiler = Bun.which("cc");
const SHARED = ["engine/runtime/dev_server.c", "engine/runtime/dev_protocol.c"].map((path) => join(ROOT, path));
const WARNINGS = ["-D_DEFAULT_SOURCE", "-D_GNU_SOURCE", "-Wall", "-Wextra", "-Werror"];

afterAll(async () => {
  clients.forEach((client) => client.close());
  for (const child of children) if (child.exitCode === null) child.kill();
  await Promise.all(children.map((child) => child.exited));
  rmSync(directory, { recursive: true, force: true });
});

function compile(args: readonly string[], output: string): void {
  expect(compiler).not.toBeNull();
  const result = Bun.spawnSync([compiler!, ...args, "-o", output]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function spawnReady(command: string[], cwd: string, marker: string): Promise<Bun.Subprocess> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(ready.value)).toContain(marker);
  return child;
}

test("the shared server replays one transcript without a transport", () => {
  const binary = join(directory, "core-transcript");
  compile(["-std=c11", ...WARNINGS, "-I", join(ROOT, "engine/runtime"),
    join(ROOT, "tests/fixtures/dev-server-core.c"), ...SHARED], binary);
  const scratch = join(directory, "core-scratch");
  mkdirSync(scratch, { recursive: true });
  const run = Bun.spawnSync([binary, scratch]);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(run.stdout.toString()).toContain("ok");
});

interface Transport {
  readonly name: string;
  readonly target: string;
  readonly label: string;
  readonly screenshots: boolean;
  start(): Promise<number>;
}

const transports: readonly Transport[] = [
  {
    name: "Nintendo 3DS libctru pump",
    target: "3ds-dev",
    label: "PocketJS 3DS",
    screenshots: true,
    async start() {
      const port = await freePort();
      const binary = join(directory, `3ds-devserver-${port}`);
      compile(["-std=gnu11", ...WARNINGS,
        '-DPOCKETJS_TARGET_ID="3ds-dev"', '-DPOCKETJS_RUNTIME_SLOT="0123456789abcdef"', "-DPOCKETJS_HOST_ABI=8",
        `-DPOCKETJS_DEV_PORT=${port}`,
        "-I", join(ROOT, "tests/fixtures/3ds-stubs"), "-I", join(ROOT, "hosts/3ds/src"),
        "-I", join(ROOT, "hosts/3ds/include"), "-I", join(ROOT, "engine/runtime"),
        join(ROOT, "tests/fixtures/3ds-devserver-host.c"), join(ROOT, "hosts/3ds/src/devserver.c"), ...SHARED], binary);
      // The console's literal sdmc: paths, relative to the scratch directory.
      const root = join(directory, `3ds-root-${port}`);
      mkdirSync(join(root, "sdmc:/pocketjs/runtime/apps/0123456789abcdef"), { recursive: true });
      writeFileSync(join(root, "sdmc:/pocketjs/runtime/dev.key"), keyText);
      await spawnReady([binary, root], ROOT, "3ds devserver ready");
      return port;
    },
  },
  {
    name: "POSIX socket pump",
    target: "host-dev",
    label: "PocketJS Host",
    screenshots: false,
    async start() {
      const port = await freePort();
      const binary = join(directory, "posix-devwire");
      compile(["-std=c11", ...WARNINGS, "-I", join(ROOT, "engine/runtime"),
        join(ROOT, "tests/fixtures/dev-wire-posix-host.c"), join(ROOT, "engine/runtime/dev_wire_posix.c"), ...SHARED], binary);
      const root = join(directory, `posix-root-${port}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "dev.key"), keyText);
      await spawnReady([binary, root, String(port)], ROOT, "posix wire ready");
      return port;
    },
  },
];

function packageBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * seed) & 0xff;
  bytes[length - 8] = 0x11;
  bytes[length - 1] = seed;
  return bytes;
}

function hex(hash: bigint): string {
  return hash.toString(16).padStart(16, "0");
}

async function status(client: PocketRuntimeClient): Promise<Record<string, unknown>> {
  const reply = client.waitForCtrl((message) => message.t === "runtime.status");
  await client.requestStatus();
  return await reply;
}

for (const transport of transports) {
  test(`${transport.name} keeps the shared PKRT semantics`, async () => {
    const port = await transport.start();
    const target = { host: "127.0.0.1", port };

    const found = await discoverPocketRuntimes({ addresses: ["127.0.0.1"], port, timeoutMs: 500 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target: transport.target, label: transport.label, hostAbi: 8, port, flags: 0,
      generation: 1, activeHash: 0x1122334455667788n, deviceId: pocketRuntimeDeviceId(token),
    });

    // A wrong key is answered with a rejection ack before the close.
    const stranger = new PocketRuntimeClient({ ...target, token: new Uint8Array(32), timeoutMs: 2000 });
    try { await expect(stranger.connect()).rejects.toThrow("rejected the pairing token (status 2)"); }
    finally { stranger.close(); }

    const client = new PocketRuntimeClient({ ...target, token, timeoutMs: 5000, heartbeatIntervalMs: 50, heartbeatTimeoutMs: 2000 });
    clients.push(client);
    const pong = new Promise<void>((resolve) => client.once("pong", () => resolve()));
    const ack = await client.connect();
    expect(ack).toMatchObject({ accepted: true, hostAbi: 8, generation: 1, flags: 1, activeHash: 0x1122334455667788n });
    expect(await status(client)).toMatchObject({ target: transport.target, generation: 1, active: hex(0x1122334455667788n) });
    await pong;
    expect((await discoverPocketRuntimes({ addresses: ["127.0.0.1"], port, timeoutMs: 300 }))[0]?.flags).toBe(1);

    // Guest control records travel both ways; unknown frames are skipped.
    const echo = client.waitForCtrl((message) => message.t === "echo");
    await client.sendCtrl({ t: "probe", n: 1 });
    expect((await echo).length).toBe(JSON.stringify({ t: "probe", n: 1 }).length);
    await client.sendFrame(0x7f, Uint8Array.of(1, 2, 3));
    expect((await status(client)).generation).toBe(1);

    // Uploads: receiving, received, then the host's admission verdict.
    const phases: string[] = [];
    client.on("ctrl", (message: Record<string, unknown>) => {
      if (message.t === "runtime.install") phases.push(String(message.phase));
    });
    const good = packageBytes(70_000, 3);
    const hash = pocketPackageFooterHash(good);
    const verdict = client.waitForCtrl((message) => message.t === "runtime.install" && message.hash === hex(hash) &&
      ["accepted", "rejected", "transfer-error"].includes(String(message.phase)));
    expect(await client.install(good)).toBe(hash);
    expect((await verdict).phase).toBe("accepted");
    expect(phases).toEqual(["receiving", "received", "accepted"]);
    expect(await status(client)).toMatchObject({ generation: 2, active: hex(hash) });

    const misplaced = client.waitForCtrl((message) => message.t === "runtime.install" && message.phase === "transfer-error");
    await client.sendFrame(POCKET_RUNTIME_MSG.packageBegin, encodePocketRuntimePackageBegin(good.length, hash));
    await client.sendFrame(POCKET_RUNTIME_MSG.packageChunk, encodePocketRuntimePackageChunk(1, good.subarray(0, 16)));
    expect(String((await misplaced).message)).toContain("offset");

    // A declared footer that does not match the bytes is the host's call.
    const rejected = client.waitForCtrl((message) => message.t === "runtime.install" && message.phase === "rejected");
    await client.sendFrame(POCKET_RUNTIME_MSG.packageBegin, encodePocketRuntimePackageBegin(good.length, hash ^ 1n));
    const chunkBytes = POCKET_RUNTIME_MAX_FRAME_BYTES - 4;
    for (let offset = 0; offset < good.length; offset += chunkBytes) {
      await client.sendFrame(POCKET_RUNTIME_MSG.packageChunk,
        encodePocketRuntimePackageChunk(offset, good.subarray(offset, Math.min(offset + chunkBytes, good.length))));
    }
    await client.sendFrame(POCKET_RUNTIME_MSG.packageCommit);
    expect((await rejected).hash).toBe(hex(hash ^ 1n));
    expect(await status(client)).toMatchObject({ generation: 2, active: hex(hash) });

    if (transport.screenshots) {
      const shot = client.waitForScreenshot(5000);
      await client.sendCtrl({ t: "screenshot" });
      const image = await shot;
      expect(image.metadata).toMatchObject({ topWidth: 400, topHeight: 240, auxiliaryWidth: 320, auxiliaryHeight: 240 });
      expect(image.top[5]).toBe(5);
      expect(image.auxiliary[0]).toBe(255);
      const png = render3dsScreenshotPng(image);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([400, 480]);
    }

    // A malformed control record closes the connection.
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    await client.sendFrame(POCKET_RUNTIME_MSG.ctrl, new TextEncoder().encode("{\n}"));
    await closed;
    expect(client.connected).toBe(false);
  }, 20000);
}
