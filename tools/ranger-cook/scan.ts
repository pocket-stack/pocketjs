// tools/ranger-cook/scan.ts — M0 evidence scanner for the OO Ranger SWF.
//
// Purpose-built AVM1/SWF tag dumper (no ABC/AVM2 assembler toolchain, no AVM
// interpreter, no runtime dependency). Reads the operator-supplied SWF read-only from
// `RANGER_SWF` or `--swf <path>` / positional arg — the exact operator path
// is never hardcoded here — and writes deterministic fact dumps (IDs,
// counts, observed strings/flags) to a local ignored output directory.
// Compact checked-in metadata is emitted separately via --inventory-out and
// contains facts/IDs/counts only, never decompiler source.
//
// Usage:
//   node tools/ranger-cook/scan.ts [--swf <path>] [--out <dir>]
//                                  [--inventory-out <path> | --no-inventory]
//
// Full dump   -> <out>/scan.json   (local only, git-ignored)
// Compact facts -> apps/ranger/m0-inventory.json (checked in, deterministic)
//
// Exit codes: 0 ok; 2 no SWF path; 3 not an FWS/FWS-version SWF.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

// ---------------------------------------------------------------------------
// SWF path resolution (never hardcoded)
// ---------------------------------------------------------------------------

export function resolveSwfPath(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv.slice(2),
): string {
  const flagIdx = argv.indexOf("--swf");
  if (flagIdx >= 0 && flagIdx + 1 < argv.length) return argv[flagIdx + 1];
  const valueFlags = new Set(["--swf", "--out", "--inventory-out"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith("--")) return a;
  }
  const fromEnv = env["RANGER_SWF"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  throw new Error(
    "ranger-cook/scan: no SWF path. Set RANGER_SWF or pass --swf <path>.",
  );
}

// ---------------------------------------------------------------------------
// Bit/byte readers
// ---------------------------------------------------------------------------

class Reader {
  pos = 0;
  bitBuf = 0;
  bitLeft = 0;
  buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  u8(): number {
    this.align();
    return this.buf[this.pos++];
  }
  u16(): number {
    this.align();
    const v = this.buf[this.pos] | (this.buf[this.pos + 1] << 8);
    this.pos += 2;
    return v >>> 0;
  }
  u32(): number {
    this.align();
    const b = this.buf;
    const v =
      b[this.pos] |
      (b[this.pos + 1] << 8) |
      (b[this.pos + 2] << 16) |
      (b[this.pos + 3] << 24);
    this.pos += 4;
    return v >>> 0;
  }
  bytes(n: number): Uint8Array {
    this.align();
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  cstring(): string {
    this.align();
    const b = this.buf;
    let end = this.pos;
    while (end < b.length && b[end] !== 0) end++;
    const s = new TextDecoder("utf-8").decode(b.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }
  align(): void {
    this.bitBuf = 0;
    this.bitLeft = 0;
  }
  ubits(n: number): number {
    let v = 0;
    while (n > 0) {
      if (this.bitLeft === 0) {
        this.bitBuf = this.buf[this.pos++];
        this.bitLeft = 8;
      }
      const take = Math.min(n, this.bitLeft);
      v = (v << take) | ((this.bitBuf >>> (this.bitLeft - take)) & ((1 << take) - 1));
      this.bitLeft -= take;
      n -= take;
    }
    return v >>> 0;
  }
  sbits(n: number): number {
    if (n === 0) return 0;
    const u = this.ubits(n);
    return u & (1 << (n - 1)) ? u - (1 << n) : u;
  }
  skipMatrix(): void {
    if (this.ubits(1)) {
      const n = this.ubits(5);
      this.ubits(n);
      this.ubits(n);
    }
    if (this.ubits(1)) {
      const n = this.ubits(5);
      this.ubits(n);
      this.ubits(n);
    }
    const n = this.ubits(5);
    this.ubits(n);
    this.ubits(n);
    this.align();
  }
  skipCxformWithAlpha(): void {
    const hasAdd = this.ubits(1);
    const hasMult = this.ubits(1);
    const n = this.ubits(4);
    if (hasMult) for (let i = 0; i < 4; i++) this.sbits(n);
    if (hasAdd) for (let i = 0; i < 4; i++) this.sbits(n);
    this.align();
  }
}

function readCStringFrom(buf: Uint8Array, pos: number): { s: string; next: number } {
  let end = pos;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = new TextDecoder("utf-8").decode(buf.subarray(pos, end));
  return { s, next: end + 1 };
}

// ---------------------------------------------------------------------------
// AVM1 action decoding (string/int/flag facts only — no execution)
// ---------------------------------------------------------------------------

const OP_NAMES: Record<number, string> = {
  0x00: "End",
  0x04: "NextFrame", 0x05: "PreviousFrame", 0x06: "Play", 0x07: "Stop",
  0x08: "ToggleQuality", 0x09: "StopSounds", 0x0a: "Add", 0x0b: "Subtract",
  0x0c: "Multiply", 0x0d: "Divide", 0x0e: "Equals", 0x0f: "Less",
  0x10: "And", 0x11: "Or", 0x12: "Not", 0x13: "StringEquals",
  0x14: "StringLength", 0x15: "StringExtract", 0x17: "Pop",
  0x18: "ToInteger", 0x1c: "GetVariable", 0x1d: "SetVariable",
  0x20: "SetTarget2", 0x21: "StringAdd", 0x22: "GetProperty",
  0x23: "SetProperty", 0x24: "CloneSprite", 0x25: "RemoveSprite",
  0x26: "Trace", 0x27: "StartDrag", 0x28: "EndDrag", 0x29: "StringLess",
  0x2a: "Throw", 0x2b: "CastOp", 0x2c: "ImplementsOp",
  0x30: "RandomNumber", 0x31: "MBStringLength", 0x32: "CharToAscii",
  0x33: "AsciiToChar", 0x34: "GetTime", 0x35: "MBStringExtract",
  0x36: "MBCharToAscii", 0x37: "MBAsciiToChar",
  // 0x38/0x39 are reserved in the SWF File Format Specification action
  // table (no assigned action). If ever observed they surface as
  // Reserved_* and poison the abstract-interpretation block honestly.
  0x38: "Reserved_0x38", 0x39: "Reserved_0x39",
  0x3a: "Delete", 0x3b: "Delete2",
  0x3c: "DefineLocal", 0x3d: "CallFunction", 0x3e: "Return",
  0x3f: "Modulo", 0x40: "NewObject", 0x41: "DefineLocal2",
  0x42: "InitArray", 0x43: "InitObject", 0x44: "TypeOf",
  0x45: "TargetPath", 0x46: "Enumerate", 0x47: "Add2", 0x48: "Less2",
  0x49: "Equals2", 0x4a: "ToNumber", 0x4b: "ToString",
  0x4c: "PushDuplicate", 0x4d: "StackSwap", 0x4e: "GetMember",
  0x4f: "SetMember", 0x50: "Increment", 0x51: "Decrement",
  0x52: "CallMethod", 0x53: "NewMethod", 0x54: "InstanceOf",
  0x55: "Enumerate2",
  0x60: "BitAnd", 0x61: "BitOr", 0x62: "BitXor", 0x63: "BitLShift",
  0x64: "BitRShift", 0x65: "BitURShift", 0x66: "StrictEquals",
  0x67: "Greater", 0x68: "StringGreater",
  0x81: "GoToFrame", 0x83: "GetURL",
  0x87: "StoreRegister", 0x88: "ConstantPool", 0x8b: "SetTarget",
  0x8c: "GoToLabel", 0x8d: "WaitForFrame", 0x8e: "DefineFunction2",
  0x8f: "Try", 0x94: "With", 0x96: "Push", 0x99: "Jump", 0x9a: "GetURL2",
  0x9b: "DefineFunction", 0x9d: "If", 0x9e: "Call", 0x9f: "GoToFrame2",
};

interface BlockFacts {
  loc: string;
  strings: string[];
  ints: number[];
  doubles: number[];
  pools: number[];
  functions: string[];
  getUrls: { url: string; target: string }[];
  gotoFrame2Flags: number[];
  getUrl2Flags: number[];
}

// ---------------------------------------------------------------------------
// Precise SWF ClipEvent flag names (defect 6).
//
// ClipEventFlags width is version-dependent: SWF <= 5 uses 16-bit flags,
// SWF >= 6 uses 32-bit flags. This SWF is FWS v6, so 32-bit parsing is
// validated below (see clipActionsWidth + union-mismatch check).
// Names follow the SWF File Format Specification ClipEventFlags table.
// Only flags actually observed in this SWF get tallied, but every
// observed bit must resolve to a name here — never a bare hex bucket.
// ---------------------------------------------------------------------------

export const CLIP_EVENT_NAMES: Record<number, string> = {
  0x001: "Load",
  0x002: "EnterFrame",
  0x004: "Unload",
  0x008: "MouseMove",
  0x010: "MouseDown",
  0x020: "MouseUp",
  0x040: "KeyDown",
  0x080: "KeyUp",
  0x100: "Data",
  0x200: "Initialize",
  0x400: "Press",
  0x800: "Release",
  0x1000: "ReleaseOutside",
  0x2000: "RollOver",
  0x4000: "RollOut",
  0x8000: "DragOver",
  0x10000: "DragOut",
  0x20000: "KeyPress",
  0x40000: "Construct",
};

export function clipEventName(flag: number): string {
  const n = CLIP_EVENT_NAMES[flag];
  if (n !== undefined) return n;
  return `UnknownFlag_0x${flag.toString(16)}`;
}

/** FNV-1a 32-bit over UTF-16 code units — determinism fingerprints only. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}

export type ActionSource = "doAction" | "doInitAction" | "clip" | "button";

/** One decoded AVM1 instruction — enough for stack-level interpretation. */
export interface AvmOp {
  code: number;
  name: string;
  /** Push payload values in order (strings/ints/doubles/null markers). */
  pushVals: { t: string; v: string | number | null }[];
  /** Branch offset for If/Jump (raw signed value), else 0. */
  branch: number;
}

export function decodeActions(
  bytes: Uint8Array,
  loc: string,
  _source: ActionSource,
): {
  facts: BlockFacts;
  recordsInclEnd: number;
  recordsExclEnd: number;
  opHist: Record<string, number>;
  ops: AvmOp[];
} {
  const facts: BlockFacts = {
    loc, strings: [], ints: [], doubles: [], pools: [], functions: [],
    getUrls: [], gotoFrame2Flags: [], getUrl2Flags: [],
  };
  const opHist: Record<string, number> = {};
  const ops: AvmOp[] = [];
  let recordsInclEnd = 0;
  let recordsExclEnd = 0;
  let pool: string[] = [];
  let p = 0;
  const hit = (code: number): void => {
    const name = OP_NAMES[code] ?? ("op_0x" + code.toString(16));
    opHist[name] = (opHist[name] ?? 0) + 1;
  };
  while (p < bytes.length) {
    const code = bytes[p++];
    recordsInclEnd++;
    if (code === 0) {
      hit(0);
      ops.push({ code, name: "End", pushVals: [], branch: 0 });
      break;
    }
    recordsExclEnd++;
    if (code < 0x80) {
      hit(code);
      const opName = OP_NAMES[code] ?? ("op_0x" + code.toString(16));
      ops.push({ code, name: opName, pushVals: [], branch: 0 });
      continue;
    }
    if (p + 2 > bytes.length) break;
    const len = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    const end = Math.min(p + len, bytes.length);
    hit(code);
    const opName = OP_NAMES[code] ?? ("op_0x" + code.toString(16));
    const op: AvmOp = { code, name: opName, pushVals: [], branch: 0 };
    if (code === 0x88) {
      // ConstantPool: count + strings
      if (p + 2 <= end) {
        const count = bytes[p] | (bytes[p + 1] << 8);
        let q = p + 2;
        pool = [];
        for (let i = 0; i < count && q < end; i++) {
          const r = readCStringFrom(bytes, q);
          pool.push(r.s);
          facts.strings.push(r.s);
          q = r.next;
        }
        facts.pools.push(count);
      }
    } else if (code === 0x96) {
      // Push: typed values
      let q = p;
      while (q < end) {
        const t = bytes[q++];
        if (t === 0) {
          const r = readCStringFrom(bytes, q);
          facts.strings.push(r.s);
          op.pushVals.push({ t: "str", v: r.s });
          q = r.next;
        } else if (t === 1) {
          const v = new DataView(bytes.buffer, bytes.byteOffset + q, 4).getFloat32(0, true);
          op.pushVals.push({ t: "float", v });
          q += 4;
        } else if (t === 2 || t === 3) {
          op.pushVals.push({ t: t === 2 ? "null" : "undefined", v: null });
        } else if (t === 4 || t === 5) {
          op.pushVals.push({ t: "regbool", v: bytes[q] });
          q += 1;
        } else if (t === 6) {
          // SWF DOUBLE: two little-endian 32-bit words with the HIGH word
          // first (swapped vs a naive 8-byte LE load). Read both words and
          // reinterpret as [lo, hi] for the IEEE-754 value.
          const hi = new DataView(bytes.buffer, bytes.byteOffset + q, 4).getUint32(0, true);
          const lo = new DataView(bytes.buffer, bytes.byteOffset + q + 4, 4).getUint32(0, true);
          const dv = new DataView(new ArrayBuffer(8));
          dv.setUint32(0, lo, true);
          dv.setUint32(4, hi, true);
          const v = dv.getFloat64(0, true);
          facts.doubles.push(v);
          op.pushVals.push({ t: "double", v });
          q += 8;
        } else if (t === 7) {
          const v = (bytes[q] | (bytes[q + 1] << 8) | (bytes[q + 2] << 16) | (bytes[q + 3] << 24)) | 0;
          facts.ints.push(v);
          op.pushVals.push({ t: "int", v });
          q += 4;
        } else if (t === 8) {
          const idx = bytes[q++];
          if (idx < pool.length) facts.strings.push(pool[idx]);
          op.pushVals.push({ t: "pool8", v: idx < pool.length ? pool[idx] : null });
        } else if (t === 9) {
          const idx = (bytes[q] | (bytes[q + 1] << 8)) >>> 0;
          if (idx < pool.length) facts.strings.push(pool[idx]);
          op.pushVals.push({ t: "pool16", v: idx < pool.length ? pool[idx] : null });
          q += 2;
        } else break;
      }
    } else if (code === 0x83) {
      const u = readCStringFrom(bytes, p);
      const t = readCStringFrom(bytes, u.next);
      facts.getUrls.push({ url: u.s, target: t.s });
      facts.strings.push(u.s);
      if (t.s) facts.strings.push(t.s);
    } else if (code === 0x8b || code === 0x8c) {
      const r = readCStringFrom(bytes, p);
      facts.strings.push(r.s);
    } else if (code === 0x9b) {
      const r = readCStringFrom(bytes, p);
      facts.functions.push(r.s);
      if (r.s) facts.strings.push(r.s);
      let q = r.next;
      if (q + 2 <= end) {
        const nParams = (bytes[q] | (bytes[q + 1] << 8)) >>> 0;
        q += 2;
        for (let i = 0; i < nParams && q < end; i++) {
          const pr = readCStringFrom(bytes, q);
          if (pr.s) facts.strings.push(pr.s);
          q = pr.next;
        }
      }
    } else if (code === 0x8e) {
      const r = readCStringFrom(bytes, p);
      facts.functions.push(r.s);
      if (r.s) facts.strings.push(r.s);
    } else if (code === 0x9a) {
      if (p < end) facts.getUrl2Flags.push(bytes[p]);
    } else if (code === 0x9f) {
      if (p < end) facts.gotoFrame2Flags.push(bytes[p]);
    } else if (code === 0x9d || code === 0x99) {
      // If / Jump: signed 16-bit branch offset (basic-block boundary below).
      if (p + 2 <= end) {
        let off = (bytes[p] | (bytes[p + 1] << 8)) >>> 0;
        if (off & 0x8000) off -= 0x10000;
        op.branch = off;
      }
    }
    ops.push(op);
    p = end;
  }
  return { facts, recordsInclEnd, recordsExclEnd, opHist, ops };
}

// ---------------------------------------------------------------------------
// AVM1 stack-level / basic-block abstract interpretation for Key calls
// (defect 3). Recovers literal vs property-variable arguments at CallMethod
// (and CallFunction-after-GetMember) sites for Key.isDown / Key.getCode.
//
// Method: per action block, split the op stream into basic blocks at
// If/Jump/Try/Return/Throw boundaries, then simulate a symbolic value
// stack linearly inside each block. Blocks after a control-flow op start
// with an empty (unknown) stack — cross-block values are NOT guessed.
// Every CallMethod/CallFunction site is classified; nothing is dropped:
// resolved key calls, other (proven non-key) calls, and unresolved sites
// each carrying a reason + location.
// ---------------------------------------------------------------------------

export type SymVal =
  | { kind: "constStr"; s: string }
  | { kind: "constInt"; v: number }
  | { kind: "constNum"; v: number }
  | { kind: "null" }
  | { kind: "var"; name: string }
  | { kind: "member"; base: string; name: string }
  | { kind: "unknown"; why: string };

export function symText(s: SymVal): string {
  switch (s.kind) {
    case "constStr": return JSON.stringify(s.s);
    case "constInt": return String(s.v);
    case "constNum": return String(s.v);
    case "null": return "null";
    case "var": return `var(${s.name})`;
    case "member": return `${s.base}.${s.name}`;
    case "unknown": return `unknown(${s.why})`;
  }
}

export interface KeyCallSite {
  loc: string;
  opIndex: number;
  kind: "callMethod" | "callFunction" | "newMethod";
  method: string;
  receiver: string;
  /** Decoded argument(s): literal int, property variable, or unknown. */
  args: { argKind: "literal-int" | "property-var" | "const-str" | "unknown"; arg: string }[];
  status: "resolved-key-call" | "other-call" | "unresolved";
  reason: string;
}

const TERMINATOR_OPS = new Set(["If", "Jump", "Return", "Throw", "Try"]);

/** Fixed stack delta (pop, push) for non-variadic ops; null = handled specially. */
function stackDelta(name: string): [number, number] | null {
  const deltas: Record<string, [number, number]> = {
    NextFrame: [0, 0], PreviousFrame: [0, 0], Play: [0, 0], Stop: [0, 0],
    ToggleQuality: [0, 0], StopSounds: [0, 0],
    Add: [2, 1], Subtract: [2, 1], Multiply: [2, 1], Divide: [2, 1],
    Equals: [2, 1], Less: [2, 1], And: [2, 1], Or: [2, 1], Not: [1, 1],
    StringEquals: [2, 1], StringLength: [1, 1], StringExtract: [3, 1],
    Pop: [1, 0], ToInteger: [1, 1], GetVariable: [1, 1], SetVariable: [2, 0],
    SetTarget2: [1, 0], SetTarget: [0, 0], StringAdd: [2, 1],
    GetProperty: [2, 1], SetProperty: [3, 0], CloneSprite: [3, 0],
    RemoveSprite: [1, 0], Trace: [1, 0], EndDrag: [0, 0],
    StringLess: [2, 1], Throw: [1, 0], CastOp: [1, 1], ImplementsOp: [0, 0],
    RandomNumber: [1, 1], MBStringLength: [1, 1],
    CharToAscii: [1, 1], AsciiToChar: [1, 1],
    GetTime: [0, 1], MBStringExtract: [3, 1],
    MBCharToAscii: [1, 1], MBAsciiToChar: [1, 1],
    Delete: [2, 1], Delete2: [1, 0], DefineLocal: [2, 0],
    Return: [1, 0], Modulo: [2, 1], DefineLocal2: [0, 0],
    TypeOf: [1, 1], TargetPath: [1, 1], Enumerate: [1, 1],
    Add2: [2, 1], Less2: [2, 1], Equals2: [2, 1], ToNumber: [1, 1],
    ToString: [1, 1], PushDuplicate: [0, 1], StackSwap: [2, 2],
    GetMember: [2, 1], SetMember: [3, 0], Increment: [1, 1],
    Decrement: [1, 1], InstanceOf: [2, 1], Enumerate2: [0, 1],
    StrictEquals: [2, 1],
    BitAnd: [2, 1], BitOr: [2, 1], BitXor: [2, 1],
    BitLShift: [2, 1], BitRShift: [2, 1], BitURShift: [2, 1],
    Greater: [2, 1], StringGreater: [2, 1],
    GoToFrame: [0, 0], GetURL: [0, 0],
    GetURL2: [0, 0], Call: [0, 0], If: [1, 0], Jump: [0, 0],
    StoreRegister: [1, 0],
  };
  return deltas[name] ?? null;
}

function popSym(stack: SymVal[], under: { n: number }): SymVal {
  const v = stack.pop();
  if (v === undefined) {
    under.n++;
    return { kind: "unknown", why: "stack-underflow" };
  }
  return v;
}

/** Call arg-count operand: int literal or integral double (both occur). */
function argCount(s: SymVal): number {
  if (s.kind === "constInt") return s.v;
  if (s.kind === "constNum" && Number.isInteger(s.v)) return s.v;
  return -1;
}

export function analyzeKeyCalls(ops: AvmOp[], loc: string): KeyCallSite[] {
  const sites: KeyCallSite[] = [];
  let stack: SymVal[] = [];
  let poisoned = false; // true once a dynamic op ended the basic block

  const pushUnknown = (why: string, n = 1): void => {
    for (let i = 0; i < n; i++) stack.push({ kind: "unknown", why });
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.name === "Push") {
      for (const pv of op.pushVals) {
        if (pv.t === "str" || pv.t === "pool8" || pv.t === "pool16") {
          stack.push(pv.v === null
            ? { kind: "unknown", why: "pool-miss" }
            : { kind: "constStr", s: pv.v as string });
        } else if (pv.t === "int") stack.push({ kind: "constInt", v: pv.v as number });
        else if (pv.t === "float" || pv.t === "double") stack.push({ kind: "constNum", v: pv.v as number });
        else if (pv.t === "null" || pv.t === "undefined") stack.push({ kind: "null" });
        else stack.push({ kind: "unknown", why: `push-${pv.t}` });
      }
      continue;
    }
    if (op.name === "GetVariable") {
      const under = { n: 0 };
      const nm = popSym(stack, under);
      if (nm.kind === "constStr") stack.push({ kind: "var", name: nm.s });
      else stack.push({ kind: "unknown", why: under.n > 0 ? "getvar-underflow" : "getvar-dynamic-name" });
      continue;
    }
    if (op.name === "GetMember") {
      const under = { n: 0 };
      const nm = popSym(stack, under);
      const obj = popSym(stack, under);
      if (nm.kind === "constStr") stack.push({ kind: "member", base: symText(obj), name: nm.s });
      else stack.push({ kind: "unknown", why: under.n > 0 ? "getmember-underflow" : "getmember-dynamic-name" });
      continue;
    }
    // Bytecode-evidenced convention (M0): push order is
    // [args..., count, object, method], so CallMethod pops method, object,
    // count, then count args. E.g. [_root.key1-slot, 1, Key, "isDown"] =
    // Key.isDown(slot); [131, 1, _parent, "gotoAndPlay"] =
    // _parent.gotoAndPlay(131).
    if (op.name === "CallMethod" || op.name === "NewMethod") {
      const under = { n: 0 };
      const mSym = popSym(stack, under);
      const rSym = popSym(stack, under);
      const cSym = popSym(stack, under);
      const methodProven = mSym.kind === "constStr";
      const method = methodProven ? (mSym as { kind: "constStr"; s: string }).s : symText(mSym);
      const receiver = symText(rSym);
      const nArgs = argCount(cSym);
      const kind = op.name === "CallMethod" ? "callMethod" : "newMethod";
      const args: KeyCallSite["args"] = [];
      if (nArgs >= 0 && nArgs <= 12) {
        for (let a = 0; a < nArgs; a++) args.unshift(classifyArg(popSym(stack, under)));
        const isKeyRecv = receiver === "var(Key)" || receiver === "Key" || receiver.endsWith(".Key");
        const isKeyMethod = method === "isDown" || method === "getCode";
        if (methodProven && isKeyMethod && isKeyRecv && kind === "callMethod") {
          sites.push({
            loc, opIndex: i, kind, method, receiver, args,
            status: "resolved-key-call",
            reason: under.n > 0 ? `arg-underflow-x${under.n}` : "stack-decoded:args,count,object,method",
          });
        } else if (methodProven && isKeyMethod) {
          sites.push({
            loc, opIndex: i, kind, method, receiver, args,
            status: "unresolved", reason: `key-method-on-unproven-receiver:${receiver}`,
          });
        } else if (!methodProven) {
          sites.push({
            loc, opIndex: i, kind, method, receiver, args,
            status: "unresolved",
            reason: poisoned ? "dynamic-method-after-block-boundary" : "dynamic-method-name",
          });
        } else {
          sites.push({
            loc, opIndex: i, kind, method, receiver, args,
            status: "other-call",
            reason: `${kind === "newMethod" ? "constructor" : "non-key-method"}:${method}`,
          });
        }
      } else {
        // Non-integral/unknown count: keep the site, poison the block.
        stack = [];
        poisoned = true;
        sites.push({
          loc, opIndex: i, kind, method, receiver, args,
          status: "unresolved",
          reason: `dynamic-arg-count:method=${method}:receiver=${receiver}`,
        });
        void under;
      }
      pushUnknown(op.name === "NewMethod" ? "newmethod-result" : "callmethod-result");
      continue;
    }
    // CallFunction pops function value, count, then count args
    // (push order [args..., count, func]).
    if (op.name === "CallFunction") {
      const under = { n: 0 };
      const fSym = popSym(stack, under);
      const cSym = popSym(stack, under);
      // Normalize: a constant-string function value is the bare name
      // (same form as CallMethod's method operand).
      const fText = fSym.kind === "constStr" ? fSym.s : symText(fSym);
      const nArgs = argCount(cSym);
      if (nArgs >= 0 && nArgs <= 12) {
        const args: KeyCallSite["args"] = [];
        for (let a = 0; a < nArgs; a++) args.unshift(classifyArg(popSym(stack, under)));
        const m = fText.match(/^(.*)\.(isDown|getCode)$/);
        if (m && (m[1] === "var(Key)" || m[1] === "Key")) {
          sites.push({
            loc, opIndex: i, kind: "callFunction", method: m[2], receiver: m[1],
            args, status: "resolved-key-call",
            reason: under.n > 0 ? `arg-underflow-x${under.n}` : "getmember-chain-decoded",
          });
        } else if (m) {
          sites.push({
            loc, opIndex: i, kind: "callFunction", method: m[2], receiver: m[1],
            args, status: "unresolved", reason: `key-method-on-unproven-receiver:${m[1]}`,
          });
        } else if (fSym.kind === "unknown") {
          sites.push({
            loc, opIndex: i, kind: "callFunction", method: fText, receiver: "?",
            args, status: "unresolved", reason: "dynamic-function-value",
          });
        } else {
          sites.push({
            loc, opIndex: i, kind: "callFunction", method: fText, receiver: "?",
            args, status: "other-call", reason: "non-key-function",
          });
        }
      } else {
        stack = [];
        poisoned = true;
        sites.push({
          loc, opIndex: i, kind: "callFunction", method: fText, receiver: "?",
          args: [], status: "unresolved", reason: "dynamic-arg-count",
        });
        void under;
      }
      pushUnknown("callfunction-result");
      continue;
    }
    if (op.name === "PushDuplicate") {
      const top = stack[stack.length - 1];
      stack.push(top ?? { kind: "unknown", why: "dup-empty" });
      continue;
    }
    if (op.name === "StackSwap") {
      if (stack.length >= 2) {
        const a = stack.pop()!;
        const b = stack.pop()!;
        stack.push(a, b);
      } else {
        stack.push({ kind: "unknown", why: "swap-underflow" });
      }
      continue;
    }
    if (op.name === "ConstantPool" || op.name === "End" || op.name === "With") {
      if (op.name === "With") popSym(stack, { n: 0 });
      if (TERMINATOR_OPS.has(op.name)) { stack = []; poisoned = false; }
      continue;
    }
    if (op.name === "Try" || op.name === "DefineFunction" || op.name === "DefineFunction2") {
      // Control-flow / scope boundary: end the basic block honestly.
      stack = [];
      poisoned = true;
      continue;
    }
    const delta = stackDelta(op.name);
    if (delta === null) {
      // Variadic or unknown op (InitArray/InitObject/NewObject/op_0x..):
      // poison the block rather than guess.
      const under = { n: 0 };
      void popSym(stack, under);
      stack = [];
      poisoned = true;
      continue;
    }
    const under = { n: 0 };
    for (let k = 0; k < delta[0]; k++) popSym(stack, under);
    void under;
    // Model GetVariable/GetMember results precisely above; generic push here.
    pushUnknown(`op:${op.name}`, delta[1]);
    // Re-tag: GetVariable/GetMember were handled earlier, so generic is fine.
    if (TERMINATOR_OPS.has(op.name)) { stack = []; poisoned = false; }
  }
  return sites;
}

function classifyArg(s: SymVal): KeyCallSite["args"][number] {
  if (s.kind === "constInt") return { argKind: "literal-int", arg: String(s.v) };
  if (s.kind === "constStr") return { argKind: "const-str", arg: JSON.stringify(s.s) };
  if (s.kind === "var") return { argKind: "property-var", arg: s.name };
  if (s.kind === "member") return { argKind: "property-var", arg: `${s.base}.${s.name}` };
  return { argKind: "unknown", arg: symText(s) };
}

// ---------------------------------------------------------------------------
// SWF tag walk
// ---------------------------------------------------------------------------

const TAG_NAMES: Record<number, string> = {
  0: "End", 1: "ShowFrame", 2: "DefineShape", 4: "PlaceObject",
  5: "RemoveObject", 6: "DefineBits", 7: "DefineButton", 8: "JPEGTables",
  9: "SetBackgroundColor", 10: "DefineFont", 11: "DefineText",
  12: "DoAction", 13: "DefineFontInfo", 14: "DefineSound",
  15: "StartSound", 17: "DefineButtonSound", 18: "SoundStreamHead",
  19: "SoundStreamBlock", 20: "DefineBitsLossless", 21: "DefineBitsJPEG2",
  22: "DefineShape2", 24: "Protect", 26: "PlaceObject2", 28: "RemoveObject2",
  32: "DefineShape3", 33: "DefineText2", 34: "DefineButton2",
  35: "DefineBitsJPEG3", 36: "DefineBitsLossless2", 37: "DefineEditText",
  39: "DefineSprite", 43: "FrameLabel", 45: "SoundStreamHead2",
  46: "DefineMorphShape", 48: "DefineFont2", 56: "ExportAssets",
  57: "ImportAssets", 59: "DoInitAction", 69: "FileAttributes",
  73: "DefineFontAlignZones", 75: "DefineFont3", 76: "SymbolClass",
  77: "Metadata", 82: "DoABC", 83: "DefineShape4", 88: "DefineFontName",
};

interface StringHit { n: number; locs: string[] }

interface ScanResult {
  swfRef: string;
  header: {
    signature: string; version: number; fileLength: number;
    stageW: number; stageH: number; frameRate: number; rootFrames: number;
  };
  background: string | null;
  tagCounts: Record<string, number>;
  doAbc: number;
  rootLabels: { frame: number; name: string }[];
  spriteLabels: { sprite: number; frame: number; name: string }[];
  sprites: number[];
  exportAssets: { charId: number; name: string; kind: string }[];
  sounds: {
    id: number; format: number; formatName: string; rateHz: number;
    bits: number; channels: number; samples: number; dataBytes: number;
  }[];
  startSounds: {
    soundId: number; syncStop: boolean; noMultiple: boolean;
    hasLoops: boolean; hasEnvelope: boolean; hasInPoint: boolean;
    hasOutPoint: boolean; loc: string;
  }[];
  buttonSounds: { buttonId: number; soundIds: number[] }[];
  streamHeads: { tag: string; compression: number; rateHz: number; samples: number; sizeBit: number; typeBit: number }[];
  bitmaps: { id: number; tag: string; format: number; w: number; h: number }[];
  fonts: number[];
  placeObject2: { count: number; named: number; withClipActions: number };
  /** Aggregated static placement graph: container sprite (null = root) -> char. */
  placeGraph: { container: number | null; charId: number; instances: number; names: string[] }[];
  clipEventNames: Record<string, string>;
  /** ClipActions flag width actually parsed: 16 (SWF<=5) or 32 (SWF>=6). */
  clipActionsWidth: number;
  clipActions: {
    blocks: number; eventFlagTally: Record<string, number>;
    keyCodes: number[]; uncertain: string[];
    eventStrings: Record<string, Record<string, number>>;
  };
  buttons2: { count: number; condBlocks: number; condKeyPress: number[]; noAction: number };
  /**
   * Per-source action accounting (defect 4). The contract baseline
   * (~100,512) counts DoAction semantic records excluding End framing;
   * the aggregate total additionally includes ClipActions/button/End
   * records, so the two numbers are different scopes — never a
   * contradiction. Field names make the scope explicit.
   */
  actionScopes: {
    doActionTags: number;
    doInitActionTags: number;
    doActionRecordsInclEnd: number;
    doActionRecordsExclEnd: number;
    doInitActionRecordsInclEnd: number;
    doInitActionRecordsExclEnd: number;
    clipActionRecordsInclEnd: number;
    clipActionRecordsExclEnd: number;
    buttonCondRecordsInclEnd: number;
    buttonCondRecordsExclEnd: number;
    endTerminators: number;
    totalRecordsInclEnd: number;
    totalRecordsExclEnd: number;
  };
  doActions: { tags: number; initTags: number; actionRecords: number };
  functionNames: Record<string, number>;
  attachMovieLinkage: { id: string; blocks: number; locs: string[] }[];
  rootFrames: { frame: number; doActions: number; clipActions: number; startSounds: number; placedNames: string[] }[];
  opHist: Record<string, number>;
  handlers: Record<string, number>;
  /**
   * Raw Push-int universe (defect 3): every integer constant observed in
   * Key/isDown blocks AND globally. This is NOT a decoded argument list —
   * coordinates, counters and frame numbers dominate it. Real call
   * arguments live in keyInventory below.
   */
  keyCandidates: { code: number; n: number }[];
  isDownCandidates: { code: number; n: number }[];
  /** Exhaustive Key-call inventory from basic-block abstract interpretation. */
  keyInventory: {
    totalCallMethodSites: number;
    totalCallFunctionSites: number;
    totalNewMethodSites: number;
    resolvedIsDown: { loc: string; argKind: string; arg: string }[];
    resolvedGetCode: { loc: string; argKind: string; arg: string }[];
    unresolved: { loc: string; kind: string; method: string; reason: string }[];
    otherCalls: number;
  };
  /**
   * Method-call survey (all non-key CallMethod/CallFunction/NewMethod
   * sites): method name, occurrence count, arg-kind signatures with
   * counts, and up to 3 sample locations. Sorted by count desc.
   * Signatures list PUSH order (this toolchain pushes call args
   * right-to-left: push-order [depth,name,linkage] = call-order
   * (linkage,name,depth) for attachMovie; verified on attachMovie
   * depth-first sites and hitTest flag-first sites).
   */
  methodCalls: { method: string; kind: string; n: number; sigs: Record<string, number>; locs: string[] }[];
  /**
   * Positional attachMovie recovery (call order = reverse of push order):
   * linkage = last-pushed arg. `linkage: null` marks dynamic linkage
   * (cannot be excluded statically — the "ef_hit"+i / "se_"+i hiding
   * place); those sites stay uncertain, never silently classified.
   */
  attachMovieSites: { loc: string; kind: string; linkage: string | null; name: string | null; depth: string | null }[];
  /** Distinct Push-double values (word-swap decoded) with counts. */
  pushDoubles: { v: number; n: number }[];
  keyBlockDetail: { loc: string; isDown: boolean; ints: number[] }[];
  /** Raw Push-int universe top-64 (see keyCandidates note — not arguments). */
  keyCodesAll: { code: number; n: number }[];
  attachMovieArgs: { id: string; n: number; locs: string[] }[];
  memberNames: Record<string, number>;
  external: {
    getUrls: { url: string; target: string; n: number; locs: string[] }[];
    getUrl2Count: number;
    apiHits: Record<string, number>;
  };
  soundRefs: Record<string, number>;
  /**
   * Sound scope classification (defect 2): defined vs emitter-hosted vs
   * referenced vs reachable vs uncertain vs out-of-scope. Static
   * reachability = closure over the static placement graph + literal
   * attachMovie spawn edges from the root timeline. Dynamic linkage
   * construction ("se_"+i style) cannot be ruled out, so sounds without
   * static evidence stay `uncertain` — never claimed as firing.
   */
  soundScope: {
    definedSounds: number[];
    emitterHosts: { soundId: number; hostSprite: number; hostName: string; triggers: number }[];
    literalSpawnRefs: { emitterName: string; spawnerLoc: string }[];
    staticPlacedEmitters: string[];
    reachableSounds: number[];
    uncertainSounds: number[];
    inScopeSounds: number[];
    rationale: string;
  };
  strings: Record<string, StringHit>;
  /** FNV-1a over the sorted string table — determinism proof without a dump. */
  stringHash: string;
}

const HANDLER_RES = [
  /^onEnterFrame$/, /^onLoad$/, /^onUnload$/, /^onMouseDown$/, /^onMouseUp$/,
  /^onMouseMove$/, /^onKeyDown$/, /^onKeyUp$/, /^onData$/, /^onPress$/,
  /^onRelease$/, /^onReleaseOutside$/, /^onRollOver$/, /^onRollOut$/,
  /^onDragOver$/, /^onDragOut$/, /^onConstruct$/, /^onClipEvent$/,
];

const EXTERNAL_RES = [
  "getURL", "loadMovie", "loadMovieNum", "unloadMovie", "unloadMovieNum",
  "loadVariables", "loadVariablesNum", "loadVars", "XML", "SharedObject",
  "fscommand", "print", "printAsBitmap", "printAsBitmapNum",
];

export function scanSwf(buf: Uint8Array): ScanResult {
  const r = new Reader(buf);
  const sig = String.fromCharCode(r.u8(), r.u8(), r.u8());
  if (sig !== "FWS") throw new Error(`ranger-cook/scan: unsupported signature ${sig} (need FWS)`);
  const version = r.u8();
  const fileLength = r.u32();
  const nBits = r.ubits(5);
  const xMin = r.sbits(nBits);
  const xMax = r.sbits(nBits);
  const yMin = r.sbits(nBits);
  const yMax = r.sbits(nBits);
  r.align();
  const frameRateRaw = r.u16();
  const rootFrames = r.u16();

  const res: ScanResult = {
    swfRef: `swf:fws${version}:root${rootFrames}f`,
    header: {
      signature: sig, version, fileLength,
      stageW: Math.round((xMax - xMin) / 20), stageH: Math.round((yMax - yMin) / 20),
      frameRate: frameRateRaw / 256, rootFrames,
    },
    background: null,
    tagCounts: {}, doAbc: 0,
    rootLabels: [], spriteLabels: [], sprites: [],
    exportAssets: [], sounds: [], startSounds: [], buttonSounds: [], streamHeads: [],
    bitmaps: [], fonts: [],
    placeObject2: { count: 0, named: 0, withClipActions: 0 },
    placeGraph: [],
    clipEventNames: {},
    clipActionsWidth: version >= 6 ? 32 : 16,
    clipActions: { blocks: 0, eventFlagTally: {}, keyCodes: [], uncertain: [], eventStrings: {} },
    buttons2: { count: 0, condBlocks: 0, condKeyPress: [], noAction: 0 },
    actionScopes: {
      doActionTags: 0, doInitActionTags: 0,
      doActionRecordsInclEnd: 0, doActionRecordsExclEnd: 0,
      doInitActionRecordsInclEnd: 0, doInitActionRecordsExclEnd: 0,
      clipActionRecordsInclEnd: 0, clipActionRecordsExclEnd: 0,
      buttonCondRecordsInclEnd: 0, buttonCondRecordsExclEnd: 0,
      endTerminators: 0, totalRecordsInclEnd: 0, totalRecordsExclEnd: 0,
    },
    doActions: { tags: 0, initTags: 0, actionRecords: 0 },
    functionNames: {}, attachMovieLinkage: [], rootFrames: [],
    opHist: {}, handlers: {}, keyCandidates: [], isDownCandidates: [],
    keyInventory: {
      totalCallMethodSites: 0, totalCallFunctionSites: 0, totalNewMethodSites: 0,
      resolvedIsDown: [], resolvedGetCode: [], unresolved: [], otherCalls: 0,
    },
    methodCalls: [],
    attachMovieSites: [],
    pushDoubles: [],
    keyBlockDetail: [], keyCodesAll: [],
    attachMovieArgs: [], memberNames: {},
    external: { getUrls: [], getUrl2Count: 0, apiHits: {} },
    soundRefs: {},
    soundScope: {
      definedSounds: [], emitterHosts: [], literalSpawnRefs: [],
      staticPlacedEmitters: [], reachableSounds: [], uncertainSounds: [],
      inScopeSounds: [], rationale: "",
    },
    strings: {},
    stringHash: "",
  };

  const spriteIds = new Set<number>();
  const soundIds = new Set<number>();
  const bitmapIds = new Set<number>();
  const fontIds = new Set<number>();
  const stringTable = new Map<string, StringHit>();
  const opHist: Record<string, number> = {};
  const keyAll = new Map<number, number>();
  const getUrlTable = new Map<string, { url: string; target: string; n: number; locs: string[] }>();

  const noteStrings = (list: string[], loc: string): void => {
    for (const s of list) {
      if (!s) continue;
      let hit = stringTable.get(s);
      if (!hit) {
        hit = { n: 0, locs: [] };
        stringTable.set(s, hit);
      }
      hit.n++;
      if (hit.locs.length < 3 && !hit.locs.includes(loc)) hit.locs.push(loc);
    }
  };
  const mergeOps = (h: Record<string, number>): void => {
    for (const k of Object.keys(h)) opHist[k] = (opHist[k] ?? 0) + h[k];
  };
  const noteHandlers = (list: string[]): void => {
    for (const s of list) {
      for (const re of HANDLER_RES) {
        if (re.test(s)) res.handlers[s] = (res.handlers[s] ?? 0) + 1;
      }
    }
  };
  const noteInts = (list: number[]): void => {
    for (const v of list) keyAll.set(v, (keyAll.get(v) ?? 0) + 1);
  };

  interface BlockCtx { blocks: BlockFacts[]; locs: string[] }
  // Per-DoAction-block analysis for Key.isDown / attachMovie attribution.
  const keyBlocks: { loc: string; hasKey: boolean; hasIsDown: boolean; ints: number[] }[] = [];
  const attachBlocks: { loc: string; strings: string[] }[] = [];
  const methodTally = new Map<string, { method: string; kind: string; n: number; sigs: Map<string, number>; locs: string[] }>();
  const doubleTally = new Map<number, number>();
  const rootTable = new Map<number, { doActions: number; clipActions: number; startSounds: number; placedNames: string[] }>();
  // Static placement graph (defect 2): container sprite id (null = root)
  // -> placed character id -> { instances, names }.
  const placeMap = new Map<string, { container: number | null; charId: number; instances: number; names: Set<string> }>();
  const placeEdge = (container: number | null, charId: number): void => {
    const k = `${container === null ? "root" : container}:${charId}`;
    let e = placeMap.get(k);
    if (!e) {
      e = { container, charId, instances: 0, names: new Set() };
      placeMap.set(k, e);
    }
    e.instances++;
  };
  const placeNameByContainer = (container: number | null, charId: number | null, nm: string): void => {
    if (charId === null) return;
    const k = `${container === null ? "root" : container}:${charId}`;
    let e = placeMap.get(k);
    if (!e) {
      e = { container, charId, instances: 0, names: new Set() };
      placeMap.set(k, e);
    }
    if (e.names.size < 8) e.names.add(nm);
  };
  const rootCell = (fr: number): { doActions: number; clipActions: number; startSounds: number; placedNames: string[] } => {
    let c = rootTable.get(fr);
    if (!c) {
      c = { doActions: 0, clipActions: 0, startSounds: 0, placedNames: [] };
      rootTable.set(fr, c);
    }
    return c;
  };

  const handleActionBytes = (bytes: Uint8Array, loc: string, source: ActionSource): BlockFacts => {
    const { facts, recordsInclEnd, recordsExclEnd, opHist: h, ops } = decodeActions(bytes, loc, source);
    res.doActions.actionRecords += recordsInclEnd;
    const sc = res.actionScopes;
    if (source === "doAction") {
      sc.doActionRecordsInclEnd += recordsInclEnd;
      sc.doActionRecordsExclEnd += recordsExclEnd;
    } else if (source === "doInitAction") {
      sc.doInitActionRecordsInclEnd += recordsInclEnd;
      sc.doInitActionRecordsExclEnd += recordsExclEnd;
    } else if (source === "clip") {
      sc.clipActionRecordsInclEnd += recordsInclEnd;
      sc.clipActionRecordsExclEnd += recordsExclEnd;
    } else {
      sc.buttonCondRecordsInclEnd += recordsInclEnd;
      sc.buttonCondRecordsExclEnd += recordsExclEnd;
    }
    sc.endTerminators += recordsInclEnd - recordsExclEnd;
    sc.totalRecordsInclEnd += recordsInclEnd;
    sc.totalRecordsExclEnd += recordsExclEnd;
    mergeOps(h);
    noteStrings(facts.strings, loc);
    noteHandlers(facts.strings);
    noteHandlers(facts.functions);
    noteInts(facts.ints);
    for (const g of facts.getUrls) {
      const k = g.url + "\u0000" + g.target;
      let e = getUrlTable.get(k);
      if (!e) {
        e = { url: g.url, target: g.target, n: 0, locs: [] };
        getUrlTable.set(k, e);
      }
      e.n++;
      if (e.locs.length < 3 && !e.locs.includes(loc)) e.locs.push(loc);
    }
    res.external.getUrl2Count += facts.getUrl2Flags.length;
    const hasKey = facts.strings.includes("Key") || facts.strings.includes("isDown");
    const hasIsDown = facts.strings.includes("isDown");
    if (hasKey) {
      keyBlocks.push({ loc, hasKey: true, hasIsDown, ints: facts.ints.slice() });
      if (res.keyBlockDetail.length < 400) {
        res.keyBlockDetail.push({ loc, isDown: hasIsDown, ints: facts.ints.slice(0, 24) });
      }
    }
    // Exhaustive per-block Key-call decoding (defect 3): every block,
    // not only Key-string blocks — dynamic names would otherwise be missed.
    for (const site of analyzeKeyCalls(ops, loc)) {
      const inv = res.keyInventory;
      if (site.kind === "callMethod") inv.totalCallMethodSites++;
      else if (site.kind === "callFunction") inv.totalCallFunctionSites++;
      else inv.totalNewMethodSites++;
      if (site.status !== "resolved-key-call") {
        const sig = `${site.args.map((a) => a.argKind).join(",")}#${site.args.length}`;
        let m = methodTally.get(`${site.kind}:${site.method}`);
        if (!m) {
          m = { method: site.method, kind: site.kind, n: 0, sigs: new Map(), locs: [] };
          methodTally.set(`${site.kind}:${site.method}`, m);
        }
        m.n++;
        m.sigs.set(sig, (m.sigs.get(sig) ?? 0) + 1);
        if (m.locs.length < 3 && !m.locs.includes(loc)) m.locs.push(loc);
      }
      // Positional attachMovie recovery (defect 1/2 evidence): call order
      // is the reverse of push order, so linkage = last-pushed arg.
      if ((site.kind === "callMethod" || site.kind === "callFunction") && site.method === "attachMovie" && site.args.length === 3) {
        const rev = site.args.slice().reverse();
        const val = (a: { argKind: string; arg: string }): string | null =>
          a.argKind === "const-str" ? JSON.parse(a.arg) as string
          : a.argKind === "literal-int" ? a.arg
          : a.argKind === "property-var" ? `var:${a.arg}`
          : null;
        if (res.attachMovieSites.length < 500) {
          res.attachMovieSites.push({
            loc, kind: site.kind,
            linkage: val(rev[0]), name: val(rev[1]), depth: val(rev[2]),
          });
        }
      } else if ((site.kind === "callMethod" || site.kind === "callFunction") && site.method === "attachMovie") {
        if (res.attachMovieSites.length < 500) {
          res.attachMovieSites.push({ loc, kind: site.kind, linkage: null, name: null, depth: null });
        }
      }
      if (site.status === "resolved-key-call" && site.method === "isDown") {
        if (inv.resolvedIsDown.length < 400) {
          inv.resolvedIsDown.push({
            loc: site.loc,
            argKind: site.args.length === 1 ? site.args[0].argKind : `arity-${site.args.length}`,
            arg: site.args.map((a) => a.arg).join(",") || "(none)",
          });
        }
      } else if (site.status === "resolved-key-call" && site.method === "getCode") {
        if (inv.resolvedGetCode.length < 400) {
          inv.resolvedGetCode.push({
            loc: site.loc,
            argKind: site.args.length === 1 ? site.args[0].argKind : `arity-${site.args.length}`,
            arg: site.args.map((a) => a.arg).join(",") || "(none)",
          });
        }
      } else if (site.status === "unresolved") {
        if (inv.unresolved.length < 400) {
          inv.unresolved.push({
            loc: site.loc, kind: site.kind, method: site.method, reason: site.reason,
          });
        }
      } else {
        inv.otherCalls++;
      }
    }
    if (facts.strings.includes("attachMovie")) {
      attachBlocks.push({ loc, strings: facts.strings.slice() });
    }
    for (const d of facts.doubles) doubleTally.set(d, (doubleTally.get(d) ?? 0) + 1);
    for (const fn of facts.functions) {
      if (!fn) continue;
      res.functionNames[fn] = (res.functionNames[fn] ?? 0) + 1;
    }
    return facts;
  };

  // Timeline context tracking.
  let ctxSprite: number | null = null;
  let rootShows = 0;
  const spriteShows = new Map<number, number>();
  const curFrame = (): number =>
    (ctxSprite === null ? rootShows : (spriteShows.get(ctxSprite) ?? 0)) + 1;
  const locOf = (tagIdx: number, tag: string): string =>
    `tag#${tagIdx}:${tag}@${ctxSprite === null ? "root" : "sprite" + ctxSprite}:f${curFrame()}`;

  let tagIdx = 0;
  const parseTags = (rr: Reader, endPos: number): void => {
    while (rr.pos < endPos) {
      const hdr = rr.u16();
      const code = hdr >>> 6;
      let len = hdr & 0x3f;
      if (len === 0x3f) len = rr.u32();
      const bodyStart = rr.pos;
      const bodyEnd = bodyStart + len;
      const name = TAG_NAMES[code] ?? `tag${code}`;
      res.tagCounts[name] = (res.tagCounts[name] ?? 0) + 1;
      tagIdx++;
      const loc = locOf(tagIdx, name);
      if (code === 0) {
        rr.pos = bodyEnd;
        if (ctxSprite !== null) return; // end of sprite
        break;
      } else if (code === 1) {
        if (ctxSprite === null) rootShows++;
        else spriteShows.set(ctxSprite, (spriteShows.get(ctxSprite) ?? 0) + 1);
      } else if (code === 9) {
        const rc = rr.u8(), gc = rr.u8(), bc = rr.u8();
        const hex = "#" + [rc, gc, bc].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
        if (!res.background) res.background = hex;
      } else if (code === 12) {
        res.doActions.tags++;
        res.actionScopes.doActionTags++;
        if (ctxSprite === null) rootCell(curFrame()).doActions++;
        handleActionBytes(rr.buf.subarray(bodyStart, bodyEnd), loc, "doAction");
      } else if (code === 59) {
        res.doActions.initTags++;
        res.actionScopes.doInitActionTags++;
        const spriteId = rr.u16(); // DoInitAction header: SpriteID (not actions)
        void spriteId;
        // Decode AFTER the 2-byte SpriteID header (defect 4: the old code
        // fed the header bytes to the action decoder, inventing records).
        handleActionBytes(rr.buf.subarray(bodyStart + 2, bodyEnd), loc, "doInitAction");
      } else if (code === 39) {
        const sid = rr.u16();
        rr.u16(); // frame count
        spriteIds.add(sid);
        res.sprites.push(sid);
        spriteShows.set(sid, 0);
        const saved = ctxSprite;
        ctxSprite = sid;
        parseTags(rr, bodyEnd);
        ctxSprite = saved;
      } else if (code === 43) {
        const label = rr.cstring();
        const fr = curFrame();
        if (ctxSprite === null) res.rootLabels.push({ frame: fr, name: label });
        else res.spriteLabels.push({ sprite: ctxSprite, frame: fr, name: label });
        noteStrings([label], loc);
      } else if (code === 14) {
        const id = rr.u16();
        const flags = rr.u8();
        const samples = rr.u32();
        const format = (flags >>> 4) & 0x0f;
        const rateIdx = (flags >>> 2) & 0x03;
        const bits = (flags >>> 1) & 0x01 ? 16 : 8;
        const chans = (flags & 0x01) + 1;
        const rateHz = [5512, 11025, 22050, 44100][rateIdx];
        const formatName = ["uncompressed", "ADPCM", "MP3", "uncompressed-LE", "-", "Nellymoser", "-", "-", "-", "-", "-", "-", "-", "-", "-", "AAC"][format] ?? `fmt${format}`;
        soundIds.add(id);
        res.sounds.push({ id, format, formatName, rateHz, bits, channels: chans, samples, dataBytes: len - 7 });
      } else if (code === 15) {
        // StartSound: event-sound trigger on a timeline (SoundId + SoundInfo).
        const soundId = rr.u16();
        const info = bodyEnd > rr.pos ? rr.u8() : 0;
        res.startSounds.push({
          soundId,
          syncStop: (info & 0x80) !== 0,
          noMultiple: (info & 0x40) !== 0,
          hasEnvelope: (info & 0x20) !== 0,
          hasLoops: (info & 0x10) !== 0,
          hasOutPoint: (info & 0x08) !== 0,
          hasInPoint: (info & 0x04) !== 0,
          loc,
        });
        if (ctxSprite === null) rootCell(curFrame()).startSounds++;
      } else if (code === 17) {
        const buttonId = rr.u16();
        rr.u16(); // reserved
        const ids: number[] = [];
        for (let i = 0; i < 4; i++) {
          if (rr.pos + 2 > bodyEnd) break;
          const sId = rr.u16();
          if (rr.pos + 5 > bodyEnd) break;
          rr.bytes(5); // sound info
          if (sId) ids.push(sId);
        }
        res.buttonSounds.push({ buttonId, soundIds: ids });
      } else if (code === 18 || code === 45) {
        const b0 = code === 18 ? rr.u8() : 0;
        const sb = rr.u8();
        const samples = rr.u16();
        const comp = code === 18 ? sb & 0x0f : (sb >>> 4) & 0x0f;
        const rateIdx = (sb >>> 2) & 0x03;
        const sizeBit = (sb >>> 1) & 0x01;
        const typeBit = sb & 0x01;
        void b0;
        res.streamHeads.push({
          tag: name, compression: comp,
          rateHz: [5512, 11025, 22050, 44100][rateIdx], samples,
          sizeBit, typeBit,
        } as ScanResult["streamHeads"][number]);
      } else if (code === 20 || code === 36) {
        const id = rr.u16();
        const fmt = rr.u8();
        const w = rr.u16(), h = rr.u16();
        bitmapIds.add(id);
        res.bitmaps.push({ id, tag: name, format: fmt, w, h });
      } else if (code === 10 || code === 48 || code === 75) {
        fontIds.add(rr.u16());
      } else if (code === 56) {
        const count = rr.u16();
        for (let i = 0; i < count; i++) {
          const charId = rr.u16();
          const nm = rr.cstring();
          res.exportAssets.push({ charId, name: nm, kind: "unknown" });
          noteStrings([nm], loc);
        }
      } else if (code === 26) {
        res.placeObject2.count++;
        const flags = rr.u8();
        const hasClipActions = (flags & 0x80) !== 0;
        const hasClipDepth = (flags & 0x40) !== 0;
        const hasName = (flags & 0x20) !== 0;
        const hasRatio = (flags & 0x10) !== 0;
        const hasCxform = (flags & 0x08) !== 0;
        const hasMatrix = (flags & 0x04) !== 0;
        const hasChar = (flags & 0x02) !== 0;
        const hasMove = (flags & 0x01) !== 0;
        void hasMove;
        rr.u16(); // depth
        let placedChar: number | null = null;
        if (hasChar) placedChar = rr.u16();
        if (hasMatrix) rr.skipMatrix();
        if (hasCxform) rr.skipCxformWithAlpha();
        if (hasRatio) rr.u16();
        if (hasName) {
          const nm = rr.cstring();
          res.placeObject2.named++;
          noteStrings([nm], loc);
          res.memberNames[nm] = (res.memberNames[nm] ?? 0) + 1;
          if (ctxSprite === null) rootCell(curFrame()).placedNames.push(nm);
          placeNameByContainer(ctxSprite, placedChar, nm);
        }
        if (placedChar !== null) placeEdge(ctxSprite, placedChar);
        if (hasClipDepth) rr.u16();
        if (hasClipActions) {
          res.placeObject2.withClipActions++;
          res.clipActions.blocks++;
          if (ctxSprite === null) rootCell(curFrame()).clipActions++;
          rr.u16(); // reserved
          // Version-width parsing (defect 6): SWF<=5 carries 16-bit
          // ClipEventFlags, SWF>=6 carries 32-bit. This SWF is v6.
          const allFlags = res.clipActionsWidth === 32 ? rr.u32() : rr.u16();
          if (res.clipActionsWidth !== (version >= 6 ? 32 : 16)) {
            res.clipActions.uncertain.push(`${loc}:width-mismatch`);
          }
          let orUnion = 0;
          let records = 0;
          for (;;) {
            if (rr.pos + 4 > bodyEnd) {
              res.clipActions.uncertain.push(`${loc}:truncated`);
              break;
            }
            const ev = rr.u32();
            if (ev === 0) break;
            if (rr.pos + 4 > bodyEnd) {
              res.clipActions.uncertain.push(`${loc}:size-oob`);
              break;
            }
            const size = rr.u32();
            records++;
            orUnion = (orUnion | ev) >>> 0;
            const keyPress = (ev & 0x00020000) !== 0;
            let keyCode = -1;
            if (keyPress) {
              if (rr.pos + 1 > bodyEnd) {
                res.clipActions.uncertain.push(`${loc}:keycode-oob`);
                break;
              }
              keyCode = rr.u8();
              if (!res.clipActions.keyCodes.includes(keyCode)) {
                res.clipActions.keyCodes.push(keyCode);
              }
            }
            const evName = `0x${ev.toString(16)}:${clipEventName(ev)}`;
            res.clipActions.eventFlagTally[evName] = (res.clipActions.eventFlagTally[evName] ?? 0) + 1;
            res.clipEventNames[`0x${ev.toString(16)}`] = clipEventName(ev);
            if (!(ev in CLIP_EVENT_NAMES)) {
              res.clipActions.uncertain.push(`${loc}:unnamed-event-flag-0x${ev.toString(16)}`);
            }
            if (keyCode >= 0) {
              const k = `0x${ev.toString(16)}:${clipEventName(ev)}:key=${keyCode}`;
              res.clipActions.eventFlagTally[k] = (res.clipActions.eventFlagTally[k] ?? 0) + 1;
            }
            const actStart = rr.pos;
            const actEnd = Math.min(actStart + size - (keyPress ? 1 : 0), bodyEnd);
            const clipFacts = handleActionBytes(rr.buf.subarray(actStart, Math.max(actStart, actEnd)), loc + ":clip", "clip");
            const evKey = `0x${ev.toString(16)}:${clipEventName(ev)}`;
            let evStrings = res.clipActions.eventStrings[evKey];
            if (!evStrings) {
              evStrings = {};
              res.clipActions.eventStrings[evKey] = evStrings;
            }
            for (const s of clipFacts.strings) {
              if (!s) continue;
              evStrings[s] = (evStrings[s] ?? 0) + 1;
            }
            rr.pos = actStart + size - (keyPress ? 1 : 0);
            if (rr.pos > bodyEnd) {
              res.clipActions.uncertain.push(`${loc}:oversize`);
              break;
            }
          }
          if (records > 0 && orUnion !== allFlags) {
            res.clipActions.uncertain.push(
              `${loc}:union-mismatch all=0x${allFlags.toString(16)} or=0x${orUnion.toString(16)}`,
            );
          }
        }
      } else if (code === 34) {
        res.buttons2.count++;
        const buttonId = rr.u16();
        void buttonId;
        rr.u8(); // flags
        const actionOffset = rr.u16();
        // ButtonRecords until flags==0
        for (;;) {
          if (rr.pos >= bodyEnd) break;
          const recFlags = rr.u8();
          if (recFlags === 0) break;
          if (recFlags & 0x80) { /* HasImage */ rr.u16(); }
          rr.u16(); // depth
          rr.skipMatrix();
          // ColorTransform present unless HasImage carried its own? Parse
          // conservatively: ButtonRecord CXFORM (no alpha) always follows.
          const hasAdd1 = rr.ubits(1), hasMult1 = rr.ubits(1);
          const n1 = rr.ubits(4);
          const terms1 = (hasMult1 ? 3 : 0) + (hasAdd1 ? 3 : 0);
          for (let i = 0; i < terms1; i++) rr.sbits(n1);
          rr.align();
          if (recFlags & 0x40) { /* HasFilterList: skip */ break; }
          if (recFlags & 0x20) { /* HasBlendMode */ rr.u8(); }
        }
        if (actionOffset > 0) {
          for (;;) {
            if (rr.pos + 2 > bodyEnd) break;
            const condSize = rr.u16();
            if (condSize === 0) break;
            const recStart = rr.pos;
            if (rr.pos + 2 > bodyEnd) break;
            const cond = rr.u16();
            const keyPress = (cond >>> 9) & 0x7f;
            if (keyPress) res.buttons2.condKeyPress.push(keyPress);
            res.buttons2.condBlocks++;
            const actBytes = rr.buf.subarray(rr.pos, Math.min(recStart + condSize, bodyEnd));
            handleActionBytes(actBytes, loc + ":btncond", "button");
            rr.pos = recStart + condSize;
            if (rr.pos > bodyEnd) break;
          }
        } else {
          res.buttons2.noAction++;
        }
      } else if (code === 82) {
        res.doAbc++;
      }
      rr.pos = bodyEnd;
    }
  };

  parseTags(r, buf.length);

  // Kind resolution for export assets.
  for (const a of res.exportAssets) {
    a.kind = spriteIds.has(a.charId) ? "sprite"
      : soundIds.has(a.charId) ? "sound"
      : bitmapIds.has(a.charId) ? "bitmap"
      : fontIds.has(a.charId) ? "font" : "unknown";
  }

  // Key.isDown candidates: ints co-occurring in Key/isDown blocks.
  const keyCand = new Map<number, number>();
  const isDownCand = new Map<number, number>();
  for (const b of keyBlocks) {
    for (const v of b.ints) {
      keyCand.set(v, (keyCand.get(v) ?? 0) + 1);
      if (b.hasIsDown) isDownCand.set(v, (isDownCand.get(v) ?? 0) + 1);
    }
  }
  res.keyCandidates = [...keyCand.entries()]
    .map(([code, n]) => ({ code, n }))
    .sort((a, b) => b.n - a.n || a.code - b.code);
  res.isDownCandidates = [...isDownCand.entries()]
    .map(([code, n]) => ({ code, n }))
    .sort((a, b) => b.n - a.n || a.code - b.code);
  res.keyCodesAll = [...keyAll.entries()]
    .map(([code, n]) => ({ code, n }))
    .sort((a, b) => b.n - a.n || a.code - b.code)
    .slice(0, 64);

  // attachMovie args: string constants in attachMovie blocks (linkage ids).
  const attachTally = new Map<string, { n: number; locs: string[] }>();
  keyBlocks.length; // (used above)
  for (const b of attachBlocks) {
    for (const s of b.strings) {
      if (!s || s === "attachMovie") continue;
      let e = attachTally.get(s);
      if (!e) {
        e = { n: 0, locs: [] };
        attachTally.set(s, e);
      }
      e.n++;
      if (e.locs.length < 3 && !e.locs.includes(b.loc)) e.locs.push(b.loc);
    }
  }
  res.attachMovieArgs = [...attachTally.entries()]
    .map(([id, e]) => ({ id, n: e.n, locs: e.locs }))
    .sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1));

  // attachMovie linkage: ExportAssets names observed inside attachMovie
  // blocks (spawn-argument evidence; arg position is NOT proven statically).
  const exportNames = new Set(res.exportAssets.map((a) => a.name));
  const linkTally = new Map<string, { blocks: number; locs: string[] }>();
  for (const b of attachBlocks) {
    const seen = new Set<string>();
    for (const s of b.strings) {
      if (!exportNames.has(s) || seen.has(s)) continue;
      seen.add(s);
      let e = linkTally.get(s);
      if (!e) {
        e = { blocks: 0, locs: [] };
        linkTally.set(s, e);
      }
      e.blocks++;
      if (e.locs.length < 3 && !e.locs.includes(b.loc)) e.locs.push(b.loc);
    }
  }
  res.attachMovieLinkage = [...linkTally.entries()]
    .map(([id, e]) => ({ id, blocks: e.blocks, locs: e.locs }))
    .sort((a, b) => b.blocks - a.blocks || (a.id < b.id ? -1 : 1));

  // Static placement graph materialization (sorted = deterministic).
  res.placeGraph = [...placeMap.values()]
    .map((e) => ({
      container: e.container, charId: e.charId,
      instances: e.instances, names: [...e.names].sort(),
    }))
    .sort((a, b) =>
      (a.container ?? -1) - (b.container ?? -1) || a.charId - b.charId);

  // Sound scope classification (defect 2). Reachability = closure over
  // static placement edges + literal attachMovie spawn edges, rooted at
  // the root timeline. Spawner containers are parsed from attach-block
  // locs; dynamic linkage construction ("se_"+i style) is NOT modeled,
  // so evidence-free emitters stay `uncertain`, never "reachable".
  {
    const exportChar = new Map<string, number>();
    for (const a of res.exportAssets) {
      if (!exportChar.has(a.name)) exportChar.set(a.name, a.charId);
    }
    const charName = new Map<number, string>();
    for (const a of res.exportAssets) {
      if (!charName.has(a.charId)) charName.set(a.charId, a.name);
    }
    const spawnerOf = (loc: string): number | null => {
      const m = loc.match(/@(root|sprite(\d+)):/);
      if (!m) return null;
      return m[1] === "root" ? null : Number(m[2]);
    };
    // Static edges: container char (null = root) -> placed chars.
    const edges = new Map<string, Set<number>>();
    const addEdge = (from: number | null, to: number): void => {
      const k = from === null ? "root" : String(from);
      let s = edges.get(k);
      if (!s) {
        s = new Set();
        edges.set(k, s);
      }
      s.add(to);
    };
    for (const g of res.placeGraph) addEdge(g.container, g.charId);
    for (const link of res.attachMovieLinkage) {
      const target = exportChar.get(link.id);
      if (target === undefined) continue;
      for (const loc of link.locs) addEdge(spawnerOf(loc), target);
    }
    const reachableChars = new Set<number>();
    const queue: (number | null)[] = [null];
    const seenNodes = new Set<string>(["root"]);
    while (queue.length > 0) {
      const node = queue.pop()!;
      const k = node === null ? "root" : String(node);
      const outs = edges.get(k);
      if (!outs) continue;
      for (const c of outs) {
        reachableChars.add(c);
        if (!seenNodes.has(`c${c}`)) {
          seenNodes.add(`c${c}`);
          queue.push(c);
        }
      }
    }
    const hostBySound = new Map<number, { hostSprite: number; triggers: number }>();
    for (const t of res.startSounds) {
      const m = t.loc.match(/sprite(\d+)/);
      const host = m ? Number(m[1]) : -1;
      const e = hostBySound.get(t.soundId) ?? { hostSprite: host, triggers: 0 };
      e.triggers++;
      hostBySound.set(t.soundId, e);
    }
    const emitterHosts = [...hostBySound.entries()]
      .map(([soundId, e]) => ({
        soundId,
        hostSprite: e.hostSprite,
        hostName: charName.get(e.hostSprite) ?? `?char${e.hostSprite}`,
        triggers: e.triggers,
      }))
      .sort((a, b) => a.soundId - b.soundId);
    const literalSpawnRefs = res.attachMovieLinkage
      .filter((l) => /^se_/.test(l.id))
      .map((l) => ({ emitterName: l.id, spawnerLoc: l.locs[0] ?? "" }))
      .sort((a, b) => (a.emitterName < b.emitterName ? -1 : 1));
    const placedCharIds = new Set(res.placeGraph.map((g) => g.charId));
    const staticPlacedEmitters = emitterHosts
      .filter((e) => placedCharIds.has(e.hostSprite))
      .map((e) => e.hostName)
      .sort();
    const reachableSounds = emitterHosts
      .filter((e) => reachableChars.has(e.hostSprite))
      .map((e) => e.soundId)
      .sort((a, b) => a - b);
    const defined = res.sounds.map((s) => s.id).sort((a, b) => a - b);
    const reachSet = new Set(reachableSounds);
    const uncertainSounds = defined.filter((id) => !reachSet.has(id));
    // Scope decision (usable by M1): the only literal se_* spawn (se_101)
    // originates at root f15 story-event dispatch — outside the fight
    // slice — so the in-slice allowlist is empty. Promotion requires new
    // static or dynamic-name evidence (M1 review), never assumption.
    res.soundScope = {
      definedSounds: defined,
      emitterHosts,
      literalSpawnRefs,
      staticPlacedEmitters,
      reachableSounds,
      uncertainSounds,
      inScopeSounds: [],
      rationale:
        "43 StartSound triggers cover all 36 sounds inside dedicated se_* host sprites, " +
        "but only se_101 has a literal attachMovie spawn edge (from root f15 story-event " +
        "dispatch, out of the fight slice) and no host sprite is statically placed; " +
        "dynamic linkage construction cannot be excluded, so the remaining 35 emitters " +
        "are uncertain rather than reachable, and the M1 conversion allowlist is empty " +
        "until spawn evidence is produced.",
    };
  }

  // Method-call survey materialization (sorted = deterministic).
  res.methodCalls = [...methodTally.values()]
    .map((m) => ({
      method: m.method, kind: m.kind, n: m.n,
      sigs: Object.fromEntries([...m.sigs.entries()].sort()),
      locs: m.locs,
    }))
    .sort((a, b) => b.n - a.n || (a.method < b.method ? -1 : 1));
  res.pushDoubles = [...doubleTally.entries()]
    .map(([v, n]) => ({ v, n }))
    .sort((a, b) => b.n - a.n || a.v - b.v);
  res.attachMovieSites.sort((a, b) => (a.loc < b.loc ? -1 : 1));

  // Root timeline table (frames 1..rootFrames).
  res.rootFrames = [];
  for (let fr = 1; fr <= rootFrames; fr++) {
    const c = rootTable.get(fr) ?? { doActions: 0, clipActions: 0, startSounds: 0, placedNames: [] as string[] };
    res.rootFrames.push({ frame: fr, doActions: c.doActions, clipActions: c.clipActions, startSounds: c.startSounds, placedNames: c.placedNames });
  }

  // External API hits over the observed string table.
  for (const api of EXTERNAL_RES) {
    let n = 0;
    for (const [s, hit] of stringTable) {
      if (s === api || s.startsWith(api + ".") || s.startsWith(api + ":") || s.startsWith(api + "/")) n += hit.n;
      else if (api === "fscommand" && s.startsWith("fscommand:")) n += hit.n;
    }
    if (n > 0) res.external.apiHits[api] = n;
  }
  // getURL: entries whose url uses a scheme or fscommand are external by construction.
  res.external.getUrls = [...getUrlTable.values()].sort((a, b) => b.n - a.n);

  // Sound method references (observed, not proven calls).
  for (const [s, hit] of stringTable) {
    if (s === "attachSound" || s === "Sound" || s === "setVolume" || s === "start" || s === "stop") {
      res.soundRefs[s] = (res.soundRefs[s] ?? 0) + hit.n;
    }
  }

  // Deterministic string table (sorted keys).
  const sortedStrings: Record<string, StringHit> = {};
  for (const k of [...stringTable.keys()].sort()) sortedStrings[k] = stringTable.get(k)!;
  res.strings = sortedStrings;
  res.stringHash = fnv1a([...stringTable.keys()].sort().join("\u0000"));
  // Deterministic key-inventory site order (by location).
  res.keyInventory.resolvedIsDown.sort((a, b) => (a.loc < b.loc ? -1 : 1));
  res.keyInventory.resolvedGetCode.sort((a, b) => (a.loc < b.loc ? -1 : 1));
  res.keyInventory.unresolved.sort((a, b) => (a.loc < b.loc ? -1 : 1));
  res.opHist = Object.fromEntries(Object.entries(opHist).sort());
  res.clipActions.keyCodes.sort((a, b) => a - b);
  res.buttons2.condKeyPress.sort((a, b) => a - b);
  res.sprites.sort((a, b) => a - b);
  res.sounds.sort((a, b) => a.id - b.id);
  res.bitmaps.sort((a, b) => a.id - b.id);
  res.fonts = [...fontIds].sort((a, b) => a - b);
  res.exportAssets.sort((a, b) => a.charId - b.charId || (a.name < b.name ? -1 : 1));

  return res;
}

