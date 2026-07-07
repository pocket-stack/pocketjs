#!/usr/bin/env bun
// saga/compiler/cli.ts — `bun saga/compiler/cli.ts build film.tsx --out out.gba`

import { compileFilm } from "./index.ts";
import { emitGenData } from "./emit.ts";
import { buildRom } from "./rom.ts";

const args = process.argv.slice(2);
if (args[0] !== "build" || !args[1]) {
  console.error("usage: saga build <film.ts> [--out dist/film.gba] [--title TITLE]");
  process.exit(1);
}
const entry = args[1];
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : new URL("../dist/film.gba", import.meta.url).pathname;
const title = args.includes("--title") ? args[args.indexOf("--title") + 1] : "SAGA";

const film = await compileFilm(entry);
const rom = await buildRom(emitGenData(film), out, title);
await Bun.write(out + ".debug.json", JSON.stringify(film.debug, null, 2));
console.log(
  `saga: ${rom.gba} (${rom.size} bytes), ${film.scenes.length} scenes, ` +
    `${film.debug.texts.length} texts, ${film.nHalfcells} glyph halfcells`,
);
for (const s of film.scenes) {
  console.log(
    `  scene ${s.id}: main ${s.nMain}t${s.wide ? " wide" : ""}, shared ${s.nShared}t, ` +
      `obj ${s.objTiles.length / 32}t, cue ${s.cue.length}B`,
  );
}
