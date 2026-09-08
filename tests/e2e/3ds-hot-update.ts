// Run against a paired, already-running 3DS runtime (console or Azahar).
// The given package must match that runtime's embedded app/native plan.
// Restores the supplied production package after exercising failure recovery.
// bun tests/e2e/3ds-hot-update.ts --host IP --key device.key --package app.pocket --out receipts
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PocketRuntimeClient, parsePocketRuntimeToken } from "../../tools/3ds-runtime-client.ts";
import { POCKET_SECTION, decodePocketPackage, encodePocketPackage } from "../../contracts/spec/pocket-package.ts";
import { POCKET_RUNTIME_MSG, encodePocketRuntimePackageBegin, encodePocketRuntimePackageChunk, pocketPackageFooterHash } from "../../contracts/spec/pocket-runtime-wire.ts";
const arg = (key: string) => { const i = process.argv.indexOf(key); if (i < 0 || !process.argv[i + 1]) throw new Error(`missing ${key}`); return process.argv[i + 1]!; };
const original = readFileSync(arg("--package"));
const output = resolve(arg("--out")); mkdirSync(output, { recursive: true });
const client = new PocketRuntimeClient({ host: arg("--host"), token: parsePocketRuntimeToken(readFileSync(arg("--key"), "utf8")), timeoutMs: 30000 });
const receipts: unknown[] = [];
client.on("ctrl", (m) => { if (m.t === "runtime.install") { receipts.push(m); console.log(JSON.stringify(m)); } });
const hash = (b: Uint8Array) => pocketPackageFooterHash(b).toString(16).padStart(16, "0");
function variant(suffix: string, kind: number = POCKET_SECTION.js): Uint8Array {
  const pkg = decodePocketPackage(original);
  for (const v of pkg.variants) {
    const section = v.sections.find(s => s.kind === kind)!;
    const text = new TextDecoder().decode(section.bytes);
    section.bytes = new TextEncoder().encode(kind === POCKET_SECTION.js ? text.slice(0, -1) + "\n" + suffix + "\0" : text + suffix);
  }
  return encodePocketPackage(pkg);
}
async function status() {
  const receipt = client.waitForCtrl(m => m.t === "runtime.status"); await client.requestStatus(); return await receipt;
}
async function install(bytes: Uint8Array, expected: "accepted" | "rejected") {
  const receipt = client.waitForCtrl(m => m.t === "runtime.install" && m.hash === hash(bytes) && (m.phase === "accepted" || m.phase === "rejected"));
  await client.install(bytes); const result = await receipt; assert.equal(result.phase, expected); return result;
}
async function evaluate(code: string) {
  const id = `qa-${Date.now()}`;
  const result = client.waitForCtrl(m => m.t === "evalResult" && m.id === id);
  await client.sendCtrl({ t: "eval", id, code }); return await result;
}
let connected = false;
try {
  receipts.push(await client.connect()); connected = true;
  const before = await status(); receipts.push({ before });
  const good = variant('globalThis.__runtimeProbe = "hot-update-ok";');
  const accepted = client.waitForCtrl(m => m.t === "runtime.install" && m.hash === hash(good) && m.phase === "accepted");
  await client.sendFrame(POCKET_RUNTIME_MSG.packageBegin, encodePocketRuntimePackageBegin(good.length, pocketPackageFooterHash(good)));
  // Deliberately stretch transfer over several UI frames. Query the native
  // status before commit to prove no guest replacement happened mid-transfer.
  const mid: Record<string, unknown>[] = [];
  for (let offset = 0; offset < good.length; offset += 16384) {
    await client.sendFrame(POCKET_RUNTIME_MSG.packageChunk, encodePocketRuntimePackageChunk(offset, good.subarray(offset, offset + 16384)));
    if (offset % 65536 === 0) mid.push(await status());
    await Bun.sleep(30);
  }
  assert(mid.every(m => m.generation === before.generation && m.running === before.running));
  assert(Number(mid.at(-1)!.frame) > Number(mid[0]!.frame) + 10, "UI stopped during upload");
  receipts.push({ transfer: mid });
  await client.sendFrame(POCKET_RUNTIME_MSG.packageCommit); await accepted;
  assert.equal((await status()).active, hash(good));
  assert(String((await evaluate("globalThis.__runtimeProbe")).value).includes("hot-update-ok"));

  await install(variant('throw new Error("hot-update eval rejection");'), "rejected");
  assert.equal((await status()).active, hash(good));
  await install(variant('globalThis.frame = () => { throw new Error("hot-update first-frame rejection"); };'), "rejected");
  assert.equal((await status()).active, hash(good));
  await install(variant(" ", POCKET_SECTION.plan), "rejected");
  assert.equal((await status()).active, hash(good));
  const corrupt = Uint8Array.from(original); corrupt[corrupt.length - 20]! ^= 1;
  await install(corrupt, "rejected");
  assert.equal((await status()).active, hash(good));
  assert(String((await evaluate("globalThis.__runtimeProbe")).value).includes("hot-update-ok"));

  // A later frame can fail after acceptance; recovery must append a generation
  // selecting last-good instead of repeatedly booting the failing package.
  const late = variant('var qaFrame = globalThis.frame, qaCount = 0; globalThis.frame = (...args) => { if (++qaCount > 90) throw new Error("hot-update running failure"); return qaFrame(...args); };');
  await install(late, "accepted");
  const recoveryDeadline = Date.now() + 30000;
  let recovered = await status();
  while (recovered.active !== hash(good) || recovered.running !== hash(good)) {
    assert(Date.now() < recoveryDeadline, "accepted guest did not recover to last-good");
    await Bun.sleep(100); recovered = await status();
  }
  receipts.push({ recovered });
} finally {
  try {
  if (connected && client.connected) {
    await install(original, "accepted");
    await Bun.sleep(1000);
    const screenshot = client.waitForScreenshot(20000);
    await client.sendCtrl({ t: "screenshot" });
    const shot = await screenshot; writeFileSync(`${output}/final.png`, shot.png);
    receipts.push({ final: await status(), screenshotFrame: shot.frame });
  }
  } finally {
  client.close(); writeFileSync(`${output}/receipts.json`, JSON.stringify(receipts, (_, v) => typeof v === "bigint" ? v.toString(16) : v, 2));
  }
}
console.log("PASS: streaming UI, admission, eval/frame rejection, last-good recovery, restoration and screenshot");
