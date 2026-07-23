#!/usr/bin/env bun
// Build a Pocket Vapor component for the official Playdate Simulator and open it.
//   bun vapor/scripts/playdate.ts [component.tsx]

import { $ } from "bun";
import { basename, join, resolve } from "node:path";
import { compileVaporApp } from "../compiler/compile.ts";
import {
  buildPlaydatePdx,
  playdateSdkVersion,
  playdateSimulatorApp,
  resolvePlaydateSdk,
} from "../compiler/playdate.ts";

const ROOT = join(import.meta.dir, "..", "..");
const entry = resolve(
  process.argv[2] ?? join(import.meta.dir, "..", "examples", "todo", "todo.tsx"),
);
const name = basename(entry).replace(/\.tsx$/, "");
const app = compileVaporApp(
  entry,
  await Bun.file(entry).text(),
  name === "todo" ? "VAPOR TODO" : name.toUpperCase(),
  "playdate",
);
const pdx = join(ROOT, "dist", "vapor", `${name}.pdx`);

console.log(app.graph);
console.log(app.plan);
const result = await buildPlaydatePdx(app, pdx);
const sdk = resolvePlaydateSdk();
console.log(
  `${pdx} (${(result.romBytes / 1024).toFixed(1)} KB, Playdate SDK ${playdateSdkVersion(sdk)})`,
);

// A fresh Simulator process gives each native extension a clean BSS. Reusing
// an existing process can retain state while switching between unrelated PDXs.
await $`open -na ${playdateSimulatorApp(sdk)} --args ${pdx}`;
