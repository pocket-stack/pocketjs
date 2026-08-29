#!/usr/bin/env bun

// Pocket Runtime development loop for Nintendo 3DS.
//
//   bun tools/3ds-dev.ts pair  --host 192.168.8.102
//   bun tools/3ds-dev.ts push  --host 192.168.8.102 --app 3ds-demo
//   bun tools/3ds-dev.ts probe --host 192.168.8.102
//   bun tools/3ds-dev.ts dev   --host 192.168.8.102 --app 3ds-demo
//
// `pair` is the one-time ftpd step. Everything else talks directly to the
// running Pocket Runtime over its authenticated TCP connection.

import { $ } from "bun";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  POCKET_RUNTIME_WIRE_PORT,
  pocketPackageFooterHash,
} from "../contracts/spec/pocket-runtime-wire.ts";
import { startDevServer } from "../hosts/web/server.ts";
import {
  PocketRuntimeClient,
  parsePocketRuntimeToken,
  type PocketRuntimeScreenshot,
} from "./3ds-runtime-client.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const argv = Bun.argv.slice(2);
const commands = new Set(["pair", "push", "probe", "dev"]);
const command = commands.has(argv[0] ?? "") ? argv.shift()! : "dev";

function value(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function has(flag: string): boolean {
  return argv.includes(flag);
}

function usage(message?: string, exitCode = 1): never {
  if (message) console.error(`3ds-dev: ${message}`);
  console.error(`Usage:
  bun tools/3ds-dev.ts pair  --host <3ds-ip> [--ftp-port 5000] [--rotate]
  bun tools/3ds-dev.ts push  --host <3ds-ip> [--app 3ds-demo | --package file.pocket]
  bun tools/3ds-dev.ts probe --host <3ds-ip> [--out screenshot.png]
  bun tools/3ds-dev.ts dev   --host <3ds-ip> [--app 3ds-demo] [--no-push] [--panel-port 8130]

The device must run Pocket Runtime for push/probe/dev. pair runs once while
ftpd is open, then the final Runtime must be restarted to load dev.key.`);
  process.exit(exitCode);
}

if (has("-h") || has("--help")) usage(undefined, 0);
const host = value("--host") ?? process.env.POCKET_3DS_HOST ?? usage("--host is required");
const port = Number(value("--port") ?? POCKET_RUNTIME_WIRE_PORT);
if (!Number.isInteger(port) || port <= 0 || port > 65535) usage("--port is invalid");
const safeDevice = `${host}-${port}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
const keyDirectory = join(ROOT, ".pocket", "3ds", "devices");
const keyPath = join(keyDirectory, `${safeDevice}.key`);

function tokenFromDisk(): Uint8Array {
  if (!existsSync(keyPath)) {
    throw new Error(`device is not paired; run bun tools/3ds-dev.ts pair --host ${host}`);
  }
  return parsePocketRuntimeToken(readFileSync(keyPath, "utf8"));
}

async function pair(): Promise<void> {
  mkdirSync(keyDirectory, { recursive: true });
  let token: Uint8Array;
  if (existsSync(keyPath) && !has("--rotate")) {
    token = tokenFromDisk();
  } else {
    token = crypto.getRandomValues(new Uint8Array(32));
    writeFileSync(keyPath, `${Buffer.from(token).toString("hex")}\n`, { mode: 0o600 });
  }
  chmodSync(keyPath, 0o600);
  const ftpPort = Number(value("--ftp-port") ?? 5000);
  if (!Number.isInteger(ftpPort) || ftpPort <= 0 || ftpPort > 65535) {
    usage("--ftp-port is invalid");
  }
  const url = `ftp://${host}:${ftpPort}/pocketjs/runtime/dev.key`;
  const upload = Bun.spawnSync([
    "curl",
    "--silent",
    "--show-error",
    "--fail",
    "--ftp-create-dirs",
    "--connect-timeout",
    "3",
    "--max-time",
    "30",
    "-T",
    keyPath,
    url,
  ]);
  if (upload.exitCode !== 0) throw new Error(upload.stderr.toString().trim());
  const readback = Bun.spawnSync([
    "curl",
    "--silent",
    "--show-error",
    "--fail",
    "--connect-timeout",
    "3",
    "--max-time",
    "15",
    url,
  ]);
  if (readback.exitCode !== 0) throw new Error(readback.stderr.toString().trim());
  const remote = parsePocketRuntimeToken(readback.stdout.toString());
  if (!Buffer.from(remote).equals(Buffer.from(token))) {
    throw new Error("device pairing key failed its FTP readback comparison");
  }
  console.log(`paired ${host}:${port}`);
  console.log(`device key: /pocketjs/runtime/dev.key`);
  console.log(`local key:  ${keyPath}`);
  console.log("restart Pocket Runtime once; ftpd is not needed afterwards");
}

