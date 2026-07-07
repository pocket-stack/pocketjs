/* saga/runtime/cue_vm.c — the suspendable cue interpreter. Non-blocking ops
 * (tweens, sprite ops, raster, sfx) execute in a burst each frame; blocking
 * ops (wait/fade/caption/dialog/choice/control/mash) park the VM in a waiting
 * state that vm_tick services first. */
#include "saga.h"

static u8 rd8(void) {
  return g.sc->cue[g.ip++];
}
static u16 rd16(void) {
  u16 v = (u16)(g.sc->cue[g.ip] | (g.sc->cue[g.ip + 1] << 8));
  g.ip += 2;
  return v;
}
static s16 rds16(void) {
  return (s16)rd16();
}

static void push(s16 v) {
  if (g.sp < 8) g.stack[g.sp++] = v;
}
static s16 pop(void) {
  return g.sp ? g.stack[--g.sp] : 0;
}

void vm_push(s16 v) {
  push(v);
}

/* free-roam interrupt: run an NPC/trigger cue, then resume the in-flight
 * OP_WORLD (ip is saved because the sub-cue moves it) */
void vm_run_sub(u8 cue) {
  if (cue == 0xff || cue >= g.sc->n_cues) return;
  g.ret_ip = g.ip;
  g.in_sub = 1;
  g.ip = g.sc->cue_offs[cue];
  g.waiting = WAITING_RUN;
}

void vm_start(void) {
  g.ip = 0;
  g.sp = 0;
  g.waiting = WAITING_RUN;
}

/* --- waiting-state service ---------------------------------------------------- */
static void service_control(void) {
  Spr *s = &g.spr[g.ctl_slot];
  static s16 frac;
  s16 step = 0;
  if (key_held(KEY_LEFT)) step = (s16)-g.ctl_speed_q4;
  else if (key_held(KEY_RIGHT)) step = (s16)g.ctl_speed_q4;
  if (step) {
    frac += step;
    s->x += frac / 16;
    frac %= 16;
    s->flags = step < 0 ? (u8)(s->flags | C_SPR_HFLIP) : (u8)(s->flags & ~C_SPR_HFLIP);
    s->mode = 1; /* walk anim */
  } else {
    s->mode = 0;
    s->frame = 0;
  }
  /* soft camera follow */
  {
    s16 target = (s16)(s->x - 120);
    if (target < g.sc->cam_min) target = g.sc->cam_min;
    if (target > g.sc->cam_max) target = g.sc->cam_max;
    g.fx[TW_CAM_X] += (s16)((target - g.fx[TW_CAM_X]) >> 3);
  }
  /* clamp actor to the pannable world */
  if (s->x < g.sc->cam_min + 8) s->x = (s16)(g.sc->cam_min + 8);
  if (s->x > g.sc->cam_max + 232) s->x = (s16)(g.sc->cam_max + 232);
  if (s->x > g.ctl_exit - 3 && s->x < g.ctl_exit + 3) {
    s->mode = 0;
    s->frame = 0;
    g.waiting = WAITING_RUN;
  }
}

static void service(void) {
  switch (g.waiting) {
    case WAITING_BUSY:
      if (g.wk_active) {
        walk_service();
        if (!g.wk_active && !g.wait_frames && !g.caption_busy) g.waiting = WAITING_RUN;
        break;
      }
      if (g.wait_frames) {
        g.wait_frames--;
        if (g.wait_frames == 0 && !g.caption_busy) g.waiting = WAITING_RUN;
      } else if (!g.caption_busy) {
        g.waiting = WAITING_RUN;
      }
      break;
    case WAITING_WORLD:
      world_service();
      break;
    case WAITING_MINIGAME:
      breakout_service();
      break;
    case WAITING_A:
      g.prompt_on = 1;
      if (key_pressed(KEY_A)) {
        g.prompt_on = 0;
        sfx_play(C_SFX_CONFIRM);
        g.waiting = WAITING_RUN;
      }
      break;
    case WAITING_DIALOG:
      if (g.caption_busy) {
        if (key_pressed(KEY_A)) { /* fast-forward typing */
          while (g.caption_busy) caption_update();
        }
        break;
      }
      g.prompt_on = 1;
      if (key_pressed(KEY_A)) {
        g.prompt_on = 0;
        caption_clear(C_CAP_DIALOG);
        sfx_play(C_SFX_CONFIRM);
        g.waiting = WAITING_RUN;
      }
      break;
    case WAITING_CHOICE: {
      s8 out;
      choice_update();
      if (choice_done(&out)) {
        g.last_choice = out;
        push(out);
        g.waiting = WAITING_RUN;
      }
      break;
    }
    case WAITING_CONTROL:
      service_control();
      break;
    case WAITING_MASH:
      if (key_pressed(KEY_A)) {
        g.vars[g.mash_var]++;
        sfx_play(C_SFX_STAR);
      }
      if (g.vars[g.mash_var] >= (s16)g.mash_target) g.waiting = WAITING_RUN;
      break;
    default:
      break;
  }
}

