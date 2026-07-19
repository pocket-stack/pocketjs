// static/vm/asm.ts — assembler/disassembler for Pocket Static bytecode.
//
// The assembler exists for VM unit tests (hand-built programs) and the
// disassembler for debugging compiler output (`pocket-static dis`). Neither
// ships in a cartridge.

import { OP, OP_OPERANDS, SYSCALL_BASE, i16 } from "../spec/isa.ts";
import { RPG_OP, RPG_OP_OPERANDS } from "../spec/rpg.ts";

type Ins = [string, ...(number | string)[]];

const NAME_TO_OP: Record<string, number> = {};
for (const [name, code] of Object.entries(OP)) NAME_TO_OP[name] = code;
for (const [name, code] of Object.entries(RPG_OP)) NAME_TO_OP[name] = code;
const OP_TO_NAME: Record<number, string> = {};
for (const [name, code] of Object.entries(NAME_TO_OP)) OP_TO_NAME[code] = name;

const OPERANDS: Record<number, number> = { ...OP_OPERANDS, ...RPG_OP_OPERANDS };

/**
 * Assemble a program. Instructions are [mnemonic, ...operands]; a bare
 * string is a label; jump operands may be label strings (encoded rel16 from
 * after the operand). CHOICE takes its option count implicitly:
 * ["CHOICE", t0, t1, ...].
 */
export function assemble(program: (Ins | string)[]): Uint8Array {
  const bytes: number[] = [];
  const labels = new Map<string, number>();
  const fixups: { at: number; label: string }[] = [];

  for (const item of program) {
    if (typeof item === "string") {
      labels.set(item, bytes.length);
      continue;
    }
    const [name, ...args] = item;
    const op = NAME_TO_OP[name];
    if (op === undefined) throw new Error(`unknown mnemonic ${name}`);
    bytes.push(op);
    if (op === RPG_OP.CHOICE) {
      bytes.push(args.length);
      for (const a of args) {
        const v = a as number;
        bytes.push(v & 0xff, (v >> 8) & 0xff);
      }
      continue;
    }
    const width = OPERANDS[op];
    if (op === OP.JMP || op === OP.JZ || op === OP.JNZ) {
      const a = args[0];
      if (typeof a === "string") {
        fixups.push({ at: bytes.length, label: a });
        bytes.push(0, 0);
      } else {
        bytes.push(a & 0xff, (a >> 8) & 0xff);
      }
      continue;
    }
    // Fixed-width numeric operands. Widths are per-op from the spec tables;
    // multi-operand ops (AVIS, WARP) list one byte per operand.
    const perOp: Record<number, number[]> = {
      [RPG_OP.AVIS]: [1, 1],
      [RPG_OP.WARP]: [1, 1, 1, 1],
    };
    const widths = perOp[op] ?? (width === 0 ? [] : width === 1 ? [1] : [width]);
    if (args.length !== widths.length) {
      throw new Error(`${name} wants ${widths.length} operands, got ${args.length}`);
    }
    widths.forEach((w, idx) => {
      const v = args[idx] as number;
      if (w === 1) bytes.push(v & 0xff);
      else bytes.push(v & 0xff, (v >> 8) & 0xff);
    });
  }

  for (const f of fixups) {
    const target = labels.get(f.label);
    if (target === undefined) throw new Error(`undefined label ${f.label}`);
    const rel = target - (f.at + 2);
    bytes[f.at] = rel & 0xff;
    bytes[f.at + 1] = (rel >> 8) & 0xff;
  }
  return Uint8Array.from(bytes);
}

/** Disassemble to text, one instruction per line, with byte offsets. */
export function disassemble(code: Uint8Array, start = 0, end = code.length): string {
  const lines: string[] = [];
  let ip = start;
  while (ip < end) {
    const at = ip;
    const op = code[ip++];
    const name = OP_TO_NAME[op] ?? `??0x${op.toString(16)}`;
    let width = OPERANDS[op];
    const args: string[] = [];
    if (op === RPG_OP.CHOICE) {
      const n = code[ip++];
      for (let k = 0; k < n; k++) {
        args.push(String(code[ip] | (code[ip + 1] << 8)));
        ip += 2;
      }
    } else if (op === RPG_OP.AVIS) {
      args.push(String(code[ip++]), String(code[ip++]));
    } else if (op === RPG_OP.WARP) {
      args.push(String(code[ip++]), String(code[ip++]), String(code[ip++]), String(code[ip++]));
    } else if (width === 1) {
      args.push(String(code[ip++]));
    } else if (width === 2) {
      const raw = code[ip] | (code[ip + 1] << 8);
      ip += 2;
      if (op === OP.JMP || op === OP.JZ || op === OP.JNZ) {
        args.push(`-> ${ip + i16(raw)}`);
      } else if (op === OP.PUSH16) {
        args.push(String(i16(raw)));
      } else {
        args.push(String(raw));
      }
    } else if (width === undefined) {
      args.push("<bad>");
    }
    lines.push(`${String(at).padStart(5)}: ${name}${args.length ? " " + args.join(", ") : ""}`);
  }
  return lines.join("\n");
}