// ---------------------------------------------------------------------------
// Compact checked-in inventory (facts/IDs/counts only)
// ---------------------------------------------------------------------------

export interface CompactInventory {
  _generatedBy: string;
  _swfRef: string;
  _doNotEdit: boolean;
  header: { stageW: number; stageH: number; frameRate: number; rootFrames: number; background: string | null };
  tagCounts: Record<string, number>;
  doAbc: number;
  rootLabels: { frame: number; name: string }[];
  /** Deduped by export name (the SWF repeats rows; scan.json keeps rows). */
  exportAssets: { name: string; charId: number; exports: number }[];
  exportTotals: { rows: number; uniqueNames: number };
  sounds: { id: number; formatName: string; rateHz: number; bits: number; channels: number; samples: number; dataBytes: number }[];
  /** Defect-2 scope decision inputs: reachable vs uncertain vs in-scope. */
  soundScope: {
    reachableSounds: number[];
    uncertainSounds: number[];
    inScopeSounds: number[];
    literalSpawnRefs: { emitterName: string; spawnerLoc: string }[];
    staticPlacedEmitters: string[];
    emitterHostCount: number;
    triggerTotal: number;
    rationale: string;
  };
  startSoundTriggers: { soundId: number; n: number; syncStop: number }[];
  buttonSoundRefs: number[];
  streamHeads: { count: number; nonEmpty: number };
  bitmaps: { id: number; tag: string; format: number; w: number; h: number }[];
  placeObject2: { count: number; named: number; withClipActions: number };
  /** Placement graph summary: counts + root chars + hash (edges in scan.json). */
  placementSummary: { edges: number; containers: number; rootPlacedChars: number[]; graphHash: string };
  clipActionsWidth: number;
  /** Precise SWF ClipEvent names (defect 6) — never bare hex. */
  clipEvents: { flag: string; name: string; n: number }[];
  clipKeyCodes: number[];
  clipUncertain: string[];
  buttons2: { count: number; condBlocks: number; condKeyPress: number[]; noAction: number };
  /** Per-source action accounting with explicit scopes (defect 4). */
  actionScopes: CompactInventoryActionScopes;
  /** Contract baseline (~100,512) scope: DoAction semantic records excl. End. */
  contractBaselineApprox: number;
  baselineNote: string;
  functionNames: Record<string, number>;
  /**
   * String co-occurrence audit trail (export names seen inside
   * attachMovie blocks). NOT the classification basis — positional
   * recovery below is. Kept so co-occurrence-only claims (e.g. the old
   * ef_hit1 literal claim) stay falsifiable.
   */
  attachMovieCooccurrence: { id: string; blocks: number }[];
  attachDynamicPossible: boolean;
  /**
   * Positional attachMovie recovery (call order = reverse push order):
   * static linkage IDs vs dynamic-linkage sites (linkage null or var:).
   * This is the LINKAGE classification basis.
   */
  attachMovieStatic: { id: string; n: number }[];
  attachMovieDynamicSites: { loc: string; kind: string }[];
  rootFrames: { frame: number; doActions: number; clipActions: number; startSounds: number; placedNames: string[] }[];
  /** Op histogram over ALL action sources (renamed: scope is explicit). */
  opHistAllSourcesTop: Record<string, number>;
  handlers: Record<string, number>;
  /** Exhaustive Key-call inventory (defect 3): decoded args + all unresolved. */
  keyInventory: {
    totalCallMethodSites: number;
    totalCallFunctionSites: number;
    totalNewMethodSites: number;
    otherCalls: number;
    resolvedIsDown: number;
    resolvedGetCode: number;
    isDownArgLiterals: { code: number; n: number }[];
    isDownArgVars: { name: string; n: number }[];
    getCodeArgKinds: { kind: string; n: number }[];
    unresolved: { loc: string; kind: string; method: string; reason: string }[];
  };
  /** Raw Push-int universe top-64 — explicitly NOT decoded arguments. */
  pushIntUniverseTop: { code: number; n: number }[];
  pushIntUniverseNote: string;
  /** Method-call survey: top entries by count (full table in scan.json). */
  methodCallsTop: { method: string; kind: string; n: number; sigs: Record<string, number> }[];
  methodCallDistinct: number;
  /** Push-double sanity: distinct count, non-finite count, top values. */
  pushDoubles: { distinct: number; nonFinite: number; top: { v: number; n: number }[] };
  /** Targeted semantic signals per ClipEvent class (top-12, counts only). */
  clipSignals: Record<string, Record<string, number>>;
  /**
   * Remappable-key slot references inside the KeyDown class (full counts,
   * not trimmed): the 7 _root.key* slots plus config-screen helpers.
   */
  keySlotSignals: Record<string, number>;
  memberNames: string[];
  external: { getUrls: { url: string; target: string; n: number }[]; getUrl2Count: number; apiHits: Record<string, number> };
  soundRefs: Record<string, number>;
  stringCount: number;
  stringHash: string;
  uncertainty: string[];
}