/* wait for all tweens */
static u8 tweens_running(void) {
  return g.tween_mask != 0;
}

void vm_tick(void) {
  int budget = 64;

  if (g.waiting == WAITING_FILM_DONE) return;
  if (g.waiting != WAITING_RUN) {
    service();
    if (g.waiting != WAITING_RUN) return;
  }

  while (budget-- > 0) {
    u8 op = rd8();
    switch (op) {
      case OP_END:
        if (g.in_sub) {
          /* NPC/trigger cue done: resume the roam the player never left */
          g.in_sub = 0;
          g.ip = g.ret_ip;
          g.waiting = WAITING_WORLD;
          return;
        }
        if (g.scene + 1 < film.n_scenes) {
          g.pending_scene = (u8)(g.scene + 1);
        } else {
          g.film_done = 1;
          g.waiting = WAITING_FILM_DONE;
        }
        return;
      case OP_WAIT:
        g.wait_frames = rd16();
        g.waiting = WAITING_BUSY;
        return;
      case OP_WAITA:
        g.waiting = WAITING_A;
        return;
      case OP_WAIT_TWEENS:
        if (tweens_running()) {
          g.ip--; /* re-run this op next frame */
          return;
        }
        break;
      case OP_FADE: {
        u8 mode = rd8();
        u16 T = rd16();
        g.fade_mode = mode;
        tween_start(TW_BLDY, (mode == C_FADE_IN_BLACK || mode == C_FADE_IN_WHITE) ? 0 : 16, T,
                    C_EASE_LINEAR);
        g.wait_frames = T;
        g.waiting = WAITING_BUSY;
        return;
      }
      case OP_CAPTION: {
        u8 style = rd8();
        u16 id = rd16();
        caption_show(style, id);
        g.waiting = WAITING_BUSY;
        g.wait_frames = 0;
        return;
      }
      case OP_CAPTION_CLR:
        caption_clear(rd8());
        break;
      case OP_DIALOG: {
        u16 sp = rd16();
        u16 body = rd16();
        caption_dialog(sp, body);
        g.waiting = WAITING_DIALOG;
        return;
      }
      case OP_CHOICE: {
        u8 n = rd8();
        int i;
        for (i = 0; i < n; i++) g.choice_ids[i] = rd16();
        choice_show(n, g.choice_ids);
        g.waiting = WAITING_CHOICE;
        return;
      }
      case OP_TWEEN: {
        u8 target = rd8();
        u8 ease = rd8();
        s16 to = rds16();
        u16 T = rd16();
        tween_start(target, to, T, ease);
        break;
      }
      case OP_SPRITE_SHOW: {
        u8 slot = rd8();
        u8 proto = rd8();
        s16 x = rds16();
        s16 y = rds16();
        u8 flags = rd8();
        Spr *s = &g.spr[slot];
        s->active = 1;
        s->proto = proto;
        s->x = x;
        s->y = y;
        s->flags = flags;
        s->mode = 0;
        s->frame = 0;
        s->timer = 0;
        s->fps = g.sc->protos[proto].fps;
        s->affine = 0;
        break;
      }
      case OP_SPRITE_HIDE:
        g.spr[rd8()].active = 0;
        break;
      case OP_SPRITE_ANIM: {
        u8 slot = rd8();
        u8 mode = rd8();
        u8 arg = rd8();
        Spr *s = &g.spr[slot];
        s->mode = mode;
        if (mode == 0) s->frame = arg;
        else if (arg) s->fps = arg;
        break;
      }
      case OP_SPRITE_MOVE: {
        u8 slot = rd8();
        u8 ease = rd8();
        s16 x = rds16();
        s16 y = rds16();
        u16 T = rd16();
        tween_start((u8)(C_TW_SPRITE_BASE + slot * 2), x, T, ease);
        tween_start((u8)(C_TW_SPRITE_BASE + slot * 2 + 1), y, T, ease);
        break;
      }
      case OP_CONTROL:
        g.ctl_slot = rd8();
        g.ctl_exit = rds16();
        g.ctl_speed_q4 = rd8();
        g.waiting = WAITING_CONTROL;
        return;
      case OP_MASH:
        g.mash_var = rd8();
        g.mash_target = rd16();
        g.waiting = WAITING_MASH;
        return;
      case OP_GOTO_SCENE:
        g.pending_scene = rd8();
        return;
      case OP_RASTER: {
        u8 mode = rd8();
        u8 amp = rd8();
        g.raster_mode = mode;
        if (mode == C_RASTER_WAVE_MAIN || mode == C_RASTER_WAVE_FAR) g.fx[TW_WAVE_AMP] = amp;
        break;
      }
      case OP_SFX:
        sfx_play(rd8());
        break;
      case OP_COUNTER: {
        u8 var = rd8();
        u8 show = rd8();
        s16 x = rds16();
        s16 y = rds16();
        g.counter_var = var;
        g.counter_show = show;
        g.counter_x = x;
        g.counter_y = y;
        g.counter_prev = g.vars[var];
        break;
      }
      case OP_AFFINE: {
        u8 slot = rd8();
        g.spr[slot].affine = rd8();
        break;
      }
      case OP_LETTERBOX: {
        u8 px = rd8();
        u16 T = rd16();
        tween_start(TW_LETTERBOX, px, T, C_EASE_INOUT);
        break;
      }
      case OP_WORLD:
        world_enter();
        return;
      case OP_BREAKOUT: {
        u8 rows = rd8();
        u8 lives = rd8();
        u16 budget = rd16();
        breakout_start(rows, lives, budget);
        return;
      }
      case OP_METER: {
        u8 id = (u8)(rd8() & 1);
        u8 var = rd8();
        s16 x = rds16();
        s16 y = rds16();
        u8 max = rd8();
        u8 show = rd8();
        g.meter_var[id] = var;
        g.meter_x[id] = x;
        g.meter_y[id] = y;
        g.meter_max[id] = max ? max : 1;
        g.meter_on[id] = show;
        break;
      }
      case OP_WARP: {
        u8 cx = rd8();
        u8 cy = rd8();
        u8 dir = rd8();
        world_warp(cx, cy, dir);
        break;
      }
      case OP_FACE: {
        u8 slot = rd8();
        u8 dir = rd8();
        world_face(slot, dir);
        break;
      }
      case OP_WALK: {
        u8 slot = rd8();
        u8 cx = rd8();
        u8 cy = rd8();
        walk_start(slot, cx, cy);
        g.waiting = WAITING_BUSY;
        return;
      }
      case OP_PUSH:
        push(rds16());
        break;
      case OP_SET_VAR:
        g.vars[rd8()] = pop();
        break;
      case OP_GET_VAR:
        push(g.vars[rd8()]);
        break;
      case OP_ADD_VAR: {
        u8 v = rd8();
        g.vars[v] = (s16)(g.vars[v] + rds16());
        break;
      }
      case OP_SET_FLAG:
        FLAG_SET(rd8());
        break;
      case OP_CLR_FLAG:
        FLAG_CLR(rd8());
        break;
      case OP_GET_FLAG:
        push((s16)FLAG_GET(rd8()));
        break;
      case OP_CMP: {
        u8 k = rd8();
        s16 b = pop();
        s16 a = pop();
        s16 r = 0;
        switch (k) {
          case C_CMP_EQ: r = a == b; break;
          case C_CMP_NE: r = a != b; break;
          case C_CMP_LT: r = a < b; break;
          case C_CMP_GT: r = a > b; break;
          case C_CMP_LE: r = a <= b; break;
          case C_CMP_GE: r = a >= b; break;
        }
        push(r);
        break;
      }
      case OP_JZ: {
        u16 to = rd16();
        if (pop() == 0) g.ip = to;
        break;
      }
      case OP_JMP:
        g.ip = rd16();
        break;
      case OP_RND: {
        u8 n = rd8();
        push((s16)((g.rng >> 4) % n));
        break;
      }
      case OP_POP:
        pop();
        break;
      default:
        /* corrupt cue: halt scene */
        g.waiting = WAITING_FILM_DONE;
        return;
    }
  }
}
