// aot/runtime/script_vm.c — the event-script stack machine.
#include "runtime.h"

// --- operand readers (little-endian, advance ip) ---------------------------
static u8 rd_u8(void) { return g.vm.code[g.vm.ip++]; }
static u16 rd_u16(void) {
  u16 v = (u16)(g.vm.code[g.vm.ip] | (g.vm.code[g.vm.ip + 1] << 8));
  g.vm.ip += 2;
  return v;
}
static s16 rd_i16(void) { return (s16)rd_u16(); }

// --- s16 operand stack (clamped) -------------------------------------------
static void push(s16 v) {
  if (g.vm.sp < PJGB_VM_MAX_STACK) g.vm.stack[g.vm.sp++] = v;
}
static s16 pop(void) {
  if (g.vm.sp > 0) return g.vm.stack[--g.vm.sp];
  return 0;
}

// Set actor `slot` to face the player: opposite of the player->actor
// direction, derived from the tile delta.
static void face_player(int slot) {
  if (slot < 0 || slot >= g.n_actors) return;
  int ax = g.actors[slot].x, ay = g.actors[slot].y;
  int px = (int)(g.player.px >> 3), py = (int)(g.player.py >> 3);
  int dx = px - ax, dy = py - ay;
  int adx = dx < 0 ? -dx : dx;
  int ady = dy < 0 ? -dy : dy;
  int dir;
  if (adx >= ady) dir = dx > 0 ? DIR_RIGHT : DIR_LEFT;
  else dir = dy > 0 ? DIR_DOWN : DIR_UP;
  g.actor_dir[slot] = (u8)dir;
}

void vm_start(int script_id, int actor_slot) {
  const u32 *table = (const u32 *)cart_chunk(CHUNK_SCRIPT_TABLE, 0, 0);
  const u8 *code = cart_chunk(CHUNK_SCRIPT_CODE, 0, 0);
  g.vm.code = code + table[script_id];
  g.vm.ip = 0;
  g.vm.sp = 0;
  g.vm.active = 1;
  g.vm.suspend = VM_SUSP_NONE;
  g.vm.wait_frames = 0;
  g.vm.actor_slot = (s16)actor_slot;
}

int vm_active(void) { return g.vm.active; }

void vm_tick(void) {
  if (!g.vm.active) return;

  // Resume from a suspension, if the resume condition is met.
  switch (g.vm.suspend) {
    case VM_SUSP_WAIT:
      if (--g.vm.wait_frames == 0) g.vm.suspend = VM_SUSP_NONE;
      else return;
      break;
    case VM_SUSP_TEXT:
      if (!textbox_active()) g.vm.suspend = VM_SUSP_NONE;
      else return;
      break;
    case VM_SUSP_CHOICE:
      if (choice_result() >= 0) {
        push((s16)choice_result());
        g.vm.suspend = VM_SUSP_NONE;
      } else {
        return;
      }
      break;
    default:
      break;
  }

  // Execute ops until END or a new suspension is set.
  for (;;) {
    u8 op = rd_u8();
    switch (op) {
      case OP_END:
        g.vm.active = 0;
        return;
      case OP_NOP:
        break;
      case OP_TEXT: {
        u16 t = rd_u16();
        textbox_show(t);
        g.vm.suspend = VM_SUSP_TEXT;
        return;
      }
      case OP_SET_FLAG: {
        u16 f = rd_u16();
        flag_set(f, 1);
        break;
      }
      case OP_CLEAR_FLAG: {
        u16 f = rd_u16();
        flag_set(f, 0);
        break;
      }
      case OP_PUSH_FLAG: {
        u16 f = rd_u16();
        push((s16)flag_get(f));
        break;
      }
      case OP_PUSH_CONST: {
        s16 v = rd_i16();
        push(v);
        break;
      }
      case OP_POP:
        pop();
        break;
      case OP_DUP: {
        s16 v = pop();
        push(v);
        push(v);
        break;
      }
      case OP_EQ: {
        s16 b = pop(), a = pop();
        push(a == b ? 1 : 0);
        break;
      }
      case OP_NE: {
        s16 b = pop(), a = pop();
        push(a != b ? 1 : 0);
        break;
      }
      case OP_NOT: {
        s16 a = pop();
        push(a ? 0 : 1);
        break;
      }
      case OP_JUMP: {
        s16 rel = rd_i16(); // measured from after the operand bytes
        g.vm.ip = (u32)((s32)g.vm.ip + rel);
        break;
      }
      case OP_JUMP_IF_FALSE: {
        s16 rel = rd_i16();
        if (!pop()) g.vm.ip = (u32)((s32)g.vm.ip + rel);
        break;
      }
      case OP_CHOICE: {
        u8 n = rd_u8();
        u16 ids[8];
        for (int i = 0; i < n; i++) {
          u16 id = rd_u16();
          if (i < 8) ids[i] = id;
        }
        if (n > 8) n = 8;
        choice_show(n, ids);
        g.vm.suspend = VM_SUSP_CHOICE;
        return;
      }
      case OP_LOCK_PLAYER:
        g.player.locked = 1;
        break;
      case OP_RELEASE_PLAYER:
        g.player.locked = 0;
        break;
      case OP_FACE_PLAYER: {
        u8 slot = rd_u8();
        // 0xFF = "the actor that started this script" (compiler emits this for
        // facePlayer("<self>"), avoiding cross-map slot resolution).
        if (slot == 0xff) {
          if (g.vm.actor_slot < 0) break;
          slot = (u8)g.vm.actor_slot;
        }
        face_player(slot);
        break;
      }
      case OP_WARP: {
        u8 m = rd_u8();
        u16 x = rd_u16();
        u16 y = rd_u16();
        u8 d = rd_u8();
        map_enter(m, x, y, d);
        break;
      }
      case OP_SET_VAR: {
        u16 i = rd_u16();
        s16 v = rd_i16();
        if (i < BUDGET_MAX_VARS) g.vars[i] = v;
        break;
      }
      case OP_ADD_VAR: {
        u16 i = rd_u16();
        s16 v = rd_i16();
        if (i < BUDGET_MAX_VARS) g.vars[i] += v;
        break;
      }
      case OP_PUSH_VAR: {
        u16 i = rd_u16();
        push(i < BUDGET_MAX_VARS ? g.vars[i] : 0);
        break;
      }
      case OP_GIVE_ITEM: {
        u16 item = rd_u16();
        u8 qty = rd_u8();
        (void)item;
        (void)qty; // stub
        break;
      }
      case OP_BATTLE: {
        u16 id = rd_u16();
        (void)id;
        push(1); // stub: "won"
        break;
      }
      case OP_WAIT: {
        u16 n = rd_u16();
        if (n == 0) break;
        g.vm.wait_frames = n;
        g.vm.suspend = VM_SUSP_WAIT;
        return;
      }
      case OP_PLAY_SFX: {
        u16 id = rd_u16();
        (void)id; // stub
        break;
      }
      default:
        // Unknown opcode: fail safe by ending the script.
        g.vm.active = 0;
        return;
    }
  }
}
