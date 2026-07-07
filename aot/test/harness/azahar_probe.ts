#!/usr/bin/env bun
// aot/test/harness/azahar_probe.ts — verify a PocketJS-AOT .3dsx is actually
// running inside Azahar/Citra by bus-reading the PJ debug block over the
// emulator's UDP scripting protocol (scripting/citra.py, port 45987).
//
//   1. azahar <game>.3dsx           # launch the emulator yourself
//   2. bun azahar_probe.ts <game>.elf
//
// The debug block address comes from the .elf symbol table (pj_debug_ram);
// 3dsx homebrew links and loads at 0x00100000, so the link-time address is
// the runtime address. Asserts MAGIC='PJDB', BOOTED=1, and a ticking frame
// counter — proof the device build boots and its main loop runs on the
// emulated ARM11.

import { $ } from "bun";
import { udpSocket } from "bun";
import { homedir } from "node:os";
import { DBG, DEBUG_MAGIC, DEBUG_BLOCK_SIZE } from "../../spec/pjgb.ts";

const elf = process.argv[2];
if (!elf) {
  console.error("usage: bun azahar_probe.ts <game.elf> (with Azahar running the matching .3dsx)");
  process.exit(2);
}

const NM = homedir() + "/.pocketjs/toolchains/devkitpro/devkitARM/bin/arm-none-eabi-nm";
const nm = await $`${NM} ${elf}`.text();
const m = nm.match(/^([0-9a-f]+) [BbDd] pj_debug_ram$/m);
if (!m) throw new Error("pj_debug_ram not found in " + elf);
const DBG_ADDR = parseInt(m[1], 16);
console.log(`pj_debug_ram @ 0x${DBG_ADDR.toString(16)}`);

// --- citra.py protocol: u32 version, u32 id, u32 type(1=ReadMemory), u32 size,
// then { u32 addr, u32 size } — reply echoes the header + data.
const PORT = 45987;
let pending: ((data: Buffer) => void) | null = null;
const sock = await udpSocket({
  socket: {
    data(_s, buf) {
      pending?.(Buffer.from(buf));
    },
  },
});

async function readMemory(addr: number, size: number): Promise<Buffer> {
  const id = (Math.random() * 0xffffffff) >>> 0;
  const req = Buffer.alloc(24);
  req.writeUInt32LE(1, 0); // version
  req.writeUInt32LE(id, 4);
  req.writeUInt32LE(1, 8); // ReadMemory
  req.writeUInt32LE(8, 12); // data size
  req.writeUInt32LE(addr, 16);
  req.writeUInt32LE(size, 20);
  const reply = await new Promise<Buffer>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout: is Azahar running with the game loaded?")), 3000);
    pending = (b) => {
      clearTimeout(t);
      resolve(b);
    };
    sock.send(req, PORT, "127.0.0.1");
  });
  if (reply.readUInt32LE(4) !== id || reply.readUInt32LE(8) !== 1) throw new Error("bad reply header");
  return reply.subarray(16);
}

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}: got ${got}${ok ? "" : `, want ${want}`}`);
  ok ? passed++ : failed++;
}

const block = await readMemory(DBG_ADDR, DEBUG_BLOCK_SIZE);
check("debug magic = 'PJDB'", block.readUInt32LE(DBG.MAGIC), DEBUG_MAGIC);
check("booted", block.readUInt8(DBG.BOOTED), 1);
const frame0 = block.readUInt32LE(DBG.FRAME);
await Bun.sleep(500);
const frame1 = (await readMemory(DBG_ADDR + DBG.FRAME, 4)).readUInt32LE(0);
check("main loop ticking (frame advanced)", frame1 > frame0, true);
console.log(
  `  state: map=${block.readUInt8(DBG.CUR_MAP)} player=(${block.readUInt16LE(DBG.PLAYER_X)},${block.readUInt16LE(DBG.PLAYER_Y)})` +
    ` text_active=${block.readUInt8(DBG.TEXT_ACTIVE)} script_active=${block.readUInt8(DBG.SCRIPT_ACTIVE)} frame=${frame1}`,
);

console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
