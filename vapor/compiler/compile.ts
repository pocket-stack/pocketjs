// vapor/compiler/compile.ts — the Pocket Vapor compiler.
//
// Input: one component module in the strict Vue Vapor TS subset (see
// vapor/DESIGN.md §4) — the same file the oracle runs on real vue 3.6.
// Output: one C translation unit (gen_app.c) against the runtime contract
// in vapor/runtime/gba/vapor.h, plus the memory plan and reactive graph.
//
// The pipeline mirrors what @vue/reactivity + vapor do at runtime, moved to
// build time:
//   refs      -> state slots (globals; lists -> fixed-capacity pools)
//   computeds -> cached recompute functions with validity bits
//   bindings  -> paint effects with compile-time dependency bitmasks
//   template  -> static rows painted once + effects merged by row span
//
// Dependency tracking is static and over-approximating: an effect
// subscribes to every ref it MAY read (conditional reads subscribe both
// arms), which can only cause redundant repaints, never a missed one.

import ts from "typescript";
import { FONT8 } from "./font.gen.ts";

// ---------------------------------------------------------------------------
// Public result
// ---------------------------------------------------------------------------

export interface DebugSlot {
  name: string;
  offset: number;
  size: number;
  kind: "num" | "bool" | "str" | "listLen";
}

export interface CompiledApp {
  c: string;
  title: string;
  graph: string;
  plan: string;
  debugSlots: DebugSlot[];
}

