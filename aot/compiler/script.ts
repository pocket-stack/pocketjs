// aot/compiler/script.ts — Stage 4/5: compile script generator ASTs to bytecode
// (design §11.4-11.5). Static expressions fold; runtime values (flags, choices,
// battle results) residualize into branches over the stack VM.

import ts from "typescript";
import { OP } from "../spec/pjgb.ts";
import type { Ctx } from "./context.ts";
import type { ScriptSite } from "./evaluate.ts";

const FACE_SELF = 0xff; // FACE_PLAYER operand meaning "the actor that started me"

class ScriptError extends Error {
  constructor(node: ts.Node, sf: ts.SourceFile, msg: string) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    super(`PJGB script error at ${sf.fileName}:${line + 1}:${character + 1}: ${msg}\n  ${node.getText(sf).slice(0, 80)}`);
  }
}

// Op wrappers that leave a value on the VM stack.
const VALUE_OPS = new Set(["hasFlag", "choose", "battle", "getVar"]);

class Emitter {
  code: number[] = [];
  constructor(private ctx: Ctx, private sf: ts.SourceFile) {}

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
    // rel is measured from the byte AFTER the 2-byte operand
    const rel = this.code.length - (at + 2);
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

  /** Emit an op call. Returns true if it leaves a value on the stack. */
  emitOp(name: string, args: unknown[], node: ts.Node): boolean {
    switch (name) {
      case "say":
        this.u8(OP.TEXT);
        this.u16(this.ctx.internText(String(args[0])));
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
      case "playSfx":
        this.u8(OP.PLAY_SFX);
        this.u16(0);
        return false;
      default:
        throw new ScriptError(node, this.sf, `unsupported script op "${name}"`);
    }
  }

  private emitChoice(options: string[]): void {
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
        this.emitChoice(choice.options);
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
    if (ts.isBlock(s)) return this.compileBlock(s.statements);
    if (s.kind === ts.SyntaxKind.EmptyStatement) return;
    throw new ScriptError(s, this.sf, "unsupported statement in a script (v1: yield-ops, if/else, choose+switch)");
  }

  private compileIf(s: ts.IfStatement): void {
    if (!ts.isYieldExpression(s.expression)) {
      throw new ScriptError(s.expression, this.sf, "if condition must be `yield <predicate>` (e.g. yield hasFlag(...))");
    }
    const { name, args, call } = this.opCall(s.expression.expression!);
    if (!VALUE_OPS.has(name)) throw new ScriptError(call, this.sf, `"${name}" does not yield a testable value`);
    this.emitOp(name, args, call); // leaves value
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

  // switch over a choice index (value already on stack); consumes it.
  private compileChoiceSwitch(sw: ts.SwitchStatement, options: string[]): void {
    const ends: number[] = [];
    for (const clause of sw.caseBlock.clauses) {
      if (ts.isDefaultClause(clause)) {
        this.compileClauseBody(clause.statements);
        ends.push(this.emitJump(OP.JUMP));
        continue;
      }
      const label = this.staticVal(clause.expression);
      const idx = options.indexOf(String(label));
      if (idx < 0) throw new ScriptError(clause, this.sf, `case "${label}" is not one of the choose() options`);
      this.u8(OP.DUP);
      this.u8(OP.PUSH_CONST);
      this.i16(idx);
      this.u8(OP.EQ);
      const nextCase = this.emitJump(OP.JUMP_IF_FALSE);
      this.compileClauseBody(clause.statements);
      ends.push(this.emitJump(OP.JUMP));
      this.patch(nextCase);
    }
    for (const e of ends) this.patch(e);
    this.u8(OP.POP); // drop the choice index
  }

  private compileClauseBody(stmts: readonly ts.Statement[]): void {
    for (const st of stmts) {
      if (ts.isBreakStatement(st)) break;
      this.compileStatement(st);
    }
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

export function compileScript(site: ScriptSite, ctx: Ctx): number[] {
  const em = new Emitter(ctx, site.file);
  const body = site.body.body;
  if (!body || !ts.isBlock(body)) {
    throw new Error(`script #${site.id}: expected a block body`);
  }
  em.compileBlock(body.statements);
  em.code.push(OP.END);
  return em.code;
}
