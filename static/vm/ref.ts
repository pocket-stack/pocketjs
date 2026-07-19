// static/vm/ref.ts — the reference implementation of the Pocket Static VM.
//
// This is the semantic golden: the compiler's unit tests run compiled
// bytecode HERE (no emulator in the loop), and the three C runtimes are held
// to this behavior by the cross-target E2E suite. If ref.ts and vm/core.c
// ever disagree, core.c is wrong.
//
// The interpreter is deliberately strict: out-of-range anything throws,
// because on host we want compiler bugs loud (the C core clamps instead —
// cartridges don't get to crash).

import {
  OP,
  OP_OPERANDS,
  RNG_SEED,
  SYSCALL_BASE,
  VM_FLAGS,
  VM_FRAMES,
  VM_LOCALS,
  VM_STACK,
  VM_VARS,
  WAITING,
  i16,
  rngNext,
} from "../spec/isa.ts";

export interface OperandReader {
  u8(): number;
  u16(): number;
  i8(): number;
  i16(): number;
}

/** What a syscall tells the VM to do after its operands are consumed. */
export interface SyscallResult {
  /** Value to push immediately (non-suspending value ops). */
  push?: number;
  /** Suspend with this reason; resume() continues. */
  suspend?: number;
  /** With `suspend`: the resume(value) argument is pushed (CHOICE). */
  pushOnResume?: boolean;
}

export interface RefHost {
  /** Handle an opcode >= SYSCALL_BASE. MUST consume exactly its operands. */
  syscall(op: number, operands: OperandReader, vm: RefVM): SyscallResult;
}

export type VmStatus = "idle" | "running" | "suspended" | "done";

export class RefVM {
  readonly vars = new Int16Array(VM_VARS);
  readonly flags = new Uint8Array(VM_FLAGS);
  rng = RNG_SEED;
  status: VmStatus = "idle";
  waiting: number = WAITING.NONE;
  /** Ops executed since start() — the runaway guard for tests. */
  opCount = 0;

  private code: Uint8Array;
  private table: number[];
  private host: RefHost;
  private ip = 0;
  private stack = new Int16Array(VM_STACK);
  private sp = 0;
  private locals = new Int16Array(VM_FRAMES * VM_LOCALS);
  private frames: number[] = []; // return ips; frame N locals base = N*VM_LOCALS
  private pendingPushOnResume = false;
  scriptId = -1;

  constructor(code: Uint8Array, table: number[], host: RefHost) {
    this.code = code;
    this.table = table;
    this.host = host;
  }

  start(scriptId: number): void {
    if (scriptId < 0 || scriptId >= this.table.length) throw new Error(`bad script id ${scriptId}`);
    this.scriptId = scriptId;
    this.ip = this.table[scriptId];
    this.sp = 0;
    this.frames = [];
    this.locals.fill(0);
    this.status = "running";
    this.waiting = WAITING.NONE;
    this.opCount = 0;
    this.run();
  }

  /** Resume a suspended VM; `value` is pushed for value-suspends (CHOICE). */
  resume(value?: number): void {
    if (this.status !== "suspended") throw new Error(`resume() while ${this.status}`);
    if (this.pendingPushOnResume) {
      if (value === undefined) throw new Error("this suspension resumes with a value");
      this.push(value);
    } else if (value !== undefined) {
      throw new Error("this suspension does not take a value");
    }
    this.pendingPushOnResume = false;
    this.status = "running";
    this.waiting = WAITING.NONE;
    this.run();
  }

  // --- stack/locals/globals (strict) --------------------------------------
  push(v: number): void {
    if (this.sp >= VM_STACK) throw new Error(`stack overflow at ip=${this.ip}`);
    this.stack[this.sp++] = i16(v);
  }
  pop(): number {
    if (this.sp <= 0) throw new Error(`stack underflow at ip=${this.ip}`);
    return this.stack[--this.sp];
  }
  getVar(id: number): number {
    if (id < 0 || id >= VM_VARS) throw new Error(`var ${id} out of range`);
    return this.vars[id];
  }
  setVar(id: number, v: number): void {
    if (id < 0 || id >= VM_VARS) throw new Error(`var ${id} out of range`);
    this.vars[id] = i16(v);
  }
  getFlag(id: number): number {
    if (id < 0 || id >= VM_FLAGS) throw new Error(`flag ${id} out of range`);
    return this.flags[id];
  }
  setFlag(id: number, v: boolean): void {
    if (id < 0 || id >= VM_FLAGS) throw new Error(`flag ${id} out of range`);
    this.flags[id] = v ? 1 : 0;
  }
  private localBase(): number {
    return this.frames.length * VM_LOCALS;
  }

  // --- operand reading ------------------------------------------------------
  private rdU8(): number {
    return this.code[this.ip++];
  }
  private rdU16(): number {
    const v = this.code[this.ip] | (this.code[this.ip + 1] << 8);
    this.ip += 2;
    return v;
  }
  private rdI8(): number {
    const v = this.rdU8();
    return v >= 0x80 ? v - 0x100 : v;
  }
  private rdI16(): number {
    return i16(this.rdU16());
  }
  private reader(): OperandReader {
    return {
      u8: () => this.rdU8(),
      u16: () => this.rdU16(),
      i8: () => this.rdI8(),
      i16: () => this.rdI16(),
    };
  }

