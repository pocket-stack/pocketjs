#!/usr/bin/env bun
// static/compiler/play.ts — build a game and play it.
//
//   bun run play [game] [target]
//     game    boardroom | smoke | path/to/game.ts   (default: boardroom)
//     target  gba | gb | nes                        (default: gba)
//
// gba/gb open in the windowed mGBA.app (Homebrew). nes serves a local jsnes
// player (the same core the E2E harness uses) and opens your browser —
// no extra emulator install needed.
//
// Controls: d-pad walks, A talks/advances (mGBA: X key; browser: X),
// B = mGBA Z / browser Z, up/down move menu cursors.

import { $ } from "bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { TARGETS, type TargetName } from "../spec/isa.ts";
import { compileGame } from "./index.ts";
import { buildGba } from "./targets/gba.ts";
import { buildGb } from "./targets/gb.ts";
import { buildNes } from "./targets/nes.ts";

const ROOT = join(import.meta.dir, "..");
const GAMES: Record<string, string> = {
  boardroom: join(ROOT, "games", "boardroom", "game.ts"),
  smoke: join(ROOT, "test", "smoke", "game.ts"),
};

const [gameArg = "boardroom", targetArg = "gba"] = process.argv.slice(2);
const target = targetArg as TargetName;
if (!TARGETS[target]) {
  console.error(`unknown target "${targetArg}" (gba | gb | nes)`);
  process.exit(2);
}
const entry = GAMES[gameArg] ?? resolve(gameArg);
if (!existsSync(entry)) {
  console.error(`no such game "${gameArg}" (boardroom | smoke | path/to/game.ts)`);
  process.exit(2);
}
const name = gameArg in GAMES ? gameArg : "game";
const rom = join(ROOT, "dist", `${name}${TARGETS[target].ext}`);

console.log(`building ${name} for ${target}...`);
const out = await compileGame(entry, target);
if (target === "gba") await buildGba(out.linked, rom);
else if (target === "gb") await buildGb(out.linked, rom);
else await buildNes(out.linked, rom);
console.log(`  ${rom}`);

if (target === "gba" || target === "gb") {
  const prefix = (await $`brew --prefix mgba`.text()).trim();
  const apps = [...new Bun.Glob("**/mGBA.app").scanSync({ cwd: prefix, onlyFiles: false })];
  if (apps.length === 0) {
    console.error("mGBA.app not found — brew install mgba, or open the ROM in any emulator:");
    console.error(`  ${rom}`);
    process.exit(1);
  }
  await $`open -n ${join(prefix, apps[0])} --args ${rom}`;
  console.log("mGBA launched. Keys: arrows = d-pad, X = A, Z = B.");
} else {
  const jsnesPath = join(ROOT, "node_modules", "jsnes", "dist", "jsnes.min.js");
  const romBytes = await Bun.file(rom).arrayBuffer();
  const page = `<!doctype html><meta charset="utf-8"><title>${name}.nes — Pocket Static</title>
<style>body{background:#05070d;color:#9aa3b2;font:13px ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}
canvas{image-rendering:pixelated;width:512px;height:480px;border:1px solid #222a38}p{margin:8px 0 0}</style>
<canvas id="c" width="256" height="240"></canvas>
<p>arrows = d-pad &nbsp; X = A &nbsp; Z = B &nbsp; enter = start &nbsp; shift = select</p>
<script src="/jsnes.min.js"></script>
<script>
const ctx = document.getElementById("c").getContext("2d");
const img = ctx.createImageData(256, 240);
let frame = null;
const nes = new jsnes.NES({
  onFrame: (buf) => { frame = buf; },
  onAudioSample: () => {},
});
const KEYS = { ArrowUp: "BUTTON_UP", ArrowDown: "BUTTON_DOWN", ArrowLeft: "BUTTON_LEFT",
  ArrowRight: "BUTTON_RIGHT", KeyX: "BUTTON_A", KeyZ: "BUTTON_B", Enter: "BUTTON_START", ShiftLeft: "BUTTON_SELECT" };
addEventListener("keydown", (e) => { const k = KEYS[e.code]; if (k) { nes.buttonDown(1, jsnes.Controller[k]); e.preventDefault(); } });
addEventListener("keyup", (e) => { const k = KEYS[e.code]; if (k) { nes.buttonUp(1, jsnes.Controller[k]); e.preventDefault(); } });
fetch("/rom").then((r) => r.arrayBuffer()).then((buf) => {
  nes.loadROM(String.fromCharCode(...new Uint8Array(buf)));
  const tick = () => {
    nes.frame();
    if (frame) {
      for (let i = 0; i < 256 * 240; i++) {
        const p = frame[i];
        img.data[i * 4] = p & 0xff; img.data[i * 4 + 1] = (p >> 8) & 0xff;
        img.data[i * 4 + 2] = (p >> 16) & 0xff; img.data[i * 4 + 3] = 0xff;
      }
      ctx.putImageData(img, 0, 0);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
</script>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response(page, { headers: { "content-type": "text/html" } });
      if (path === "/jsnes.min.js") return new Response(Bun.file(jsnesPath));
      if (path === "/rom") return new Response(romBytes);
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  console.log(`jsnes player at ${url} (ctrl-c to stop)`);
  if (!process.env.PLAY_NO_OPEN) await $`open ${url}`;
}