export interface CompactInventoryActionScopes {
  doActionTags: number;
  doInitActionTags: number;
  doActionRecordsInclEnd: number;
  doActionRecordsExclEnd: number;
  doInitActionRecordsInclEnd: number;
  doInitActionRecordsExclEnd: number;
  clipActionRecordsInclEnd: number;
  clipActionRecordsExclEnd: number;
  buttonCondRecordsInclEnd: number;
  buttonCondRecordsExclEnd: number;
  endTerminators: number;
  totalRecordsInclEnd: number;
  totalRecordsExclEnd: number;
}

export function toCompact(full: ScanResult): CompactInventory {
  const opEntries = Object.entries(full.opHist)
    .filter(([k]) => k !== "op_0x0") // ActionEnd framing, not semantics
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);
  const triggerTally = new Map<number, { n: number; syncStop: number }>();
  for (const t of full.startSounds) {
    let e = triggerTally.get(t.soundId);
    if (!e) {
      e = { n: 0, syncStop: 0 };
      triggerTally.set(t.soundId, e);
    }
    e.n++;
    if (t.syncStop) e.syncStop++;
  }
  // Targeted semantic signals per ClipEvent class (defect 7): top-12
  // entries per class instead of verbatim top-64 dumps. Full per-event
  // tables stay in scan.json (local only).
  const clipSignals: Record<string, Record<string, number>> = {};
  for (const [ev, table] of Object.entries(full.clipActions.eventStrings)) {
    clipSignals[ev] = Object.fromEntries(
      Object.entries(table).sort((a, b) => b[1] - a[1]).slice(0, 12),
    );
  }
  // Key-slot signals: full (untrimmed) counts for the remappable slots
  // inside the KeyDown class — the §5.9 variable inventory.
  const keyDownTable = full.clipActions.eventStrings["0x40:KeyDown"] ?? {};
  const keySlotSignals: Record<string, number> = {};
  for (const slot of ["keyL", "keyR", "keyU", "keyD", "key1", "key2", "key3", "keyhen", "keycode0", "keyhi"]) {
    if (keyDownTable[slot] !== undefined) keySlotSignals[slot] = keyDownTable[slot];
  }
  // Deduped export table (the SWF repeats export rows per scene).
  const expTally = new Map<string, { charId: number; exports: number }>();
  for (const a of full.exportAssets) {
    const e = expTally.get(a.name);
    if (!e) expTally.set(a.name, { charId: a.charId, exports: 1 });
    else e.exports++;
  }
  const exportAssets = [...expTally.entries()]
    .map(([name, e]) => ({ name, charId: e.charId, exports: e.exports }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  // Placement summary: counts + root-placed chars + graph hash.
  const rootChars = [...new Set(
    full.placeGraph.filter((g) => g.container === null).map((g) => g.charId),
  )].sort((a, b) => a - b);
  const containers = new Set(full.placeGraph.map((g) => g.container === null ? "root" : g.container)).size;
  const graphHash = fnv1a(full.placeGraph.map((g) => `${g.container === null ? "root" : g.container}:${g.charId}x${g.instances}`).join(","));
  // Precise clip events (defect 6): flag + SWF name + count, sorted by flag.
  const clipEvents = Object.entries(full.clipActions.eventFlagTally)
    .filter(([k]) => !k.includes(":key="))
    .map(([k, n]) => {
      const m = k.match(/^(0x[0-9a-f]+):(.*)$/);
      return { flag: m ? m[1] : k, name: m ? m[2] : k, n };
    })
    .sort((a, b) => parseInt(a.flag, 16) - parseInt(b.flag, 16));
  // Key inventory rollups (defect 3): literal vs property-var arguments.
  const litTally = new Map<number, number>();
  const varTally = new Map<string, number>();
  const codeTally = new Map<string, number>();
  for (const s of full.keyInventory.resolvedIsDown) {
    if (s.argKind === "literal-int") {
      const v = Number(s.arg);
      if (Number.isInteger(v)) litTally.set(v, (litTally.get(v) ?? 0) + 1);
    } else if (s.argKind === "property-var") {
      varTally.set(s.arg, (varTally.get(s.arg) ?? 0) + 1);
    }
  }
  for (const s of full.keyInventory.resolvedGetCode) {
    codeTally.set(s.argKind, (codeTally.get(s.argKind) ?? 0) + 1);
  }
  return {
    _generatedBy: "tools/ranger-cook/scan.ts",
    _swfRef: full.swfRef,
    _doNotEdit: true,
    header: {
      stageW: full.header.stageW, stageH: full.header.stageH,
      frameRate: full.header.frameRate, rootFrames: full.header.rootFrames,
      background: full.background,
    },
    tagCounts: full.tagCounts,
    doAbc: full.doAbc,
    rootLabels: full.rootLabels,
    exportAssets,
    exportTotals: { rows: full.exportAssets.length, uniqueNames: expTally.size },
    sounds: full.sounds.map((s) => ({
      id: s.id, formatName: s.formatName, rateHz: s.rateHz,
      bits: s.bits, channels: s.channels, samples: s.samples, dataBytes: s.dataBytes,
    })),
    soundScope: {
      reachableSounds: full.soundScope.reachableSounds,
      uncertainSounds: full.soundScope.uncertainSounds,
      inScopeSounds: full.soundScope.inScopeSounds,
      literalSpawnRefs: full.soundScope.literalSpawnRefs,
      staticPlacedEmitters: full.soundScope.staticPlacedEmitters,
      emitterHostCount: full.soundScope.emitterHosts.length,
      triggerTotal: full.startSounds.length,
      rationale: full.soundScope.rationale,
    },
    buttonSoundRefs: full.buttonSounds.flatMap((b) => b.soundIds).sort((a, b) => a - b),
    startSoundTriggers: [...triggerTally.entries()]
      .map(([soundId, e]) => ({ soundId, n: e.n, syncStop: e.syncStop }))
      .sort((a, b) => a.soundId - b.soundId),
    streamHeads: {
      count: full.streamHeads.length,
      nonEmpty: full.streamHeads.filter((h) => h.samples > 0).length,
    },
    bitmaps: full.bitmaps,
    placeObject2: full.placeObject2,
    placementSummary: {
      edges: full.placeGraph.length,
      containers,
      rootPlacedChars: rootChars,
      graphHash,
    },
    clipActionsWidth: full.clipActionsWidth,
    clipEvents,
    clipKeyCodes: full.clipActions.keyCodes,
    clipUncertain: full.clipActions.uncertain,
    buttons2: full.buttons2,
    actionScopes: { ...full.actionScopes },
    contractBaselineApprox: 100512,
    baselineNote:
      "Contract baseline ~100,512 = DoAction semantic records excl. End framing " +
      "(see actionScopes.doActionRecordsExclEnd). Totals incl. End plus ClipActions " +
      "and button-cond records use a wider scope and are reported separately — " +
      "different scopes, never a contradiction.",
    functionNames: full.functionNames,
    attachMovieCooccurrence: full.attachMovieLinkage.map((a) => ({ id: a.id, blocks: a.blocks })),
    attachDynamicPossible: true,
    attachMovieStatic: (() => {
      const t = new Map<string, number>();
      for (const s of full.attachMovieSites) {
        if (s.linkage !== null && !s.linkage.startsWith("var:")) {
          t.set(s.linkage, (t.get(s.linkage) ?? 0) + 1);
        }
      }
      return [...t.entries()]
        .map(([id, n]) => ({ id, n }))
        .sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1));
    })(),
    attachMovieDynamicSites: full.attachMovieSites
      .filter((s) => s.linkage === null || s.linkage.startsWith("var:"))
      .map((s) => ({ loc: s.loc, kind: s.kind })),
    rootFrames: full.rootFrames,
    opHistAllSourcesTop: Object.fromEntries(opEntries),
    handlers: full.handlers,
    keyInventory: {
      totalCallMethodSites: full.keyInventory.totalCallMethodSites,
      totalCallFunctionSites: full.keyInventory.totalCallFunctionSites,
      totalNewMethodSites: full.keyInventory.totalNewMethodSites,
      otherCalls: full.keyInventory.otherCalls,
      resolvedIsDown: full.keyInventory.resolvedIsDown.length,
      resolvedGetCode: full.keyInventory.resolvedGetCode.length,
      isDownArgLiterals: [...litTally.entries()]
        .map(([code, n]) => ({ code, n }))
        .sort((a, b) => b.n - a.n || a.code - b.code),
      isDownArgVars: [...varTally.entries()]
        .map(([name, n]) => ({ name, n }))
        .sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1)),
      getCodeArgKinds: [...codeTally.entries()]
        .map(([kind, n]) => ({ kind, n }))
        .sort((a, b) => b.n - a.n),
      unresolved: full.keyInventory.unresolved,
    },
    pushIntUniverseTop: full.keyCodesAll,
    pushIntUniverseNote:
      "Raw Push-int constants (coordinates, counters, frame numbers dominate). " +
      "NOT decoded Key arguments — use keyInventory for call-site arguments.",
    methodCallsTop: full.methodCalls.slice(0, 48).map((m) => ({
      method: m.method, kind: m.kind, n: m.n, sigs: m.sigs,
    })),
    methodCallDistinct: full.methodCalls.length,
    pushDoubles: {
      distinct: full.pushDoubles.length,
      nonFinite: full.pushDoubles.filter((d) => !Number.isFinite(d.v)).length,
      top: full.pushDoubles.slice(0, 32),
    },
    clipSignals,
    keySlotSignals,
    memberNames: Object.keys(full.memberNames).sort(),
    external: {
      getUrls: full.external.getUrls.map((g) => ({ url: g.url, target: g.target, n: g.n })),
      getUrl2Count: full.external.getUrl2Count,
      apiHits: full.external.apiHits,
    },
    soundRefs: full.soundRefs,
    stringCount: Object.keys(full.strings).length,
    stringHash: full.stringHash,
    uncertainty: [
      "Static scan only: observed references are not proofs of reachability or call order (no CFG, no AVM1 execution).",
      "Key arguments come from basic-block abstract interpretation (keyInventory); Push-int constants are a raw universe, not arguments.",
      "Unresolved call sites are listed exhaustively in keyInventory.unresolved with reasons — none are dropped.",
      "attachMovie refs are literal string constants; dynamic linkage construction (\"ef_hit\"+i / \"se_\"+i style) cannot be excluded.",
      "Sound audibility needs emitter instantiation: only statically reachable hosts count as reachable; the rest are uncertain.",
      "ClipActions KeyPress bit assumed 1<<17 (0x20000); action streams parsed at that boundary — see clipUncertain for misparses (must stay empty).",
      "ClipEventFlags parsed as 32-bit (SWF v6 >= 6); width validated — see clipActionsWidth.",
    ],
  };
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(v, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const getFlag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: scan.ts [--swf <path>] [--out <dir>] [--inventory-out <path> | --no-inventory]");
    console.log("  SWF path: --swf, positional arg, or RANGER_SWF env (never hardcoded).");
    process.exit(0);
  }
  let swfPath: string;
  try {
    swfPath = getFlag("--swf") ?? resolveSwfPath(process.env, argv);
  } catch (e) {
    console.error(String(e));
    process.exit(2);
  }
  const outDir = getFlag("--out") ?? resolve(HERE, "out");
  const noInventory = argv.includes("--no-inventory");
  const inventoryOut = getFlag("--inventory-out") ?? resolve(REPO, "apps/ranger/m0-inventory.json");

  let buf: Uint8Array;
  try {
    buf = readFileSync(swfPath);
  } catch {
    console.error(`ranger-cook/scan: cannot read SWF at given path (read-only access expected).`);
    process.exit(2);
  }
  let full: ScanResult;
  try {
    full = scanSwf(buf);
  } catch (e) {
    console.error(`ranger-cook/scan: ${e instanceof Error ? e.message : e}`);
    process.exit(3);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "scan.json"), canonicalJson(full));
  if (!noInventory) writeFileSync(inventoryOut, canonicalJson(toCompact(full)));
  const sounds = full.sounds.length;
  const sc = full.actionScopes;
  console.log(`scan: ${full.swfRef} ${full.header.stageW}x${full.header.stageH} @${full.header.frameRate}fps`);
  console.log(`scan: tags=${Object.values(full.tagCounts).reduce((a, b) => a + b, 0)} sprites=${full.sprites.length} sounds=${sounds} doaction=${full.doActions.tags}`);
  console.log(`scan: actions doAction=${sc.doActionRecordsExclEnd}(exclEnd)/${sc.doActionRecordsInclEnd}(inclEnd) clip=${sc.clipActionRecordsExclEnd}/${sc.clipActionRecordsInclEnd} button=${sc.buttonCondRecordsExclEnd}/${sc.buttonCondRecordsInclEnd} init=${sc.doInitActionRecordsExclEnd}/${sc.doInitActionRecordsInclEnd} total=${sc.totalRecordsExclEnd}/${sc.totalRecordsInclEnd}`);
  console.log(`scan: keyCalls method=${full.keyInventory.totalCallMethodSites} function=${full.keyInventory.totalCallFunctionSites} new=${full.keyInventory.totalNewMethodSites} isDown=${full.keyInventory.resolvedIsDown.length} getCode=${full.keyInventory.resolvedGetCode.length} unresolved=${full.keyInventory.unresolved.length}`);
  console.log(`scan: sounds reachable=[${full.soundScope.reachableSounds.join(",")}] uncertain=${full.soundScope.uncertainSounds.length} inScope=[${full.soundScope.inScopeSounds.join(",")}]`);
  console.log(`scan: wrote ${resolve(outDir, "scan.json")}${noInventory ? "" : ` + ${inventoryOut}`}`);
}

const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
