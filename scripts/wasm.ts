// scripts/wasm.ts — build wasm/ for the browser/Bun hosts:
//   cargo build --release --target wasm32-unknown-unknown
// then copy target/wasm32-unknown-unknown/release/pocketjs_wasm.wasm to
// host-web/pocketjs.wasm and print its size.
//
//   bun scripts/wasm.ts
//
// Needs the wasm target: rustup target add wasm32-unknown-unknown

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, delimiter } from "node:path";
import { homedir } from "node:os";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url))); // PocketJS/
const WASM_DIR = join(ROOT, "wasm");
const OUT = join(ROOT, "host-web/pocketjs.wasm");
const BUILT = join(WASM_DIR, "target/wasm32-unknown-unknown/release/pocketjs_wasm.wasm");

// cargo lives in ~/.cargo/bin, which non-login shells may not have on PATH.
const env = {
  ...process.env,
  PATH: `${join(homedir(), ".cargo/bin")}${delimiter}${process.env.PATH ?? ""}`,
  RUSTFLAGS: "-C target-feature=+simd128",
};

const proc = Bun.spawnSync(
  ["cargo", "build", "--release", "--target", "wasm32-unknown-unknown"],
  { cwd: WASM_DIR, env, stdout: "inherit", stderr: "inherit" },
);
if (proc.exitCode !== 0) {
  console.error(
    "PocketJS wasm: cargo build failed" +
      " (missing target? run: rustup target add wasm32-unknown-unknown)",
  );
  process.exit(proc.exitCode ?? 1);
}
if (!existsSync(BUILT)) {
  console.error(`PocketJS wasm: build succeeded but ${BUILT} is missing`);
  process.exit(1);
}

const bytes = await Bun.file(BUILT).arrayBuffer();
await Bun.write(OUT, bytes);
console.log(
  `PocketJS wasm: host-web/pocketjs.wasm (${bytes.byteLength} bytes, ${(bytes.byteLength / 1024).toFixed(1)} KiB)`,
);
