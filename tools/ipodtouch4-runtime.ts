#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { pocketPackageFooterHash, pocketRuntimeDeviceId, POCKET_RUNTIME_WIRE_PORT } from "../contracts/spec/pocket-runtime-wire.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { startDevServer } from "../hosts/web/server.ts";
import { IPODTOUCH4_DEV_TARGET_ID, IPODTOUCH4_DEV_HOST_ABI } from "./ipodtouch4-profile.ts";
import { IPODTOUCH4_APPS, IPODTOUCH4_RUNTIME_KEYS, pairIPodTouch4Runtime, withIPodTouch4RuntimeUsb } from "./ipodtouch4.ts";
import { buildIPodTouch4Package, verifyIPodTouch4Package } from "./ipodtouch4-package.ts";
import { makeVariant } from "./pocket-pack.ts";
import { discoverPocketRuntimes, parsePocketRuntimeToken, PocketRuntimeClient, PocketRuntimeSession } from "./pocket-runtime-client.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
type Options = { command: string; app: string; manifest?: string; projectRoot: string;
  package?: string; host?: string; key?: string; port: number; lan: boolean; rotate: boolean;
  panelPort: number; noPush: boolean; pushes: number; skipBackground: boolean; autoBackground: boolean; };
type Target = { host: string; port: number; token: Uint8Array };

