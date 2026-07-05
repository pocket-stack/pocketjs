// aot/compiler/script.ts — Stage 4/5: compile script generator ASTs to bytecode
// (design §11.4-11.5). Static expressions fold; runtime values (flags, choices,
// battle results) residualize into branches over the stack VM.

import ts from "typescript";
import { OP } from "../spec/pjgb.ts";
import { textCells, wrapPages } from "./text.ts";
import type { Ctx } from "./context.ts";
import type { ScriptSite } from "./evaluate.ts";

const FACE_SELF = 0xff; // FACE_PLAYER operand meaning "the actor that started me"

export type TextMode = "ascii8" | "cjk16";

class ScriptError extends Error {
  constructor(node: ts.Node, sf: ts.SourceFile, msg: string) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    super(`PJGB script error at ${sf.fileName}:${line + 1}:${character + 1}: ${msg}\n  ${node.getText(sf).slice(0, 80)}`);
  }
}

// Op wrappers that leave a value on the VM stack.
const VALUE_OPS = new Set([
  "hasFlag",
  "choose",
  "battle",
  "getVar",
  "varEq",
  "varGt",
  "varLt",
  "varGe",
  "varLe",
  "rnd",
]);

class Emitter {
  code: number[] = [];
  /** Open while-loops: each entry collects break-JUMP operand offsets. */
  private loopBreaks: number[][] = [];
  constructor(
    private ctx: Ctx,
    private sf: ts.SourceFile,
    private mode: TextMode,
  ) {}

  private u8(v: number): void {
    this.code.push(v & 0xff);
  }
  private u16(v: number): void {
    this.code.push(v & 0xff, (v >> 8) & 0xff);
  }
  private i16(v: number): void {
    this.u16(v & 0xffff);
  }
  /** Emit op+placeholder rel16; returns operand index to patch. */
  private emitJump(op: number): number {
    this.u8(op);
    const at = this.code.length;
    this.i16(0);
    return at;
  }
  private patch(at: number): void {
    this.patchTo(at, this.code.length);
  }
  /** Patch a rel16 operand at `at` to jump to absolute code offset `target`. */
  private patchTo(at: number, target: number): void {
    const rel = target - (at + 2); // rel is measured from AFTER the 2-byte operand
    this.code[at] = rel & 0xff;
    this.code[at + 1] = (rel >> 8) & 0xff;
  }

  // --- static evaluation ---------------------------------------------------
  private staticVal(node: ts.Expression): unknown {
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return this.staticVal(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken)
      return -(this.staticVal(node.operand) as number);
    if (ts.isArrayLiteralExpression(node)) return node.elements.map((e) => this.staticVal(e));
    throw new ScriptError(node, this.sf, "expected a compile-time constant here");
  }

  private opCall(node: ts.Expression): { name: string; args: unknown[]; call: ts.CallExpression } {
    let e = node;
    if (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) {
      throw new ScriptError(node, this.sf, "yield must call a @pocketjs/aot op (say, choose, hasFlag, ...)");
    }
    return { name: e.expression.text, args: e.arguments.map((a) => this.staticVal(a)), call: e };
  }

  /** say(): one OP_TEXT per compile-time page (cjk16 wraps; ascii8 is 1:1). */
  private emitSay(text: string): void {
    const pages = this.mode === "cjk16" ? wrapPages(text, this.ctx.target) : [text];
    for (const page of pages) {
      this.u8(OP.TEXT);
      this.u16(this.ctx.internText(page));
    }
  }

