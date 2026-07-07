// saga/compiler/residualize.ts — lower cue generator ASTs to cue-VM bytecode.
//
// Recognized statement forms (anything else is a compile error, on purpose —
// residual code is a DSL, not JavaScript):
//   yield op(...);                       op from the vocabulary table below
//   const x = yield choice([...]);       result var (also hasFlag/rnd/var*)
//   if (cond) {...} else {...}           cond: x === n | x < n | yield hasFlag()
//                                        | yield varXx() | !cond | (cond)
//   while (cond) {...}   break;  return;
//   setVar/addVar/setFlag/clrFlag via yield like any op.

import ts from "typescript";
import {
  OP, TW, ByteWriter, CMP_EQ, CMP_NE, CMP_LT, CMP_GT, CMP_LE, CMP_GE,
  FADE_IN_BLACK, FADE_OUT_BLACK, FADE_IN_WHITE, FADE_OUT_WHITE,
  RASTER_OFF, RASTER_GRADIENT, RASTER_WAVE_MAIN, RASTER_WAVE_FAR,
  CAP_CHIP, CAP_SUB, CAP_CARD,
  EASE_LINEAR, EASE_IN, EASE_OUT, EASE_INOUT,
  SFX_BLIP, SFX_CONFIRM, SFX_WHOOSH, SFX_STAR,
  SPR_HFLIP, SPR_SCREEN, SPR_BEHIND, SPR_GHOST,
  TW_SPRITE_BASE, N_VARS, N_FLAGS, MAX_CHOICES,
  DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT, BRICK_ROWS_MAX,
} from "../spec/saga.ts";
import type { TextBank } from "./text.ts";
import type { ActorDecl } from "../dsl/index.ts";

export interface CueCtx {
  texts: TextBank;
  vars: Map<string, number>;
  flags: Map<string, number>;
  sceneIndex: Map<string, number>;
  /** current scene's actors: name -> { slot, proto, decl } */
  actors: Map<string, { slot: number; proto: number; decl: ActorDecl }>;
  cueName: string;
}

const EASES: Record<string, number> = { linear: EASE_LINEAR, in: EASE_IN, out: EASE_OUT, inout: EASE_INOUT };
const SFXS: Record<string, number> = { blip: SFX_BLIP, confirm: SFX_CONFIRM, whoosh: SFX_WHOOSH, star: SFX_STAR };
const CAPS: Record<string, number> = { chip: CAP_CHIP, sub: CAP_SUB, card: CAP_CARD };
const DIRS: Record<string, number> = { down: DIR_DOWN, up: DIR_UP, left: DIR_LEFT, right: DIR_RIGHT };

/** `base` = this cue's offset in the scene's concatenated cue blob. All jump
 * targets are blob-absolute at runtime, so every emitted/patched target must
 * add it (a sub-cue's `if` would otherwise jump into the play cue). */
