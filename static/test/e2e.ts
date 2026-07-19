#!/usr/bin/env bun
// static/test/e2e.ts — the cross-target contract suite.
//
// Build the smoke game for each target, then drive the same logical
// playthrough through each console's headless emulator (libmgba for gba/gb,
// jsnes for nes) and assert on the shared debug block. The REFERENCE VM is
// the oracle: the expected choice-round count, page counts and final
// vars/flags are computed by playing the story on vm/ref.ts first — the
// consoles just have to agree with it.
//
//   bun static/test/e2e.ts            # all targets with a runtime
//   bun static/test/e2e.ts gba gb     # subset

import { $ } from "bun";
import { join } from "node:path";
import { compileGame, type CompileOutput } from "../compiler/index.ts";
import { buildGba } from "../compiler/targets/gba.ts";
import { buildGb } from "../compiler/targets/gb.ts";
import { buildNes } from "../compiler/targets/nes.ts";
import { DBG, KEYS, TARGETS, dbgFlagAddr, dbgVarAddr, type TargetName } from "../spec/isa.ts";
import { RefVM } from "../vm/ref.ts";
import { AutoRpgHost } from "../vm/rpg-host.ts";

const HERE = import.meta.dir;
const DIST = join(HERE, "..", "dist");
const SHOTS = join(DIST, "shots");
const ENTRY = join(HERE, "smoke", "game.ts");
const RUNNER = join(HERE, "harness", "mgba_runner");
const NES_RUNNER = join(HERE, "harness", "nes_runner.ts");

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}: ${got}${ok ? "" : ` (want ${want})`}`);
  ok ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// Scenario builder (line protocol shared by both harnesses)
// ---------------------------------------------------------------------------
class Scenario {
  lines: string[] = [];
  advance(frames: number): this {
    this.lines.push(`A ${frames}`);
    return this;
  }
  press(keys: (keyof typeof KEYS)[], hold = 2, release = 6): this {
    const mask = keys.reduce((m, k) => m | KEYS[k], 0);
    this.lines.push(`P ${mask.toString(16)} ${hold} ${release}`);
    return this;
  }
  read(name: string, addr: number, size: 1 | 2 | 4): this {
    this.lines.push(`R ${name} 0x${addr.toString(16)} ${size}`);
    return this;
  }
  shot(path: string): this {
    this.lines.push(`S ${path}`);
    return this;
  }
}

async function run(target: TargetName, rom: string, sc: Scenario): Promise<Record<string, number>> {
  const file = join(DIST, `scenario-${target}.txt`);
  await Bun.write(file, sc.lines.join("\n") + "\n");
  const out =
    target === "nes" ? await $`bun ${NES_RUNNER} ${rom} ${file}`.text() : await $`${RUNNER} ${rom} ${file}`.text();
  const line = out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) throw new Error(`runner produced no JSON:\n${out}`);
  const parsed = JSON.parse(line);
  if (!parsed.ok) throw new Error(`runner error: ${line}`);
  return parsed.reads ?? {};
}

// ---------------------------------------------------------------------------
// Oracle: play the guide fight on the reference VM
// ---------------------------------------------------------------------------
interface Oracle {
  /** say-page text ids in on-screen order */
  sayPages: number[];
  choiceCount: number;
  hp: number;
  cheers: number;
  subCalls: number;
}

function oracle(out: CompileOutput): Oracle {
  const code = out.linked.blobs[out.linked.scriptBlobIndex].bytes;
  const host = new AutoRpgHost(Array(30).fill(0));
  const vm = new RefVM(code, out.linked.scriptTable, host);
  host.play(vm, out.debug.scripts.GuideTalk);
  return {
    sayPages: host.events.filter((e) => e.kind === "say").map((e) => (e as { textId: number }).textId),
    choiceCount: host.events.filter((e) => e.kind === "choice").length,
    hp: vm.getVar(out.debug.vars.hp),
    cheers: vm.getVar(out.debug.vars.cheers),
    subCalls: vm.getVar(out.debug.vars.sub_calls),
  };
}

// ---------------------------------------------------------------------------
// The playthrough, per target
// ---------------------------------------------------------------------------
async function testTarget(target: TargetName): Promise<void> {
  console.log(`\n=== ${target.toUpperCase()} ===`);
  const out = await compileGame(ENTRY, target);
  const rom = join(DIST, `smoke${TARGETS[target].ext}`);
  if (target === "gba") await buildGba(out.linked, rom);
  else if (target === "gb") await buildGb(out.linked, rom);
  else await buildNes(out.linked, rom);
  await $`mkdir -p ${SHOTS}`.quiet();

  const A = (f: keyof typeof DBG) => TARGETS[target].debugAddr + DBG[f];
  const orc = oracle(out);
  const { vars, flags } = out.debug;
  const shot = (n: string) => join(SHOTS, `${target}_${n}.ppm`);
  // Generous page-reveal wait: longest page is < 90 tokens at 2/frame,
  // plus queued-clear latency on the 8-bit consoles.
  const REVEAL = 70;

  console.log("boot & spawn");
  {
    const r = await run(
      target,
      rom,
      new Scenario()
        .advance(30)
        .read("boot", A("BOOTED"), 1)
        .read("x", A("PLAYER_X"), 2)
        .read("y", A("PLAYER_Y"), 2)
        .read("map", A("CUR_MAP"), 1)
        .read("dir", A("PLAYER_DIR"), 1)
        .shot(shot("01_boot")),
    );
    check("booted", r.boot, 1);
    check("spawn x", r.x, 5);
    check("spawn y", r.y, 1);
    check("map", r.map, 0);
    check("dir down", r.dir, 0);
  }

  console.log("walk, collide with npc, talk, choice, battle, flag");
  {
    const sc = new Scenario()
      .advance(30)
      // two tiles left; third is the guide (solid) — hold long enough for 3
      .press(["LEFT"], 20, 4)
      .read("blockedX", A("PLAYER_X"), 2)
      .read("dirLeft", A("PLAYER_DIR"), 1)
      .press(["A"], 2, 6) // talk
      .read("script1", A("SCRIPT_ACTIVE"), 1)
      .advance(REVEAL)
      .read("text1", A("TEXT_ACTIVE"), 1)
      .read("page1", A("CUR_TEXT"), 2)
      .shot(shot("02_dialogue"))
      .press(["A"], 2, 6) // dismiss page -> choice
      .advance(10)
      .read("waitChoice", A("WAITING"), 1)
      .read("cursor0", A("CHOICE_CURSOR"), 1)
      .press(["DOWN"], 2, 4)
      .read("cursor1", A("CHOICE_CURSOR"), 1)
      .press(["UP"], 2, 4)
      .read("cursorBack", A("CHOICE_CURSOR"), 1)
      .shot(shot("03_choice"))
      .press(["A"], 2, 8); // pick "Spar"
    // battle rounds: one choice each (pick "Strike"), menu redraws between
    for (let i = 1; i < orc.choiceCount; i++) sc.advance(30).press(["A"], 2, 8);
    // win pages (FMT slot included), one A per page
    for (let i = 1; i < orc.sayPages.length; i++) sc.advance(REVEAL).shot(shot("04_win")).press(["A"], 2, 6);
    sc.advance(10)
      .read("scriptEnd", A("SCRIPT_ACTIVE"), 1)
      .read("textEnd", A("TEXT_ACTIVE"), 1)
      .read("flagWon", dbgFlagAddr(target, flags.beat_guide).addr, 1)
      .read("hp", dbgVarAddr(target, vars.hp), 2)
      .read("cheers", dbgVarAddr(target, vars.cheers), 2)
      .read("subCalls", dbgVarAddr(target, vars.sub_calls), 2)
      // re-talk takes the short flag branch
      .press(["A"], 2, 6)
      .advance(REVEAL)
      .read("retalkText", A("TEXT_ACTIVE"), 1)
      .read("retalkPage", A("CUR_TEXT"), 2);
    const r = await run(target, rom, sc);
    check("blocked at guide (x=4)", r.blockedX, 4);
    check("faces left", r.dirLeft, 2);
    check("script active", r.script1, 1);
    check("textbox up", r.text1, 1);
    check("first page id", r.page1, orc.sayPages[0]);
    check("choice waiting", r.waitChoice, 2);
    check("cursor 0", r.cursor0, 0);
    check("cursor down", r.cursor1, 1);
    check("cursor up", r.cursorBack, 0);
    check("script ended", r.scriptEnd, 0);
    check("textbox closed", r.textEnd, 0);
    const fw = dbgFlagAddr(target, flags.beat_guide);
    check("beat_guide set", (r.flagWon >> fw.bit) & 1, 1);
    check("hp matches reference vm", (r.hp << 16) >> 16, orc.hp);
    check("cheers (macro unroll)", r.cheers, orc.cheers);
    check("sub calls (CALL/RET)", r.subCalls, orc.subCalls);
    check("re-talk textbox", r.retalkText, 1);
    const retalk = out.debug.texts.findIndex((t) => t.replace(/\n/g, " ").includes("already won"));
    check("re-talk page", r.retalkPage, retalk);
  }

  console.log("trigger (once), reveal actor, talk, scripted warp, walk-on warp");
  {
    const r = await run(
      target,
      rom,
      new Scenario()
        .advance(30)
        // (5,1) -> (5,4): hold DOWN through 3 tiles
        .press(["DOWN"], 24, 4)
        .read("y4", A("PLAYER_Y"), 2)
        // left onto the trigger at (4,4)
        .press(["LEFT"], 8, 4)
        .advance(10)
        .read("trigFlag", dbgFlagAddr(target, flags.trigger_hit).addr, 1)
        // walk to the revealed intern at (8,3): right along row 4 until the
        // east wall stops us (overshoot-safe), then face up into the intern.
        .press(["RIGHT"], 28, 4)
        .read("x8", A("PLAYER_X"), 2)
        .press(["UP"], 8, 4)
        .read("faceY", A("PLAYER_Y"), 2)
        .read("dirUp", A("PLAYER_DIR"), 1)
        .press(["A"], 2, 6) // talk to intern
        .advance(REVEAL)
        .read("internSay", A("TEXT_ACTIVE"), 1)
        .press(["A"], 2, 6) // dismiss -> script warps to street
        .advance(10)
        .read("mapStreet", A("CUR_MAP"), 1)
        .read("sx", A("PLAYER_X"), 2)
        .read("sy", A("PLAYER_Y"), 2)
        .shot(shot("05_street"))
        // walk-on warp back: exactly one step down (the office south entrance
        // sits directly above the office->street warp, so a long hold would
        // ping-pong through both doors)
        .press(["DOWN"], 4, 8)
        .advance(10)
        .read("mapBack", A("CUR_MAP"), 1)
        .read("bx", A("PLAYER_X"), 2)
        .read("by", A("PLAYER_Y"), 2)
        // trigger tile is where we land (4,4) but once-flag is set: no re-run
        .read("script0", A("SCRIPT_ACTIVE"), 1),
    );
    check("walked down to y=4", r.y4, 4);
    const tf = dbgFlagAddr(target, flags.trigger_hit);
    check("trigger fired", (r.trigFlag >> tf.bit) & 1, 1);
    check("wall-stopped at x=8", r.x8, 8);
    check("blocked by revealed intern (y stays 4)", r.faceY, 4);
    check("faces up", r.dirUp, 1);
    check("intern talk textbox", r.internSay, 1);
    check("scripted warp -> street", r.mapStreet, 1);
    check("street door x", r.sx, 5);
    check("street door y", r.sy, 2);
    check("walk-on warp back -> office", r.mapBack, 0);
    check("south entrance x", r.bx, 4);
    check("south entrance y", r.by, 4);
    check("once-trigger did not rerun", r.script0, 0);
  }
}

const requested = process.argv.slice(2) as TargetName[];
const targets: TargetName[] = requested.length ? requested : (["gba", "gb", "nes"] as TargetName[]);
for (const t of targets) await testTarget(t);
console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