export function parseRuntimeOptions(argv: readonly string[]): Options {
  const args = [...argv];
  const result: Options = { command: args.shift() ?? "help", app: "clear", projectRoot: ROOT,
    port: POCKET_RUNTIME_WIRE_PORT, lan: false, rotate: false, panelPort: 8130, noPush: false,
    pushes: 5, skipBackground: false, autoBackground: false };
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--lan") result.lan = true;
    else if (arg === "--usb") result.lan = false;
    else if (arg === "--rotate") result.rotate = true;
    else if (arg === "--no-push") result.noPush = true;
    else if (arg === "--skip-background") result.skipBackground = true;
    else if (arg === "--auto-background") result.autoBackground = true;
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
      else if (arg === "--pushes") result.pushes = Number(value);
      else throw new Error(`unknown option ${arg}`);
    }
  }
  for (const port of [result.port, result.panelPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(result.app)) throw new Error("--app must name a repository app; use --manifest for external apps");
  if (!Number.isInteger(result.pushes) || result.pushes < 1 || result.pushes > 50) throw new Error("--pushes must be an integer from 1 to 50");
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

async function statusOf(client: PocketRuntimeClient): Promise<Record<string, unknown>> {
  const reply = client.waitForCtrl((message) => message.t === "runtime.status");
  await client.requestStatus();
  return await reply;
}
async function verdictOf(client: PocketRuntimeClient, bytes: Uint8Array): Promise<Record<string, unknown>> {
  const hash = pocketPackageFooterHash(bytes).toString(16).padStart(16, "0");
  const verdict = client.waitForCtrl((message) => message.t === "runtime.install" && message.hash === hash &&
    ["accepted", "rejected", "transfer-error"].includes(String(message.phase)), 60000);
  const [, result] = await Promise.all([client.install(bytes), verdict]);
  return { ...result, hash };
}
/** SpringBoard app switch over the USB SSH tunnel (bun ipodtouch4 open-url). */
async function openUrlOnDevice(url: string): Promise<void> {
  const child = Bun.spawn([process.execPath, join(ROOT, "tools/ipodtouch4.ts"), "open-url", url], {
    cwd: ROOT, env: { ...process.env, POCKETJS_IPODTOUCH4_APP: "runtime", POCKETJS_IPODTOUCH4_APP_FILE: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) throw new Error(`open-url ${url} failed: ${err.trim()}`);
}
/** The native shell's acceptance record (bun ipodtouch4 status for the Runtime
 * app), read over the USB SSH tunnel; null when it is unavailable. */
async function shellRecord(): Promise<Record<string, unknown> | null> {
  const child = Bun.spawn([process.execPath, join(ROOT, "tools/ipodtouch4.ts"), "status"], {
    cwd: ROOT, env: { ...process.env, POCKETJS_IPODTOUCH4_APP: "runtime", POCKETJS_IPODTOUCH4_APP_FILE: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (code || start < 0 || end < start) return null;
  try { return JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}

/**
 * The device acceptance pass from docs/IPODTOUCH4.md, run against a paired
 * Runtime in the foreground: repeated replacement, a first-frame failure, a
 * later-frame failure with recovery, a reconnect, one foreground/background
 * round trip (the operator presses Home) and the shell's resident memory
 * before and after. The receipt goes to .pocket-build/validation/.
 */
async function acceptance(options: Options, target: Target): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(ROOT, ".pocket-build/validation/ipodtouch4-runtime", runId);
  mkdirSync(runDir, { recursive: true });
  const steps: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const record = (step: string, ok: boolean, data: Record<string, unknown>) => {
    steps.push({ step, ok, ...data });
    console.log(`${ok ? "[ok]" : "[FAIL]"} ${step} ${JSON.stringify(data)}`);
    if (!ok) failures.push(step);
  };
  const built = await buildIPodTouch4Package({
    manifest: options.manifest ?? `apps/${options.app}/pocket.json`, projectRoot: options.projectRoot,
  });
  const outdir = dirname(built.path);
  const manifest = readFileSync(built.manifestPath);
  const js = readFileSync(join(outdir, `${built.plan.app.output}.js`));
  const pak = readFileSync(join(outdir, `${built.plan.app.output}.pak`));
  const plan = built.plan;
  const synthesize = (source: Uint8Array, assets: Uint8Array) => encodePocketPackage({ manifest, variants: [makeVariant({
    target: plan.target.id, hostAbi: plan.target.hostAbi, planJson: canonicalJson(plan),
    identity: { id: plan.app.id, title: plan.app.title, output: plan.app.output }, js: source, pak: assets,
  })] });
  // Each replacement carries a distinct hash: the same compiled guest with a run-specific trailer.
  const replacement = (n: number) => synthesize(Buffer.concat([js, Buffer.from(`\n// acceptance ${runId} push ${n}\n`)]), pak);
  const encoder = new TextEncoder();
  const firstFrameFailure = synthesize(encoder.encode(
    "globalThis.frame = function () { throw new Error('acceptance: first frame failure'); };"), new Uint8Array([0]));
  const laterFailure = synthesize(encoder.encode(
    "let n = 0; globalThis.frame = function () { if (++n > 90) throw new Error('acceptance: later frame failure'); };"), new Uint8Array([0]));

  const session = new PocketRuntimeSession({ createClient: () => new PocketRuntimeClient({ ...target, timeoutMs: 15000 }) });
  session.on("ctrl", report);
  try {
    let client = await session.start();
    await checkHost(client);
    const before = await statusOf(client);
    record("baseline", before.phase === "accepted", { status: before });
    const shellBefore = await shellRecord();
    let active = String(before.active);
    let generation = Number(before.generation);

    for (let n = 1; n <= options.pushes; n += 1) {
      const verdict = await verdictOf(client, replacement(n));
      const status = await statusOf(client);
      const ok = verdict.phase === "accepted" && status.active === verdict.hash && Number(status.generation) === generation + 1;
      record(`replacement ${n}/${options.pushes}`, ok, {
        hash: verdict.hash, phase: verdict.phase, message: verdict.message,
        generation: status.generation, bootMs: status.bootMs, firstFrameMs: status.firstFrameMs,
      });
      if (ok) { active = String(status.active); generation = Number(status.generation); }
    }

    {
      const verdict = await verdictOf(client, firstFrameFailure);
      const status = await statusOf(client);
      record("first-frame failure", verdict.phase === "rejected" && status.active === active && status.phase === "accepted", {
        phase: verdict.phase, message: verdict.message, active: status.active, generation: status.generation,
      });
    }
    {
      const verdict = await verdictOf(client, laterFailure);
      const startedAt = Date.now();
      let recovered: Record<string, unknown> | null = null;
      while (Date.now() - startedAt < 20000) {
        const status = await statusOf(client);
        if (status.active === active && status.running === active && status.phase === "accepted") { recovered = status; break; }
        await Bun.sleep(250);
      }
      record("later-frame failure", verdict.phase === "accepted" && recovered !== null && recovered.lastGood !== verdict.hash, {
        phase: verdict.phase, message: verdict.message, recoveredAfterMs: recovered ? Date.now() - startedAt : null, status: recovered,
      });
      generation = recovered ? Number(recovered.generation) : generation;
    }
    {
      client.close();
      client = await session.requireClient();
      const tree = client.waitForCtrl((message) => message.t === "tree");
      await client.sendCtrl({ t: "getTree" });
      const evaluated = client.waitForCtrl((message) => message.t === "evalResult" && message.id === "acceptance");
      await client.sendCtrl({ t: "eval", id: "acceptance", code: "ui.__host + ':' + ui.__hostAbi" });
      const [treeResult, evalResult] = await Promise.all([tree, evaluated]);
      record("reconnect", treeResult.t === "tree" && evalResult.value === `${IPODTOUCH4_DEV_TARGET_ID}:${IPODTOUCH4_DEV_HOST_ABI}`, {
        tree: treeResult.t, eval: evalResult.value,
      });
    }
    if (!options.skipBackground) {
      // Automatic: SpringBoard brings Settings forward and, ten seconds later,
      // Runtime again. The shell resigns active, closes its sockets, and
      // reopens the listener when it becomes active; the same callbacks the
      // Home button drives. Manual: the operator presses Home and reopens.
      const wait = (event: string, timeoutMs: number) => new Promise<boolean>((done) => {
        const timer = setTimeout(() => done(false), timeoutMs);
        session.once(event, () => { clearTimeout(timer); done(true); });
      });
      const timeoutMs = options.autoBackground ? 30000 : 180000;
      const disconnecting = wait("disconnect", timeoutMs);
      if (options.autoBackground) await openUrlOnDevice("prefs:root=General");
      else console.log("\n>>> Press the Home button on the iPod now, wait ten seconds, then reopen Pocket Runtime (up to three minutes).");
      const disconnected = await disconnecting;
      const reconnecting = wait("reconnect", timeoutMs);
      if (options.autoBackground && disconnected) {
        await Bun.sleep(10000);
        await openUrlOnDevice(`${IPODTOUCH4_APPS.runtime.scheme}://launch`);
      }
      const reconnected = disconnected ? await reconnecting : false;
      let status: Record<string, unknown> | null = null;
      let verdict: Record<string, unknown> | null = null;
      if (reconnected) {
        client = await session.requireClient();
        status = await statusOf(client);
        verdict = await verdictOf(client, replacement(options.pushes + 1));
      }
      // The package that was active before the switch must still be active on
      // return (generation and hash reloaded from disk), and a push must land.
      const kept = status !== null && status.active === active && status.phase === "accepted";
      record("background/foreground", disconnected && reconnected && kept && verdict?.phase === "accepted", {
        mode: options.autoBackground ? "springboard app switch" : "home button",
        disconnected, reconnected, statusAfterReturn: status, pushAfterReturn: verdict?.phase ?? null,
      });
      if (verdict?.phase === "accepted") { active = String(verdict.hash); generation += 1; }
    }
    const shellAfter = await shellRecord();
    const beforeKb = Number(shellBefore?.resident_kb ?? NaN);
    const afterKb = Number(shellAfter?.resident_kb ?? NaN);
    const measured = Number.isFinite(beforeKb) && Number.isFinite(afterKb) && beforeKb > 0;
    record("resident memory", !measured || afterKb <= beforeKb * 1.5, {
      beforeKb: measured ? beforeKb : null, afterKb: measured ? afterKb : null,
      note: measured ? "after all swaps versus the first accepted guest" : "shell record unavailable",
    });
    writeFileSync(join(runDir, "shell-before.json"), JSON.stringify(shellBefore, null, 2));
    writeFileSync(join(runDir, "shell-after.json"), JSON.stringify(shellAfter, null, 2));
  } finally {
    session.close();
  }
  writeFileSync(join(runDir, "receipt.json"), JSON.stringify({ runId, host: target.host, port: target.port, pushes: options.pushes, steps, failures }, null, 2) + "\n");
  console.log(`receipt: ${join(runDir, "receipt.json")}`);
  if (failures.length > 0) throw new Error(`acceptance failed: ${failures.join(", ")}`);
  console.log("acceptance passed");
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
  bun ipodtouch4:runtime acceptance [--app clear] [--pushes 5] [--auto-background | --skip-background] [--lan]

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
  if (!["push", "status", "dev", "acceptance"].includes(options.command)) throw new Error(`unknown Runtime command ${options.command}`);
  const filename = options.command === "push" ? await packagePath(options) : undefined;
  const operation = async (target: Target) => {
    if (options.command === "dev") await dev(options, target);
    else if (options.command === "acceptance") await acceptance(options, target);
    else await once(options, target, filename);
  };
  if (options.lan) await operation(await lanTarget(options));
  else await withIPodTouch4RuntimeUsb((host, port, token) => operation({ host, port, token }));
}

if (import.meta.main) main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
