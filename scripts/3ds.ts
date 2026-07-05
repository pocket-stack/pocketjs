// scripts/3ds.ts <app> — build a runnable Nintendo 3DS homebrew (.3dsx) for the
// 3DS emulator (Azahar) / hardware, the 3DS analogue of scripts/psp.ts.
//
//   bun scripts/3ds.ts hero        # -> native-3ds/pocketjs-3ds.3dsx
//
// Pipeline (see native-3ds/README.md for the full runbook + what to install):
//   1. build the app bundle + pak for the "3ds" device profile (400x240):
//      bun scripts/build.ts <app> --device=3ds
//   2. cross-compile the Rust bridge (native-3ds/ffi) for armv6k-nintendo-3ds
//      with the profile's screen size (nightly + -Z build-std) -> a staticlib
//   3. embed the bundle + pak into the C host (native-3ds/gen-game.ts)
//   4. make the .3dsx (devkitARM: host DEVKITARM, else the devkitpro/devkitarm
//      Docker image — no host toolchain/sudo, like dreamcart runtime-3ds)
//
// SCAFFOLD: the 3DS toolchain (devkitPro) is not installed in the authoring
// environment, so this has not been run end-to-end. Each step fails fast with
// an actionable message. The Rust bridge (step 2) DOES build on the host as a
// plain staticlib (that is how its Rust is verified) — only the cross build +
// the C link require the toolchain.

import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolveProfile } from "../spec/devices.ts";

const root = new URL("..", import.meta.url).pathname; // repo root
const native3ds = root + "native-3ds/";
const ffiDir = native3ds + "ffi/";
const profile = resolveProfile("3ds"); // 400x240 — one source of truth
const TOOLCHAIN = process.env.POCKETJS_3DS_TOOLCHAIN ?? "nightly";
const home = process.env.HOME ?? "";
const rustup =
  Bun.which("rustup") ?? (existsSync(`${home}/.cargo/bin/rustup`) ? `${home}/.cargo/bin/rustup` : null);

// ---------------------------------------------------------------------------
// CLI: first bare arg = app; the rest pass through to build.ts.
// ---------------------------------------------------------------------------
const argv = Bun.argv.slice(2);
let appArg = "";
const buildArgs: string[] = [];
for (const a of argv) {
  if (!appArg && !a.startsWith("-")) appArg = a;
  else buildArgs.push(a);
}
if (!appArg) {
  console.error("usage: bun scripts/3ds.ts <app> [build.ts args…]   e.g. bun scripts/3ds.ts hero");
  process.exit(1);
}

// A bare component demo needs its mounting entry (demos/<app>/main.tsx).
function mountedAppName(arg: string): string {
  const bare = arg.replace(/\.tsx?$/, "").replace(/-main$/, "");
  if (existsSync(`${root}demos/${bare}/main.tsx`)) return `${bare}-main`;
  return arg;
}
const app = mountedAppName(appArg);

// ---------------------------------------------------------------------------
// Prereqs (fail fast).
// ---------------------------------------------------------------------------
if (!rustup) {
  console.error("PocketJS 3ds: rustup not found — install Rust (https://rustup.rs) then `rustup toolchain install nightly && rustup component add rust-src --toolchain nightly`");
  process.exit(1);
}
const hasDevkitArm = !!process.env.DEVKITARM && existsSync(`${process.env.DEVKITARM}/bin`);
const hasDocker = !!Bun.which("docker");
if (!hasDevkitArm && !hasDocker) {
  console.error(
    "PocketJS 3ds: need devkitARM to link the .3dsx. Either:\n" +
      "  • install devkitPro (`dkp-pacman -S 3ds-dev`) and `export DEVKITARM=/opt/devkitpro/devkitARM`, or\n" +
      "  • install Docker (the build falls back to the devkitpro/devkitarm image).",
  );
  process.exit(1);
}
if (!existsSync(`${native3ds}quickjs/quickjs.c`)) {
  console.error(
    `PocketJS 3ds: native-3ds/quickjs/ is empty — vendor the proven 3DS QuickJS fork first ` +
      `(e.g. copy dreamcart runtime-3ds/quickjs). See native-3ds/README.md.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. App bundle + pak for the 3ds profile.
// ---------------------------------------------------------------------------
console.log(`PocketJS 3ds: building app "${app}" (device 3ds, ${profile.width}x${profile.height})`);
await $`bun scripts/build.ts ${app} --device=3ds ${buildArgs}`.cwd(root);

// ---------------------------------------------------------------------------
// 2. Cross-compile the Rust bridge for armv6k-nintendo-3ds, screen from profile.
//    The built-in Tier-3 target needs no `rustup target add`, only rust-src.
// ---------------------------------------------------------------------------
console.log(`PocketJS 3ds: cargo build (armv6k-nintendo-3ds, build-std)`);
// build-std = core,alloc ONLY (no std): the ffi crate is #![no_std] and routes
// its heap through the C host's newlib malloc, so pulling in horizon `std`
// would only drag in the pthread-3ds/shim-3ds runtime we deliberately avoid.
// panic=abort comes from ffi/Cargo.toml [profile.release] and propagates to the
// build-std crates, so no unwinder / rust_eh_personality is emitted.
await $`${rustup} run ${TOOLCHAIN} cargo build --release --target armv6k-nintendo-3ds -Z build-std=core,alloc`
  .cwd(ffiDir)
  .env({
    ...process.env,
    POCKETJS_SCREEN_W: String(profile.width),
    POCKETJS_SCREEN_H: String(profile.height),
  });

// ---------------------------------------------------------------------------
// 3. Embed bundle + pak into the C host.
// ---------------------------------------------------------------------------
await $`bun ${native3ds}gen-game.ts ${app}`.cwd(root);

// ---------------------------------------------------------------------------
// 4. make the .3dsx (host devkitARM, else Docker).
// ---------------------------------------------------------------------------
if (hasDevkitArm) {
  console.log("PocketJS 3ds: make (host devkitARM)");
  await $`make -j8`.cwd(native3ds);
} else {
  console.log("PocketJS 3ds: make (devkitpro/devkitarm Docker image)");
  const mount = root.replace(/\/$/, "");
  // The image only puts /opt/devkitpro/tools/bin on PATH; the compiler lives in
  // $DEVKITARM/bin, so prepend it before make.
  await $`docker run --rm -v ${mount}:/work -w /work/native-3ds devkitpro/devkitarm:latest bash -lc ${"export PATH=$DEVKITARM/bin:$PATH && make -j8"}`;
}

const out = `${native3ds}pocketjs-3ds.3dsx`;
if (existsSync(out)) {
  console.log(`output: ${out}`);
  console.log(`run it:  /Applications/Azahar.app/Contents/MacOS/azahar ${out}`);
} else {
  console.error(`PocketJS 3ds: build finished but ${out} is missing — check the make output above`);
  process.exit(1);
}