  // --- the loop -------------------------------------------------------------
  private run(): void {
    for (;;) {
      if (this.ip < 0 || this.ip >= this.code.length) {
        throw new Error(`ip ${this.ip} out of code (script ${this.scriptId})`);
      }
      const op = this.code[this.ip++];
      this.opCount++;
      if (this.opCount > 1_000_000) throw new Error("runaway script (1M ops)");

      if (op >= SYSCALL_BASE) {
        const res = this.host.syscall(op, this.reader(), this);
        if (res.suspend !== undefined) {
          this.status = "suspended";
          this.waiting = res.suspend;
          this.pendingPushOnResume = res.pushOnResume === true;
          return;
        }
        if (res.push !== undefined) this.push(res.push);
        continue;
      }

      switch (op) {
        case OP.END:
          this.status = "done";
          this.waiting = WAITING.NONE;
          return;
        case OP.NOP:
          break;
        case OP.PUSH8:
          this.push(this.rdI8());
          break;
        case OP.PUSH16:
          this.push(this.rdI16());
          break;
        case OP.POP:
          this.pop();
          break;
        case OP.DUP: {
          const v = this.pop();
          this.push(v);
          this.push(v);
          break;
        }
        case OP.JMP: {
          const rel = this.rdI16();
          this.ip += rel;
          break;
        }
        case OP.JZ: {
          const rel = this.rdI16();
          if (this.pop() === 0) this.ip += rel;
          break;
        }
        case OP.JNZ: {
          const rel = this.rdI16();
          if (this.pop() !== 0) this.ip += rel;
          break;
        }
        case OP.CALL: {
          const id = this.rdU16();
          if (id >= this.table.length) throw new Error(`CALL bad script ${id}`);
          if (this.frames.length >= VM_FRAMES - 1) throw new Error("call stack overflow");
          this.frames.push(this.ip);
          const base = this.localBase();
          this.locals.fill(0, base, base + VM_LOCALS);
          this.ip = this.table[id];
          break;
        }
        case OP.RET: {
          const ret = this.frames.pop();
          if (ret === undefined) {
            this.status = "done";
            this.waiting = WAITING.NONE;
            return;
          }
          this.ip = ret;
          break;
        }
        case OP.LDV:
          this.push(this.getVar(this.rdU8()));
          break;
        case OP.STV:
          this.setVar(this.rdU8(), this.pop());
          break;
        case OP.LDL: {
          const s = this.rdU8();
          if (s >= VM_LOCALS) throw new Error(`local ${s} out of range`);
          this.push(this.locals[this.localBase() + s]);
          break;
        }
        case OP.STL: {
          const s = this.rdU8();
          if (s >= VM_LOCALS) throw new Error(`local ${s} out of range`);
          this.locals[this.localBase() + s] = i16(this.pop());
          break;
        }
        case OP.FLAG:
          this.push(this.getFlag(this.rdU8()));
          break;
        case OP.SETF:
          this.setFlag(this.rdU8(), true);
          break;
        case OP.CLRF:
          this.setFlag(this.rdU8(), false);
          break;
        case OP.STF:
          this.setFlag(this.rdU8(), this.pop() !== 0);
          break;
        case OP.ADD: {
          const b = this.pop(), a = this.pop();
          this.push(a + b);
          break;
        }
        case OP.SUB: {
          const b = this.pop(), a = this.pop();
          this.push(a - b);
          break;
        }
        case OP.MUL: {
          const b = this.pop(), a = this.pop();
          this.push(Math.imul(a, b));
          break;
        }
        case OP.DIV: {
          const b = this.pop(), a = this.pop();
          this.push(b === 0 ? 0 : Math.trunc(a / b));
          break;
        }
        case OP.MOD: {
          const b = this.pop(), a = this.pop();
          this.push(b === 0 ? 0 : a % b);
          break;
        }
        case OP.NEG:
          this.push(-this.pop());
          break;
        case OP.EQ: {
          const b = this.pop(), a = this.pop();
          this.push(a === b ? 1 : 0);
          break;
        }
        case OP.NE: {
          const b = this.pop(), a = this.pop();
          this.push(a !== b ? 1 : 0);
          break;
        }
        case OP.LT: {
          const b = this.pop(), a = this.pop();
          this.push(a < b ? 1 : 0);
          break;
        }
        case OP.GT: {
          const b = this.pop(), a = this.pop();
          this.push(a > b ? 1 : 0);
          break;
        }
        case OP.LE: {
          const b = this.pop(), a = this.pop();
          this.push(a <= b ? 1 : 0);
          break;
        }
        case OP.GE: {
          const b = this.pop(), a = this.pop();
          this.push(a >= b ? 1 : 0);
          break;
        }
        case OP.NOT:
          this.push(this.pop() === 0 ? 1 : 0);
          break;
        case OP.RND: {
          const n = this.pop();
          if (n <= 0) {
            this.push(0);
            break;
          }
          this.rng = rngNext(this.rng);
          this.push(this.rng % n);
          break;
        }
        case OP.WAIT: {
          const n = this.pop();
          if (n > 0) {
            this.status = "suspended";
            this.waiting = WAITING.FRAMES;
            this.pendingPushOnResume = false;
            // The host is told how long via lastWait (frame simulation is
            // the driver's business, not the VM's).
            this.lastWait = n;
            return;
          }
          break;
        }
        default:
          throw new Error(`illegal opcode 0x${op.toString(16)} at ip=${this.ip - 1}`);
      }
    }
  }

  lastWait = 0;
}
