/* static/runtime/core/vm.c — the Pocket Static stack VM, portable C.
 * Semantics are pinned by static/vm/ref.ts + static/test/vm.test.ts; if this
 * file and ref.ts disagree, this file is wrong.
 *
 * The cartridge build is forgiving where the host reference is strict:
 * out-of-range access clamps/no-ops instead of trapping (there is no one to
 * read a panic on a handheld). The compiler guarantees well-formed bytecode;
 * clamping is belt-and-braces.
 */
#include "vm.h"

Vm vm;

/* vars/flags live INSIDE the debug block: the mirror is the storage. */
#define DBGB ((volatile u8 *)PS_DEBUG_ADDR)
#define VARS ((volatile s16 *)(PS_DEBUG_ADDR + DBGO_VARS))
#define FLAGS (DBGB + DBGO_FLAGS)

static const u8 *code;

s16 vm_get_var(u8 id) { return VARS[id & (VM_VARS - 1)]; }
void vm_set_var(u8 id, s16 v) { VARS[id & (VM_VARS - 1)] = v; }
u8 vm_get_flag(u8 id) { return (FLAGS[id >> 3] >> (id & 7)) & 1; }
void vm_set_flag(u8 id, u8 on) {
  u8 m = (u8)(1 << (id & 7));
  if (on) FLAGS[id >> 3] |= m;
  else FLAGS[id >> 3] &= (u8)~m;
}

static void push(s16 v) {
  if (vm.sp < VM_STACK) vm.stack[vm.sp++] = v;
}
static s16 pop(void) {
  if (vm.sp == 0) return 0;
  return vm.stack[--vm.sp];
}

u8 vm_fetch8(void) { return code[vm.ip++]; }
u16 vm_fetch16(void) {
  u16 v = code[vm.ip];
  v |= ((u16)code[vm.ip + 1]) << 8;
  vm.ip += 2;
  return v;
}

void vm_push(s16 v) { push(v); }
s16 vm_pop(void) { return pop(); }

void vm_start(u16 scriptId) {
  vm.script = scriptId;
  vm.ip = ps_script_table[scriptId];
  vm.sp = 0;
  vm.frame = 0;
  vm.waiting = WAITING_NONE;
  vm.active = 1;
}

void vm_resume(void) { vm.waiting = WAITING_NONE; }

void vm_resume_value(s16 v) {
  push(v);
  vm.waiting = WAITING_NONE;
}

static void vm_end(void) {
  vm.active = 0;
  vm.waiting = WAITING_NONE;
}

u16 vm_rng_next(void) {
  u16 x = vm.rng;
  x ^= (u16)(x << 7);
  x ^= (u16)(x >> 9);
  x ^= (u16)(x << 8);
  vm.rng = x;
  return x;
}

void vm_run(void) {
  u8 budget = VM_BURST;
  s16 a, b;
  u8 op, o8;
  u16 o16;

  if (!vm.active || vm.waiting != WAITING_NONE) return;
  code = hal_blob(0); /* blob 0 is always SCRIPTS (link.ts) */

  while (budget--) {
    op = code[vm.ip++];
    if (op >= PS_SYSCALL_BASE) {
      rpg_syscall(op);
      if (!vm.active || vm.waiting != WAITING_NONE) return;
      code = hal_blob(0); /* a syscall may have latched another blob */
      continue;
    }
    switch (op) {
      case OP_END:
        vm_end();
        return;
      case OP_NOP:
        break;
      case OP_PUSH8:
        push((s8)vm_fetch8());
        break;
      case OP_PUSH16:
        push((s16)vm_fetch16());
        break;
      case OP_POP:
        pop();
        break;
      case OP_DUP:
        a = pop();
        push(a);
        push(a);
        break;
      case OP_JMP:
        o16 = vm_fetch16();
        vm.ip = (u16)(vm.ip + (s16)o16);
        break;
      case OP_JZ:
        o16 = vm_fetch16();
        if (pop() == 0) vm.ip = (u16)(vm.ip + (s16)o16);
        break;
      case OP_JNZ:
        o16 = vm_fetch16();
        if (pop() != 0) vm.ip = (u16)(vm.ip + (s16)o16);
        break;
      case OP_CALL:
        o16 = vm_fetch16();
        if (vm.frame < VM_FRAMES - 1) {
          u8 i;
          s16 *fl;
          vm.ret[vm.frame++] = vm.ip;
          fl = &vm.locals[(u16)vm.frame * VM_LOCALS];
          for (i = 0; i < VM_LOCALS; i++) fl[i] = 0;
          vm.ip = ps_script_table[o16];
        }
        break;
      case OP_RET:
        if (vm.frame == 0) {
          vm_end();
          return;
        }
        vm.ip = vm.ret[--vm.frame];
        break;
      case OP_LDV:
        push(vm_get_var(vm_fetch8()));
        break;
      case OP_STV:
        o8 = vm_fetch8();
        vm_set_var(o8, pop());
        break;
      case OP_LDL:
        o8 = vm_fetch8();
        push(vm.locals[(u16)vm.frame * VM_LOCALS + (o8 & (VM_LOCALS - 1))]);
        break;
      case OP_STL:
        o8 = vm_fetch8();
        vm.locals[(u16)vm.frame * VM_LOCALS + (o8 & (VM_LOCALS - 1))] = pop();
        break;
      case OP_FLAG:
        push(vm_get_flag(vm_fetch8()));
        break;
      case OP_SETF:
        vm_set_flag(vm_fetch8(), 1);
        break;
      case OP_CLRF:
        vm_set_flag(vm_fetch8(), 0);
        break;
      case OP_STF:
        o8 = vm_fetch8();
        vm_set_flag(o8, pop() != 0);
        break;
      case OP_ADD:
        b = pop();
        a = pop();
        push((s16)(a + b));
        break;
      case OP_SUB:
        b = pop();
        a = pop();
        push((s16)(a - b));
        break;
      case OP_MUL:
        b = pop();
        a = pop();
        push((s16)(a * b));
        break;
      case OP_DIV:
        b = pop();
        a = pop();
        push(b == 0 ? 0 : (s16)(a / b));
        break;
      case OP_MOD:
        b = pop();
        a = pop();
        push(b == 0 ? 0 : (s16)(a % b));
        break;
      case OP_NEG:
        push((s16)-pop());
        break;
      case OP_EQ:
        b = pop();
        a = pop();
        push(a == b);
        break;
      case OP_NE:
        b = pop();
        a = pop();
        push(a != b);
        break;
      case OP_LT:
        b = pop();
        a = pop();
        push(a < b);
        break;
      case OP_GT:
        b = pop();
        a = pop();
        push(a > b);
        break;
      case OP_LE:
        b = pop();
        a = pop();
        push(a <= b);
        break;
      case OP_GE:
        b = pop();
        a = pop();
        push(a >= b);
        break;
      case OP_NOT:
        push(pop() == 0);
        break;
      case OP_RND:
        a = pop();
        if (a <= 0) push(0);
        else push((s16)(vm_rng_next() % (u16)a));
        break;
      case OP_WAIT:
        a = pop();
        if (a > 0) {
          vm.wait_frames = (u16)a;
          vm.waiting = WAITING_FRAMES;
          return;
        }
        break;
      default:
        vm_end(); /* illegal opcode: stop the script, keep the game alive */
        return;
    }
  }
}
