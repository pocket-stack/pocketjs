import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createConnection } from "node:net";
import { encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { resolveIPodTouch4BuildPlan } from "../tools/ipodtouch4-profile.ts";
import { ipodtouch4QuickJsPath, IPODTOUCH4_TOOLCHAIN } from "../tools/ipodtouch4-toolchain.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { buildIPodTouch4Package } from "../tools/ipodtouch4-package.ts";
import { discoverPocketRuntimes, PocketRuntimeClient } from "../tools/pocket-runtime-client.ts";
import { encodePocketRuntimeFrame, encodePocketRuntimeHello, encodePocketRuntimePackageBegin,
  encodePocketRuntimePackageChunk, pocketPackageFooterHash, POCKET_RUNTIME_MSG } from "../contracts/spec/pocket-runtime-wire.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), "pocket-ipod-runtime-"));
const binary = join(directory, "runtime");
const token = new Uint8Array(32).fill(0x67);
const manifest = JSON.parse(readFileSync(join(ROOT, "apps/clear/pocket.json"), "utf8"));
const plan = resolveIPodTouch4BuildPlan(manifest);
const children: Bun.Subprocess[] = [];
const clients: PocketRuntimeClient[] = [];
let clearPackage: string;

async function run(command: string[], cwd = ROOT, env = process.env) {
  const process = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([process.exited,
    new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if (code) throw new Error(`${command.join(" ")}\n${out}${err}`);
  return out.trim();
}
beforeAll(async () => {
  const quickjs = process.env.POCKETJS_QUICKJS_SOURCE ?? join(ipodtouch4QuickJsPath(), "libquickjs-sys/embed/quickjs");
  if (!existsSync(join(quickjs, "quickjs.c"))) throw new Error("set POCKETJS_QUICKJS_SOURCE to the pinned QuickJS source directory (see native-c-harness.yml)");
  const toolchain = IPODTOUCH4_TOOLCHAIN.compiler.rustToolchain;
  const cargo = await run(["rustup", "which", "--toolchain", toolchain, "cargo"]);
  const rustc = await run(["rustup", "which", "--toolchain", toolchain, "rustc"]);
  const target = join(ROOT, ".pocket-build/ipodtouch4-runtime-tests/rust");
  await run([cargo, "build", "--locked", "--release", "--features", "bare-platform,software-only",
    "--manifest-path", join(ROOT, "engine/ui-cabi/Cargo.toml"), "--target-dir", target], ROOT,
  { ...process.env, RUSTC: rustc });
  const objects: string[] = [];
  for (const name of ["quickjs", "cutils", "dtoa", "libregexp", "libunicode"]) {
    const object = join(directory, `${name}.o`);
    await run(["cc", "-O1", "-D_GNU_SOURCE", `-DCONFIG_VERSION=\"${IPODTOUCH4_TOOLCHAIN.compiler.quickJsVersion}\"`,
      "-I", quickjs, "-c", join(quickjs, `${name}.c`), "-o", object]);
    objects.push(object);
  }
  await run(["cc", "-std=c11", "-D_DEFAULT_SOURCE", "-D_GNU_SOURCE", "-Wall", "-Wextra", "-Werror",
    '-DPOCKETJS_TARGET_ID="ipodtouch4-dev"', "-DPOCKETJS_HOST_ABI=8", "-DPOCKET_RASTER_DENSITY=2", "-DPOCKET_DEV_RUNTIME",
    "-I", join(ROOT, "engine/runtime"), "-I", join(ROOT, "engine/quickjs-c"), "-I", join(ROOT, "engine/ui-cabi/include"),
    "-I", join(ROOT, "contracts/generated"), "-isystem", quickjs,
    join(ROOT, "tests/fixtures/ipodtouch4-runtime.c"), join(ROOT, "engine/quickjs-c/pocket_runtime.c"),
    ...["dev_protocol", "dev_server", "guest_runtime"].map((name) => join(ROOT, `engine/runtime/${name}.c`)),
    ...objects, join(target, "release/libpocketjs_symbian_core.a"), "-lm", "-lpthread",
    ...(process.platform === "linux" ? ["-ldl"] : []), "-o", binary]);
  clearPackage = (await buildIPodTouch4Package({ manifest: "apps/clear/pocket.json", outdir: join(directory, "clear") })).path;
}, 180000);

afterAll(async () => {
  clients.forEach((client) => client.close());
  for (const child of children) if (child.exitCode === null) child.kill();
  await Promise.all(children.map((child) => child.exited));
  rmSync(directory, { recursive: true, force: true });
});

function packageBytes(source: string, mutate?: (variant: ReturnType<typeof makeVariant>) => void) {
  const variant = makeVariant({ target: plan.target.id, hostAbi: plan.target.hostAbi, planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
    js: new TextEncoder().encode(source), pak: new Uint8Array([0]) });
  mutate?.(variant);
  return encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [variant] });
}
async function port() {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}
async function start(name: string, paired = true) {
  const root = join(directory, name);
  mkdirSync(root, { recursive: true });
  if (paired) writeFileSync(join(root, "dev.key"), Buffer.from(token).toString("hex") + "\n");
  const address = { host: "127.0.0.1", port: await port(), token };
  const child = Bun.spawn([binary, root, String(address.port)], { stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(ready.value)).toContain("runtime harness ready");
  return { root, address, child };
}
async function connect(address: { host: string; port: number; token: Uint8Array }) {
  for (let i = 0; i < 40; ++i) {
    const client = new PocketRuntimeClient({ ...address, timeoutMs: 2000 });
    try { await client.connect(); clients.push(client); return client; }
    catch { client.close(); await Bun.sleep(50); }
  }
  throw new Error("runtime did not accept a connection");
}
async function status(client: PocketRuntimeClient) {
  const reply = client.waitForCtrl((message) => message.t === "runtime.status");
  await client.requestStatus();
  return await reply;
}
async function install(client: PocketRuntimeClient, bytes: Uint8Array) {
  const hash = pocketPackageFooterHash(bytes).toString(16).padStart(16, "0");
  const result = client.waitForCtrl((message) => message.t === "runtime.install" && message.hash === hash &&
    ["accepted", "rejected", "transfer-error"].includes(String(message.phase)), 10000);
  const [, verdict] = await Promise.all([client.install(bytes), result]);
  return verdict;
}
function hash(bytes: Uint8Array) { return pocketPackageFooterHash(bytes).toString(16).padStart(16, "0"); }

test("real QuickJS: accepts, rejects incompatible packages, rolls back eval/frame failures and recovers after restart", async () => {
  const device = await start("recovery");
  let client = await connect(device.address);
  expect((await status(client)).active).toBe("0000000000000000");
  const first = packageBytes("globalThis.frame = function() {}; // first");
  const second = packageBytes("globalThis.frame = function() {}; // second");
  expect((await install(client, first)).phase).toBe("accepted");
  expect((await install(client, second)).phase).toBe("accepted");
  expect(await status(client)).toMatchObject({ active: hash(second), lastGood: hash(first), generation: 2 });
  const invalid = [
    packageBytes("globalThis.frame = function() {};", (v) => { v.target = "3ds-dev"; }),
    packageBytes("globalThis.frame = function() {};", (v) => { v.hostAbi = 99; }),
    packageBytes("globalThis.frame = function() {};", (v) => {
      const section = v.sections.find((s) => s.kind === POCKET_SECTION.plan)!;
      section.bytes = new TextEncoder().encode(canonicalJson({ ...plan, viewport: { ...plan.viewport, logical: [480, 320] } }));
    }),
    packageBytes("globalThis.frame = function() {};", (v) => {
      v.sections.find((s) => s.kind === POCKET_SECTION.plan)!.bytes = new TextEncoder().encode("{ invalid");
    }),
    packageBytes("this is not javascript!"),
    packageBytes("while (true) {}"),
    packageBytes("globalThis.frame = function() { throw new Error('first frame failed'); };"),
    packageBytes("globalThis.frame = function() { while (true) {} };"),
  ];
  for (const bytes of invalid) {
    expect((await install(client, bytes)).phase).toBe("rejected");
    expect((await status(client)).active).toBe(hash(second));
  }
  const corrupt = new Uint8Array(first); corrupt[20] ^= 1;
  expect((await install(client, corrupt)).phase).toBe("rejected");
  expect((await status(client)).active).toBe(hash(second));
  client.close(); device.child.kill(); await device.child.exited;
  const restarted = await start("recovery");
  client = await connect(restarted.address);
  expect(await status(client)).toMatchObject({ active: hash(second), lastGood: hash(first), generation: 2, phase: "accepted" });
  // Corrupt the newest disk blob. A restart must present last-good before it
  // publishes a new generation, and must not retain the corrupt blob as backup.
  client.close(); restarted.child.kill(); await restarted.child.exited;
  writeFileSync(join(device.root, "packages", `${hash(second)}.pocket`), "torn");
  const recovered = await start("recovery");
  client = await connect(recovered.address);
  expect(await status(client)).toMatchObject({ active: hash(first), lastGood: "0000000000000000", generation: 3 });
}, 30000);

test("unpaired listener stays closed, pairing enables discovery, fragmented uploads and disconnects preserve active", async () => {
  const device = await start("wire", false);
  const unpairedConnects = await new Promise<boolean>((done) => {
    const probe = createConnection({ host: device.address.host, port: device.address.port });
    probe.once("connect", () => { probe.destroy(); done(true); });
    probe.once("error", () => { probe.destroy(); done(false); });
  });
  expect(unpairedConnects).toBe(false);
  expect(await discoverPocketRuntimes({ addresses: ["127.0.0.1"], port: device.address.port, timeoutMs: 100 })).toHaveLength(0);
  writeFileSync(join(device.root, "dev.key"), Buffer.from(token).toString("hex"));
  let client = await connect(device.address);
  const bytes = packageBytes("globalThis.frame = function() {}; // wire");
  expect((await install(client, bytes)).phase).toBe("accepted");
  const before = await status(client);
  const badOffset = client.waitForCtrl((message) => message.t === "runtime.install" && message.phase === "transfer-error");
  await client.sendFrame(POCKET_RUNTIME_MSG.packageBegin, encodePocketRuntimePackageBegin(bytes.length, pocketPackageFooterHash(bytes)));
  await client.sendFrame(POCKET_RUNTIME_MSG.packageChunk, encodePocketRuntimePackageChunk(1, bytes.subarray(0, 16)));
  expect((await badOffset).phase).toBe("transfer-error");
  expect((await status(client)).active).toBe(before.active);
  await client.sendFrame(POCKET_RUNTIME_MSG.packageBegin, encodePocketRuntimePackageBegin(bytes.length, pocketPackageFooterHash(bytes)));
  await client.sendFrame(POCKET_RUNTIME_MSG.packageChunk, encodePocketRuntimePackageChunk(0, bytes.subarray(0, 30)));
  client.close();
  await Bun.sleep(50);
  client = await connect(device.address);
  expect((await status(client)).active).toBe(before.active);
  expect(existsSync(join(device.root, "upload.tmp"))).toBe(false);
  const discoveries = await discoverPocketRuntimes({ addresses: ["127.0.0.1"], port: device.address.port, timeoutMs: 100 });
  expect(discoveries[0]?.target).toBe("ipodtouch4-dev");
  client.close();
  await Bun.sleep(50);
  const unauthorized = new PocketRuntimeClient({ ...device.address, token: new Uint8Array(32), timeoutMs: 500 });
  try { await expect(unauthorized.connect()).rejects.toThrow(); }
  finally { unauthorized.close(); }
  await Bun.sleep(50);
  // Actual TCP fragmentation, including a coalesced hello and status frame.
  const socket = createConnection({ host: device.address.host, port: device.address.port });
  await new Promise<void>((ready) => socket.once("connect", ready));
  const transcript = Buffer.concat([encodePocketRuntimeHello(token), encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.statusRequest)]);
  const data = new Promise<Buffer>((ready) => socket.once("data", (bytes) => ready(Buffer.from(bytes))));
  for (let i = 0; i < transcript.length; i += 3) { socket.write(transcript.subarray(i, i + 3)); await Bun.sleep(1); }
  expect((await data).readUInt32LE(0)).toBe(0x54524b50);
  socket.destroy();
}, 15000);

test("the compiled Clear app renders, answers DevTools, and recovers from a later guest exception", async () => {
  const device = await start("clear");
  const client = await connect(device.address);
  expect((await install(client, readFileSync(clearPackage))).phase).toBe("accepted");
  const tree = client.waitForCtrl((message) => message.t === "tree");
  await client.sendCtrl({ t: "getTree" });
  expect((await tree).t).toBe("tree");
  const evaluated = client.waitForCtrl((message) => message.t === "evalResult" && message.id === "probe");
  await client.sendCtrl({ t: "eval", id: "probe", code: "ui.__host + ':' + ui.__hostAbi" });
  expect(await evaluated).toMatchObject({ ok: true, value: "ipodtouch4-dev:8" });
  const laterFailure = packageBytes("let n=0; globalThis.frame = function() { if (++n > 25) throw Error('late failure'); };");
  expect((await install(client, laterFailure)).phase).toBe("accepted");
  for (let i = 0; i < 50; ++i) {
    const current = await status(client);
    if (current.active === hash(readFileSync(clearPackage))) {
      expect(current).toMatchObject({ phase: "accepted", generation: 3, lastGood: "0000000000000000" });
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error("late guest failure did not restore Clear");
}, 15000);
