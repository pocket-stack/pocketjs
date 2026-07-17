// static/compiler/script.ts — compile script generator bodies to stack-VM
// bytecode. This is a real (small) compiler over a typed TS subset, not a
// statement-pattern matcher: expressions, locals, control flow, short-circuit
// logic, switch, subroutine CALLs and compile-time macro inlining all work
// the way the TypeScript reads.
//
// The residual contract: script bodies NEVER execute on the host. Everything
// they may reference is either (a) the three role parameters
// `function* (s, v, f)` — engine ops, global vars proxy, flags proxy —
// (b) local `let/const`, (c) compile-time constants, or (d) helper generator
// functions (inlined macros with statically-bound arguments).

import ts from "typescript";
import { OP, VAR_SCRATCH_BASE, VM_LOCALS, VM_VARS } from "../spec/isa.ts";
import { DIR_BY_NAME, FACE_SELF, RPG_OP, SFX, type DirName } from "../spec/rpg.ts";
import type { Ctx } from "./context.ts";
import { richFromString, type RichText } from "./text.ts";
import type { ScriptSite, Sites } from "./sites.ts";

// ---------------------------------------------------------------------------
// Static values (compile-time constants)
// ---------------------------------------------------------------------------
export type StaticValue = number | string | boolean | StaticValue[] | { [k: string]: StaticValue };

type Binding =
  | { kind: "role"; role: "ops" | "vars" | "flags" }
  | { kind: "local"; slot: number; choiceOptions?: string[] }
  | { kind: "const"; value: StaticValue };

class Scope {
  private byName = new Map<string, Binding>();
  constructor(readonly parent?: Scope) {}
  lookup(name: string): Binding | undefined {
    return this.byName.get(name) ?? this.parent?.lookup(name);
  }
  declare(name: string, b: Binding): void {
    this.byName.set(name, b);
  }
}

export class ScriptError extends Error {
  constructor(node: ts.Node, fallback: ts.SourceFile, msg: string) {
    const sf = node.getSourceFile() ?? fallback;
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    super(
      `${sf.fileName}:${line + 1}:${character + 1}: ${msg}\n  near: ${node.getText(sf).slice(0, 90)}`,
    );
  }
}

interface LoopCtx {
  breaks: number[]; // JMP operand offsets to patch to loop end
  continues: number[]; // JMP operand offsets to patch to continue target
  continueTarget?: number; // known immediately for while; patched late for for
}

interface MacroCtx {
  endJumps: number[]; // `return` sites
  resultSlot?: number; // set when the macro is used in value position
}

const SCRATCH_SLOTS = VM_VARS - VAR_SCRATCH_BASE;

// ---------------------------------------------------------------------------
export class ScriptCompiler {
  code: number[] = [];
  private scopes: Scope;
  private nextSlot = 0;
  private loops: LoopCtx[] = [];
  private macros: MacroCtx[] = [];
  private expansion: string[] = []; // macro names, for recursion detection
  /** Set by compileExpr when the value came straight from s.choose(). */
  private lastChoiceOptions?: string[];

  constructor(
    private site: ScriptSite,
    private sites: Sites,
    private ctx: Ctx,
  ) {
    this.scopes = new Scope();
    const params = site.fn.parameters;
    const roles = ["ops", "vars", "flags"] as const;
    params.forEach((p, i) => {
      if (!ts.isIdentifier(p.name)) throw this.err(p, "script parameters must be plain identifiers");
      if (i >= roles.length) throw this.err(p, "scripts take at most (s, v, f)");
      this.scopes.declare(p.name.text, { kind: "role", role: roles[i] });
    });
  }

