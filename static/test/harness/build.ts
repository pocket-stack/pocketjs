#!/usr/bin/env bun
// static/test/harness/build.ts — build mgba_runner against Homebrew libmgba.
//   bun static/test/harness/build.ts

import { $ } from "bun";
import { join } from "node:path";

const prefix = (await $`brew --prefix mgba`.text()).trim();
const here = import.meta.dir;
const out = join(here, "mgba_runner");

await $`clang -O2 -Wall -I${prefix}/include ${join(here, "mgba_runner.c")} -L${prefix}/lib -lmgba -Wl,-rpath,${prefix}/lib -o ${out}`;
console.log(`built ${out}`);