export class VaporCompileError extends Error {
  constructor(sf: ts.SourceFile, node: ts.Node, message: string) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    super(`${sf.fileName}:${line + 1}:${character + 1} — ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Types and bindings
// ---------------------------------------------------------------------------

type Ty =
  | { k: "num" }
  | { k: "bool" }
  | { k: "char" }
  | { k: "strlit" } // C `const char *`
  | { k: "sb" } // C `const vp_sb *`
  | { k: "obj"; iface: string; listRef: string } // nullable record pointer
  | { k: "view"; iface: string; listRef: string; maxLen: number }
  | { k: "void" };

const NUM: Ty = { k: "num" };
const BOOL: Ty = { k: "bool" };

interface IfaceShape {
  name: string;
  fields: { name: string; ty: "str" | "bool" | "num" }[];
}

interface RefBinding {
  kind: "ref";
  name: string;
  index: number; // dirty bit
  refTy: "num" | "bool" | "str" | "list";
  iface?: string;
  seed: ts.Expression;
}

interface ComputedBinding {
  kind: "computed";
  name: string;
  index: number; // validity bit + emit order
  valTy: Ty; // num | view
  deps: Set<string>; // transitive ref names
  maxLen: number; // for views
}

interface FnBinding {
  kind: "fn";
  name: string;
  decl: ts.FunctionDeclaration;
  emitted: boolean;
  deps: Set<string>;
  params: string[]; // s32 params, annotated `: number` in source
}

interface ConstBinding {
  kind: "const";
  name: string;
  value: number | string | string[] | Record<string, number>;
}

interface KeymapBinding {
  kind: "keymap";
  name: string;
  /** button id -> C function name (10-entry fnptr table in ROM) */
  entries: Map<number, string>;
}

interface LocalBinding {
  kind: "local";
  cName: string;
  ty: Ty;
}

type Binding = RefBinding | ComputedBinding | FnBinding | ConstBinding | LocalBinding | KeymapBinding;

const POOL_CAP = 32;

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export function compileVaporApp(fileName: string, source: string, title = "VAPOR"): CompiledApp {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  return new AppCompiler(sf, title).compile();
}

class AppCompiler {
  private ifaces = new Map<string, IfaceShape>();
  private scope = new Map<string, Binding>();
  private refs: RefBinding[] = [];
  private computeds: ComputedBinding[] = [];
  private fns: FnBinding[] = [];
  private handler: ts.ArrowFunction | null = null;
  private template: ts.JsxFragment | null = null;

  private vueRef = "";
  private vueComputed = "";
  private hostOnButton = "";
  private hostButton = "";

  // emission
  private decls: string[] = [];
  private bodies: string[] = [];
  private tmpCounter = 0;
  private curDeps: Set<string> | null = null;
  private strLits = new Map<string, string>(); // literal -> C name
  private strArrays = new Map<string, string>();

  constructor(
    private sf: ts.SourceFile,
    private title: string,
  ) {}

  private err(node: ts.Node, message: string): never {
    throw new VaporCompileError(this.sf, node, message);
  }

  // ---- module scan ---------------------------------------------------------

  compile(): CompiledApp {
    let component: ts.ArrowFunction | null = null;
    for (const stmt of this.sf.statements) {
      if (ts.isImportDeclaration(stmt)) this.scanImport(stmt);
      else if (ts.isInterfaceDeclaration(stmt)) this.scanInterface(stmt);
      else if (ts.isTypeAliasDeclaration(stmt)) continue; // types are erased
      else if (ts.isVariableStatement(stmt)) this.scanModuleConst(stmt);
      else if (ts.isExportAssignment(stmt)) {
        if (!ts.isArrowFunction(stmt.expression)) this.err(stmt, "export default must be an arrow component");
        component = stmt.expression;
      } else this.err(stmt, `unsupported module statement: ${ts.SyntaxKind[stmt.kind]}`);
    }
    if (!component) this.err(this.sf, "missing `export default () => ...` component");
    if (!this.vueRef || !this.vueComputed) this.err(this.sf, 'component must import { ref, computed } from "vue"');
    this.scanSetup(component);
    return this.emit();
  }

  private scanImport(stmt: ts.ImportDeclaration): void {
    const from = (stmt.moduleSpecifier as ts.StringLiteral).text;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) this.err(stmt, "only named imports are supported");
    for (const spec of bindings.elements) {
      const imported = (spec.propertyName ?? spec.name).text;
      const local = spec.name.text;
      if (from === "vue") {
        if (imported === "ref") this.vueRef = local;
        else if (imported === "computed") this.vueComputed = local;
        else this.err(spec, `unsupported vue import: ${imported} (subset allows ref, computed)`);
      } else if (/\/host\/input(\.ts)?$/.test(from)) {
        if (imported === "onButton") this.hostOnButton = local;
        else if (imported === "Button") this.hostButton = local;
        else this.err(spec, `unsupported host import: ${imported}`);
      } else this.err(stmt, `unsupported import source: ${from}`);
    }
  }

  private scanInterface(decl: ts.InterfaceDeclaration): void {
    const fields: IfaceShape["fields"] = [];
    for (const member of decl.members) {
      if (!ts.isPropertySignature(member) || !member.type || !ts.isIdentifier(member.name))
        this.err(member, "interface members must be `name: type`");
      const tyText = member.type.getText(this.sf);
      if (tyText !== "string" && tyText !== "boolean" && tyText !== "number")
        this.err(member.type, `interface field type must be string | boolean | number, got ${tyText}`);
      fields.push({
        name: member.name.text,
        ty: tyText === "string" ? "str" : tyText === "boolean" ? "bool" : "num",
      });
    }
    this.ifaces.set(decl.name.text, { name: decl.name.text, fields });
  }

  private scanModuleConst(stmt: ts.VariableStatement): void {
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) this.err(stmt, "module variables must be const");
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) this.err(decl, "const needs a simple name + initializer");
      const name = decl.name.text;
      const init = decl.initializer;
      if (ts.isNumericLiteral(init)) this.scope.set(name, { kind: "const", name, value: Number(init.text) });
      else if (ts.isStringLiteral(init)) this.scope.set(name, { kind: "const", name, value: init.text });
      else if (ts.isArrayLiteralExpression(init)) {
        const items = init.elements.map((el) => {
          if (!ts.isStringLiteral(el)) this.err(el, "const arrays must contain string literals");
          return el.text;
        });
        this.scope.set(name, { kind: "const", name, value: items });
      } else if (ts.isObjectLiteralExpression(init)) {
        const record: Record<string, number> = {};
        for (const prop of init.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name))
            this.err(prop, "const objects must use `name: number` members");
          const v = this.constNum(prop.initializer);
          if (v === null) this.err(prop.initializer, "const object members must be compile-time numbers");
          record[prop.name.text] = v;
        }
        this.scope.set(name, { kind: "const", name, value: record });
      } else this.err(init, "module consts must be number, string, string[], or {name: number} literals");
    }
  }

  // ---- setup scan ----------------------------------------------------------

  private scanSetup(component: ts.ArrowFunction): void {
    if (!ts.isBlock(component.body)) this.err(component, "component body must be a block");
    for (const stmt of component.body.statements) {
      if (ts.isVariableStatement(stmt)) this.scanSetupConst(stmt);
      else if (ts.isFunctionDeclaration(stmt)) {
        if (!stmt.name || !stmt.body) this.err(stmt, "setup functions need a name and body");
        const params = stmt.parameters.map((p) => {
          if (!ts.isIdentifier(p.name)) this.err(p, "helper params must be simple names");
          if (!p.type || p.type.getText(this.sf) !== "number")
            this.err(p, "helper params must be annotated `: number`");
          return p.name.text;
        });
        const binding: FnBinding = {
          kind: "fn",
          name: stmt.name.text,
          decl: stmt,
          emitted: false,
          deps: new Set(),
          params,
        };
        this.scope.set(stmt.name.text, binding);
        this.fns.push(binding);
      } else if (ts.isExpressionStatement(stmt)) {
        const call = stmt.expression;
        if (
          ts.isCallExpression(call) &&
          ts.isIdentifier(call.expression) &&
          call.expression.text === this.hostOnButton
        ) {
          if (this.handler) this.err(call, "only one onButton handler is supported");
          const arg = call.arguments[0];
          if (!arg || !ts.isArrowFunction(arg)) this.err(call, "onButton takes an arrow");
          this.handler = arg;
        } else this.err(stmt, "unsupported setup statement");
      } else if (ts.isReturnStatement(stmt)) {
        if (!stmt.expression) this.err(stmt, "component must return JSX");
        const expr = ts.isParenthesizedExpression(stmt.expression) ? stmt.expression.expression : stmt.expression;
        if (!ts.isJsxFragment(expr)) this.err(stmt, "component must return a JSX fragment (<>...</>)");
        this.template = expr;
      } else this.err(stmt, `unsupported setup statement: ${ts.SyntaxKind[stmt.kind]}`);
    }
    if (!this.template) this.err(component, "component never returned JSX");
  }

  private scanSetupConst(stmt: ts.VariableStatement): void {
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) this.err(decl, "setup const needs name + initializer");
      const name = decl.name.text;
      const init = decl.initializer;
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === this.vueRef) {
        const seed = init.arguments[0];
        if (!seed) this.err(init, "ref() needs an initial value");
        const binding: RefBinding = {
          kind: "ref",
          name,
          index: this.refs.length,
          refTy: this.classifyRefSeed(init, seed),
          seed,
        };
        if (binding.refTy === "list") binding.iface = this.listIfaceOf(init, seed);
        if (this.refs.length >= 16) this.err(init, "subset budget: at most 16 refs");
        this.refs.push(binding);
        this.scope.set(name, binding);
      } else if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === this.vueComputed
      ) {
        const arrow = init.arguments[0];
        if (!arrow || !ts.isArrowFunction(arrow)) this.err(init, "computed() takes an arrow");
        this.compileComputed(name, arrow);
      } else if (
        ts.isObjectLiteralExpression(init) &&
        init.properties.length > 0 &&
        init.properties.every((p) => ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name))
      ) {
        this.scanKeymap(name, init);
      } else {
        this.scanModuleConst(stmt);
        return;
      }
    }
  }

  private classifyRefSeed(at: ts.Node, seed: ts.Expression): RefBinding["refTy"] {
    if (ts.isNumericLiteral(seed) || ts.isPrefixUnaryExpression(seed)) return "num";
    if (seed.kind === ts.SyntaxKind.TrueKeyword || seed.kind === ts.SyntaxKind.FalseKeyword) return "bool";
    if (ts.isStringLiteral(seed)) return "str";
    if (ts.isArrayLiteralExpression(seed)) return "list";
    this.err(at, "ref() seed must be a number, boolean, string, or object-literal array");
  }

  private listIfaceOf(call: ts.CallExpression, seed: ts.Expression): string {
    const typeArg = call.typeArguments?.[0];
    if (typeArg && ts.isArrayTypeNode(typeArg) && ts.isTypeReferenceNode(typeArg.elementType)) {
      const name = typeArg.elementType.typeName.getText(this.sf);
      if (this.ifaces.has(name)) return name;
    }
    this.err(seed, "list refs need an explicit ref<T[]>(...) annotation with a declared interface T");
  }

  // ---- keymaps --------------------------------------------------------------
  // `const listKeys: Keymap = { [Button.Up]: () => ..., [Button.A]: action }`
  // Each value becomes a C function; the map becomes a 10-entry function-
  // pointer table in ROM, indexed by the GBA key bit. Dispatch is
  // `(cond ? mapA : mapB)[b]?.()` — undefined entries are null pointers.

  private keymaps: KeymapBinding[] = [];

  private scanKeymap(name: string, init: ts.ObjectLiteralExpression): void {
    const entries = new Map<number, string>();
    for (const prop of init.properties) {
      const pa = prop as ts.PropertyAssignment;
      const keyExpr = (pa.name as ts.ComputedPropertyName).expression;
      const key = this.constNum(keyExpr);
      if (key === null || key < 0 || key > 9)
        this.err(keyExpr, "keymap keys must be compile-time Button constants (0..9)");
      if (entries.has(key)) this.err(keyExpr, "duplicate keymap key");
      const value = this.unparen(pa.initializer);
      if (ts.isArrowFunction(value)) {
        if (value.parameters.length !== 0) this.err(value, "keymap actions take no arguments");
        const cName = `km_${name}_${key}`;
        this.compileActionArrow(cName, value);
        entries.set(key, cName);
      } else if (ts.isIdentifier(value)) {
        const b = this.scope.get(value.text);
        if (b?.kind !== "fn") this.err(value, "keymap values must be arrows or setup functions");
        if (b.params.length !== 0) this.err(value, `${b.name} takes arguments; wrap it in an arrow`);
        this.emitFn(b);
        entries.set(key, `fn_${b.name}`);
      } else this.err(pa.initializer, "keymap values must be arrows or setup functions");
    }
    const binding: KeymapBinding = { kind: "keymap", name, entries };
    this.keymaps.push(binding);
    this.scope.set(name, binding);
  }

  private compileActionArrow(cName: string, arrow: ts.ArrowFunction): void {
    const out: string[] = [];
    const saved = new Map(this.scope);
    if (ts.isBlock(arrow.body)) {
      for (const stmt of arrow.body.statements) this.compileStmt(stmt, out, "  ");
    } else {
      this.compileExprStmt(arrow.body, out, "  ");
    }
    this.scope = saved;
    this.bodies.push(`static void ${cName}(void) {\n${out.join("\n")}\n}\n`);
  }

  /** Resolve a keymap-typed expression to a C fnptr-table expression. */
  private compileKeymapExpr(e: ts.Expression, out: string[], ind: string): string | null {
    e = this.unparen(e);
    if (ts.isIdentifier(e)) {
      const b = this.scope.get(e.text);
      return b?.kind === "keymap" ? `KM_${b.name}` : null;
    }
    if (ts.isConditionalExpression(e)) {
      const a = this.compileKeymapExpr(e.whenTrue, out, ind);
      const bTab = this.compileKeymapExpr(e.whenFalse, out, ind);
      if (!a || !bTab) return null;
      const cond = this.compileExpr(e.condition, out, ind);
      return `(${this.truthy(cond)} ? ${a} : ${bTab})`;
    }
    return null;
  }

  // ---- shared emission helpers --------------------------------------------

  private tmp(prefix: string): string {
    return `${prefix}${this.tmpCounter++}`;
  }

  private cStrLit(text: string): string {
    let name = this.strLits.get(text);
    if (!name) {
      name = `S${this.strLits.size}`;
      this.strLits.set(text, name);
    }
    return name;
  }

  private escC(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private depRef(name: string): void {
    this.curDeps?.add(name);
  }

  private refBit(name: string): number {
    const b = this.scope.get(name);
    if (!b || b.kind !== "ref") throw new Error(`not a ref: ${name}`);
    return 1 << b.index;
  }

  private maskOf(deps: Set<string>): number {
    let mask = 0;
    for (const d of deps) mask |= this.refBit(d);
    return mask;
  }

  // ---- computed compilation -------------------------------------------------

  private compileComputed(name: string, arrow: ts.ArrowFunction): void {
    if (this.computeds.length >= 16) this.err(arrow, "subset budget: at most 16 computeds");
    const body = arrow.body;
    if (ts.isBlock(body)) this.err(body, "computed bodies must be single expressions");

    const deps = new Set<string>();
    const prevDeps = this.curDeps;
    this.curDeps = deps;
    const lines: string[] = [];

    const index = this.computeds.length;
    let binding: ComputedBinding;
    if (this.isViewExpr(body)) {
      const maxLen = this.viewMaxLen(body);
      binding = { kind: "computed", name, index, valTy: this.viewTyOf(body), deps, maxLen };
      this.compileViewInto(body, `c_${name}_v`, lines, "  ");
    } else {
      const val = this.compileExpr(body, lines, "  ");
      if (val.ty.k !== "num" && val.ty.k !== "bool" && val.ty.k !== "obj")
        this.err(body, "computed must yield a number, a record, or a list view");
      binding = {
        kind: "computed",
        name,
        index,
        valTy: val.ty.k === "obj" ? val.ty : NUM,
        deps,
        maxLen: 0,
      };
      lines.push(`  c_${name}_v = ${val.c};`);
    }
    this.curDeps = prevDeps;

    const cTy =
      binding.valTy.k === "view"
        ? { store: "static vp_view", accessor: "static const vp_view *", result: `&c_${name}_v` }
        : binding.valTy.k === "obj"
          ? {
              store: `static rec_${binding.valTy.iface.toLowerCase()} *`,
              accessor: `static rec_${binding.valTy.iface.toLowerCase()} *`,
              result: `c_${name}_v`,
            }
          : { store: "static s32", accessor: "static s32 ", result: `c_${name}_v` };
    this.decls.push(`${cTy.store} c_${name}_v;`);
    this.bodies.push(
      `static void c_${name}_update(void) {\n${lines.join("\n")}\n}\n` +
        `${cTy.accessor}c_${name}(void) {\n` +
        `  if (!(c_valid & ${1 << index}u)) { c_${name}_update(); c_valid |= ${1 << index}u; }\n` +
        `  return ${cTy.result};\n}\n`,
    );
    this.computeds.push(binding);
    this.scope.set(name, binding);
  }

  // A view expression: list-typed — todos.value, computed-view reads,
  // .filter(...), .slice(...), or a ternary of views.
  private isViewExpr(e: ts.Expression): boolean {
    e = this.unparen(e);
    if (ts.isConditionalExpression(e)) return this.isViewExpr(e.whenTrue) && this.isViewExpr(e.whenFalse);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const method = e.expression.name.text;
      if (method === "filter" || method === "slice") return this.isViewExpr(e.expression.expression);
      return false;
    }
    const base = this.valueBase(e);
    if (!base) return false;
    const b = this.scope.get(base);
    return (b?.kind === "ref" && b.refTy === "list") || (b?.kind === "computed" && b.valTy.k === "view");
  }

  /** `name.value` -> name, for ref/computed reads. */
  private valueBase(e: ts.Expression): string | null {
    e = this.unparen(e);
    if (
      ts.isPropertyAccessExpression(e) &&
      e.name.text === "value" &&
      ts.isIdentifier(e.expression)
    )
      return e.expression.text;
    return null;
  }

  private unparen(e: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  }

  private viewTyOf(e: ts.Expression): Ty {
    const iface = this.viewIface(e);
    return { k: "view", iface, listRef: this.viewListRef(e), maxLen: this.viewMaxLen(e) };
  }

  private viewIface(e: ts.Expression): string {
    return this.ifaceOfListRef(this.viewListRef(e));
  }

  private ifaceOfListRef(refName: string): string {
    const b = this.scope.get(refName);
    if (b?.kind === "ref" && b.iface) return b.iface;
    throw new Error(`no iface for list ref ${refName}`);
  }

  private viewListRef(e: ts.Expression): string {
    e = this.unparen(e);
    if (ts.isConditionalExpression(e)) return this.viewListRef(e.whenTrue);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression))
      return this.viewListRef(e.expression.expression);
    const base = this.valueBase(e);
    if (base) {
      const b = this.scope.get(base);
      if (b?.kind === "ref") return b.name;
      if (b?.kind === "computed" && b.valTy.k === "view") return b.valTy.listRef;
    }
    this.err(e, "cannot resolve the list this view reads");
  }

  private viewMaxLen(e: ts.Expression): number {
    e = this.unparen(e);
    if (ts.isConditionalExpression(e))
      return Math.max(this.viewMaxLen(e.whenTrue), this.viewMaxLen(e.whenFalse));
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const inner = this.viewMaxLen(e.expression.expression);
      if (e.expression.name.text === "filter") return inner;
      // slice(a, a + K) or slice(a, b): bound by constant difference if provable
      const [a, b] = e.arguments;
      const win = this.sliceWindow(a, b);
      return win === null ? inner : Math.min(inner, win);
    }
    const base = this.valueBase(e);
    if (base) {
      const b = this.scope.get(base);
      if (b?.kind === "ref") return POOL_CAP;
      if (b?.kind === "computed") return b.maxLen;
    }
    return POOL_CAP;
  }

  /** slice(x, x + K) with syntactically-identical x -> K. */
  private sliceWindow(a: ts.Expression | undefined, b: ts.Expression | undefined): number | null {
    if (!a || !b) return null;
    const bx = this.unparen(b);
    if (ts.isBinaryExpression(bx) && bx.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const k = this.constNum(bx.right);
      if (k !== null && bx.left.getText(this.sf) === a.getText(this.sf)) return k;
    }
    return null;
  }

  private constNum(e: ts.Expression): number | null {
    e = this.unparen(e);
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (ts.isIdentifier(e)) {
      const b = this.scope.get(e.text);
      if (b?.kind === "const" && typeof b.value === "number") return b.value;
    }
    if (ts.isPropertyAccessExpression(e)) {
      // GLYPHS.length, FILTERS.length, PAL.title, Button.X
      if (ts.isIdentifier(e.expression)) {
        const b = this.scope.get(e.expression.text);
        if (b?.kind === "const" && typeof b.value === "string" && e.name.text === "length") return b.value.length;
        if (b?.kind === "const" && Array.isArray(b.value) && e.name.text === "length") return b.value.length;
        if (b?.kind === "const" && typeof b.value === "object" && !Array.isArray(b.value)) {
          const record = b.value as Record<string, number>;
          if (e.name.text in record) return record[e.name.text];
        }
        if (e.expression.text === this.hostButton) {
          const buttons: Record<string, number> = {
            A: 0, B: 1, Select: 2, Start: 3, Right: 4, Left: 5, Up: 6, Down: 7, R: 8, L: 9,
          };
          if (e.name.text in buttons) return buttons[e.name.text];
        }
      }
    }
    if (ts.isBinaryExpression(e)) {
      const l = this.constNum(e.left);
      const r = this.constNum(e.right);
      if (l !== null && r !== null) {
        switch (e.operatorToken.kind) {
          case ts.SyntaxKind.PlusToken: return l + r;
          case ts.SyntaxKind.MinusToken: return l - r;
          case ts.SyntaxKind.AsteriskToken: return l * r;
        }
      }
    }
    return null;
  }

  /** Emit statements filling `target` (a vp_view lvalue) from a view expr. */
  private compileViewInto(e: ts.Expression, target: string, out: string[], ind: string): void {
    e = this.unparen(e);
    if (ts.isConditionalExpression(e)) {
      const cond = this.compileExpr(e.condition, out, ind);
      out.push(`${ind}if (${this.truthy(cond)}) {`);
      this.compileViewInto(e.whenTrue, target, out, ind + "  ");
      out.push(`${ind}} else {`);
      this.compileViewInto(e.whenFalse, target, out, ind + "  ");
      out.push(`${ind}}`);
      return;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const method = e.expression.name.text;
      const srcExpr = e.expression.expression;
      if (method === "filter") {
        const src = this.viewSource(srcExpr, out, ind);
        const arrow = e.arguments[0];
        if (!arrow || !ts.isArrowFunction(arrow) || ts.isBlock(arrow.body) || arrow.parameters.length !== 1)
          this.err(e, "filter takes a single-param expression arrow");
        const param = arrow.parameters[0].name.getText(this.sf);
        const iface = this.viewIface(srcExpr);
        const listRef = this.viewListRef(srcExpr);
        const i = this.tmp("i");
        const p = this.tmp("p");
        out.push(`${ind}{ u8 ${i}; ${target}.len = 0;`);
        out.push(`${ind}  for (${i} = 0; ${i} < ${src.len}; ${i}++) {`);
        out.push(`${ind}    rec_${iface.toLowerCase()} *${p} = &g_${listRef}[${src.at(i)}];`);
        const saved = new Map(this.scope);
        this.scope.set(param, { kind: "local", cName: p, ty: { k: "obj", iface, listRef } });
        const pred = this.compileExpr(arrow.body, out, ind + "    ");
        this.scope = saved;
        out.push(`${ind}    if (${this.truthy(pred)}) ${target}.idx[${target}.len++] = ${src.at(i)};`);
        out.push(`${ind}  }`);
        out.push(`${ind}}`);
        return;
      }
      if (method === "slice") {
        const src = this.viewSource(srcExpr, out, ind);
        const a = e.arguments[0] ? this.compileExpr(e.arguments[0], out, ind) : { c: "0", ty: NUM };
        const b = e.arguments[1] ? this.compileExpr(e.arguments[1], out, ind) : { c: src.len, ty: NUM };
        const s = this.tmp("s");
        const t = this.tmp("t");
        const i = this.tmp("i");
        out.push(`${ind}{ s32 ${s} = ${a.c}, ${t} = ${b.c}; u8 ${i};`);
        out.push(`${ind}  if (${s} < 0) ${s} = 0;`);
        out.push(`${ind}  if (${t} > (s32)${src.len}) ${t} = (s32)${src.len};`);
        out.push(`${ind}  ${target}.len = 0;`);
        out.push(`${ind}  for (${i} = (u8)${s}; (s32)${i} < ${t}; ${i}++) ${target}.idx[${target}.len++] = ${src.at(i)};`);
        out.push(`${ind}}`);
        return;
      }
      this.err(e, `unsupported view method: ${method}`);
    }
    // base case: identity over a list ref or copy of a computed view
    const src = this.viewSource(e, out, ind);
    const i = this.tmp("i");
    out.push(`${ind}{ u8 ${i}; ${target}.len = 0;`);
    out.push(`${ind}  for (${i} = 0; ${i} < ${src.len}; ${i}++) ${target}.idx[${target}.len++] = ${src.at(i)};`);
    out.push(`${ind}}`);
  }

  /** Resolve a view source to (len, at(i)) C fragments without materializing. */
  private viewSource(
    e: ts.Expression,
    out: string[],
    ind: string,
  ): { len: string; at: (i: string) => string } {
    e = this.unparen(e);
    const base = this.valueBase(e);
    if (base) {
      const b = this.scope.get(base);
      if (b?.kind === "ref" && b.refTy === "list") {
        this.depRef(b.name);
        return { len: `g_${b.name}_len`, at: (i) => i };
      }
      if (b?.kind === "computed" && b.valTy.k === "view") {
        for (const d of b.deps) this.depRef(d);
        const v = this.tmp("v");
        out.push(`${ind}const vp_view *${v} = c_${b.name}();`);
        return { len: `${v}->len`, at: (i) => `${v}->idx[${i}]` };
      }
    }
    // nested filter/slice chain: materialize into a temp view
    if (ts.isCallExpression(e)) {
      const v = this.tmp("vt");
      this.decls.push(`static vp_view ${v};`);
      this.compileViewInto(e, v, out, ind);
      return { len: `${v}.len`, at: (i) => `${v}.idx[${i}]` };
    }
    this.err(e, "unsupported view source");
  }

  private truthy(v: { c: string; ty: Ty }): string {
    if (v.ty.k === "obj") return `(${v.c} != 0)`;
    return v.c;
  }

  // ---- scalar expression compilation ---------------------------------------

  private compileExpr(e: ts.Expression, out: string[], ind: string): { c: string; ty: Ty } {
    e = this.unparen(e);
    const folded = this.constNum(e);
    if (folded !== null) return { c: String(folded), ty: NUM };

    if (ts.isNumericLiteral(e)) return { c: e.text, ty: NUM };
    if (e.kind === ts.SyntaxKind.TrueKeyword) return { c: "1", ty: BOOL };
    if (e.kind === ts.SyntaxKind.FalseKeyword) return { c: "0", ty: BOOL };
    if (ts.isStringLiteral(e)) return { c: this.cStrLit(e.text), ty: { k: "strlit" } };

    if (ts.isIdentifier(e)) {
      const b = this.scope.get(e.text);
      if (!b) this.err(e, `unknown identifier: ${e.text}`);
      if (b.kind === "const") {
        if (typeof b.value === "number") return { c: String(b.value), ty: NUM };
        if (typeof b.value === "string") return { c: this.cStrLit(b.value), ty: { k: "strlit" } };
        this.err(e, "string arrays can only be indexed");
      }
      if (b.kind === "local") return { c: b.cName, ty: b.ty };
      this.err(e, `identifier ${e.text} cannot be used as a value here`);
    }

    // name.value reads
    const base = this.valueBase(e);
    if (base) {
      const b = this.scope.get(base);
      if (b?.kind === "ref") {
        this.depRef(b.name);
        if (b.refTy === "num") return { c: `g_${b.name}`, ty: NUM };
        if (b.refTy === "bool") return { c: `g_${b.name}`, ty: BOOL };
        if (b.refTy === "str") return { c: `&g_${b.name}`, ty: { k: "sb" } };
        this.err(e, "list refs can only be used through list operations");
      }
      if (b?.kind === "computed") {
        for (const d of b.deps) this.depRef(d);
        if (b.valTy.k === "num") return { c: `c_${base}()`, ty: NUM };
        if (b.valTy.k === "obj") return { c: `c_${base}()`, ty: b.valTy };
        this.err(e, "view computeds can only be used through list operations");
      }
      this.err(e, `.value on non-reactive: ${base}`);
    }

    if (ts.isPropertyAccessExpression(e)) return this.compileMember(e, out, ind);
    if (ts.isElementAccessExpression(e)) return this.compileIndex(e, out, ind);
    if (ts.isCallExpression(e)) return this.compileCall(e, out, ind);

    if (ts.isPrefixUnaryExpression(e)) {
      const v = this.compileExpr(e.operand, out, ind);
      if (e.operator === ts.SyntaxKind.ExclamationToken) return { c: `!${this.truthy(v)}`, ty: BOOL };
      if (e.operator === ts.SyntaxKind.MinusToken) return { c: `(-${v.c})`, ty: NUM };
      this.err(e, "unsupported unary operator");
    }

    if (ts.isBinaryExpression(e)) return this.compileBinary(e, out, ind);

    if (ts.isConditionalExpression(e)) {
      const c = this.compileExpr(e.condition, out, ind);
      const a = this.compileExpr(e.whenTrue, out, ind);
      const b = this.compileExpr(e.whenFalse, out, ind);
      if (a.ty.k !== b.ty.k) this.err(e, `ternary arms differ: ${a.ty.k} vs ${b.ty.k}`);
      return { c: `(${this.truthy(c)} ? ${a.c} : ${b.c})`, ty: a.ty };
    }

    this.err(e, `unsupported expression: ${ts.SyntaxKind[e.kind]}`);
  }

  private compileMember(e: ts.PropertyAccessExpression, out: string[], ind: string): { c: string; ty: Ty } {
    const prop = e.name.text;
    const objExpr = this.unparen(e.expression);

    // <view or list>.length
    if (prop === "length") {
      if (this.isViewExpr(objExpr)) {
        const src = this.viewSource(objExpr, out, ind);
        return { c: `(s32)${src.len}`, ty: NUM };
      }
      const v = this.compileExpr(objExpr, out, ind);
      if (v.ty.k === "sb") return { c: `(s32)(${v.c})->len`, ty: NUM };
      this.err(e, ".length on unsupported value");
    }

    // record field access t.done / t.text
    const v = this.compileExpr(objExpr, out, ind);
    if (v.ty.k === "obj") {
      const iface = this.ifaces.get(v.ty.iface)!;
      const field = iface.fields.find((f) => f.name === prop);
      if (!field) this.err(e, `no field ${prop} on ${v.ty.iface}`);
      this.depRef(v.ty.listRef);
      if (field.ty === "num") return { c: `${v.c}->${prop}`, ty: NUM };
      if (field.ty === "bool") return { c: `${v.c}->${prop}`, ty: BOOL };
      return { c: `&${v.c}->${prop}`, ty: { k: "sb" } };
    }
    this.err(e, `unsupported member access .${prop}`);
  }

  private compileIndex(e: ts.ElementAccessExpression, out: string[], ind: string): { c: string; ty: Ty } {
    const objExpr = this.unparen(e.expression);
    const idx = this.compileExpr(e.argumentExpression, out, ind);

    // const string array / const string indexing
    if (ts.isIdentifier(objExpr)) {
      const b = this.scope.get(objExpr.text);
      if (b?.kind === "const" && Array.isArray(b.value)) {
        return { c: `vp_cstr_at(${this.cStrArray(b.name, b.value)}, ${b.value.length}, ${idx.c})`, ty: { k: "strlit" } };
      }
      if (b?.kind === "const" && typeof b.value === "string") {
        return { c: `vp_char_at(${this.cStrLit(b.value)}, ${b.value.length}, ${idx.c})`, ty: { k: "char" } };
      }
    }

    // view / list indexing -> nullable record pointer
    if (this.isViewExpr(objExpr)) {
      const src = this.viewSource(objExpr, out, ind);
      const listRef = this.viewListRef(objExpr);
      const iface = this.viewIface(objExpr);
      this.depRef(listRef);
      const p = this.tmp("e");
      out.push(
        `${ind}rec_${iface.toLowerCase()} *${p} = (${idx.c} >= 0 && ${idx.c} < (s32)${src.len}) ? &g_${listRef}[${src.at(`(u8)(${idx.c})`)}] : 0;`,
      );
      return { c: p, ty: { k: "obj", iface, listRef } };
    }
    this.err(e, "unsupported indexing");
  }

  private cStrArray(name: string, values: string[]): string {
    let cName = this.strArrays.get(name);
    if (!cName) {
      cName = `A_${name}`;
      this.strArrays.set(name, cName);
      const parts = values.map((v) => `"${this.escC(v)}"`).join(", ");
      this.decls.push(`static const char *const ${cName}[${values.length}] = { ${parts} };`);
    }
    return cName;
  }

  private compileCall(e: ts.CallExpression, out: string[], ind: string): { c: string; ty: Ty } {
    const callee = this.unparen(e.expression);
    // Math.min/max
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Math"
    ) {
      const args = e.arguments.map((a) => this.compileExpr(a, out, ind).c);
      if (callee.name.text === "max") return { c: `vp_max(${args.join(", ")})`, ty: NUM };
      if (callee.name.text === "min") return { c: `vp_min(${args.join(", ")})`, ty: NUM };
      this.err(e, `unsupported Math.${callee.name.text}`);
    }
    // list.indexOf(ptr)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "indexOf") {
      const listRef = this.viewListRef(callee.expression);
      const arg = this.compileExpr(e.arguments[0], out, ind);
      if (arg.ty.k !== "obj") this.err(e, "indexOf takes a record from the same list");
      this.depRef(listRef);
      return { c: `(s32)(${arg.c} - g_${listRef})`, ty: NUM };
    }
    // setup helper call (statement position handles void fns)
    if (ts.isIdentifier(callee)) {
      const b = this.scope.get(callee.text);
      if (b?.kind === "fn") {
        if (e.arguments.length !== b.params.length)
          this.err(e, `${b.name} takes ${b.params.length} argument(s)`);
        const args = e.arguments.map((a) => {
          const v = this.compileExpr(a, out, ind);
          if (v.ty.k !== "num" && v.ty.k !== "bool") this.err(a, "helper arguments must be numbers");
          return v.c;
        });
        this.emitFn(b);
        for (const d of b.deps) this.depRef(d);
        return { c: `fn_${b.name}(${args.join(", ")})`, ty: { k: "void" } };
      }
    }
    this.err(e, "unsupported call");
  }

  private compileBinary(e: ts.BinaryExpression, out: string[], ind: string): { c: string; ty: Ty } {
    const op = e.operatorToken.kind;
    const K = ts.SyntaxKind;
    if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
      const l = this.compileExpr(e.left, out, ind);
      const r = this.compileExpr(e.right, out, ind);
      const cop = op === K.AmpersandAmpersandToken ? "&&" : "||";
      return { c: `(${this.truthy(l)} ${cop} ${this.truthy(r)})`, ty: BOOL };
    }
    const l = this.compileExpr(e.left, out, ind);
    const r = this.compileExpr(e.right, out, ind);
    const table: Partial<Record<ts.SyntaxKind, string>> = {
      [K.PlusToken]: "+",
      [K.MinusToken]: "-",
      [K.AsteriskToken]: "*",
      [K.SlashToken]: "/",
      [K.PercentToken]: "%",
      [K.LessThanToken]: "<",
      [K.GreaterThanToken]: ">",
      [K.LessThanEqualsToken]: "<=",
      [K.GreaterThanEqualsToken]: ">=",
      [K.EqualsEqualsEqualsToken]: "==",
      [K.ExclamationEqualsEqualsToken]: "!=",
    };
    const cop = table[op];
    if (!cop) this.err(e, `unsupported operator (note: use === / !==)`);
    if (op === K.PlusToken && (l.ty.k === "sb" || l.ty.k === "strlit" || l.ty.k === "char"))
      this.err(e, "string concatenation is only supported as the right side of a string ref assignment");
    const isCmp = [K.LessThanToken, K.GreaterThanToken, K.LessThanEqualsToken, K.GreaterThanEqualsToken, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken].includes(op);
    if (isCmp && l.ty.k === "obj" && r.ty.k === "obj") return { c: `(${l.c} ${cop} ${r.c})`, ty: BOOL };
    return { c: `(${l.c} ${cop} ${r.c})`, ty: isCmp ? BOOL : NUM };
  }

  // ---- string-building (str ref assignment RHS) ----------------------------

  private compileStringInto(e: ts.Expression, sb: string, out: string[], ind: string): void {
    e = this.unparen(e);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      this.compileStringInto(e.left, sb, out, ind);
      this.compileStringInto(e.right, sb, out, ind);
      return;
    }
    if (ts.isStringLiteral(e)) {
      if (e.text.length > 0) out.push(`${ind}vp_sb_str(&${sb}, ${this.cStrLit(e.text)});`);
      return;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "slice") {
      const srcV = this.compileExpr(e.expression.expression, out, ind);
      if (srcV.ty.k !== "sb") this.err(e, ".slice source must be a string ref");
      const a = e.arguments[0] ? this.compileExpr(e.arguments[0], out, ind) : { c: "0", ty: NUM };
      const b = e.arguments[1]
        ? this.compileExpr(e.arguments[1], out, ind)
        : { c: `(s32)(${srcV.c})->len`, ty: NUM };
      out.push(`${ind}{ vp_sb sl; vp_sb_slice(&sl, ${srcV.c}, ${a.c}, ${b.c}); vp_sb_sb(&${sb}, &sl); }`);
      return;
    }
    const v = this.compileExpr(e, out, ind);
    if (v.ty.k === "sb") out.push(`${ind}vp_sb_sb(&${sb}, ${v.c});`);
    else if (v.ty.k === "strlit") out.push(`${ind}vp_sb_str(&${sb}, ${v.c});`);
    else if (v.ty.k === "char") out.push(`${ind}vp_sb_ch(&${sb}, ${v.c});`);
    else this.err(e, "unsupported piece in string expression");
  }

  // ---- statements (handlers + setup fns) -----------------------------------

  private compileStmt(stmt: ts.Statement, out: string[], ind: string): void {
    if (ts.isReturnStatement(stmt)) {
      if (stmt.expression) this.err(stmt, "handlers cannot return values");
      out.push(`${ind}return;`);
      return;
    }
    if (ts.isIfStatement(stmt)) {
      const cond = this.compileExpr(stmt.expression, out, ind);
      out.push(`${ind}if (${this.truthy(cond)}) {`);
      this.compileStmt(stmt.thenStatement, out, ind + "  ");
      if (stmt.elseStatement) {
        out.push(`${ind}} else {`);
        this.compileStmt(stmt.elseStatement, out, ind + "  ");
      }
      out.push(`${ind}}`);
      return;
    }
    if (ts.isBlock(stmt)) {
      const saved = new Map(this.scope);
      for (const s of stmt.statements) this.compileStmt(s, out, ind);
      this.scope = saved;
      return;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) this.err(decl, "locals need name + initializer");
        const name = decl.name.text;
        const init = decl.initializer;
        const inner: string[] = [];
        const v = this.compileExpr(init, inner, ind);
        out.push(...inner);
        const cName = this.tmp(`l_${name}_`);
        if (v.ty.k === "num") out.push(`${ind}s32 ${cName} = ${v.c};`);
        else if (v.ty.k === "bool") out.push(`${ind}u8 ${cName} = ${v.c};`);
        else if (v.ty.k === "obj") out.push(`${ind}rec_${v.ty.iface.toLowerCase()} *${cName} = ${v.c};`);
        else this.err(decl, `unsupported local type: ${v.ty.k}`);
        this.scope.set(name, { kind: "local", cName, ty: v.ty });
      }
      return;
    }
    if (ts.isForStatement(stmt)) {
      const initDecl = stmt.initializer;
      if (!initDecl || !ts.isVariableDeclarationList(initDecl) || initDecl.declarations.length !== 1)
        this.err(stmt, "for loops need `let i = ...`");
      const d = initDecl.declarations[0];
      if (!ts.isIdentifier(d.name) || !d.initializer) this.err(stmt, "for loops need `let i = <expr>`");
      const cName = this.tmp(`l_${d.name.text}_`);
      const init = this.compileExpr(d.initializer, out, ind);
      const saved = new Map(this.scope);
      this.scope.set(d.name.text, { kind: "local", cName, ty: NUM });
      const cond = stmt.condition ? this.compileExpr(stmt.condition, out, ind) : { c: "1", ty: BOOL };
      const incr = stmt.incrementor ? this.compileIncrement(stmt.incrementor) : "";
      out.push(`${ind}{ s32 ${cName};`);
      out.push(`${ind}for (${cName} = ${init.c}; ${this.truthy(cond)}; ${incr}) {`);
      this.compileStmt(stmt.statement, out, ind + "  ");
      out.push(`${ind}} }`);
      this.scope = saved;
      return;
    }
    if (ts.isExpressionStatement(stmt)) {
      this.compileExprStmt(stmt.expression, out, ind);
      return;
    }
    this.err(stmt, `unsupported statement: ${ts.SyntaxKind[stmt.kind]}`);
  }

  private compileIncrement(e: ts.Expression): string {
    e = this.unparen(e);
    if (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) {
      const operand = (e as ts.PostfixUnaryExpression).operand;
      if (ts.isIdentifier(operand)) {
        const b = this.scope.get(operand.text);
        if (b?.kind === "local") {
          const op = e.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--";
          return `${b.cName}${op}`;
        }
      }
    }
    this.err(e, "for-loop increment must be i++ or i--");
  }

  private compileExprStmt(e: ts.Expression, out: string[], ind: string): void {
    e = this.unparen(e);
    // assignments
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      this.compileAssign(e.left, e.right, out, ind);
      return;
    }
    // push / splice / helper calls
    if (ts.isCallExpression(e)) {
      const callee = this.unparen(e.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (method === "push") {
          this.compilePush(callee.expression, e, out, ind);
          return;
        }
        if (method === "splice") {
          this.compileSplice(callee.expression, e, out, ind);
          return;
        }
      }
      if (ts.isIdentifier(callee)) {
        const b = this.scope.get(callee.text);
        if (b?.kind === "fn") {
          const v = this.compileCall(e, out, ind);
          out.push(`${ind}${v.c};`);
          return;
        }
      }
      // keymap dispatch: (cond ? mapA : mapB)[b]?.() or map[b]?.()
      if (ts.isElementAccessExpression(callee)) {
        const table = this.compileKeymapExpr(callee.expression, out, ind);
        if (table) {
          const idx = this.compileExpr(callee.argumentExpression, out, ind);
          const km = this.tmp("km");
          const bi = this.tmp("bi");
          out.push(`${ind}{ void (*const *${km})(void) = ${table}; s32 ${bi} = ${idx.c};`);
          out.push(`${ind}  if (${bi} >= 0 && ${bi} < 10 && ${km}[${bi}]) ${km}[${bi}](); }`);
          return;
        }
      }
    }
    // compound assignment sugar: x.value += e, x.value -= e, ...
    if (ts.isBinaryExpression(e)) {
      const K = ts.SyntaxKind;
      const sugar: Partial<Record<ts.SyntaxKind, ts.BinaryOperator>> = {
        [K.PlusEqualsToken]: K.PlusToken,
        [K.MinusEqualsToken]: K.MinusToken,
        [K.AsteriskEqualsToken]: K.AsteriskToken,
        [K.PercentEqualsToken]: K.PercentToken,
      };
      const op = sugar[e.operatorToken.kind];
      if (op) {
        const rhs = ts.factory.createBinaryExpression(e.left, op, ts.isParenthesizedExpression(e.right) ? e.right : ts.factory.createParenthesizedExpression(e.right));
        this.compileAssign(e.left, rhs, out, ind);
        return;
      }
    }
    // ++ / -- statement sugar
    if (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) {
      const op = e.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        const one = ts.factory.createNumericLiteral("1");
        const rhs = ts.factory.createBinaryExpression(
          e.operand,
          op === ts.SyntaxKind.PlusPlusToken ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken,
          one,
        );
        this.compileAssign(e.operand, rhs, out, ind);
        return;
      }
    }
    this.err(e, "unsupported expression statement");
  }

  private markCode(refName: string): string {
    const b = this.scope.get(refName);
    if (!b || b.kind !== "ref") throw new Error(`mark on non-ref ${refName}`);
    return `vp_mark(${b.index})`;
  }

  private compileAssign(lhs: ts.Expression, rhs: ts.Expression, out: string[], ind: string): void {
    lhs = this.unparen(lhs);
    // ref.value = ...
    const base = this.valueBase(lhs);
    if (base) {
      const b = this.scope.get(base);
      if (b?.kind !== "ref") this.err(lhs, `.value assignment on non-ref ${base}`);
      if (b.refTy === "num" || b.refTy === "bool") {
        const v = this.compileExpr(rhs, out, ind);
        const tmp = this.tmp("nv");
        out.push(`${ind}{ s32 ${tmp} = ${v.c}; if (g_${b.name} != ${tmp}) { g_${b.name} = ${tmp}; ${this.markCode(b.name)}; } }`);
        return;
      }
      if (b.refTy === "str") {
        const tmp = this.tmp("sb");
        out.push(`${ind}{ vp_sb ${tmp}; vp_sb_reset(&${tmp});`);
        this.compileStringInto(rhs, tmp, out, ind + "  ");
        out.push(`${ind}  if (vp_sb_assign(&g_${b.name}, &${tmp})) ${this.markCode(b.name)};`);
        out.push(`${ind}}`);
        return;
      }
      // whole-list assignment: todos.value = todos.value.filter(...)
      // Views over one list always carry increasing pool indices (identity
      // -> filter -> slice preserve order), so in-place compaction is safe.
      if (b.refTy === "list") {
        if (!this.isViewExpr(this.unparen(rhs)))
          this.err(rhs, "list refs can only be assigned a filter/slice view");
        if (this.viewListRef(this.unparen(rhs)) !== b.name)
          this.err(rhs, "list assignment must derive from the same list");
        const nv = this.tmp("nv");
        const k = this.tmp("k");
        out.push(`${ind}{ vp_view ${nv}; u8 ${k};`);
        this.compileViewInto(this.unparen(rhs), nv, out, ind + "  ");
        out.push(`${ind}  for (${k} = 0; ${k} < ${nv}.len; ${k}++) g_${b.name}[${k}] = g_${b.name}[${nv}.idx[${k}]];`);
        out.push(`${ind}  g_${b.name}_len = ${nv}.len;`);
        out.push(`${ind}  ${this.markCode(b.name)}; /* new array identity always triggers */`);
        out.push(`${ind}}`);
        return;
      }
      this.err(lhs, "unsupported ref assignment");
    }
    // t.done = ... (record field write)
    if (ts.isPropertyAccessExpression(lhs)) {
      const obj = this.compileExpr(lhs.expression, out, ind);
      if (obj.ty.k !== "obj") this.err(lhs, "field assignment target must be a record");
      const iface = this.ifaces.get(obj.ty.iface)!;
      const field = iface.fields.find((f) => f.name === lhs.name.text);
      if (!field) this.err(lhs, `no field ${lhs.name.text} on ${obj.ty.iface}`);
      if (field.ty === "str") this.err(lhs, "string field writes only via push");
      const v = this.compileExpr(rhs, out, ind);
      const tmp = this.tmp("fv");
      const cast = field.ty === "bool" ? "(u8)" : "(s32)";
      out.push(
        `${ind}{ ${field.ty === "bool" ? "u8" : "s32"} ${tmp} = ${cast}(${this.truthy(v)}); if (${obj.c}->${lhs.name.text} != ${tmp}) { ${obj.c}->${lhs.name.text} = ${tmp}; ${this.markCode(obj.ty.listRef)}; } }`,
      );
      return;
    }
    this.err(lhs, "unsupported assignment target");
  }

  private compilePush(listExpr: ts.Expression, call: ts.CallExpression, out: string[], ind: string): void {
    const listRef = this.viewListRef(listExpr);
    const b = this.scope.get(listRef);
    if (b?.kind !== "ref" || b.refTy !== "list") this.err(call, "push only on list refs");
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) this.err(call, "push takes an object literal");
    const iface = this.ifaces.get(b.iface!)!;
    out.push(`${ind}if (g_${listRef}_len < ${POOL_CAP}) {`);
    out.push(`${ind}  rec_${iface.name.toLowerCase()} *np = &g_${listRef}[g_${listRef}_len++];`);
    for (const propNode of arg.properties) {
      if (!ts.isPropertyAssignment(propNode) || !ts.isIdentifier(propNode.name))
        this.err(propNode, "push object must use `field: value`");
      const field = iface.fields.find((f) => f.name === (propNode.name as ts.Identifier).text);
      if (!field) this.err(propNode, `no field ${propNode.name.getText(this.sf)} on ${iface.name}`);
      if (field.ty === "str") {
        const tmp = this.tmp("sb");
        out.push(`${ind}  { vp_sb ${tmp}; vp_sb_reset(&${tmp});`);
        this.compileStringInto(propNode.initializer, tmp, out, ind + "    ");
        out.push(`${ind}    vp_sb_assign(&np->${field.name}, &${tmp}); }`);
      } else {
        const v = this.compileExpr(propNode.initializer, out, ind);
        out.push(`${ind}  np->${field.name} = ${field.ty === "bool" ? this.truthy(v) : v.c};`);
      }
    }
    out.push(`${ind}} else { vp_tripwires |= VP_TRIP_POOL_FULL; }`);
    out.push(`${ind}${this.markCode(listRef)};`);
  }

  private compileSplice(listExpr: ts.Expression, call: ts.CallExpression, out: string[], ind: string): void {
    const listRef = this.viewListRef(listExpr);
    const b = this.scope.get(listRef);
    if (b?.kind !== "ref" || b.refTy !== "list") this.err(call, "splice only on list refs");
    const count = call.arguments[1];
    if (!count || this.constNum(count) !== 1) this.err(call, "only splice(i, 1) is supported");
    const idx = this.compileExpr(call.arguments[0], out, ind);
    const i = this.tmp("i");
    const at = this.tmp("at");
    out.push(`${ind}{ s32 ${at} = ${idx.c}; u8 ${i};`);
    out.push(`${ind}  if (${at} >= 0 && ${at} < (s32)g_${listRef}_len) {`);
    out.push(`${ind}    for (${i} = (u8)${at}; ${i} + 1 < g_${listRef}_len; ${i}++) g_${listRef}[${i}] = g_${listRef}[${i} + 1];`);
    out.push(`${ind}    g_${listRef}_len--;`);
    out.push(`${ind}  }`);
    out.push(`${ind}  ${this.markCode(listRef)};`);
    out.push(`${ind}}`);
  }

  private emitFn(b: FnBinding): void {
    if (b.emitted) return;
    b.emitted = true; // set first: recursion guard
    const out: string[] = [];
    const prevDeps = this.curDeps;
    this.curDeps = b.deps;
    const saved = new Map(this.scope);
    for (const p of b.params) this.scope.set(p, { kind: "local", cName: `p_${p}`, ty: NUM });
    for (const stmt of b.decl.body!.statements) this.compileStmt(stmt, out, "  ");
    this.scope = saved;
    this.curDeps = prevDeps;
    const sig = b.params.length ? b.params.map((p) => `s32 p_${p}`).join(", ") : "void";
    this.bodies.push(`static void fn_${b.name}(${sig}) {\n${out.join("\n")}\n}\n`);
  }

  // ---- JSX -> effects -------------------------------------------------------

  private emitTemplate(): {
    inits: string[];
    effects: { name: string; mask: number; span: [number, number] }[];
  } {
    interface Unit {
      span: [number, number];
      deps: Set<string>;
      body: string[];
      isStatic: boolean;
    }
    const units: Unit[] = [];

    for (const rawChild of this.template!.children) {
      if (ts.isJsxText(rawChild)) {
        if (rawChild.text.trim() !== "") this.err(rawChild, "stray text at fragment root");
        continue;
      }
      if (ts.isJsxElement(rawChild)) {
        units.push(this.compileRowUnit(rawChild));
        continue;
      }
      if (ts.isJsxExpression(rawChild)) {
        const expr = rawChild.expression;
        if (!expr) continue;
        const inner = this.unparen(expr);
        if (ts.isConditionalExpression(inner)) {
          units.push(this.compileConditionalUnit(inner));
          continue;
        }
        if (
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          inner.expression.name.text === "map"
        ) {
          units.push(this.compileMapUnit(inner));
          continue;
        }
        this.err(rawChild, "fragment children must be <row>, {cond ? <row/> : null}, or {view.map(...)}");
      }
    }

    // static rows paint once; overlap with a dynamic span demotes to dynamic
    const dynamic = units.filter((u) => !u.isStatic);
    const overlap = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
    for (const u of units) {
      if (u.isStatic && dynamic.some((d) => overlap(d.span, u.span))) u.isStatic = false;
    }

    // merge overlapping dynamic units (document order preserved)
    const merged: Unit[] = [];
    for (const u of units.filter((x) => !x.isStatic)) {
      const hit = merged.find((m) => overlap(m.span, u.span));
      if (hit) {
        hit.span = [Math.min(hit.span[0], u.span[0]), Math.max(hit.span[1], u.span[1])];
        for (const d of u.deps) hit.deps.add(d);
        hit.body.push(...u.body);
      } else {
        merged.push({ ...u, deps: new Set(u.deps), body: [...u.body], span: [...u.span] as [number, number] });
      }
    }
    // re-merge until fixpoint (span growth can create new overlaps)
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < merged.length && !changed; i++) {
        for (let j = i + 1; j < merged.length && !changed; j++) {
          if (overlap(merged[i].span, merged[j].span)) {
            merged[i].span = [
              Math.min(merged[i].span[0], merged[j].span[0]),
              Math.max(merged[i].span[1], merged[j].span[1]),
            ];
            for (const d of merged[j].deps) merged[i].deps.add(d);
            merged[i].body.push(...merged[j].body);
            merged.splice(j, 1);
            changed = true;
          }
        }
      }
    }

    const inits: string[] = [];
    for (const u of units.filter((x) => x.isStatic)) inits.push(...u.body);

    const effects: { name: string; mask: number; span: [number, number] }[] = [];
    merged.forEach((u, i) => {
      const name = `eff_${i}`;
      const body = [`  vp_row_clear(${u.span[0]}, ${u.span[1]});`, ...u.body];
      this.bodies.push(`static void ${name}(void) {\n${body.join("\n")}\n}\n`);
      effects.push({ name, mask: this.maskOf(u.deps), span: u.span });
    });
    return { inits, effects };
  }

  private jsxAttr(el: ts.JsxElement, name: string): ts.Expression | undefined {
    for (const attr of el.openingElement.attributes.properties) {
      if (ts.isJsxAttribute(attr) && attr.name.getText(this.sf) === name) {
        if (!attr.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression)
          this.err(attr, `attribute ${name} must be {expr}`);
        return attr.initializer.expression;
      }
    }
    return undefined;
  }

  /** Compile one <row> paint (dynamic y allowed for map rows). */
  private compileRowPaint(
    el: ts.JsxElement,
    yC: string,
    out: string[],
    ind: string,
  ): void {
    const xExpr = this.jsxAttr(el, "x");
    const palExpr = this.jsxAttr(el, "pal");
    const x = xExpr ? this.constNum(xExpr) : 0;
    if (x === null) this.err(el, "row x must be compile-time constant");
    const pal = palExpr ? this.compileExpr(palExpr, out, ind) : { c: "0", ty: NUM };
    const palV = this.tmp("pal");
    const colV = this.tmp("col");
    out.push(`${ind}{ u8 ${palV} = (u8)(${pal.c}); u8 ${colV} = ${x};`);
    for (const child of el.children) {
      if (ts.isJsxText(child)) {
        const text = child.text.replace(/\s*\n\s*/g, "");
        if (text) out.push(`${ind}  vp_put_str(${yC}, &${colV}, ${palV}, ${this.cStrLit(text)});`);
        continue;
      }
      if (ts.isJsxExpression(child)) {
        if (!child.expression) continue;
        const v = this.compileExpr(child.expression, out, ind + "  ");
        if (v.ty.k === "strlit") out.push(`${ind}  vp_put_str(${yC}, &${colV}, ${palV}, ${v.c});`);
        else if (v.ty.k === "sb") out.push(`${ind}  vp_put_sb(${yC}, &${colV}, ${palV}, ${v.c});`);
        else if (v.ty.k === "char") out.push(`${ind}  vp_put_ch(${yC}, &${colV}, ${palV}, ${v.c});`);
        else if (v.ty.k === "num") out.push(`${ind}  vp_put_int(${yC}, &${colV}, ${palV}, ${v.c});`);
        else this.err(child, `cannot interpolate a ${v.ty.k} into a row`);
        continue;
      }
      this.err(child, "rows may contain only text and {expr} interpolations");
    }
    out.push(`${ind}  vp_pad(${yC}, ${colV}, ${palV});`);
    out.push(`${ind}}`);
  }

  private rowConstY(el: ts.JsxElement): number {
    const yExpr = this.jsxAttr(el, "y");
    if (!yExpr) this.err(el, "row needs a y attribute");
    const y = this.constNum(yExpr);
    if (y === null) this.err(el, "row y must be compile-time constant here");
    if (y < 0 || y >= 20) this.err(el, `row y out of range: ${y}`);
    return y;
  }

  private compileRowUnit(el: ts.JsxElement): {
    span: [number, number];
    deps: Set<string>;
    body: string[];
    isStatic: boolean;
  } {
    if (el.openingElement.tagName.getText(this.sf) !== "row") this.err(el, "only <row> elements exist");
    const y = this.rowConstY(el);
    const deps = new Set<string>();
    const prev = this.curDeps;
    this.curDeps = deps;
    const body: string[] = [];
    this.compileRowPaint(el, String(y), body, "  ");
    this.curDeps = prev;
    return { span: [y, y + 1], deps, body, isStatic: deps.size === 0 };
  }

  private compileConditionalUnit(e: ts.ConditionalExpression): {
    span: [number, number];
    deps: Set<string>;
    body: string[];
    isStatic: boolean;
  } {
    const whenTrue = this.unparen(e.whenTrue);
    if (!ts.isJsxElement(whenTrue) || e.whenFalse.kind !== ts.SyntaxKind.NullKeyword)
      this.err(e, "conditional children must be {cond ? <row/> : null}");
    const y = this.rowConstY(whenTrue);
    const deps = new Set<string>();
    const prev = this.curDeps;
    this.curDeps = deps;
    const body: string[] = [];
    const cond = this.compileExpr(e.condition, body, "  ");
    body.push(`  if (${this.truthy(cond)}) {`);
    this.compileRowPaint(whenTrue, String(y), body, "    ");
    body.push(`  }`);
    this.curDeps = prev;
    return { span: [y, y + 1], deps, body, isStatic: false };
  }

  private compileMapUnit(call: ts.CallExpression): {
    span: [number, number];
    deps: Set<string>;
    body: string[];
    isStatic: boolean;
  } {
    const viewExpr = (call.expression as ts.PropertyAccessExpression).expression;
    if (!this.isViewExpr(viewExpr)) this.err(call, ".map is only supported on list views");
    const arrow = call.arguments[0];
    if (!arrow || !ts.isArrowFunction(arrow)) this.err(call, ".map takes an arrow");
    const rowJsx = this.unparen(arrow.body as ts.Expression);
    if (!ts.isJsxElement(rowJsx)) this.err(call, ".map arrow must return a <row>");
    const [itemParam, indexParam] = arrow.parameters.map((p) => p.name.getText(this.sf));
    if (!itemParam || !indexParam) this.err(arrow, ".map arrow needs (item, index) params");

    const yExpr = this.jsxAttr(rowJsx, "y");
    if (!yExpr) this.err(rowJsx, "row needs y");

    const deps = new Set<string>();
    const prev = this.curDeps;
    this.curDeps = deps;
    const body: string[] = [];

    const src = this.viewSource(viewExpr, body, "  ");
    const listRef = this.viewListRef(viewExpr);
    const iface = this.viewIface(viewExpr);
    const maxLen = this.viewMaxLen(viewExpr);
    const iV = this.tmp("i");
    const pV = this.tmp("t");
    body.push(`  { u8 ${iV};`);
    body.push(`  for (${iV} = 0; ${iV} < ${src.len}; ${iV}++) {`);
    body.push(`    rec_${iface.toLowerCase()} *${pV} = &g_${listRef}[${src.at(iV)}];`);

    const saved = new Map(this.scope);
    this.scope.set(itemParam, { kind: "local", cName: pV, ty: { k: "obj", iface, listRef } });
    this.scope.set(indexParam, { kind: "local", cName: `(s32)${iV}`, ty: NUM });
    const yV = this.compileExpr(yExpr, body, "    ");
    const yTmp = this.tmp("y");
    body.push(`    { u8 ${yTmp} = (u8)(${yV.c});`);
    body.push(`    if (${yTmp} < ${20}) {`);
    this.compileRowPaint(rowJsx, yTmp, body, "      ");
    body.push(`    } }`);
    this.scope = saved;
    body.push(`  } }`);
    this.curDeps = prev;

    // span: y = base + i requires resolving the base constant
    const yBase = this.mapYBase(yExpr, indexParam);
    const span: [number, number] = [yBase, Math.min(20, yBase + maxLen)];
    return { span, deps, body, isStatic: false };
  }

  /** y must be `i` or `CONST + i` / `i + CONST` inside a map row. */
  private mapYBase(yExpr: ts.Expression, indexParam: string): number {
    const e = this.unparen(yExpr);
    if (ts.isIdentifier(e) && e.text === indexParam) return 0;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.constNum(e.left);
      const r = this.constNum(e.right);
      if (l !== null && ts.isIdentifier(e.right) && e.right.text === indexParam) return l;
      if (r !== null && ts.isIdentifier(e.left) && e.left.text === indexParam) return r;
    }
    this.err(yExpr, "map row y must be `i` or `CONST + i`");
  }

  // ---- final emission -------------------------------------------------------

  private emit(): CompiledApp {
    // handler
    if (!this.handler) this.err(this.sf, "component must register onButton");
    const handlerOut: string[] = [];
    {
      const saved = new Map(this.scope);
      const param = this.handler.parameters[0]?.name.getText(this.sf);
      if (!param) this.err(this.handler, "onButton arrow needs a (b) param");
      this.scope.set(param, { kind: "local", cName: "b_arg", ty: NUM });
      if (ts.isBlock(this.handler.body)) {
        for (const stmt of this.handler.body.statements) this.compileStmt(stmt, handlerOut, "  ");
      } else {
        this.compileExprStmt(this.handler.body, handlerOut, "  ");
      }
      this.scope = saved;
    }

    const { inits, effects } = this.emitTemplate();

    // seed + init
    const initOut: string[] = [];
    for (const ref of this.refs) {
      if (ref.refTy === "num") initOut.push(`  g_${ref.name} = ${this.constNum(ref.seed) ?? 0};`);
      else if (ref.refTy === "bool")
        initOut.push(`  g_${ref.name} = ${ref.seed.kind === ts.SyntaxKind.TrueKeyword ? 1 : 0};`);
      else if (ref.refTy === "str") {
        const text = (ref.seed as ts.StringLiteral).text;
        initOut.push(`  vp_sb_reset(&g_${ref.name});`);
        if (text) initOut.push(`  vp_sb_str(&g_${ref.name}, ${this.cStrLit(text)});`);
      } else {
        const arr = ref.seed as ts.ArrayLiteralExpression;
        const iface = this.ifaces.get(ref.iface!)!;
        if (arr.elements.length > POOL_CAP) this.err(arr, `seed exceeds pool capacity ${POOL_CAP}`);
        initOut.push(`  g_${ref.name}_len = ${arr.elements.length};`);
        arr.elements.forEach((el, i) => {
          if (!ts.isObjectLiteralExpression(el)) this.err(el, "list seeds are object literals");
          for (const propNode of el.properties) {
            if (!ts.isPropertyAssignment(propNode) || !ts.isIdentifier(propNode.name))
              this.err(propNode, "seed fields are `name: literal`");
            const field = iface.fields.find((f) => f.name === (propNode.name as ts.Identifier).text)!;
            if (field.ty === "str") {
              const text = (propNode.initializer as ts.StringLiteral).text;
              initOut.push(`  vp_sb_reset(&g_${ref.name}[${i}].${field.name});`);
              if (text) initOut.push(`  vp_sb_str(&g_${ref.name}[${i}].${field.name}, ${this.cStrLit(text)});`);
            } else {
              const v =
                propNode.initializer.kind === ts.SyntaxKind.TrueKeyword
                  ? 1
                  : propNode.initializer.kind === ts.SyntaxKind.FalseKeyword
                    ? 0
                    : (this.constNum(propNode.initializer) ?? 0);
              initOut.push(`  g_${ref.name}[${i}].${field.name} = ${v};`);
            }
          }
        });
      }
    }

    // per-ref computed invalidation masks
    const cInval = this.refs.map((r) => {
      let mask = 0;
      for (const c of this.computeds) if (c.deps.has(r.name)) mask |= 1 << c.index;
      return mask;
    });

    // debug layout
    const debugSlots: DebugSlot[] = [];
    let dbgOff = 0;
    const dbgOut: string[] = [];
    for (const ref of this.refs) {
      if (ref.refTy === "num" || ref.refTy === "bool") {
        dbgOut.push(`  *(volatile s32 *)(out + ${dbgOff}) = (s32)g_${ref.name};`);
        debugSlots.push({ name: ref.name, offset: dbgOff, size: 4, kind: ref.refTy === "num" ? "num" : "bool" });
        dbgOff += 4;
      } else if (ref.refTy === "str") {
        dbgOut.push(`  out[${dbgOff}] = g_${ref.name}.len;`);
        dbgOut.push(`  { u8 i; for (i = 0; i < VP_STR_CAP; i++) out[${dbgOff} + 1 + i] = (u8)g_${ref.name}.b[i]; }`);
        debugSlots.push({ name: ref.name, offset: dbgOff, size: 1 + 24, kind: "str" });
        dbgOff += 1 + 24;
        dbgOff = (dbgOff + 3) & ~3;
      } else {
        dbgOut.push(`  *(volatile s32 *)(out + ${dbgOff}) = (s32)g_${ref.name}_len;`);
        debugSlots.push({ name: ref.name, offset: dbgOff, size: 4, kind: "listLen" });
        dbgOff += 4;
      }
    }

    // ---- assemble C ----
    const c: string[] = [];
    c.push("/* gen_app.c — GENERATED by vapor/compiler/compile.ts. DO NOT EDIT. */");
    c.push('#include "vapor.h"');
    c.push("");
    c.push("static inline s32 vp_max(s32 a, s32 b) { return a > b ? a : b; }");
    c.push("static inline s32 vp_min(s32 a, s32 b) { return a < b ? a : b; }");
    c.push(
      "static inline const char *vp_cstr_at(const char *const *arr, s32 n, s32 i) { return (i >= 0 && i < n) ? arr[i] : \"\"; }",
    );
    c.push("static inline char vp_char_at(const char *s, s32 n, s32 i) { return (i >= 0 && i < n) ? s[i] : ' '; }");
    c.push("");

    // record structs
    for (const iface of this.ifaces.values()) {
      const fields = iface.fields
        .map((f) => (f.ty === "str" ? `vp_sb ${f.name};` : f.ty === "bool" ? `u8 ${f.name};` : `s32 ${f.name};`))
        .join(" ");
      c.push(`typedef struct { ${fields} } rec_${iface.name.toLowerCase()};`);
    }
    c.push("");

    // state
    for (const ref of this.refs) {
      if (ref.refTy === "num") c.push(`static s32 g_${ref.name};`);
      else if (ref.refTy === "bool") c.push(`static s32 g_${ref.name};`);
      else if (ref.refTy === "str") c.push(`static vp_sb g_${ref.name};`);
      else c.push(`static rec_${ref.iface!.toLowerCase()} g_${ref.name}[${POOL_CAP}]; static u8 g_${ref.name}_len;`);
    }
    c.push("static u32 vp_dirty; static u32 c_valid;");
    c.push(`static const u32 C_INVAL[${Math.max(1, cInval.length)}] = { ${cInval.map((m) => `0x${m.toString(16)}u`).join(", ") || "0"} };`);
    c.push("static void vp_mark(u8 refIdx) { vp_dirty |= (u32)1 << refIdx; c_valid &= ~C_INVAL[refIdx]; }");
    c.push("");

    // string literals
    for (const [text, name] of this.strLits) c.push(`static const char ${name}[] = "${this.escC(text)}";`);
    c.push("");
    c.push(this.decls.join("\n"));
    c.push("");
    c.push(this.bodies.join("\n"));

    // keymap fnptr tables (ROM), indexed by GBA key bit
    for (const km of this.keymaps) {
      const slots = Array.from({ length: 10 }, (_, i) => km.entries.get(i) ?? "0");
      c.push(`static void (*const KM_${km.name}[10])(void) = { ${slots.join(", ")} };`);
    }
    c.push("");

    // handler
    c.push(`void app_on_button(u8 b) {\n  s32 b_arg = (s32)b;\n${handlerOut.join("\n")}\n}\n`);

    // flush
    const flush: string[] = [];
    flush.push("u8 app_flush(void) {");
    flush.push("  if (!vp_dirty) return 0;");
    for (const eff of effects) flush.push(`  if (vp_dirty & 0x${eff.mask.toString(16)}u) ${eff.name}();`);
    flush.push("  vp_dirty = 0;");
    flush.push("  return 1;");
    flush.push("}");
    c.push(flush.join("\n"));
    c.push("");

    // init
    const init: string[] = [];
    init.push("void app_init(void) {");
    init.push(...initOut);
    init.push("  vp_dirty = 0; c_valid = 0;");
    init.push(...inits.map((line) => line));
    for (const eff of effects) init.push(`  ${eff.name}();`);
    init.push("}");
    c.push(init.join("\n"));
    c.push("");

    // debug
    c.push(`u16 app_debug_state(volatile u8 *out) {\n${dbgOut.join("\n")}\n  return ${dbgOff};\n}`);
    c.push("");

    // generated data: font, palettes, title
    c.push(emitFontTiles());
    c.push(emitPalettes());
    c.push(`const char vp_app_title[] = "${this.escC(this.title)}";`);
    c.push("");

    // ---- reports ----
    const graphLines: string[] = [];
    graphLines.push("refs:");
    for (const r of this.refs) graphLines.push(`  bit ${r.index}: ${r.name} (${r.refTy})`);
    graphLines.push("computeds:");
    for (const comp of this.computeds)
      graphLines.push(
        `  ${comp.name}: ${comp.valTy.k}${comp.valTy.k === "view" ? `(maxLen ${comp.maxLen})` : ""} <- {${[...comp.deps].join(", ")}}`,
      );
    graphLines.push("effects:");
    effects.forEach((eff) =>
      graphLines.push(
        `  ${eff.name}: rows [${eff.span[0]}, ${eff.span[1]}) mask 0x${eff.mask.toString(16)} {${this.refs
          .filter((r) => eff.mask & (1 << r.index))
          .map((r) => r.name)
          .join(", ")}}`,
      ),
    );

    const pools = this.refs.filter((r) => r.refTy === "list");
    const poolBytes = pools.reduce((acc, p) => {
      const iface = this.ifaces.get(p.iface!)!;
      const rec = iface.fields.reduce((a, f) => a + (f.ty === "str" ? 25 : f.ty === "bool" ? 1 : 4), 0);
      return acc + rec * POOL_CAP + 1;
    }, 0);
    const viewBytes = this.computeds.filter((comp) => comp.valTy.k === "view").length * 33;
    const scalarBytes = this.refs.filter((r) => r.refTy !== "list").reduce((a, r) => a + (r.refTy === "str" ? 25 : 4), 0);
    const romStrings = [...this.strLits.keys()].reduce((a, s) => a + s.length + 1, 0);
    const planLines = [
      `state RAM: ${scalarBytes} B scalars/strings + ${poolBytes} B pools + ${viewBytes} B computed views`,
      `reactive tables: ${this.refs.length} dirty bits, ${this.computeds.length} validity bits, ${effects.length} effects`,
      `ROM data: ${romStrings} B strings + ${95 * 32} B font + ${16 * 16 * 2} B palettes`,
    ];

    return {
      c: c.join("\n"),
      title: this.title,
      graph: graphLines.join("\n"),
      plan: planLines.join("\n"),
      debugSlots,
    };
  }
}

// ---------------------------------------------------------------------------
// Generated data: font + palettes
// ---------------------------------------------------------------------------

const INK = 1;
const PAPER = 2;

function emitFontTiles(): string {
  const bytes: number[] = [];
  for (let g = 0; g < 95; g++) {
    const bitmap = FONT8[g];
    // 8x8 pixels, 4bpp: two pixels per byte, low nibble = left pixel
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x += 2) {
        const left = bitmap[y] & (0x80 >> x) ? INK : PAPER;
        const right = bitmap[y] & (0x80 >> (x + 1)) ? INK : PAPER;
        bytes.push(left | (right << 4));
      }
    }
  }
  return `const u8 vp_font_tiles[] = { ${bytes.join(",")} };`;
}

function bgr555(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) >> 3;
  const g = parseInt(hex.slice(3, 5), 16) >> 3;
  const b = parseInt(hex.slice(5, 7), 16) >> 3;
  return r | (g << 5) | (b << 10);
}

const THEME: { ink: string; paper: string }[] = [
  { ink: "#e6edf3", paper: "#101423" }, // 0 text: light on navy
  { ink: "#101423", paper: "#42b883" }, // 1 title: navy on vue mint
  { ink: "#42b883", paper: "#101423" }, // 2 accent: mint on navy
  { ink: "#5b6b84", paper: "#101423" }, // 3 dim
  { ink: "#101423", paper: "#e6edf3" }, // 4 cursor: inverted
  { ink: "#101423", paper: "#e8c266" }, // 5 edit: navy on amber
];

function emitPalettes(): string {
  const banks: number[] = [];
  for (const t of THEME) {
    const bank = new Array<number>(16).fill(0);
    bank[INK] = bgr555(t.ink);
    bank[PAPER] = bgr555(t.paper);
    banks.push(...bank);
  }
  return (
    `const u16 vp_palettes[] = { ${banks.join(",")} };\n` +
    `const u8 vp_palette_count = ${THEME.length};\n` +
    `const u16 vp_backdrop = ${bgr555("#101423")};`
  );
}