  /** Emit an op call. Returns true if it leaves a value on the stack. */
  emitOp(name: string, args: unknown[], node: ts.Node): boolean {
    switch (name) {
      case "say":
        this.emitSay(String(args[0]));
        return false;
      case "lockPlayer":
        this.u8(OP.LOCK_PLAYER);
        return false;
      case "releasePlayer":
        this.u8(OP.RELEASE_PLAYER);
        return false;
      case "facePlayer":
        this.u8(OP.FACE_PLAYER);
        this.u8(FACE_SELF);
        return false;
      case "setFlag":
        this.u8(OP.SET_FLAG);
        this.u16(this.ctx.flagId(String(args[0])));
        return false;
      case "clearFlag":
        this.u8(OP.CLEAR_FLAG);
        this.u16(this.ctx.flagId(String(args[0])));
        return false;
      case "hasFlag":
        this.u8(OP.PUSH_FLAG);
        this.u16(this.ctx.flagId(String(args[0])));
        return true;
      case "giveItem":
        this.u8(OP.GIVE_ITEM);
        this.u16(this.ctx.items.intern(String(args[0])));
        this.u8(Number(args[1] ?? 1));
        return false;
      case "battle":
        this.u8(OP.BATTLE);
        this.u16(this.ctx.battles.intern(String(args[0])));
        return true;
      case "wait":
        this.u8(OP.WAIT);
        this.u16(Number(args[0]));
        return false;
      case "setVar":
        this.u8(OP.SET_VAR);
        this.u16(this.ctx.varIdOf(String(args[0])));
        this.i16(Number(args[1]));
        return false;
      case "addVar":
        this.u8(OP.ADD_VAR);
        this.u16(this.ctx.varIdOf(String(args[0])));
        this.i16(Number(args[1]));
        return false;
      case "getVar":
        this.u8(OP.PUSH_VAR);
        this.u16(this.ctx.varIdOf(String(args[0])));
        return true;
      case "varEq":
      case "varGt":
      case "varLt":
      case "varGe":
      case "varLe": {
        this.u8(OP.PUSH_VAR);
        this.u16(this.ctx.varIdOf(String(args[0])));
        this.u8(OP.PUSH_CONST);
        this.i16(Number(args[1]));
        const cmp = { varEq: OP.EQ, varGt: OP.GT, varLt: OP.LT, varGe: OP.GE, varLe: OP.LE }[name];
        this.u8(cmp);
        return true;
      }
      case "rnd": {
        const n = Number(args[0]);
        if (!(n >= 1 && n <= 255)) throw new ScriptError(node, this.sf, `rnd(n) needs 1..255 (got ${n})`);
        this.u8(OP.RND);
        this.u8(n);
        return true;
      }
      case "warpTo": {
        const dest = String(args[0]);
        if (!dest.includes(":")) throw new ScriptError(node, this.sf, `warpTo needs "map:entrance" (got "${dest}")`);
        this.u8(OP.WARP);
        // Operands are patched after buildModel resolves map indices/entrances.
        this.ctx.warpFixups.push({ scriptId: -1, at: this.code.length, dest });
        this.u8(0); // map
        this.u16(0); // x
        this.u16(0); // y
        this.u8(0); // dir
        return false;
      }
      case "playSfx":
        this.u8(OP.PLAY_SFX);
        this.u16(0);
        return false;
      default:
        throw new ScriptError(node, this.sf, `unsupported script op "${name}"`);
    }
  }

  private emitChoice(options: string[], node: ts.Node): void {
    // ascii8: the GBA textbox renders up to 7 rows. cjk16: options are 16px
    // lines; every target fits maxChoices of them (spec TARGETS).
    const max = this.mode === "cjk16" ? this.ctx.target.maxChoices : 7;
    if (options.length < 1 || options.length > max) {
      throw new ScriptError(node, this.sf, `choose() needs 1..${max} options (got ${options.length})`);
    }
    if (this.mode === "cjk16") {
      for (const o of options) {
        if (o.includes("\n")) throw new ScriptError(node, this.sf, `choice option must be one line ("${o}")`);
        const cells = textCells(o);
        if (cells > this.ctx.target.choiceCols - 2) {
          throw new ScriptError(node, this.sf, `choice option too wide for ${this.ctx.target.name} (${cells} > ${this.ctx.target.choiceCols - 2} cells): "${o}"`);
        }
      }
    }
    this.u8(OP.CHOICE);
    this.u8(options.length);
    for (const o of options) this.u16(this.ctx.internText(o));
  }

