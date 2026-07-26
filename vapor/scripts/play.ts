#!/usr/bin/env bun
// vapor/scripts/play.ts — build the todo cart and launch it in mGBA.
//   bun vapor/scripts/play.ts [component.tsx]

import { basename, join, resolve } from "node:path";
import { $ } from "bun";
import { compileVaporApp } from "../compiler/compile.ts";
import { buildGbaRom } from "../compiler/rom.ts";

const ROOT = join(import.meta.dir, "..", "..");
const entry = resolve(process.argv[2] ?? join(import.meta.dir, "..", "examples", "todo", "todo.tsx"));
const name = basename(entry).replace(/\.tsx$/, "");

const app = compileVaporApp(entry, await Bun.file(entry).text(), name === "todo" ? "VAPOR TODO" : name.toUpperCase());
console.log(app.graph);
console.log(app.plan);
const rom = join(ROOT, "dist", "vapor", `${name}.gba`);
await buildGbaRom(app, rom);
console.log(rom);

const prefix = (await $`brew --prefix mgba`.text()).trim();
await $`open -a ${prefix}/mGBA.app ${rom}`;
