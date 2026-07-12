// Deterministic PS Vita E2E: build capture VPKs, boot them in an isolated
// Vita3K VitaFS, wait for the guest completion marker, then compare the
// guest-produced, native-density 960x544 frames against Vita goldens.

import { $ } from "bun";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { encodePNG } from "./png.ts";
import { encodeThresholdInput, GOLDEN_SPECS } from "./golden-specs.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = `${ROOT}dist/e2e-vita3k`;
const VITAFS = `${OUT}/vitafs`;
const CONFIG = `${OUT}/config/config.yml`;
const APP_DIR = `${VITAFS}/ux0/app/PCKT00001`;
const CAPTURE_DIR = `${VITAFS}/ux0/data/pocketjs-captures`;
const NATIVE_RELEASE = `${ROOT}native-vita/target/armv7-sony-vita-newlibeabihf/release`;
const VITA_GOLDENS = `${ROOT}test/goldens-vita`;
const W = 960;
const H = 544;
const RAW_BYTES = W * H * 4;
const TIMEOUT_MS = Number(process.env.E2E_VITA3K_TIMEOUT_MS ?? 45_000);
const updateVita = process.env.UPDATE_VITA === "1";

const vita3k =
  process.env.VITA3K ||
  (process.platform === "darwin"
    ? `${homedir()}/Applications/Vita3K.app/Contents/MacOS/Vita3K`
    : Bun.which("Vita3K"));
const sourceConfig =
  process.env.VITA3K_CONFIG ||
  (process.platform === "darwin"
    ? `${homedir()}/Library/Application Support/Vita3K/Vita3K/config.yml`
    : `${homedir()}/.config/Vita3K/config.yml`);

if (!vita3k || !existsSync(vita3k)) {
  console.error("Vita3K not found (set VITA3K, or install ~/Applications/Vita3K.app)");
  process.exit(2);
}
if (!existsSync(sourceConfig)) {
  console.error(`Vita3K config not found at ${sourceConfig} (set VITA3K_CONFIG)`);
  process.exit(2);
}
const sourceConfigText = readFileSync(sourceConfig, "utf8");
const configuredVitaFs = sourceConfigText.match(/^pref-path:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, "");
const globalVitaFs = configuredVitaFs || `${dirname(sourceConfig)}/fs`;
const globalTitleStub = `${globalVitaFs}/ux0/app/PCKT00001`;
let createdGlobalTitleStub = false;
if (!existsSync(`${homedir()}/vitasdk/bin/arm-vita-eabi-gcc`) && !process.env.VITASDK) {
  console.error("VitaSDK not found (set VITASDK, or install it at ~/vitasdk)");
  process.exit(2);
}

function writeFixture(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${APP_DIR}/sce_sys`, { recursive: true });
  mkdirSync(CAPTURE_DIR, { recursive: true });
  mkdirSync(`${VITAFS}/ux0/user/00`, { recursive: true });
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(
    `${VITAFS}/ux0/user/00/user.xml`,
    '<?xml version="1.0" encoding="utf-8"?>\n<user id="00" name="Vita3K"><theme use-background="true"><content-id>default</content-id></theme><start-screen type="default"><path></path></start-screen><backgrounds /></user>\n',
  );
  writeFileSync(`${VITAFS}/ux0/user/time.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<time><user id="00" /></time>\n');
  // Vita3K's keyboard-binding decoder currently requires every config key to
  // be present. Clone the installed binary's own complete config, then change
  // only isolated/deterministic settings; never mutate the developer config.
  let config = sourceConfigText;
  const set = (key: string, value: string): void => {
    const line = new RegExp(`^${key}:.*$`, "m");
    config = line.test(config) ? config.replace(line, `${key}: ${value}`) : `${config.trimEnd()}\n${key}: ${value}\n`;
  };
  set("initial-setup", "false");
  set("backend-renderer", "Vulkan");
  set("resolution-multiplier", "1");
  set("screen-filter", "Nearest");
  set("v-sync", "false");
  set("memory-mapping", "double-buffer");
  set("disable-surface-sync", "false");
  set("modules-mode", "2");
  set("pref-path", VITAFS);
  set("show-live-area-screen", "false");
  set("boot-apps-full-screen", "false");
  set("show-welcome", "false");
  set("warn-missing-firmware", "false");
  set("check-for-updates-mode", "0");
  set("discord-rich-presence", "false");
  set("log-level", "0");
  writeFileSync(CONFIG, config);
}