  private get sf(): ts.SourceFile {
    return this.sites.file;
  }
  private err(node: ts.Node, msg: string): ScriptError {
    return new ScriptError(node, this.sf, msg);
  }
  private where(node: ts.Node): string {
    const sf = node.getSourceFile() ?? this.sf;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${sf.fileName}:${line + 1}`;
  }

  // --- emission helpers ------------------------------------------------------
  private u8(v: number): void {
    this.code.push(v & 0xff);
  }
  private u16(v: number): void {
    this.code.push(v & 0xff, (v >> 8) & 0xff);
  }
  private emitPush(v: number, node: ts.Node): void {
    const x = Math.trunc(v);
    if (x < -32768 || x > 32767) throw this.err(node, `constant ${x} out of i16 range`);
    if (x >= -128 && x <= 127) {
      this.u8(OP.PUSH8);
      this.u8(x & 0xff);
    } else {
      this.u8(OP.PUSH16);
      this.u16(x & 0xffff);
    }
  }
  /** Emit a jump; returns the operand offset for patching. */
  private jump(op: number): number {
    this.u8(op);
    const at = this.code.length;
    this.u16(0);
    return at;
  }
  private patch(at: number, target = this.code.length): void {
    const rel = target - (at + 2);
    this.code[at] = rel & 0xff;
    this.code[at + 1] = (rel >> 8) & 0xff;
  }
  private allocSlot(node: ts.Node): number {
    if (this.nextSlot >= VM_LOCALS) {
      throw this.err(node, `too many locals (max ${VM_LOCALS} per script, macros included)`);
    }
    return this.nextSlot++;
  }

  // --- static evaluation ------------------------------------------------------
  tryStatic(node: ts.Expression): { ok: true; value: StaticValue } | { ok: false } {
    const no = { ok: false } as const;
    const yes = (value: StaticValue) => ({ ok: true, value }) as const;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return this.tryStatic(node.expression);
    if (ts.isNumericLiteral(node)) return yes(Number(node.text));
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return yes(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return yes(true);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return yes(false);
    if (ts.isIdentifier(node)) {
      const b = this.scopes.lookup(node.text);
      if (b?.kind === "const") return yes(b.value);
      return no;
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const inner = this.tryStatic(node.operand);
      if (!inner.ok) return no;
      if (node.operator === ts.SyntaxKind.MinusToken && typeof inner.value === "number") return yes(-inner.value);
      if (node.operator === ts.SyntaxKind.ExclamationToken) return yes(!inner.value);
      return no;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const out: StaticValue[] = [];
      for (const e of node.elements) {
        const r = this.tryStatic(e);
        if (!r.ok) return no;
        out.push(r.value);
      }
      return yes(out);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const out: { [k: string]: StaticValue } = {};
      for (const p of node.properties) {
        if (!ts.isPropertyAssignment(p) || (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name))) return no;
        const r = this.tryStatic(p.initializer);
        if (!r.ok) return no;
        out[p.name.text] = r.value;
      }
      return yes(out);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const obj = this.tryStatic(node.expression);
      if (!obj.ok || typeof obj.value !== "object" || obj.value === null || Array.isArray(obj.value)) {
        if (obj.ok && Array.isArray(obj.value) && node.name.text === "length") return yes(obj.value.length);
        return no;
      }
      const v = (obj.value as { [k: string]: StaticValue })[node.name.text];
      return v === undefined ? no : yes(v);
    }
    if (ts.isElementAccessExpression(node)) {
      const obj = this.tryStatic(node.expression);
      const idx = this.tryStatic(node.argumentExpression);
      if (!obj.ok || !idx.ok) return no;
      if (Array.isArray(obj.value) && typeof idx.value === "number") {
        const v = obj.value[idx.value];
        return v === undefined ? no : yes(v);
      }
      if (typeof obj.value === "object" && typeof idx.value === "string") {
        const v = (obj.value as { [k: string]: StaticValue })[idx.value];
        return v === undefined ? no : yes(v);
      }
      return no;
    }
    if (ts.isTemplateExpression(node)) {
      let s = node.head.text;
      for (const span of node.templateSpans) {
        const r = this.tryStatic(span.expression);
        if (!r.ok) return no;
        s += String(r.value) + span.literal.text;
      }
      return yes(s);
    }
    if (ts.isBinaryExpression(node)) {
      const a = this.tryStatic(node.left);
      const b = this.tryStatic(node.right);
      if (!a.ok || !b.ok) return no;
      const x = a.value as number | string | boolean;
      const y = b.value as number | string | boolean;
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return yes((x as never) + (y as never));
        case ts.SyntaxKind.MinusToken:
          return yes((x as number) - (y as number));
        case ts.SyntaxKind.AsteriskToken:
          return yes((x as number) * (y as number));
        case ts.SyntaxKind.SlashToken:
          return yes(Math.trunc((x as number) / (y as number)));
        case ts.SyntaxKind.PercentToken:
          return yes((x as number) % (y as number));
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
          return yes(x === y);
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
          return yes(x !== y);
        case ts.SyntaxKind.LessThanToken:
          return yes(x < y);
        case ts.SyntaxKind.GreaterThanToken:
          return yes(x > y);
        case ts.SyntaxKind.LessThanEqualsToken:
          return yes(x <= y);
        case ts.SyntaxKind.GreaterThanEqualsToken:
          return yes(x >= y);
        case ts.SyntaxKind.AmpersandAmpersandToken:
          return yes(x && y);
        case ts.SyntaxKind.BarBarToken:
          return yes(x || y);
        default:
          return no;
      }
    }
    return no;
  }

  private staticOrThrow(node: ts.Expression, what: string): StaticValue {
    const r = this.tryStatic(node);
    if (!r.ok) throw this.err(node, `${what} must be a compile-time constant`);
    return r.value;
  }

  // --- role recognition --------------------------------------------------------
  private roleOf(node: ts.Expression): "ops" | "vars" | "flags" | undefined {
    if (!ts.isIdentifier(node)) return undefined;
    const b = this.scopes.lookup(node.text);
    return b?.kind === "role" ? b.role : undefined;
  }

  /** v.name / f.name (or v["name"]). Returns the interned id. */
  private globalRef(node: ts.Expression): { kind: "var" | "flag"; id: number } | undefined {
    let objExpr: ts.Expression | undefined;
    let name: string | undefined;
    if (ts.isPropertyAccessExpression(node)) {
      objExpr = node.expression;
      name = node.name.text;
    } else if (ts.isElementAccessExpression(node)) {
      objExpr = node.expression;
      const idx = this.tryStatic(node.argumentExpression);
      if (idx.ok && typeof idx.value === "string") name = idx.value;
    }
    if (!objExpr || name === undefined) return undefined;
    const role = this.roleOf(objExpr);
    if (role === "vars") return { kind: "var", id: this.ctx.varId(name, this.where(node)) };
    if (role === "flags") return { kind: "flag", id: this.ctx.flagId(name, this.where(node)) };
    return undefined;
  }

  /** s.<op>(...) call, unwrapped from yield*. */
  private opsCall(node: ts.Expression): { op: string; args: readonly ts.Expression[]; call: ts.CallExpression } | undefined {
    let e = node;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return undefined;
    if (this.roleOf(e.expression.expression) !== "ops") return undefined;
    return { op: e.expression.name.text, args: e.arguments, call: e };
  }

  /** yield* <expr> unwrap. */
  private yieldStar(node: ts.Expression): ts.Expression | undefined {
    let e = node;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
    if (ts.isYieldExpression(e) && e.asteriskToken && e.expression) return e.expression;
    return undefined;
  }

  // --- rich text (say/choice payloads) -----------------------------------------
  /**
   * Build a RichText from a string-ish expression. Runtime `${...}` spans
   * compile to scratch-var stores (emitted NOW, before the SAY) + FMT atoms.
   */
  private richText(node: ts.Expression, fmtUsed: { n: number }): RichText {
    const st = this.tryStatic(node);
    if (st.ok) {
      if (typeof st.value !== "string") throw this.err(node, "expected text");
      return richFromString(st.value);
    }
    let e = node;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
    if (ts.isTemplateExpression(e)) {
      const rt: RichText = [...richFromString(e.head.text)];
      for (const span of e.templateSpans) {
        const r = this.tryStatic(span.expression);
        if (r.ok) {
          rt.push(...richFromString(String(r.value)));
        } else {
          if (fmtUsed.n >= SCRATCH_SLOTS) {
            throw this.err(span.expression, `too many runtime \${...} slots (max ${SCRATCH_SLOTS} per statement)`);
          }
          const scratch = VAR_SCRATCH_BASE + fmtUsed.n++;
          this.compileExpr(span.expression);
          this.u8(OP.STV);
          this.u8(scratch);
          rt.push({ fmtVar: scratch });
        }
        rt.push(...richFromString(span.literal.text));
      }
      return rt;
    }
    throw this.err(node, "text must be a string literal, a template literal, or a compile-time constant");
  }

  // --- expressions ---------------------------------------------------------------
  /** Compile an expression; leaves exactly one i16 on the VM stack. */
  compileExpr(node: ts.Expression): void {
    this.lastChoiceOptions = undefined;

    const st = this.tryStatic(node);
    if (st.ok) {
      const v = st.value;
      if (typeof v === "number") return this.emitPush(v, node);
      if (typeof v === "boolean") return this.emitPush(v ? 1 : 0, node);
      throw this.err(node, `a ${Array.isArray(v) ? "array" : typeof v} constant cannot be a runtime value`);
    }

    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return this.compileExpr(node.expression);

    // yield* — value ops and value macros
    const inner = this.yieldStar(node);
    if (inner) return this.compileYieldValue(node, inner);

    if (ts.isIdentifier(node)) {
      const b = this.scopes.lookup(node.text);
      if (!b) throw this.err(node, `unknown identifier "${node.text}" (locals, v.*, f.* and constants only)`);
      if (b.kind === "local") {
        this.u8(OP.LDL);
        this.u8(b.slot);
        this.lastChoiceOptions = b.choiceOptions;
        return;
      }
      throw this.err(node, `"${node.text}" cannot be used as a value here`);
    }

    const g = this.globalRef(node);
    if (g) {
      this.u8(g.kind === "var" ? OP.LDV : OP.FLAG);
      this.u8(g.id);
      return;
    }

    if (ts.isPrefixUnaryExpression(node)) {
      switch (node.operator) {
        case ts.SyntaxKind.ExclamationToken:
          this.compileExpr(node.operand);
          this.u8(OP.NOT);
          return;
        case ts.SyntaxKind.MinusToken:
          this.compileExpr(node.operand);
          this.u8(OP.NEG);
          return;
        default:
          throw this.err(node, "unsupported unary operator");
      }
    }

    if (ts.isBinaryExpression(node)) return this.compileBinary(node);

    if (ts.isConditionalExpression(node)) {
      this.compileExpr(node.condition);
      const toElse = this.jump(OP.JZ);
      this.compileExpr(node.whenTrue);
      const toEnd = this.jump(OP.JMP);
      this.patch(toElse);
      this.compileExpr(node.whenFalse);
      this.patch(toEnd);
      return;
    }

    throw this.err(node, "unsupported expression in a script");
  }

  private compileBinary(node: ts.BinaryExpression): void {
    const k = node.operatorToken.kind;
    // Assignment used as an expression is not supported (statement only).
    if (
      k === ts.SyntaxKind.EqualsToken ||
      k === ts.SyntaxKind.PlusEqualsToken ||
      k === ts.SyntaxKind.MinusEqualsToken
    ) {
      throw this.err(node, "assignments are statements, not expressions, in scripts");
    }
    if (k === ts.SyntaxKind.AmpersandAmpersandToken) {
      // JS semantics: a && b -> a if falsy else b
      this.compileExpr(node.left);
      this.u8(OP.DUP);
      const short = this.jump(OP.JZ);
      this.u8(OP.POP);
      this.compileExpr(node.right);
      this.patch(short);
      return;
    }
    if (k === ts.SyntaxKind.BarBarToken) {
      this.compileExpr(node.left);
      this.u8(OP.DUP);
      const short = this.jump(OP.JNZ);
      this.u8(OP.POP);
      this.compileExpr(node.right);
      this.patch(short);
      return;
    }

    // choice-string comparisons: `pick === "Battle"`
    const strCmp = this.tryChoiceStringCompare(node);
    if (strCmp) return;

    const table: Partial<Record<ts.SyntaxKind, number>> = {
      [ts.SyntaxKind.PlusToken]: OP.ADD,
      [ts.SyntaxKind.MinusToken]: OP.SUB,
      [ts.SyntaxKind.AsteriskToken]: OP.MUL,
      [ts.SyntaxKind.SlashToken]: OP.DIV,
      [ts.SyntaxKind.PercentToken]: OP.MOD,
      [ts.SyntaxKind.EqualsEqualsEqualsToken]: OP.EQ,
      [ts.SyntaxKind.ExclamationEqualsEqualsToken]: OP.NE,
      [ts.SyntaxKind.LessThanToken]: OP.LT,
      [ts.SyntaxKind.GreaterThanToken]: OP.GT,
      [ts.SyntaxKind.LessThanEqualsToken]: OP.LE,
      [ts.SyntaxKind.GreaterThanEqualsToken]: OP.GE,
    };
    if (k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken) {
      throw this.err(node, "use === / !== in scripts");
    }
    const op = table[k];
    if (op === undefined) throw this.err(node, "unsupported binary operator");
    this.compileExpr(node.left);
    const leftChoice = this.lastChoiceOptions;
    this.compileExpr(node.right);
    this.lastChoiceOptions = leftChoice; // (only meaningful for ===/!== path)
    this.u8(op);
    this.lastChoiceOptions = undefined;
  }

  /** `pick === "Battle"` where pick carries choice metadata. */
  private tryChoiceStringCompare(node: ts.BinaryExpression): boolean {
    const k = node.operatorToken.kind;
    if (k !== ts.SyntaxKind.EqualsEqualsEqualsToken && k !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return false;
    const sides = [
      { val: node.left, str: node.right },
      { val: node.right, str: node.left },
    ];
    for (const { val, str } of sides) {
      const s = this.tryStatic(str);
      if (!s.ok || typeof s.value !== "string") continue;
      if (!ts.isIdentifier(val)) continue;
      const b = this.scopes.lookup(val.text);
      if (b?.kind !== "local" || !b.choiceOptions) continue;
      const idx = b.choiceOptions.indexOf(s.value);
      if (idx < 0) {
        throw this.err(str, `"${s.value}" is not one of the choices [${b.choiceOptions.join(", ")}]`);
      }
      this.u8(OP.LDL);
      this.u8(b.slot);
      this.emitPush(idx, node);
      this.u8(k === ts.SyntaxKind.EqualsEqualsEqualsToken ? OP.EQ : OP.NE);
      return true;
    }
    return false;
  }

  // --- yield* value position ---------------------------------------------------
  private compileYieldValue(node: ts.Expression, inner: ts.Expression): void {
    const call = this.opsCall(inner);
    if (call) {
      switch (call.op) {
        case "choose": {
          const options = this.chooseOptions(call);
          this.emitChoice(options, call.call);
          this.lastChoiceOptions = options;
          return;
        }
        case "rnd": {
          if (call.args.length !== 1) throw this.err(call.call, "s.rnd(n) takes one argument");
          this.compileExpr(call.args[0]);
          this.u8(OP.RND);
          return;
        }
        default:
          throw this.err(call.call, `s.${call.op}() does not produce a value`);
      }
    }
    // value macro
    if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
      const helper = this.sites.helpers.get(inner.expression.text);
      if (helper) {
        this.inlineMacro(inner, helper, /*wantValue*/ true);
        return;
      }
    }
    throw this.err(node, "yield* here must be a value op (s.choose/s.rnd) or a helper generator");
  }

  private chooseOptions(call: { args: readonly ts.Expression[]; call: ts.CallExpression }): string[] {
    if (call.args.length !== 1) throw this.err(call.call, "s.choose([...options]) takes one array argument");
    const v = this.staticOrThrow(call.args[0], "choice options");
    if (!Array.isArray(v) || v.some((o) => typeof o !== "string")) {
      throw this.err(call.call, "choice options must be an array of strings");
    }
    return v as string[];
  }

  private emitChoice(options: string[], node: ts.Node): void {
    const max = this.ctx.target.maxChoices;
    if (options.length < 1 || options.length > max) {
      throw this.err(node, `choose() needs 1..${max} options on ${this.ctx.target.name} (got ${options.length})`);
    }
    this.u8(RPG_OP.CHOICE);
    this.u8(options.length);
    for (const o of options) this.u16(this.ctx.internOption(richFromString(o), this.where(node)));
  }

  // --- statements -----------------------------------------------------------------
  compileBody(): void {
    const body = this.site.fn.body;
    this.compileBlockStatements(body.statements);
    this.u8(OP.RET);
  }

  private compileBlockStatements(stmts: readonly ts.Statement[]): void {
    // Locals die with their scope, so their slots are reclaimable: restore
    // the allocator on scope exit (the VM has no closures — nothing outlives
    // its block).
    const savedSlots = this.nextSlot;
    this.scopes = new Scope(this.scopes);
    for (const s of stmts) this.compileStatement(s);
    this.scopes = this.scopes.parent!;
    this.nextSlot = savedSlots;
  }

  private compileStatement(s: ts.Statement): void {
    if (ts.isVariableStatement(s)) return this.compileVarDecl(s);
    if (ts.isExpressionStatement(s)) return this.compileExprStatement(s.expression);
    if (ts.isIfStatement(s)) return this.compileIf(s);
    if (ts.isWhileStatement(s)) return this.compileWhile(s);
    if (ts.isForStatement(s)) return this.compileFor(s);
    if (ts.isForOfStatement(s)) return this.compileForOf(s);
    if (ts.isSwitchStatement(s)) return this.compileSwitch(s);
    if (ts.isBreakStatement(s)) {
      const loop = this.loops[this.loops.length - 1];
      if (!loop) throw this.err(s, "break outside a loop (switch breaks are handled inline)");
      loop.breaks.push(this.jump(OP.JMP));
      return;
    }
    if (ts.isContinueStatement(s)) {
      const loop = this.loops[this.loops.length - 1];
      if (!loop) throw this.err(s, "continue outside a loop");
      if (loop.continueTarget !== undefined) this.patch(this.jump(OP.JMP), loop.continueTarget);
      else loop.continues.push(this.jump(OP.JMP));
      return;
    }
    if (ts.isReturnStatement(s)) return this.compileReturn(s);
    if (ts.isBlock(s)) return this.compileBlockStatements(s.statements);
    if (s.kind === ts.SyntaxKind.EmptyStatement) return;
    throw this.err(s, "unsupported statement in a script");
  }

  private compileVarDecl(s: ts.VariableStatement): void {
    const isConst = (s.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) throw this.err(d, "destructuring is not supported in scripts");
      if (!d.initializer) throw this.err(d, "script locals need an initializer");
      const st = this.tryStatic(d.initializer);
      if (isConst && st.ok) {
        this.scopes.declare(d.name.text, { kind: "const", value: st.value });
        continue;
      }
      const slot = this.allocSlot(d);
      this.compileExpr(d.initializer);
      const choiceOptions = this.lastChoiceOptions;
      this.u8(OP.STL);
      this.u8(slot);
      this.scopes.declare(d.name.text, { kind: "local", slot, choiceOptions });
    }
  }

  private compileExprStatement(e: ts.Expression): void {
    // assignment / compound assignment / ++ / --
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      const compound: Partial<Record<ts.SyntaxKind, number>> = {
        [ts.SyntaxKind.PlusEqualsToken]: OP.ADD,
        [ts.SyntaxKind.MinusEqualsToken]: OP.SUB,
        [ts.SyntaxKind.AsteriskEqualsToken]: OP.MUL,
        [ts.SyntaxKind.SlashEqualsToken]: OP.DIV,
        [ts.SyntaxKind.PercentEqualsToken]: OP.MOD,
      };
      if (k === ts.SyntaxKind.EqualsToken) return this.compileAssign(e.left, e.right, undefined, e);
      const op = compound[k];
      if (op !== undefined) return this.compileAssign(e.left, e.right, op, e);
    }
    if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) {
      const k = e.operator;
      if (k === ts.SyntaxKind.PlusPlusToken || k === ts.SyntaxKind.MinusMinusToken) {
        const one = ts.factory.createNumericLiteral("1");
        // ++x as statement == x += 1 (no value use)
        return this.compileAssign(
          e.operand,
          one,
          k === ts.SyntaxKind.PlusPlusToken ? OP.ADD : OP.SUB,
          e,
          /*syntheticRight*/ true,
        );
      }
    }
    // yield* op / macro in statement position
    const inner = this.yieldStar(e);
    if (inner) return this.compileYieldStatement(e, inner);
    throw this.err(e, "unsupported expression statement (did you forget yield* ?)");
  }

  private compileAssign(
    target: ts.Expression,
    rhs: ts.Expression,
    compoundOp: number | undefined,
    node: ts.Node,
    syntheticRight = false,
  ): void {
    // local
    if (ts.isIdentifier(target)) {
      const b = this.scopes.lookup(target.text);
      if (!b) throw this.err(target, `unknown identifier "${target.text}"`);
      if (b.kind !== "local") throw this.err(target, `cannot assign to "${target.text}"`);
      if (compoundOp !== undefined) {
        this.u8(OP.LDL);
        this.u8(b.slot);
      }
      if (syntheticRight) this.emitPush(1, node);
      else this.compileExpr(rhs);
      if (compoundOp !== undefined) this.u8(compoundOp);
      this.u8(OP.STL);
      this.u8(b.slot);
      return;
    }
    // v.name / f.name
    const g = this.globalRef(target);
    if (g?.kind === "var") {
      if (compoundOp !== undefined) {
        this.u8(OP.LDV);
        this.u8(g.id);
      }
      if (syntheticRight) this.emitPush(1, node);
      else this.compileExpr(rhs);
      if (compoundOp !== undefined) this.u8(compoundOp);
      this.u8(OP.STV);
      this.u8(g.id);
      return;
    }
    if (g?.kind === "flag") {
      if (compoundOp !== undefined) throw this.err(node, "flags only support plain assignment");
      const st = this.tryStatic(rhs);
      if (st.ok && typeof st.value === "boolean") {
        this.u8(st.value ? OP.SETF : OP.CLRF);
        this.u8(g.id);
        return;
      }
      this.compileExpr(rhs);
      this.u8(OP.STF);
      this.u8(g.id);
      return;
    }
    throw this.err(target, "assignment target must be a local, v.<name>, or f.<name>");
  }

  private compileYieldStatement(node: ts.Expression, inner: ts.Expression): void {
    const call = this.opsCall(inner);
    if (call) return this.compileOpStatement(call);
    if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
      const helper = this.sites.helpers.get(inner.expression.text);
      if (helper) return this.inlineMacro(inner, helper, /*wantValue*/ false);
      throw this.err(inner, `"${inner.expression.text}" is not a helper generator in this file`);
    }
    throw this.err(node, "yield* must call an s.* op or a helper generator");
  }

  private compileOpStatement(call: { op: string; args: readonly ts.Expression[]; call: ts.CallExpression }): void {
    const { op, args, call: node } = call;
    const where = this.where(node);
    switch (op) {
      case "say": {
        if (args.length !== 1) throw this.err(node, "s.say(text) takes one argument");
        const fmtUsed = { n: 0 };
        const rt = this.richText(args[0], fmtUsed);
        const pages = this.ctx.internPages(rt, where);
        for (const id of pages) {
          this.u8(RPG_OP.SAY);
          this.u16(id);
        }
        return;
      }
      case "choose": {
        // choose in statement position: emit + drop the result
        const options = this.chooseOptions({ args, call: node });
        this.emitChoice(options, node);
        this.u8(OP.POP);
        return;
      }
      case "rnd":
        throw this.err(node, "s.rnd() result is unused — assign it or use it in an expression");
      case "wait": {
        if (args.length !== 1) throw this.err(node, "s.wait(frames) takes one argument");
        this.compileExpr(args[0]);
        this.u8(OP.WAIT);
        return;
      }
      case "lock":
        this.u8(RPG_OP.LOCK);
        return;
      case "release":
        this.u8(RPG_OP.RELEASE);
        return;
      case "face": {
        if (args.length === 0) {
          this.u8(RPG_OP.FACE);
          this.u8(FACE_SELF);
          return;
        }
        const id = this.staticOrThrow(args[0], "actor id");
        if (typeof id !== "string") throw this.err(node, "s.face(actorId) takes an actor id string");
        this.u8(RPG_OP.FACE);
        this.ctx.actorFixups.push({ at: this.code.length + this.fixupBase(), actorId: id, where });
        this.u8(0);
        return;
      }
      case "show":
      case "hide": {
        if (args.length !== 1) throw this.err(node, `s.${op}(actorId) takes one argument`);
        const id = this.staticOrThrow(args[0], "actor id");
        if (typeof id !== "string") throw this.err(node, "actor id must be a string");
        this.u8(RPG_OP.AVIS);
        this.ctx.actorFixups.push({ at: this.code.length + this.fixupBase(), actorId: id, where });
        this.u8(0);
        this.u8(op === "show" ? 1 : 0);
        return;
      }
      case "warp": {
        if (args.length !== 1) throw this.err(node, 's.warp("map:entrance") takes one argument');
        const dest = this.staticOrThrow(args[0], "warp destination");
        if (typeof dest !== "string" || !dest.includes(":")) {
          throw this.err(node, 'warp destination must be "map:entrance"');
        }
        this.u8(RPG_OP.WARP);
        this.ctx.warpFixups.push({ at: this.code.length + this.fixupBase(), dest, where });
        this.u8(0);
        this.u8(0);
        this.u8(0);
        this.u8(0);
        return;
      }
      case "sfx": {
        if (args.length !== 1) throw this.err(node, "s.sfx(name) takes one argument");
        const name = this.staticOrThrow(args[0], "sfx name");
        const key = String(name).toUpperCase() as keyof typeof SFX;
        if (!(key in SFX)) throw this.err(node, `unknown sfx "${name}" (${Object.keys(SFX).join(", ").toLowerCase()})`);
        this.u8(RPG_OP.SFX);
        this.u8(SFX[key]);
        return;
      }
      case "faceDir": {
        // authoring aid used by cutscenes: turn the player. Encoded as a
        // warp-in-place? No — v1 keeps player facing implicit; reject.
        throw this.err(node, "s.faceDir is not part of the v1 surface");
      }
      case "call": {
        if (args.length !== 1 || !ts.isIdentifier(args[0])) {
          throw this.err(node, "s.call(ScriptName) takes a top-level script const");
        }
        const id = this.sites.scriptIds.get(args[0].text);
        if (id === undefined) throw this.err(args[0], `"${args[0].text}" is not a top-level script(...) const`);
        this.u8(OP.CALL);
        this.u16(id);
        return;
      }
      default:
        throw this.err(node, `unknown script op s.${op}()`);
    }
  }

  /** Fixup offsets are recorded blob-relative by the link stage; during a
   * single script compile they are code-relative (base 0) and shifted later. */
  private fixupBase(): number {
    return 0;
  }

  private compileIf(s: ts.IfStatement): void {
    // Statically-decidable conditions drop the dead branch (macro staples).
    const st = this.tryStatic(s.expression);
    if (st.ok) {
      const taken = !!st.value;
      if (taken) this.compileStatement(s.thenStatement);
      else if (s.elseStatement) this.compileStatement(s.elseStatement);
      return;
    }
    this.compileExpr(s.expression);
    const toElse = this.jump(OP.JZ);
    this.compileStatement(s.thenStatement);
    if (s.elseStatement) {
      const toEnd = this.jump(OP.JMP);
      this.patch(toElse);
      this.compileStatement(s.elseStatement);
      this.patch(toEnd);
    } else {
      this.patch(toElse);
    }
  }

  private compileWhile(s: ts.WhileStatement): void {
    const loopStart = this.code.length;
    const st = this.tryStatic(s.expression);
    let toEnd: number | undefined;
    if (st.ok) {
      if (!st.value) return; // while(false) — dead
      // while(true): no test
    } else {
      this.compileExpr(s.expression);
      toEnd = this.jump(OP.JZ);
    }
    this.loops.push({ breaks: [], continues: [], continueTarget: loopStart });
    this.compileStatement(s.statement);
    this.patch(this.jump(OP.JMP), loopStart);
    if (toEnd !== undefined) this.patch(toEnd);
    const loop = this.loops.pop()!;
    for (const b of loop.breaks) this.patch(b);
  }

  private compileFor(s: ts.ForStatement): void {
    const savedSlots = this.nextSlot;
    this.scopes = new Scope(this.scopes);
    if (s.initializer) {
      if (ts.isVariableDeclarationList(s.initializer)) {
        this.compileVarDecl(
          ts.factory.createVariableStatement(undefined, s.initializer) as ts.VariableStatement & {
            declarationList: ts.VariableDeclarationList;
          },
        );
      } else {
        this.compileExprStatement(s.initializer);
      }
    }
    const loopStart = this.code.length;
    let toEnd: number | undefined;
    if (s.condition) {
      this.compileExpr(s.condition);
      toEnd = this.jump(OP.JZ);
    }
    this.loops.push({ breaks: [], continues: [] });
    this.compileStatement(s.statement);
    const loop = this.loops.pop()!;
    const continueTarget = this.code.length;
    for (const c of loop.continues) this.patch(c, continueTarget);
    if (s.incrementor) this.compileExprStatement(s.incrementor);
    this.patch(this.jump(OP.JMP), loopStart);
    if (toEnd !== undefined) this.patch(toEnd);
    for (const b of loop.breaks) this.patch(b);
    this.scopes = this.scopes.parent!;
    this.nextSlot = savedSlots;
  }

  private compileForOf(s: ts.ForOfStatement): void {
    // Unrolled iteration over a compile-time array (macro workhorse).
    if (!ts.isVariableDeclarationList(s.initializer) || s.initializer.declarations.length !== 1) {
      throw this.err(s, "for...of needs `for (const x of <static array>)`");
    }
    const decl = s.initializer.declarations[0];
    if (!ts.isIdentifier(decl.name)) throw this.err(decl, "for...of variable must be an identifier");
    const arr = this.staticOrThrow(s.expression, "for...of iterable");
    if (!Array.isArray(arr)) throw this.err(s.expression, "for...of iterates a compile-time array");
    for (const item of arr) {
      this.scopes = new Scope(this.scopes);
      this.scopes.declare(decl.name.text, { kind: "const", value: item });
      this.compileStatement(s.statement);
      this.scopes = this.scopes.parent!;
    }
  }

  private compileSwitch(s: ts.SwitchStatement): void {
    this.compileExpr(s.expression);
    const choiceOptions = this.lastChoiceOptions ?? this.switchDiscriminantChoices(s.expression);
    const slot = this.allocSlot(s); // hidden discriminant temp
    this.u8(OP.STL);
    this.u8(slot);

    const clauses = s.caseBlock.clauses;
    const bodyJumps = new Map<number, number>();
    let defaultIdx = -1;
    clauses.forEach((clause, i) => {
      if (ts.isDefaultClause(clause)) {
        if (defaultIdx >= 0) throw this.err(clause, "duplicate default");
        defaultIdx = i;
        return;
      }
      const label = this.staticOrThrow(clause.expression, "case label");
      let val: number;
      if (typeof label === "number") {
        val = label;
      } else if (typeof label === "string") {
        if (!choiceOptions) throw this.err(clause, "string case labels need a choice-valued switch");
        val = choiceOptions.indexOf(label);
        if (val < 0) throw this.err(clause, `"${label}" is not one of [${choiceOptions.join(", ")}]`);
      } else {
        throw this.err(clause, "case label must be a number or a choice string");
      }
      this.u8(OP.LDL);
      this.u8(slot);
      this.emitPush(val, clause);
      this.u8(OP.EQ);
      bodyJumps.set(i, this.jump(OP.JNZ));
    });
    const fall = this.jump(OP.JMP);

    // switch participates in break like a loop (break exits the switch)
    this.loops.push({ breaks: [], continues: [], continueTarget: undefined });
    const bodyOffsets: number[] = [];
    clauses.forEach((clause, i) => {
      bodyOffsets[i] = this.code.length;
      const j = bodyJumps.get(i);
      if (j !== undefined) this.patch(j, bodyOffsets[i]);
      if (i === defaultIdx) this.patch(fall, bodyOffsets[i]);
      this.compileBlockStatements(clause.statements);
    });
    const loop = this.loops.pop()!;
    if (loop.continues.length) throw this.err(s, "continue inside switch is not supported");
    const end = this.code.length;
    if (defaultIdx < 0) this.patch(fall, end);
    for (const b of loop.breaks) this.patch(b, end);
    this.nextSlot = slot; // the hidden discriminant temp is dead now
  }

  /** switch (yield* s.choose([...])) — metadata via direct inspection. */
  private switchDiscriminantChoices(e: ts.Expression): string[] | undefined {
    const inner = this.yieldStar(e);
    if (!inner) return undefined;
    const call = this.opsCall(inner);
    if (call?.op === "choose") return this.chooseOptions(call);
    return undefined;
  }

  private compileReturn(s: ts.ReturnStatement): void {
    const macro = this.macros[this.macros.length - 1];
    if (macro) {
      if (s.expression) {
        if (macro.resultSlot === undefined) {
          throw this.err(s, "this helper is used as a statement — `return <value>` has nowhere to go");
        }
        this.compileExpr(s.expression);
        this.u8(OP.STL);
        this.u8(macro.resultSlot);
      }
      macro.endJumps.push(this.jump(OP.JMP));
      return;
    }
    if (s.expression) throw this.err(s, "scripts cannot return a value; use plain `return;`");
    this.u8(OP.RET);
  }

  // --- macro inlining -------------------------------------------------------------
  private inlineMacro(
    call: ts.CallExpression,
    helper: ts.FunctionExpression | ts.FunctionDeclaration,
    wantValue: boolean,
  ): void {
    const name = ts.isIdentifier(call.expression) ? call.expression.text : "<macro>";
    if (this.expansion.includes(name)) {
      throw this.err(call, `recursive macro expansion: ${[...this.expansion, name].join(" -> ")}`);
    }
    if (this.expansion.length >= 8) throw this.err(call, "macro expansion too deep (8)");
    if (!helper.body) throw this.err(call, `helper "${name}" has no body`);

    // Bind parameters: role identifiers pass through; everything else must be
    // a compile-time constant.
    const outer = this.scopes;
    const macroScope = new Scope(); // macros do NOT see the caller's locals
    helper.parameters.forEach((p, i) => {
      if (!ts.isIdentifier(p.name)) throw this.err(p, "helper parameters must be identifiers");
      const arg = call.arguments[i];
      if (arg === undefined) {
        if (p.initializer) {
          const dv = this.tryStatic(p.initializer);
          if (!dv.ok) throw this.err(p, "helper default values must be compile-time constants");
          macroScope.declare(p.name.text, { kind: "const", value: dv.value });
          return;
        }
        throw this.err(call, `helper "${name}" expects argument #${i + 1} (${p.name.text})`);
      }
      const role = this.roleOf(arg);
      if (role) {
        macroScope.declare(p.name.text, { kind: "role", role });
        return;
      }
      const st = this.tryStatic(arg);
      if (!st.ok) {
        throw this.err(
          arg,
          `macro argument "${p.name.text}" must be a compile-time constant (or the s/v/f handles)`,
        );
      }
      macroScope.declare(p.name.text, { kind: "const", value: st.value });
    });

    const macro: MacroCtx = { endJumps: [], resultSlot: wantValue ? this.allocSlot(call) : undefined };
    if (macro.resultSlot !== undefined) {
      // default result 0 on fallthrough
      this.emitPush(0, call);
      this.u8(OP.STL);
      this.u8(macro.resultSlot);
    }
    this.macros.push(macro);
    this.expansion.push(name);
    this.scopes = macroScope;
    this.compileBlockStatements(helper.body.statements);
    this.scopes = outer;
    this.expansion.pop();
    this.macros.pop();
    const end = this.code.length;
    for (const j of macro.endJumps) this.patch(j, end);
    if (macro.resultSlot !== undefined) {
      this.u8(OP.LDL);
      this.u8(macro.resultSlot);
    }
  }
}

// ---------------------------------------------------------------------------
// Whole-module compile: every script site -> one blob + id table.
// ---------------------------------------------------------------------------
export interface CompiledScripts {
  blob: Uint8Array;
  /** Byte offset of each script id in the blob. */
  table: number[];
}

export function compileScripts(sites: Sites, ctx: Ctx): CompiledScripts {
  const chunks: number[][] = [];
  const table: number[] = [];
  let base = 0;
  for (const site of sites.scripts) {
    const before = { warp: ctx.warpFixups.length, actor: ctx.actorFixups.length };
    const c = new ScriptCompiler(site, sites, ctx);
    c.compileBody();
    // shift this script's fixups to blob-relative offsets
    for (let i = before.warp; i < ctx.warpFixups.length; i++) ctx.warpFixups[i].at += base;
    for (let i = before.actor; i < ctx.actorFixups.length; i++) ctx.actorFixups[i].at += base;
    table.push(base);
    chunks.push(c.code);
    base += c.code.length;
  }
  const blob = new Uint8Array(base);
  let at = 0;
  for (const c of chunks) {
    blob.set(c, at);
    at += c.length;
  }
  return { blob, table };
}