async function buildPackage(app: string): Promise<string> {
  const result = await $`bun tools/3ds.ts ${app} --pocket-only`.cwd(ROOT).quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`3DS guest build failed\n${result.stdout}${result.stderr}`);
  }
  const text = `${result.stdout}\n${result.stderr}`;
  const paths = [...text.matchAll(/^output: (.+\.pocket) \(/gm)];
  const path = paths.at(-1)?.[1];
  if (!path || !existsSync(path)) throw new Error("3DS guest build did not report a .pocket output");
  return path;
}

async function packagePath(): Promise<string> {
  const explicit = value("--package");
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error(`package does not exist: ${path}`);
    return path;
  }
  return await buildPackage(value("--app") ?? "3ds-demo");
}

function createClient(): PocketRuntimeClient {
  return new PocketRuntimeClient({ host, port, token: tokenFromDisk(), timeoutMs: 15_000 });
}

async function connect(client = createClient()): Promise<PocketRuntimeClient> {
  client.on("socketError", (error) => console.error(`3ds-dev: socket: ${String(error)}`));
  const ack = await client.connect();
  console.log(
    `connected ${host}:${port} — abi ${ack.hostAbi}, generation ${ack.generation}, active ${ack.activeHash.toString(16).padStart(16, "0")}`,
  );
  return client;
}

function hashOf(value: Record<string, unknown>): string {
  return String(value.hash ?? "").toLowerCase();
}

async function pushWithClient(client: PocketRuntimeClient, path: string): Promise<string> {
  const bytes = new Uint8Array(readFileSync(path));
  const expectedHash = pocketPackageFooterHash(bytes).toString(16).padStart(16, "0");
  const verdict = client.waitForCtrl(
    (message) => message.t === "runtime.install" &&
      ["accepted", "rejected", "transfer-error"].includes(String(message.phase)) &&
      hashOf(message) === expectedHash,
    30_000,
  );
  const hash = await client.install(bytes);
  if (hash.toString(16).padStart(16, "0") !== expectedHash) {
    throw new Error("package footer changed while preparing the transfer");
  }
  console.log(`sent ${basename(path)} — ${bytes.length} bytes, ${expectedHash}`);
  const result = await verdict;
  if (result.phase !== "accepted") {
    throw new Error(`device rejected ${expectedHash}: ${String(result.message ?? result.phase)}`);
  }
  console.log(`accepted ${expectedHash}`);
  return expectedHash;
}

async function push(): Promise<void> {
  const path = await packagePath();
  const client = await connect();
  try {
    await pushWithClient(client, path);
  } finally {
    client.close();
  }
}

function screenshotPath(frame: number): string {
  const explicit = value("--out");
  if (explicit) return resolve(explicit);
  const directory = join(ROOT, "dist", "3ds", "screenshots");
  mkdirSync(directory, { recursive: true });
  return join(directory, `pocket-runtime-f${String(frame).padStart(6, "0")}.png`);
}

