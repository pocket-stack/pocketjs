// pocket-drive driver: cook the city pack, build the streaming-drive EBOOT,
// run it under PPSSPPHeadless (software renderer) with the pack on the
// emulated memory stick, and convert dumped frames to PNGs for eyeballing.
// The city-drive sibling of scripts/gu-demo.ts.
//
//   bun scripts/pocket-drive.ts                          # frames 8..40
//   bun scripts/pocket-drive.ts --cap-start 0 --cap-n 600 -r
//   bun scripts/pocket-drive.ts --embed                  # no ms0 file: embedded pack path
//
// Output PNGs land in dist/pocket-drive/.

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolvePspBuildToolchain } from "./psp-toolchain.ts";

const repo = new URL("..", import.meta.url).pathname;
const home = process.env.HOME ?? "";
const crateDir = `${repo}pocket3d/crates/pocket-drive/`;

// ---- args -------------------------------------------------------------
const argv = Bun.argv.slice(2);
function flag(name: string, def: string): string {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
const capStart = flag("cap-start", "8");
const capN = flag("cap-n", "32");
const release = argv.includes("-r") || argv.includes("--release");
const embed = argv.includes("--embed");

// ---- 1. cook ----------------------------------------------------------
const pdrv = `${repo}dist/drive/manhattan.pdrv`;
console.log("pocket-drive: cooking manhattan");
await $`bun cooker/cook.ts --out ${pdrv}`.cwd(crateDir);

// ---- 2. cargo psp (same canonical contract as scripts/gu-demo.ts) ------
let toolchain: ReturnType<typeof resolvePspBuildToolchain>;
try {
  toolchain = resolvePspBuildToolchain();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const sdk = toolchain.sdk.path;

const env = {
  ...toolchain.environment,
  RUSTFLAGS: "-A linker-messages -A unexpected-cfgs -A unstable-name-collisions",
  CRATE_CC_NO_DEFAULTS: "1",
  TARGET_CC: "clang",
  TARGET_AR: `${toolchain.llvmBin}/llvm-ar`,
  TARGET_CFLAGS:
    `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls -fno-pic -G0 -mno-check-zero-division ` +
    `-fno-stack-protector -I${sdk}/psp/include -I${sdk}/psp/sdk/include`,
  AR_mipsel_sony_psp: `${toolchain.llvmBin}/llvm-ar`,
  RANLIB_mipsel_sony_psp: `${toolchain.llvmBin}/llvm-ranlib`,
  RUST_PSP_TARGET: `${repo}native/targets/mipsel-sony-psp.json`,
  RUST_PSP_ABORT_ONLY: "1",
  CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "3",
  DRIVE_PACK: embed ? pdrv : "",
  DRIVE_CAP_START: capStart,
  DRIVE_CAP_N: capN,
};

console.log(`pocket-drive: cargo psp (cap=${capStart}+${capN}${embed ? ", embedded pack" : ""})`);
const cargoArgs = release ? ["--release"] : [];
await $`${toolchain.rustup} run ${toolchain.manifest.rust.toolchain} cargo psp ${cargoArgs}`
  .cwd(crateDir)
  .env(env);

const profile = release ? "release" : "debug";
const ebootDir = `${crateDir}target/mipsel-sony-psp/${profile}`;
const named = `${ebootDir}/pocket-drive.EBOOT.PBP`;
if (existsSync(named)) {
  await Bun.write(`${ebootDir}/EBOOT.PBP`, await Bun.file(named).arrayBuffer());
}
if (!existsSync(`${ebootDir}/EBOOT.PBP`)) {
  console.error(`no EBOOT.PBP under ${ebootDir}`);
  process.exit(1);
}

// ---- 3. PPSSPPHeadless -------------------------------------------------
const ppsspp =
  process.env.PPSSPP_HEADLESS ?? `${home}/ppsspp-src/build/PPSSPPHeadless`;
if (!existsSync(ppsspp)) {
  console.log(`PPSSPPHeadless not found at ${ppsspp}; EBOOT at ${ebootDir}/EBOOT.PBP`);
  process.exit(0);
}
// The pack on the emulated memory stick — the real streaming path.
if (!embed) {
  mkdirSync(`${home}/.ppsspp/pocket-drive`, { recursive: true });
  await Bun.write(
    `${home}/.ppsspp/pocket-drive/manhattan.pdrv`,
    await Bun.file(pdrv).arrayBuffer(),
  );
} else {
  rmSync(`${home}/.ppsspp/pocket-drive`, { recursive: true, force: true });
}
const capDir = `${home}/.ppsspp/dc_cap`;
rmSync(capDir, { recursive: true, force: true });
const timeout = process.env.DRIVE_TIMEOUT ?? "180";
console.log("pocket-drive: PPSSPPHeadless (software renderer)");
await $`${ppsspp} --graphics=software --timeout=${timeout} ${ebootDir}/EBOOT.PBP`
  .nothrow()
  .quiet();

// ---- 4. convert -------------------------------------------------------
const outDir = `${repo}dist/pocket-drive`;
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const raws = existsSync(capDir)
  ? readdirSync(capDir).filter((f) => f.endsWith(".raw")).sort()
  : [];
if (raws.length === 0) {
  console.error("no frames dumped — check the run");
  process.exit(1);
}
for (const raw of raws) {
  const png = `${outDir}/${raw.replace(".raw", ".png")}`;
  await $`magick -size 512x272 -depth 8 RGBA:${capDir}/${raw} -alpha off -crop 480x272+0+0 +repage PNG24:${png}`.quiet();
}
console.log(`pocket-drive: ${raws.length} frames -> ${outDir}/`);
