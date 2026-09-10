#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pocketPackageFooterHash, pocketRuntimeDeviceId, POCKET_RUNTIME_WIRE_PORT } from "../contracts/spec/pocket-runtime-wire.ts";
import { startDevServer } from "../hosts/web/server.ts";
import { IPODTOUCH4_DEV_TARGET_ID, IPODTOUCH4_DEV_HOST_ABI } from "./ipodtouch4-profile.ts";
import { IPODTOUCH4_RUNTIME_KEYS, pairIPodTouch4Runtime, withIPodTouch4RuntimeUsb } from "./ipodtouch4.ts";
import { buildIPodTouch4Package, verifyIPodTouch4Package } from "./ipodtouch4-package.ts";
import { discoverPocketRuntimes, parsePocketRuntimeToken, PocketRuntimeClient, PocketRuntimeSession } from "./pocket-runtime-client.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
type Options = { command: string; app: string; manifest?: string; projectRoot: string;
  package?: string; host?: string; key?: string; port: number; lan: boolean; rotate: boolean;
  panelPort: number; noPush: boolean; };

export function parseRuntimeOptions(argv: readonly string[]): Options {
  const args = [...argv];
  const result: Options = { command: args.shift() ?? "help", app: "clear", projectRoot: ROOT,
    port: POCKET_RUNTIME_WIRE_PORT, lan: false, rotate: false, panelPort: 8130, noPush: false };
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--lan") result.lan = true;
    else if (arg === "--usb") result.lan = false;
    else if (arg === "--rotate") result.rotate = true;
    else if (arg === "--no-push") result.noPush = true;
    else if (arg === "--help" || arg === "-h") result.command = "help";
    else {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--app") result.app = value;
      else if (arg === "--manifest") result.manifest = value;
      else if (arg === "--project-root") result.projectRoot = resolve(value);
      else if (arg === "--package") result.package = resolve(value);
      else if (arg === "--host") { result.host = value; result.lan = true; }
      else if (arg === "--key") result.key = resolve(value);
      else if (arg === "--port") result.port = Number(value);
      else if (arg === "--panel-port") result.panelPort = Number(value);
      else throw new Error(`unknown option ${arg}`);
    }
  }
  for (const port of [result.port, result.panelPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(result.app)) throw new Error("--app must name a repository app; use --manifest for external apps");
  return result;
}
function keys(options: Options): Uint8Array[] {
  if (options.key) return [parsePocketRuntimeToken(readFileSync(options.key, "utf8"))];
  if (!existsSync(IPODTOUCH4_RUNTIME_KEYS)) return [];
  return readdirSync(IPODTOUCH4_RUNTIME_KEYS).filter((name) => name.endsWith(".key"))
    .map((name) => parsePocketRuntimeToken(readFileSync(join(IPODTOUCH4_RUNTIME_KEYS, name), "utf8")));
}
async function lanTarget(options: Options) {
  const tokens = keys(options);
  if (options.host && options.key) return { host: options.host, port: options.port, token: tokens[0] };
  const devices = await discoverPocketRuntimes({ port: options.port,
    ...(options.host ? { addresses: [options.host] } : {}) });
  const matches = devices.filter((device) => device.target === IPODTOUCH4_DEV_TARGET_ID && device.hostAbi === IPODTOUCH4_DEV_HOST_ABI)
    .flatMap((device) => {
      const token = tokens.find((value) => pocketRuntimeDeviceId(value) === device.deviceId);
      return token ? [{ host: device.address, port: device.port, token }] : [];
    });
  if (matches.length !== 1) throw new Error(`found ${matches.length} paired iPod Runtimes; use --host and --key to select one`);
  return matches[0];
}
async function packagePath(options: Options): Promise<string> {
  if (options.package) {
    verifyIPodTouch4Package(readFileSync(options.package));
    return options.package;
  }
  const result = await buildIPodTouch4Package({
    manifest: options.manifest ?? `apps/${options.app}/pocket.json`, projectRoot: options.projectRoot,
  });
  return result.path;
}
export async function pushIPodTouch4Package(client: PocketRuntimeClient, filename: string): Promise<void> {
  const bytes = readFileSync(filename);
  verifyIPodTouch4Package(bytes);
  const hash = pocketPackageFooterHash(bytes).toString(16).padStart(16, "0");
  const verdict = client.waitForCtrl((message) => message.t === "runtime.install" && message.hash === hash &&
    ["accepted", "rejected", "transfer-error"].includes(String(message.phase)), 60000);
  // Attach both rejections before sending: an upload failure must not leave a
  // later verdict timeout as an unhandled promise rejection.
  const [, result] = await Promise.all([client.install(bytes), verdict]);
  if (result.phase !== "accepted") throw new Error(`Runtime rejected ${hash}: ${String(result.message)}`);
  console.log(`accepted ${hash} (${bytes.length} bytes)`);
}
function report(message: Record<string, unknown>) {
  if (message.t === "log") console.log(`[${String(message.level)}] ${JSON.stringify(message.args)}`);
  else if (message.t === "runtime.install") console.log(`${message.phase}: ${message.message}`);
}
async function checkHost(client: PocketRuntimeClient) {
  const response = client.waitForCtrl((message) => message.t === "runtime.status");
  await client.requestStatus();
  const status = await response;
  if (status.target !== IPODTOUCH4_DEV_TARGET_ID || status.hostAbi !== IPODTOUCH4_DEV_HOST_ABI) {
    throw new Error("connected Runtime is not the supported iPod touch 4 target/ABI");
  }
  return status;
}
async function once(options: Options, target: { host: string; port: number; token: Uint8Array }, filename?: string) {
  const client = new PocketRuntimeClient(target);
  client.on("ctrl", report);
  try {
    await client.connect();
    const status = await checkHost(client);
    if (options.command === "status") console.log(JSON.stringify(status, null, 2));
    else if (filename) await pushIPodTouch4Package(client, filename);
  } finally { client.close(); }
}