export function residualizeCue(
  body: ts.FunctionExpression | ts.ArrowFunction,
  ctx: CueCtx,
  base = 0,
): Uint8Array {
  const w = new ByteWriter();
  const endJumps: number[] = [];
  const breakStack: number[][] = [];

  const err = (n: ts.Node, msg: string): never => {
    const sf = n.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
    throw new Error(`[${ctx.cueName}] ${msg} (line ${line + 1}): ${n.getText().slice(0, 80)}`);
  };

  const internVar = (name: string): number => {
    let id = ctx.vars.get(name);
    if (id === undefined) {
      id = ctx.vars.size;
      if (id >= N_VARS) throw new Error(`too many vars (max ${N_VARS}): ${name}`);
      ctx.vars.set(name, id);
    }
    return id;
  };
  const internFlag = (name: string): number => {
    let id = ctx.flags.get(name);
    if (id === undefined) {
      id = ctx.flags.size;
      if (id >= N_FLAGS) throw new Error(`too many flags (max ${N_FLAGS}): ${name}`);
      ctx.flags.set(name, id);
    }
    return id;
  };

  const num = (n: ts.Expression): number => {
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand))
      return -Number(n.operand.text);
    return err(n, "expected a numeric literal");
  };
  const str = (n: ts.Expression): string => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    return err(n, "expected a string literal");
  };
  const actor = (n: ts.Expression): { slot: number; proto: number; decl: ActorDecl } => {
    const name = str(n);
    const a = ctx.actors.get(name);
    if (!a) return err(n, `unknown actor "${name}" in this scene`);
    return a;
  };

  const asCall = (e: ts.Expression): { name: string; args: readonly ts.Expression[] } | null => {
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return { name: e.expression.text, args: e.arguments };
    return null;
  };

  /** value-producing yields usable in conditions / assignments (push result) */
  const emitValueYield = (call: { name: string; args: readonly ts.Expression[] }, n: ts.Node): void => {
    switch (call.name) {
      case "choice": {
        const arr = call.args[0];
        if (!arr || !ts.isArrayLiteralExpression(arr)) return err(n, "choice() takes an array literal");
        const ids = arr.elements.map((e) => ctx.texts.intern(str(e as ts.Expression), { cols: 22, maxLines: 1 }));
        if (ids.length < 2 || ids.length > MAX_CHOICES) return err(n, `choice() needs 2..${MAX_CHOICES} options`);
        w.u8(OP.CHOICE).u8(ids.length);
        for (const id of ids) w.u16(id);
        return;
      }
      case "hasFlag":
        w.u8(OP.GET_FLAG).u8(internFlag(str(call.args[0])));
        return;
      case "rnd":
        w.u8(OP.RND).u8(num(call.args[0]));
        return;
      case "varEq":
      case "varNe":
      case "varLt":
      case "varGt":
      case "varLe":
      case "varGe": {
        const kind = { varEq: CMP_EQ, varNe: CMP_NE, varLt: CMP_LT, varGt: CMP_GT, varLe: CMP_LE, varGe: CMP_GE }[
          call.name
        ]!;
        w.u8(OP.GET_VAR).u8(internVar(str(call.args[0])));
        w.u8(OP.PUSH).i16(num(call.args[1]));
        w.u8(OP.CMP).u8(kind);
        return;
      }
      case "world":
        w.u8(OP.WORLD);
        return;
      case "breakout": {
        const rows = num(call.args[0]);
        const lives = num(call.args[1]);
        const frames = call.args[2] ? num(call.args[2]) : 3600;
        if (rows < 1 || rows > BRICK_ROWS_MAX) return err(n, `breakout rows 1..${BRICK_ROWS_MAX}`);
        w.u8(OP.BREAKOUT).u8(rows).u8(lives).u16(frames);
        return;
      }
      default:
        return err(n, `${call.name}() does not produce a value here`);
    }
  };

  /** condition -> leaves 0/1-ish on stack */
  const emitCond = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) return emitCond(e.expression);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      emitCond(e.operand);
      w.u8(OP.PUSH).i16(0);
      w.u8(OP.CMP).u8(CMP_EQ);
      return;
    }
    if (ts.isYieldExpression(e) && e.expression) {
      const call = asCall(e.expression);
      if (!call) return err(e, "yield in condition must be a call");
      return emitValueYield(call, e);
    }
    if (ts.isBinaryExpression(e)) {
      const KINDS: Partial<Record<ts.SyntaxKind, number>> = {
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: CMP_EQ,
        [ts.SyntaxKind.EqualsEqualsToken]: CMP_EQ,
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: CMP_NE,
        [ts.SyntaxKind.ExclamationEqualsToken]: CMP_NE,
        [ts.SyntaxKind.LessThanToken]: CMP_LT,
        [ts.SyntaxKind.GreaterThanToken]: CMP_GT,
        [ts.SyntaxKind.LessThanEqualsToken]: CMP_LE,
        [ts.SyntaxKind.GreaterThanEqualsToken]: CMP_GE,
      };
      const kind = KINDS[e.operatorToken.kind];
      if (kind === undefined) return err(e, "unsupported comparison");
      if (!ts.isIdentifier(e.left)) return err(e, "left side must be a result variable");
      w.u8(OP.GET_VAR).u8(internVar(localName(e.left.text)));
      w.u8(OP.PUSH).i16(num(e.right));
      w.u8(OP.CMP).u8(kind);
      return;
    }
    if (ts.isIdentifier(e)) {
      w.u8(OP.GET_VAR).u8(internVar(localName(e.text)));
      return;
    }
    return err(e, "unsupported condition");
  };

  const localName = (name: string): string => `${ctx.cueName}:${name}`;

  /** statement-position yield op table */
  const emitOp = (call: { name: string; args: readonly ts.Expression[] }, n: ts.Node): void => {
    const a = call.args;
    const easeArg = (i: number, dflt: number): number => {
      if (!a[i]) return dflt;
      const e = EASES[str(a[i])];
      if (e === undefined) return err(n, `unknown ease ${a[i].getText()}`);
      return e;
    };
    switch (call.name) {
      case "fadeIn":
      case "fadeOut": {
        const frames = a[0] ? num(a[0]) : 30;
        const white = a[1] ? str(a[1]) === "white" : false;
        const mode = call.name === "fadeIn" ? (white ? FADE_IN_WHITE : FADE_IN_BLACK) : white ? FADE_OUT_WHITE : FADE_OUT_BLACK;
        w.u8(OP.FADE).u8(mode).u16(frames);
        return;
      }
      case "wait":
        w.u8(OP.WAIT).u16(num(a[0]));
        return;
      case "waitA":
        w.u8(OP.WAITA);
        return;
      case "waitTweens":
        w.u8(OP.WAIT_TWEENS);
        return;
      case "caption": {
        const style = CAPS[str(a[0])];
        if (style === undefined) return err(n, "caption style must be chip|sub|card");
        const opts = style === CAP_CHIP ? { cols: 24, maxLines: 1 } : {};
        w.u8(OP.CAPTION).u8(style).u16(ctx.texts.intern(str(a[1]), opts));
        return;
      }
      case "captionClear": {
        const s = a[0] ? str(a[0]) : "all";
        w.u8(OP.CAPTION_CLR).u8(s === "all" ? 0xff : (CAPS[s] ?? 0xff));
        return;
      }
      case "dialog":
        w.u8(OP.DIALOG)
          .u16(ctx.texts.intern(str(a[0]), { cols: 12, maxLines: 1 }))
          .u16(ctx.texts.intern(str(a[1])));
        return;
      case "pan":
        w.u8(OP.TWEEN).u8(TW.CAM_X).u8(easeArg(2, EASE_INOUT)).i16(num(a[0])).u16(num(a[1]));
        return;
      case "panY":
        w.u8(OP.TWEEN).u8(TW.CAM_Y).u8(easeArg(2, EASE_INOUT)).i16(num(a[0])).u16(num(a[1]));
        return;
      case "alpha":
        w.u8(OP.TWEEN).u8(TW.EVA).u8(EASE_LINEAR).i16(num(a[0])).u16(num(a[2]));
        w.u8(OP.TWEEN).u8(TW.EVB).u8(EASE_LINEAR).i16(num(a[1])).u16(num(a[2]));
        return;
      case "mosaicTo":
        w.u8(OP.TWEEN).u8(TW.MOSAIC).u8(EASE_LINEAR).i16(num(a[0])).u16(num(a[1]));
        return;
      case "shake":
        w.u8(OP.TWEEN).u8(TW.SHAKE).u8(EASE_LINEAR).i16(num(a[0])).u16(0);
        w.u8(OP.TWEEN).u8(TW.SHAKE).u8(EASE_OUT).i16(0).u16(num(a[1]));
        return;
      case "autoScroll": {
        const t = str(a[0]) === "far" ? TW.FAR_VX : TW.SKY_VX;
        w.u8(OP.TWEEN).u8(t).u8(EASE_LINEAR).i16(Math.round(numF(a[1]) * 256)).u16(a[2] ? num(a[2]) : 0);
        return;
      }
      case "zoom":
        w.u8(OP.TWEEN).u8(TW.OBJ_SCALE).u8(easeArg(2, EASE_INOUT)).i16(Math.round(numF(a[0]) * 256)).u16(num(a[1]));
        return;
      case "spinTo":
        w.u8(OP.TWEEN).u8(TW.OBJ_ANGLE).u8(easeArg(2, EASE_LINEAR)).i16(Math.round((num(a[0]) / 360) * 256)).u16(num(a[1]));
        return;
      case "letterbox":
        w.u8(OP.LETTERBOX).u8(num(a[0])).u16(a[1] ? num(a[1]) : 20);
        return;
      case "rasterWave":
        w.u8(OP.RASTER).u8(str(a[0]) === "far" ? RASTER_WAVE_FAR : RASTER_WAVE_MAIN).u8(num(a[1]));
        return;
      case "rasterGradient":
        w.u8(OP.RASTER).u8(RASTER_GRADIENT).u8(0);
        return;
      case "rasterOff":
        w.u8(OP.RASTER).u8(RASTER_OFF).u8(0);
        return;
      case "show": {
        const ac = actor(a[0]);
        const x = a[1] ? num(a[1]) : (ac.decl.at?.[0] ?? 0);
        const y = a[2] ? num(a[2]) : (ac.decl.at?.[1] ?? 0);
        let flags = 0;
        if (ac.decl.flip) flags |= SPR_HFLIP;
        if (ac.decl.screen) flags |= SPR_SCREEN;
        if (ac.decl.behind) flags |= SPR_BEHIND;
        if (ac.decl.ghost) flags |= SPR_GHOST;
        if (a[3] && ts.isObjectLiteralExpression(a[3])) {
          for (const p of a[3].properties) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "flip") {
              if (p.initializer.kind === ts.SyntaxKind.TrueKeyword) flags |= SPR_HFLIP;
              else flags &= ~SPR_HFLIP;
            }
          }
        }
        w.u8(OP.SPRITE_SHOW).u8(ac.slot).u8(ac.proto).i16(x).i16(y).u8(flags);
        return;
      }
      case "hide":
        w.u8(OP.SPRITE_HIDE).u8(actor(a[0]).slot);
        return;
      case "animate": {
        const ac = actor(a[0]);
        const mode = ts.isStringLiteral(a[1]) ? 1 : 0;
        const arg = mode === 1 ? (a[2] ? num(a[2]) : 0) : num(a[1]);
        w.u8(OP.SPRITE_ANIM).u8(ac.slot).u8(mode).u8(arg);
        return;
      }
      case "moveTo": {
        const ac = actor(a[0]);
        w.u8(OP.SPRITE_MOVE).u8(ac.slot).u8(easeArg(3 + 1, EASE_INOUT)).i16(num(a[1])).i16(num(a[2])).u16(num(a[3]));
        return;
      }
      case "walkTo": {
        const ac = actor(a[0]);
        w.u8(OP.SPRITE_ANIM).u8(ac.slot).u8(1).u8(0);
        w.u8(OP.TWEEN).u8(TW_SPRITE_BASE + ac.slot * 2).u8(EASE_LINEAR).i16(num(a[1])).u16(num(a[2]));
        w.u8(OP.WAIT_TWEENS);
        w.u8(OP.SPRITE_ANIM).u8(ac.slot).u8(0).u8(0);
        return;
      }
      case "control": {
        const ac = actor(a[0]);
        const speed = a[2] ? numF(a[2]) : 1.5;
        w.u8(OP.CONTROL).u8(ac.slot).i16(num(a[1])).u8(Math.max(1, Math.round(speed * 16)));
        return;
      }
      case "mash":
        w.u8(OP.MASH).u8(internVar(str(a[0]))).u16(num(a[1]));
        return;
      case "counter":
        w.u8(OP.COUNTER).u8(internVar(str(a[0]))).u8(1).i16(num(a[1])).i16(num(a[2]));
        return;
      case "counterHide":
        w.u8(OP.COUNTER).u8(0).u8(0).i16(0).i16(0);
        return;
      case "affineOn":
        w.u8(OP.AFFINE).u8(actor(a[0]).slot).u8(1);
        return;
      case "affineOff":
        w.u8(OP.AFFINE).u8(actor(a[0]).slot).u8(0);
        return;
      case "sfx": {
        const id = SFXS[str(a[0])];
        if (id === undefined) return err(n, "unknown sfx");
        w.u8(OP.SFX).u8(id);
        return;
      }
      case "gotoScene": {
        const idx = ctx.sceneIndex.get(str(a[0]));
        if (idx === undefined) return err(n, `unknown scene "${str(a[0])}"`);
        w.u8(OP.GOTO_SCENE).u8(idx);
        return;
      }
      case "world":
      case "breakout":
        // statement position: run it, discard the pushed result
        emitValueYield(call, n);
        w.u8(OP.POP);
        return;
      case "meterShow":
        w.u8(OP.METER)
          .u8(num(a[0]))
          .u8(internVar(str(a[1])))
          .i16(num(a[2]))
          .i16(num(a[3]))
          .u8(num(a[4]))
          .u8(1);
        return;
      case "meterHide":
        w.u8(OP.METER).u8(num(a[0])).u8(0).i16(0).i16(0).u8(1).u8(0);
        return;
      case "warp": {
        const dir = a[2] ? DIRS[str(a[2])] : DIR_DOWN;
        if (dir === undefined) return err(n, "warp dir must be down|up|left|right");
        w.u8(OP.WARP).u8(num(a[0])).u8(num(a[1])).u8(dir);
        return;
      }
      case "face": {
        const dir = DIRS[str(a[1])];
        if (dir === undefined) return err(n, "face dir must be down|up|left|right");
        w.u8(OP.FACE).u8(actor(a[0]).slot).u8(dir);
        return;
      }
      case "walk":
        w.u8(OP.WALK).u8(actor(a[0]).slot).u8(num(a[1])).u8(num(a[2]));
        return;
      case "setFlag":
        w.u8(OP.SET_FLAG).u8(internFlag(str(a[0])));
        return;
      case "clrFlag":
        w.u8(OP.CLR_FLAG).u8(internFlag(str(a[0])));
        return;
      case "setVar":
        if (ts.isIdentifier(a[1])) w.u8(OP.GET_VAR).u8(internVar(localName(a[1].text)));
        else w.u8(OP.PUSH).i16(num(a[1]));
        w.u8(OP.SET_VAR).u8(internVar(str(a[0])));
        return;
      case "addVar":
        w.u8(OP.ADD_VAR).u8(internVar(str(a[0]))).i16(num(a[1]));
        return;
      default:
        return err(n, `unknown cue op ${call.name}()`);
    }
  };

  const numF = (e: ts.Expression): number => {
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand))
      return -Number(e.operand.text);
    return err(e, "expected a number");
  };

  const emitStmt = (s: ts.Statement): void => {
    if (ts.isExpressionStatement(s)) {
      const e = s.expression;
      if (ts.isYieldExpression(e) && e.expression) {
        const call = asCall(e.expression);
        if (!call) return void err(s, "yield must wrap a cue op call");
        emitOp(call, s);
        return;
      }
      return void err(s, "only `yield op(...)` expression statements are allowed");
    }
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!d.initializer || !ts.isYieldExpression(d.initializer) || !d.initializer.expression)
          return void err(s, "const x = yield <value-op>(...) is the only declaration form");
        const call = asCall(d.initializer.expression);
        if (!call) return void err(s, "expected a value-producing cue op");
        emitValueYield(call, s);
        if (!ts.isIdentifier(d.name)) return void err(s, "destructuring not supported");
        w.u8(OP.SET_VAR).u8(internVar(localName(d.name.text)));
      }
      return;
    }
    if (ts.isIfStatement(s)) {
      emitCond(s.expression);
      w.u8(OP.JZ);
      const jzAt = w.length;
      w.u16(0);
      emitBlock(s.thenStatement);
      if (s.elseStatement) {
        w.u8(OP.JMP);
        const jmpAt = w.length;
        w.u16(0);
        w.patchU16(jzAt, base + w.length);
        emitBlock(s.elseStatement);
        w.patchU16(jmpAt, base + w.length);
      } else {
        w.patchU16(jzAt, base + w.length);
      }
      return;
    }
    if (ts.isWhileStatement(s)) {
      const loopStart = w.length;
      emitCond(s.expression);
      w.u8(OP.JZ);
      const jzAt = w.length;
      w.u16(0);
      breakStack.push([]);
      emitBlock(s.statement);
      w.u8(OP.JMP).u16(base + loopStart);
      w.patchU16(jzAt, base + w.length);
      for (const b of breakStack.pop()!) w.patchU16(b, base + w.length);
      return;
    }
    if (ts.isBreakStatement(s)) {
      if (!breakStack.length) return void err(s, "break outside while");
      w.u8(OP.JMP);
      breakStack[breakStack.length - 1].push(w.length);
      w.u16(0);
      return;
    }
    if (ts.isReturnStatement(s)) {
      w.u8(OP.JMP);
      endJumps.push(w.length);
      w.u16(0);
      return;
    }
    if (ts.isBlock(s)) {
      for (const st of s.statements) emitStmt(st);
      return;
    }
    if (ts.isEmptyStatement(s)) return;
    return void err(s, `unsupported statement kind ${ts.SyntaxKind[s.kind]}`);
  };

  const emitBlock = (s: ts.Statement): void => {
    if (ts.isBlock(s)) for (const st of s.statements) emitStmt(st);
    else emitStmt(s);
  };

  if (!body.body || !ts.isBlock(body.body)) throw new Error(`[${ctx.cueName}] cue body must be a block`);
  for (const st of body.body.statements) emitStmt(st);

  for (const j of endJumps) w.patchU16(j, base + w.length);
  w.u8(OP.END);
  return w.toUint8Array();
}
