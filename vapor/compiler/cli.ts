#!/usr/bin/env bun
// Rust SFC builds and the retained cartridge compiler share one entry point.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const candidate = args[0] === "check" ? args[1] : args[0];
const isSfc = candidate?.endsWith(".vue") || (candidate &&
  [resolve(candidate), resolve(import.meta.dir, "../../apps", candidate)].some(path =>
    existsSync(path) && statSync(path).isDirectory(),
  ));
if (args[0] === "--help" || args[0] === "-h") {
  console.log("bun vapor/compiler/cli.ts build <app|Root.vue> [--out gen] [--strict] [--ir file] [--board name] [--no-format]\nbun vapor/compiler/cli.ts check <app|Root.vue> [--strict] [--boards | --board name] [--json]\nbun vapor/compiler/cli.ts <legacy.tsx> [--target gba|gb|nes|esp32|playdate]");
} else if (args[0] === "build" || isSfc) {
  try {
    const { runVueAotCli } = await import("./aot-build.ts");
    await runVueAotCli(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  await import("./cli-legacy.ts");
}