async function probe(): Promise<void> {
  const client = await connect();
  try {
    const statusPromise = client.waitForCtrl((message) => message.t === "runtime.status");
    await client.requestStatus();
    const status = await statusPromise;

    const statsPromise = client.waitForCtrl((message) => message.t === "devStats");
    const treePromise = client.waitForCtrl((message) => message.t === "tree");
    const evalPromise = client.waitForCtrl(
      (message) => message.t === "evalResult" && message.id === "3ds-probe",
    );
    const logPromise = client.waitForCtrl(
      (message) => message.t === "log" && JSON.stringify(message).includes("Pocket Runtime probe"),
    );
    const shotPromise = client.waitForScreenshot(20_000);
    await client.sendCtrl({ t: "devStats" });
    await client.sendCtrl({ t: "getTree" });
    await client.sendCtrl({
      t: "eval",
      id: "3ds-probe",
      code: 'console.log("Pocket Runtime probe"); ({target:globalThis.ui.__host,abi:globalThis.ui.__hostAbi,probe:globalThis.__runtimeProbe??null})',
    });
    await client.sendCtrl({ t: "screenshot" });
    const [stats, tree, evaluation, , screenshot] = await Promise.all([
      statsPromise,
      treePromise,
      evalPromise,
      logPromise,
      shotPromise,
    ]);
    const output = screenshotPath(screenshot.frame);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, screenshot.png);
    console.log(`status:     ${JSON.stringify(status)}`);
    console.log(`devStats:   ${JSON.stringify(stats.data)}`);
    console.log(`tree frame: ${String(tree.frame ?? "?")}`);
    console.log(`eval:       ${String(evaluation.value ?? "?")}`);
    console.log(`screenshot: ${output} (${screenshot.png.length} bytes)`);
  } finally {
    client.close();
  }
}

async function dev(): Promise<void> {
  const panelPort = Number(value("--panel-port") ?? process.env.PORT ?? 8130);
  const server = startDevServer({ port: panelPort, portRetries: 10 });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?role=device`);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.onopen = () => resolveOpen();
    socket.onerror = () => rejectOpen(new Error("Pocket DevTools panel WebSocket failed to open"));
  });
  const client = createClient();
  let currentPackage = value("--package") ? resolve(value("--package")!) : "";

  const forwardScreenshot = (screenshot: PocketRuntimeScreenshot) => {
    if (socket.readyState === WebSocket.OPEN) {
      const data = `data:image/png;base64,${screenshot.png.toString("base64")}`;
      socket.send(JSON.stringify({ t: "screenshot", frame: screenshot.frame, data }));
    }
    const output = screenshotPath(screenshot.frame);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, screenshot.png);
    console.log(`screenshot ${output}`);
  };
  client.on("screenshot", forwardScreenshot);
  client.on("ctrlLine", (line: string) => {
    let rawNotice = false;
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      rawNotice = message.t === "screenshotRaw";
      if (message.t === "runtime.status") console.log(`runtime ${line}`);
      if (message.t === "runtime.install") console.log(`update ${line}`);
    } catch {
      // Forward malformed lines so the panel can expose the protocol error.
    }
    if (!rawNotice && socket.readyState === WebSocket.OPEN) socket.send(line);
  });
  socket.onmessage = (event) => {
    if (typeof event.data === "string") void client.sendCtrl(event.data).catch(console.error);
  };
  await connect(client);

  const rebuild = async () => {
    currentPackage = value("--package") ? resolve(value("--package")!) : await buildPackage(value("--app") ?? "3ds-demo");
    await pushWithClient(client, currentPackage);
  };
  if (!has("--no-push")) await rebuild();

  console.log(`panel: ${server.panelUrl}`);
  console.log("keys: r rebuild+push · s screenshot · o open panel · q quit");
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    client.close();
    socket.close();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => {
      const key = chunk.toString();
      if (key === "q" || key === "\x03") cleanup();
      if (key === "r") void rebuild().catch((error) => console.error(String(error)));
      if (key === "s") void client.sendCtrl({ t: "screenshot" }).catch(console.error);
      if (key === "o") void $`open ${server.panelUrl}`.nothrow().quiet();
    });
  }
  await new Promise(() => {});
}

try {
  if (command === "pair") await pair();
  else if (command === "push") await push();
  else if (command === "probe") await probe();
  else await dev();
} catch (error) {
  console.error(`3ds-dev: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