function writeDemoManifest(name: string): string {
  const demo = name.replace(/-main$/, "");
  const manifest = JSON.parse(readFileSync(`${ROOT}pocket.json`, "utf8")) as Record<string, any>;
  manifest.id = `dev.pocket-stack.e2e.${demo.replace(/-/g, ".")}`;
  manifest.name = `pocketjs-e2e-${demo}`;
  manifest.title = `PocketJS E2E ${demo}`;
  manifest.app.entry = `demos/${demo}/main.tsx`;
  manifest.app.output = name;
  manifest.app.framework = "solid";
  const path = `${OUT}/manifests/${name}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return path;
}

// Vita3K validates `-r TITLE_ID` against the default/global VitaFS before it
// parses --config-location. Seed only an empty title directory for that CLI
// check when needed; the actual app always lives in the isolated VitaFS.
if (!existsSync(globalTitleStub)) {
  mkdirSync(globalTitleStub, { recursive: true });
  createdGlobalTitleStub = true;
}
process.on("exit", () => {
  if (createdGlobalTitleStub) {
    try {
      rmdirSync(globalTitleStub);
    } catch {
      // Refuse recursive deletion if another process unexpectedly populated it.
    }
  }
});

async function terminate(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([proc.exited, Bun.sleep(2_000)]);
  if (proc.exitCode === null) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

async function runVita3K(): Promise<void> {
  const done = `${CAPTURE_DIR}/done`;
  const error = `${CAPTURE_DIR}/error.txt`;
  const proc = Bun.spawn(
    [vita3k!, "--keep-config", "--load-config", "--config-location", CONFIG, "-r", "PCKT00001"],
    { cwd: ROOT, stdout: "ignore", stderr: "ignore" },
  );
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (existsSync(error)) throw new Error(readFileSync(error, "utf8"));
      if (existsSync(done)) return;
      if (proc.exitCode !== null) throw new Error(`Vita3K exited before guest completion (code ${proc.exitCode})`);
      await Bun.sleep(20);
    }
    throw new Error(`timed out after ${TIMEOUT_MS} ms`);
  } finally {
    // The capture guest parks after writing `done`; host-owned termination
    // avoids Vita3K 0.2.1/macOS's sceKernelExitProcess GXM teardown fault.
    await terminate(proc);
  }
}

function isNonFlat(rgba: Uint8Array): boolean {
  const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength / 4);
  const seen = new Set<number>();
  for (const pixel of pixels) {
    seen.add(pixel);
    if (seen.size >= 3) return true;
  }
  return false;
}

/** Prove capture did not regress to rendering 480x272 and duplicating each pixel. */
function hasNativeDetail(rgba: Uint8Array): boolean {
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const topLeft = (y * W + x) * 4;
      for (const offset of [topLeft + 4, topLeft + W * 4, topLeft + W * 4 + 4]) {
        for (let channel = 0; channel < 4; channel++) {
          if (rgba[topLeft + channel] !== rgba[offset + channel]) return true;
        }
      }
    }
  }
  return false;
}

writeFixture();
mkdirSync(VITA_GOLDENS, { recursive: true });
let passed = 0;
let failed = 0;
const requestedApp = process.env.E2E_VITA3K_APP;
const specs = requestedApp
  ? GOLDEN_SPECS.filter((spec) => spec.name === requestedApp || spec.name === `${requestedApp}-main`)
  : GOLDEN_SPECS;
if (specs.length === 0) {
  console.error(`unknown E2E_VITA3K_APP: ${requestedApp}`);
  process.exit(2);
}

for (const spec of specs) {
  const input = encodeThresholdInput(spec);
  const manifest = writeDemoManifest(spec.name);
  console.log(`\n## ${spec.name} (${spec.capture.length} golden frame(s))`);
  // Exercise the same manifest -> plan -> compiler -> backend path as real
  // applications, including the target/HostOps ABI startup handshake.
  const build = await $`bun scripts/pocket.ts build --target vita --manifest ${manifest} --project-root ${ROOT} -- --capture --release`
    .cwd(ROOT)
    .env({
      ...process.env,
      VITASDK: process.env.VITASDK ?? `${homedir()}/vitasdk`,
      POCKETJS_CAPTURE_INPUT: input,
      POCKETJS_CAPTURE_FRAMES: spec.capture.join(","),
    })
    .quiet()
    .nothrow();
  if (build.exitCode !== 0) {
    console.error(`FAIL ${spec.name}: Vita build failed\n${build.stdout}${build.stderr}`);
    failed += spec.capture.length;
    continue;
  }

  rmSync(CAPTURE_DIR, { recursive: true, force: true });
  mkdirSync(CAPTURE_DIR, { recursive: true });
  copyFileSync(`${NATIVE_RELEASE}/pocketjs-vita.self`, `${APP_DIR}/eboot.bin`);
  copyFileSync(`${NATIVE_RELEASE}/pocketjs-vita.sfo`, `${APP_DIR}/sce_sys/param.sfo`);

  try {
    await runVita3K();
  } catch (error) {
    console.error(`FAIL ${spec.name}: ${(error as Error).message}`);
    failed += spec.capture.length;
    continue;
  }

  for (const frame of spec.capture) {
    const label = `${spec.name}.${frame}`;
    try {
      const rawPath = `${CAPTURE_DIR}/f${String(frame).padStart(4, "0")}.rgba`;
      if (!existsSync(rawPath)) throw new Error(`${label}: capture file missing`);
      const raw = readFileSync(rawPath);
      if (raw.byteLength !== RAW_BYTES) {
        throw new Error(`${label}: expected ${RAW_BYTES} bytes (960x544 RGBA), got ${raw.byteLength}`);
      }
      if (!isNonFlat(raw)) throw new Error(`${label}: degenerate flat frame`);
      if (!hasNativeDetail(raw)) {
        throw new Error(`${label}: framebuffer contains only duplicated 2x2 logical pixels`);
      }
      const actual = Buffer.from(encodePNG(raw, W, H));
      const vitaGoldenPath = `${VITA_GOLDENS}/${label}.png`;
      if (updateVita) {
        writeFileSync(vitaGoldenPath, actual);
        console.log(`WROTE ${label} (960x544 native-density Vita golden)`);
        passed++;
        continue;
      }
      if (!existsSync(vitaGoldenPath)) {
        throw new Error(`${label}: Vita golden missing (run with UPDATE_VITA=1 after visual review)`);
      }
      const expected = readFileSync(vitaGoldenPath);
      if (!actual.equals(expected)) {
        writeFileSync(`${OUT}/${label}.actual.png`, actual);
        throw new Error(`${label}: PNG bytes differ (see dist/e2e-vita3k/${label}.actual.png)`);
      }
      console.log(`PASS ${label} (960x544 native density, GXM textures/fonts resident, byte-exact)`);
      passed++;
    } catch (error) {
      console.error(`FAIL ${(error as Error).message}`);
      failed++;
    }
  }
}

console.log(`\nVita3K E2E: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
