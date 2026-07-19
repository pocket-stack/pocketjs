/* static/runtime/core/vm.h — VM state + the seam to the category runtime. */
#ifndef PS_VM_H
#define PS_VM_H

#include "hal.h"

typedef struct {
  u16 ip;
  u16 script;   /* running script id */
  u16 rng;      /* xorshift16 state (PS_RNG_SEED at boot) */
  u16 wait_frames;
  u8 sp;
  u8 frame;     /* call depth, 0 = top */
  u8 waiting;   /* WAITING_* */
  u8 active;
  s16 stack[VM_STACK];
  u16 ret[VM_FRAMES];
  s16 locals[VM_FRAMES * VM_LOCALS];
} Vm;

extern Vm vm;

void vm_start(u16 scriptId);
void vm_run(void);
void vm_resume(void);
void vm_resume_value(s16 v);

/* Operand access for the category syscall handler. */
u8 vm_fetch8(void);
u16 vm_fetch16(void);
void vm_push(s16 v);
s16 vm_pop(void);

s16 vm_get_var(u8 id);
void vm_set_var(u8 id, s16 v);
u8 vm_get_flag(u8 id);
void vm_set_flag(u8 id, u8 on);
u16 vm_rng_next(void);

/* Implemented by the category runtime (rpg.c): ops >= PS_SYSCALL_BASE. */
void rpg_syscall(u8 op);

#endif
