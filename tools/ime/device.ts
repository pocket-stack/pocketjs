/** Pair and run one USB companion. Keys remain in private device storage and
 * ignored local files, outside APKs, IPAs, guest bundles, and build receipts. */
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { shellQuote } from "../ipodtouch4-installation.ts";
const target = Bun.argv[2];
if (!["ipodtouch4", "moto-g-play"].includes(target)) throw new Error("Usage: bun tools/ime/device.ts <ipodtouch4|moto-g-play> --id=<USB device ID>");
const option = (key: string) => Bun.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const id = option("id");
if (!id || !/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Select the exact device with --id");
const keyPath = resolve(option("key") ?? `.pocket/clear-${target}.key`);
mkdirSync(dirname(keyPath), { recursive: true });
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
const key = readFileSync(keyPath, "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid pairing key");
function run(args: string[], stdin?: string) {
  const result = Bun.spawnSync(args, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(`${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
let tunnel: ReturnType<typeof Bun.spawn> | undefined;
process.on("exit", () => tunnel?.kill());
const port = target === "ipodtouch4" ? 18741 : 28741;
if (target === "ipodtouch4") {
  if (run(["ideviceinfo", "-u", id, "-k", "ProductType"]) !== "iPod4,1") throw new Error("Expected iPod touch 4");
  tunnel = Bun.spawn(["iproxy", "-u", id, "19224:22", `${port}:8741`], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(500);
  const cache = resolve(homedir(), ".cache/pocket-stack/ipodtouch4/ssh");
  const ssh = ["ssh", "-p", "19224", "-i", resolve(cache, "id_rsa"), "-o", `UserKnownHostsFile=${resolve(cache, "known_hosts")}`,
    "-o", "HostKeyAlias=[127.0.0.1]:2224", "-o", "StrictHostKeyChecking=yes",
    "-o", "HostKeyAlgorithms=+ssh-rsa", "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa", "-o", "BatchMode=yes", "root@127.0.0.1"];
  const bundle = run([...ssh, "/var/root/Library/PocketJS/ipodtouch4-installer user-path dev.pocket-stack.clear"]);
  if (!/^\/private\/var\/mobile\/Applications\/[A-Fa-f0-9-]+\/PocketJSiPodTouch4.app$/.test(bundle)) throw new Error("Unexpected Clear installation path");
  const path = shellQuote(`${dirname(bundle)}/Documents/offload.key`);
  run([...ssh, `umask 077; cat > ${path}; chown mobile:mobile ${path}`], key);
  const readback = run([...ssh, `cat ${path}`]);
  if (readback !== key) throw new Error("Pairing readback mismatch");
} else {
  const adb = ["adb", "-s", id];
  if (run([...adb, "shell", "getprop", "ro.product.device"]) !== "fogona") throw new Error("Expected Moto G Play 2024 (fogona)");
  run([...adb, "shell", "run-as", "dev.pocket_stack.clear", "mkdir", "-p", "files"]);
  run([...adb, "shell", "run-as", "dev.pocket_stack.clear", "sh", "-c", "'umask 077; cat > files/offload.key'"], key);
  if (run([...adb, "shell", "run-as", "dev.pocket_stack.clear", "cat", "files/offload.key"]) !== key) throw new Error("Pairing readback mismatch");
  run([...adb, "forward", `tcp:${port}`, "tcp:8741"]);
}
writeFileSync(resolve(dirname(keyPath), `clear-${target}-pairing.json`), JSON.stringify({ target, id, port,
  keyFingerprint: createHash("sha256").update(key).digest("hex"), readback: true }, null, 2));
const companion = Bun.spawn([process.execPath, resolve(import.meta.dir, "serve.ts"), `--port=${port}`, `--key=${keyPath}`], { stdout: "inherit", stderr: "inherit" });
const stop = () => { companion.kill(); tunnel?.kill(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
await companion.exited;
tunnel?.kill();