async function dev(options: Options, firstTarget: { host: string; port: number; token: Uint8Array }) {
  let target = firstTarget;
  const deviceId = pocketRuntimeDeviceId(target.token);
  let attempts = 0;
  const session = new PocketRuntimeSession({ createClient: async () => {
    if (attempts++ && options.lan && !options.host) {
      const devices = await discoverPocketRuntimes({ port: options.port });
      const match = devices.find((entry) => entry.deviceId === deviceId && entry.target === IPODTOUCH4_DEV_TARGET_ID);
      if (!match) throw new Error("paired iPod Runtime is not answering discovery");
      target = { ...target, host: match.address, port: match.port };
    }
    return new PocketRuntimeClient(target);
  } });
  const server = startDevServer({ port: options.panelPort, portRetries: 10 });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?role=device`);
  let stopped = false;
  let building = false;
  let dirty = !options.noPush;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: ReturnType<typeof watch>[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolveDone) => { finish = resolveDone; });
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    session.close();
    socket.close();
    server.stop();
    finish();
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  const rebuild = async () => {
    if (building || stopped || !dirty || !session.connected) return;
    building = true;
    dirty = false;
    try {
      const filename = await packagePath(options);
      if (!stopped) {
        const client = await session.requireClient();
        await checkHost(client);
        await pushIPodTouch4Package(client, filename);
      }
    } catch (error) {
      console.error(String(error));
      // Keep the latest build pending across a connection loss. A compile or
      // admission error waits for another source edit instead of retrying it.
      if (!session.connected) dirty = true;
    } finally {
      building = false;
      if (dirty && !stopped) timer = setTimeout(() => void rebuild(), 300);
    }
  };
  session.on("ctrl", report);
  session.on("ctrlLine", (line: string) => { if (socket.readyState === WebSocket.OPEN) socket.send(line); });
  session.on("connect", () => console.log("Runtime connected"));
  session.on("reconnect", () => { console.log("Runtime reconnected"); void rebuild(); });
  session.on("disconnect", () => console.log("Runtime disconnected; waiting for it to return"));
  let reconnectErrors = 0;
  session.on("reconnectError", (error: Error) => {
    if (++reconnectErrors === 1 || reconnectErrors % 12 === 0) console.error(error.message);
  });
  socket.onmessage = (event) => {
    if (typeof event.data === "string") void session.sendCtrl(event.data).catch((error) => console.error(String(error)));
  };
  try {
    await new Promise<void>((opened, reject) => {
      socket.onopen = () => opened();
      socket.onerror = () => reject(new Error("DevTools panel connection failed"));
    });
    // requireClient keeps the foreground/background reconnect loop alive even
    // when Runtime is not open yet; signal handlers can still close it.
    const client = await session.requireClient();
    await checkHost(client);
    const watched = options.package ? [dirname(options.package)] : [...new Set([options.projectRoot, ROOT])];
    for (const directory of watched) {
      const watcher = watch(directory, { recursive: true }, (_event, name) => {
        if (!name) return;
        const file = name.toString();
        if (file.split(/[\\/]/).some((part) => ["node_modules", ".git", ".pocket", ".pocket-build", "dist", "target"].includes(part))) return;
        if (options.package && resolve(directory, file) !== options.package) return;
        if (!options.package && directory === ROOT && /^(engine|hosts|site|tests|docs)\//.test(file)) return;
        dirty = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void rebuild(), 300);
      });
      watcher.on("error", (error) => { console.error(`watch failed: ${error.message}`); cleanup(); });
      watchers.push(watcher);
    }
    console.log(`DevTools: ${server.panelUrl}\nWatching ${options.package ?? options.manifest ?? options.app}; Ctrl-C to stop`);
    await rebuild();
    await finished;
  } finally {
    cleanup();
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
  }
}

function usage() {
  console.log(`Pocket Runtime for iPod touch 4
  bun ipodtouch4:runtime build|deploy|launch|capture|uninstall
  bun ipodtouch4:runtime pair [--rotate]
  bun ipodtouch4:runtime pack [--app clear | --manifest path --project-root directory]
  bun ipodtouch4:runtime discover
  bun ipodtouch4:runtime status [--lan | --host IP --key file]
  bun ipodtouch4:runtime push [--app clear | --package file.pocket] [--lan]
  bun ipodtouch4:runtime dev [--app clear | --manifest path --project-root directory | --package file.pocket] [--lan] [--no-push]

USB uses the existing pinned SSH tunnel by default. --lan discovers a paired
Runtime; --host and --key work when broadcast is unavailable. Runtime must
be in the foreground. Native build commands produce a separate PocketRuntime
User app, using Clear as the embedded recovery guest (320x480, density 2).`);
}
export async function main(argv = Bun.argv.slice(2)) {
  const options = parseRuntimeOptions(argv);
  if (["help", "--help", "-h"].includes(options.command)) return usage();
  if (["build", "deploy", "launch", "capture", "uninstall"].includes(options.command)) {
    const child = Bun.spawn([process.execPath, join(ROOT, "tools/ipodtouch4.ts"), options.command], {
      cwd: ROOT, env: { ...process.env, POCKETJS_IPODTOUCH4_APP: "runtime", POCKETJS_IPODTOUCH4_APP_FILE: "" },
      stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    if (await child.exited) throw new Error(`Runtime ${options.command} failed`);
    return;
  }
  if (options.command === "pair") return await pairIPodTouch4Runtime(options.rotate);
  if (options.command === "pack") { console.log(await packagePath(options)); return; }
  if (options.command === "discover") {
    const devices = await discoverPocketRuntimes({ port: options.port });
    console.log(JSON.stringify(devices.filter((entry) => entry.target === IPODTOUCH4_DEV_TARGET_ID),
      (_key, value) => typeof value === "bigint" ? value.toString(16) : value, 2));
    return;
  }
  if (!["push", "status", "dev"].includes(options.command)) throw new Error(`unknown Runtime command ${options.command}`);
  const filename = options.command === "push" ? await packagePath(options) : undefined;
  const operation = async (target: { host: string; port: number; token: Uint8Array }) => {
    if (options.command === "dev") await dev(options, target);
    else await once(options, target, filename);
  };
  if (options.lan) await operation(await lanTarget(options));
  else await withIPodTouch4RuntimeUsb((host, port, token) => operation({ host, port, token }));
}

if (import.meta.main) main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
