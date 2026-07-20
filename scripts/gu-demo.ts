// gu-demo driver: cook a map, build the pocket3d-gu bring-up EBOOT, run it
// under PPSSPPHeadless (software renderer), and convert the dumped frames to
// PNGs for eyeballing. The 3D-backend equivalent of test/e2e-ppsspp.ts's
// build+run half, without goldens — this is a bring-up/debug tool.
//
//   bun scripts/gu-demo.ts                        # de_dust2, frames 8..40
//   bun scripts/gu-demo.ts --map de_inferno --cap-start 0 --cap-n 480
//   POCKET3D_TEST_MAPS=~/cs bun scripts/gu-demo.ts
//
// Maps root (maps/*.bsp + support/*.wad): POCKET3D_TEST_MAPS or the local
// default below. Output PNGs land in dist/gu-demo/.

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolvePspBuildToolchain } from "./psp-toolchain.ts";

const repo = new URL("..", import.meta.url).pathname;
const home = process.env.HOME ?? "";
const pocket3d = `${repo}pocket3d/`;
const demoDir = `${pocket3d}crates/gu-demo/`;

// ---- args -------------------------------------------------------------
const argv = Bun.argv.slice(2);
function flag(name: string, def: string): string {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
const mapName = flag("map", "de_dust2");
const capStart = flag("cap-start", "8");
const capN = flag("cap-n", "32");
const release = argv.includes("-r") || argv.includes("--release");

const mapsRoot =
  process.env.POCKET3D_TEST_MAPS ?? `${home}/Downloads/cs-maps-20260705-1836`;
const bsp = `${mapsRoot}/maps/${mapName}.bsp`;
if (!existsSync(bsp)) {
  console.error(`no such map: ${bsp} (set POCKET3D_TEST_MAPS)`);
  process.exit(1);
}

// ---- 1. cook ----------------------------------------------------------
mkdirSync(`${repo}dist/maps`, { recursive: true });
const p3d = `${repo}dist/maps/${mapName}.p3d`;
console.log(`gu-demo: cooking ${mapName}`);
await $`cargo run --release -q -p pocket3d-cook -- ${bsp} --wads ${mapsRoot}/support -o ${p3d} --verify`.cwd(
  pocket3d,
);

// ---- 2. cargo psp (same canonical contract as scripts/psp.ts) ----------
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
  // -O2 HAS TO LIVE HERE, not in a build script's `.opt_level()`:
  // CRATE_CC_NO_DEFAULTS above makes cc-rs skip add_default_flags, which is
  // where it would emit -O (cc-1.2 src/lib.rs, `if !no_defaults`). Without an
  // explicit flag clang compiles at -O0, so every C dependency — QuickJS most
  // of all, whose interpreter dispatch loop is the hottest code on the device
  // — shipped unoptimized.
  TARGET_CFLAGS:
    `-O2 -target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls -fno-pic -G0 -mno-check-zero-division ` +
    `-fno-stack-protector -I${sdk}/psp/include -I${sdk}/psp/sdk/include`,
  AR_mipsel_sony_psp: `${toolchain.llvmBin}/llvm-ar`,
  RANLIB_mipsel_sony_psp: `${toolchain.llvmBin}/llvm-ranlib`,
  RUST_PSP_TARGET: `${repo}native/targets/mipsel-sony-psp.json`,
  RUST_PSP_ABORT_ONLY: "1",
  CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "3",
  GU_DEMO_MAP: p3d,
  GU_DEMO_CAP_START: capStart,
  GU_DEMO_CAP_N: capN,
};

console.log(`gu-demo: cargo psp (map=${mapName}, cap=${capStart}+${capN})`);
const cargoArgs = release ? ["--release"] : [];
await $`${toolchain.rustup} run ${toolchain.manifest.rust.toolchain} cargo psp ${cargoArgs}`.cwd(demoDir).env(env);

const profile = release ? "release" : "debug";
const ebootDir = `${demoDir}target/mipsel-sony-psp/${profile}`;
// cargo-psp emits either <bin>.EBOOT.PBP or EBOOT.PBP depending on version.
const named = `${ebootDir}/gu-demo.EBOOT.PBP`;
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
const capDir = `${home}/.ppsspp/dc_cap`;
rmSync(capDir, { recursive: true, force: true });
rmSync(`${ebootDir}/pocketjs-dbg`, { recursive: true, force: true });
const timeout = process.env.GU_DEMO_TIMEOUT ?? "120";
console.log("gu-demo: PPSSPPHeadless (software renderer)");
await $`${ppsspp} --graphics=software --timeout=${timeout} ${ebootDir}/EBOOT.PBP`
  .nothrow()
  .quiet();

// ---- 4. convert -------------------------------------------------------
const outDir = `${repo}dist/gu-demo`;
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
  const png = `${outDir}/${mapName}.${raw.replace(".raw", ".png")}`;
  await $`magick -size 512x272 -depth 8 RGBA:${capDir}/${raw} -alpha off -crop 480x272+0+0 +repage PNG24:${png}`.quiet();
}
console.log(`gu-demo: ${raws.length} frames -> ${outDir}/`);