  // --- statements ----------------------------------------------------------
  compileBlock(stmts: readonly ts.Statement[]): void {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      // pattern: const X = yield choose([...]); switch (X) { ... }
      const choice = this.matchChoiceDecl(s);
      if (choice) {
        const next = stmts[i + 1];
        if (!next || !ts.isSwitchStatement(next) || !this.isRef(next.expression, choice.name)) {
          throw new ScriptError(s, this.sf, "`const x = yield choose(...)` must be immediately followed by `switch (x)`");
        }
        this.emitChoice(choice.options, s);
        this.compileChoiceSwitch(next, choice.options);
        i++; // consume the switch
        continue;
      }
      this.compileStatement(s);
    }
  }

  private compileStatement(s: ts.Statement): void {
    if (ts.isExpressionStatement(s) && ts.isYieldExpression(s.expression)) {
      const y = s.expression.expression!;
      const { name, args, call } = this.opCall(y);
      const produced = this.emitOp(name, args, call);
      if (produced) this.u8(OP.POP);
      return;
    }
    if (ts.isIfStatement(s)) return this.compileIf(s);
    if (ts.isWhileStatement(s)) return this.compileWhile(s);
    if (ts.isBreakStatement(s)) {
      // NOTE: inside a choose+switch clause, top-level `break` exits the
      // switch (handled by compileChoiceSwitch); this path is for breaks in
      // while-loop bodies (e.g. `if (yield varLe(...)) break;`).
      const loop = this.loopBreaks[this.loopBreaks.length - 1];
      if (!loop) throw new ScriptError(s, this.sf, "break outside a while loop");
      loop.push(this.emitJump(OP.JUMP));
      return;
    }
    if (ts.isReturnStatement(s)) {
      if (s.expression) throw new ScriptError(s, this.sf, "scripts cannot return a value; use plain `return;`");
      this.u8(OP.END);
      return;
    }
    if (ts.isBlock(s)) return this.compileBlock(s.statements);
    if (s.kind === ts.SyntaxKind.EmptyStatement) return;
    throw new ScriptError(s, this.sf, "unsupported statement in a script (yield-ops, if/else, while, choose+switch)");
  }

  // while (yield <predicate>) { ... } — loops over a runtime value.
  private compileWhile(s: ts.WhileStatement): void {
    const loopStart = this.code.length;
    this.emitCondition(s.expression);
    const toEnd = this.emitJump(OP.JUMP_IF_FALSE);
    this.loopBreaks.push([]);
    this.compileStatement(s.statement);
    const back = this.emitJump(OP.JUMP);
    this.patchTo(back, loopStart);
    this.patch(toEnd);
    for (const b of this.loopBreaks.pop()!) this.patch(b);
  }

  /**
   * Emit a testable condition: `yield <valueop>` optionally wrapped in any
   * number of `!` negations / parens. Leaves 0/1 on the VM stack.
   */
  private emitCondition(expr: ts.Expression): void {
    let e = expr;
    let negs = 0;
    for (;;) {
      if (ts.isParenthesizedExpression(e)) {
        e = e.expression;
      } else if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
        negs++;
        e = e.operand;
      } else {
        break;
      }
    }
    if (!ts.isYieldExpression(e)) {
      throw new ScriptError(expr, this.sf, "condition must be `yield <predicate>` (e.g. yield hasFlag(...)), optionally negated with !");
    }
    const { name, args, call } = this.opCall(e.expression!);
    if (!VALUE_OPS.has(name)) throw new ScriptError(call, this.sf, `"${name}" does not yield a testable value`);
    this.emitOp(name, args, call); // leaves value
    for (let i = 0; i < negs; i++) this.u8(OP.NOT);
  }

  private compileIf(s: ts.IfStatement): void {
    this.emitCondition(s.expression);
    const toElse = this.emitJump(OP.JUMP_IF_FALSE);
    this.compileStatement(s.thenStatement);
    if (s.elseStatement) {
      const toEnd = this.emitJump(OP.JUMP);
      this.patch(toElse);
      this.compileStatement(s.elseStatement);
      this.patch(toEnd);
    } else {
      this.patch(toElse);
    }
  }

  // Switch over a choice index (value already on stack); consumes it.
  //
  // Proper switch lowering so `default` may appear anywhere and empty
  // fall-through case labels share the next clause's body (JS semantics):
  //   dispatch: for each case  DUP; PUSH idx; NE; JUMP_IF_FALSE bodyN  (jump if ==)
  //             default -> JUMP bodyDefault ;  else -> JUMP end
  //   bodies:   clause statements in source order (break -> JUMP end;
  //             no break -> falls into the next clause's body)
  //   end:      POP (drop the choice index)
  private compileChoiceSwitch(sw: ts.SwitchStatement, options: string[]): void {
    const clauses = sw.caseBlock.clauses;
    const caseJumps = new globalThis.Map<number, number>(); // clauseIndex -> JUMP_IF_FALSE operand
    let defaultIndex = -1;

    // Dispatch: test every CASE (default is skipped here — it is the fallthrough).
    clauses.forEach((clause, i) => {
      if (ts.isDefaultClause(clause)) {
        if (defaultIndex >= 0) throw new ScriptError(clause, this.sf, "duplicate default clause");
        defaultIndex = i;
        return;
      }
      // Case labels may be option strings or option indices (0-based).
      const label = this.staticVal(clause.expression);
      const idx = typeof label === "number" ? label : options.indexOf(String(label));
      if (idx < 0 || idx >= options.length) throw new ScriptError(clause, this.sf, `case is not one of the choose() options`);
      this.u8(OP.DUP);
      this.u8(OP.PUSH_CONST);
      this.i16(idx);
      this.u8(OP.NE);
      caseJumps.set(i, this.emitJump(OP.JUMP_IF_FALSE)); // NE==0 (equal) -> jump to this body
    });
    // No case matched -> default body if present, else end.
    const fallJump = this.emitJump(OP.JUMP);

    // Bodies in source order; a clause without `break` falls into the next.
    const endJumps: number[] = [];
    clauses.forEach((clause, i) => {
      const bodyOffset = this.code.length;
      const cj = caseJumps.get(i);
      if (cj !== undefined) this.patchTo(cj, bodyOffset);
      if (i === defaultIndex) this.patchTo(fallJump, bodyOffset);
      for (const st of clause.statements) {
        if (ts.isBreakStatement(st)) {
          endJumps.push(this.emitJump(OP.JUMP));
          break;
        }
        this.compileStatement(st);
      }
    });

    const end = this.code.length;
    if (defaultIndex < 0) this.patchTo(fallJump, end); // no default -> fall through to end
    for (const e of endJumps) this.patchTo(e, end);
    this.u8(OP.POP); // drop the choice index
  }

  // --- pattern helpers -----------------------------------------------------
  private matchChoiceDecl(s: ts.Statement): { name: string; options: string[] } | null {
    if (!ts.isVariableStatement(s)) return null;
    const d = s.declarationList.declarations[0];
    if (!d || !d.initializer || !ts.isIdentifier(d.name)) return null;
    if (!ts.isYieldExpression(d.initializer)) return null;
    const inner = d.initializer.expression;
    if (!inner) return null;
    let call = inner;
    if (ts.isAsExpression(call) || ts.isParenthesizedExpression(call)) call = call.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "choose") return null;
    const arr = this.staticVal(call.arguments[0]) as unknown[];
    return { name: d.name.text, options: arr.map(String) };
  }

  private isRef(e: ts.Expression, name: string): boolean {
    return ts.isIdentifier(e) && e.text === name;
  }
}

export function compileScript(site: ScriptSite, ctx: Ctx, mode: TextMode): number[] {
  const em = new Emitter(ctx, site.file, mode);
  const body = site.body.body;
  if (!body || !ts.isBlock(body)) {
    throw new Error(`script #${site.id}: expected a block body`);
  }
  const fixupStart = ctx.warpFixups.length;
  em.compileBlock(body.statements);
  em.code.push(OP.END);
  // Attribute this script's warpTo fixups to its (about-to-be-assigned) id.
  for (let i = fixupStart; i < ctx.warpFixups.length; i++) ctx.warpFixups[i].scriptId = site.id;
  return em.code;
}
