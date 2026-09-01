// vapor/compiler/sccp.ts — sparse conditional constant propagation over refs.
//
// The dependency graph the compiler bakes into ROM is a syntactic
// over-approximation: `flag.value ? a.value : b.value` subscribes to all
// three refs. This pass runs before setup analysis and asks a prior
// question: which refs can ever hold more than one value at runtime?
//
// A ref whose every reachable write either (a) sits behind a guard that is
// decidably false, or (b) stores the value the ref already holds, is a
// compile-time constant. Its reads fold, decidable ternaries and ifs pick
// one arm, and the dead arm's dependencies — and ROM code — disappear.
//
// The analysis is optimistic in the classic SCCP sense: every ref starts
// at const(seed), and writes only lower it. Guard reachability is judged
// under the *current* environment, so mutually-gated refs converge to
// const (`if (a.value) b.value = 1; if (b.value) a.value = 1;` with both
// seeded 0 keeps both at 0 — a pessimistic pass could not conclude that).
// Iteration re-examines every write site until the environment stabilizes;
// at fixpoint every pruning decision is consistent with the final env,
// which makes the result sound.
//
// Soundness relies on two subset properties the compiler enforces later:
// assignments only occur in statement position (so if/ternary conditions
// are the complete guard vocabulary), and no function or closure escapes
// setup (so every function-like node in the component body is the whole
// universe of callable code — all are conservatively assumed reachable;
// only statement-level guards prune).
//
// Deliberately conservative (v1): locals are not tracked (a write whose
// RHS reads a local is NAC), helper params are NAC, loop bodies count as
// reachable, and only num/bool refs fold — str/list refs start at NAC.

import ts from "typescript";

export type SccpValue = { kind: "const"; value: number } | { kind: "nac" };

const NAC: SccpValue = { kind: "nac" };
const cval = (v: number): SccpValue => ({ kind: "const", value: v | 0 });

function join(a: SccpValue, b: SccpValue): SccpValue {
  if (a.kind === "nac" || b.kind === "nac") return NAC;
  return a.value === b.value ? a : NAC;
}

interface Guard {
  cond: ts.Expression;
  whenTruthy: boolean;
}

type WriteOp = "=" | "+=" | "-=" | "*=" | "%=" | "++" | "--" | "nac";

interface WriteSite {
  ref: string;
  op: WriteOp;
  rhs: ts.Expression | null; // null for ++/--
  guards: Guard[];
}

export interface SccpOptions {
  component: ts.ArrowFunction;
  /** local name of vue's `ref` import */
  refLocalName: string;
  /** module-level folding (consts, SCREEN, Button, folded comparisons) */
  foldConst: (e: ts.Expression) => number | null;
}

/** `name.value` -> name. */
function valueBase(e: ts.Expression): string | null {
  e = unparen(e);
  if (ts.isPropertyAccessExpression(e) && e.name.text === "value" && ts.isIdentifier(e.expression))
    return e.expression.text;
  return null;
}

function unparen(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/**
 * Run the analysis over one component. Returns only the refs proven
 * constant: name -> value (booleans as 0/1). Everything absent is NAC.
 */
export function sccpRefConstants(opts: SccpOptions): Map<string, number> {
  const { component, refLocalName, foldConst } = opts;
  if (!ts.isBlock(component.body)) return new Map();

  // -- discover refs (top-level `const x = ref(seed)` only, like scanSetup) --
  const env = new Map<string, SccpValue>();
  for (const stmt of component.body.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const init = decl.initializer;
      if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) continue;
      if (init.expression.text !== refLocalName) continue;
      const seed = init.arguments[0];
      if (!seed) continue;
      env.set(decl.name.text, seedValue(seed, foldConst));
    }
  }
  if (env.size === 0) return new Map();

  // -- collect write sites with their statement-level guard chains ----------
  const writes: WriteSite[] = [];
  const K = ts.SyntaxKind;
  const compound: Partial<Record<ts.SyntaxKind, WriteOp>> = {
    [K.EqualsToken]: "=",
    [K.PlusEqualsToken]: "+=",
    [K.MinusEqualsToken]: "-=",
    [K.AsteriskEqualsToken]: "*=",
    [K.PercentEqualsToken]: "%=",
  };

  const walk = (node: ts.Node, guards: Guard[]): void => {
    if (ts.isIfStatement(node)) {
      walk(node.expression, guards);
      walk(node.thenStatement, [...guards, { cond: node.expression, whenTruthy: true }]);
      if (node.elseStatement) walk(node.elseStatement, [...guards, { cond: node.expression, whenTruthy: false }]);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      walk(node.condition, guards);
      walk(node.whenTrue, [...guards, { cond: node.condition, whenTruthy: true }]);
      walk(node.whenFalse, [...guards, { cond: node.condition, whenTruthy: false }]);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const op = compound[node.operatorToken.kind];
      const isAssign =
        op !== undefined ||
        node.operatorToken.kind >= K.FirstAssignment && node.operatorToken.kind <= K.LastAssignment;
      if (isAssign) {
        const base = valueBase(node.left);
        if (base && env.has(base)) writes.push({ ref: base, op: op ?? "nac", rhs: node.right, guards });
        walk(node.right, guards);
        return;
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken)
    ) {
      const base = valueBase(node.operand);
      if (base && env.has(base)) {
        writes.push({ ref: base, op: node.operator === K.PlusPlusToken ? "++" : "--", rhs: null, guards });
        return;
      }
    }
    ts.forEachChild(node, (c) => walk(c, guards));
  };
  walk(component.body, []);

  // -- abstract evaluation under the current environment --------------------
  const evalExpr = (e: ts.Expression): SccpValue => {
    e = unparen(e);
    const k = foldConst(e);
    if (k !== null) return cval(k);
    if (e.kind === K.TrueKeyword) return cval(1);
    if (e.kind === K.FalseKeyword) return cval(0);
    const base = valueBase(e);
    if (base) return env.get(base) ?? NAC;
    if (ts.isPrefixUnaryExpression(e)) {
      const v = evalExpr(e.operand);
      if (v.kind !== "const") return NAC;
      if (e.operator === K.ExclamationToken) return cval(v.value ? 0 : 1);
      if (e.operator === K.MinusToken) return cval(-v.value);
      return NAC;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
        const l = evalExpr(e.left);
        if (l.kind !== "const") return NAC; // short-circuit needs a decided left
        const lTruthy = l.value !== 0;
        if (op === K.AmpersandAmpersandToken) return lTruthy ? evalExpr(e.right) : cval(0);
        return lTruthy ? cval(1) : evalExpr(e.right);
      }
      const l = evalExpr(e.left);
      const r = evalExpr(e.right);
      if (l.kind !== "const" || r.kind !== "const") return NAC;
      switch (op) {
        case K.PlusToken: return cval(l.value + r.value);
        case K.MinusToken: return cval(l.value - r.value);
        case K.AsteriskToken: return cval(Math.imul(l.value, r.value));
        case K.LessThanToken: return cval(l.value < r.value ? 1 : 0);
        case K.GreaterThanToken: return cval(l.value > r.value ? 1 : 0);
        case K.LessThanEqualsToken: return cval(l.value <= r.value ? 1 : 0);
        case K.GreaterThanEqualsToken: return cval(l.value >= r.value ? 1 : 0);
        case K.EqualsEqualsEqualsToken: return cval(l.value === r.value ? 1 : 0);
        case K.ExclamationEqualsEqualsToken: return cval(l.value !== r.value ? 1 : 0);
        default: return NAC; // / stays unfolded: device semantics live in codegen
      }
    }
    if (ts.isConditionalExpression(e)) {
      const c = evalExpr(e.condition);
      if (c.kind === "const") return evalExpr(c.value ? e.whenTrue : e.whenFalse);
      return join(evalExpr(e.whenTrue), evalExpr(e.whenFalse));
    }
    return NAC;
  };

  const writeValue = (w: WriteSite): SccpValue => {
    const cur = env.get(w.ref)!;
    if (w.op === "++" || w.op === "--") {
      if (cur.kind !== "const") return NAC;
      return cval(cur.value + (w.op === "++" ? 1 : -1));
    }
    const rhs = w.rhs ? evalExpr(w.rhs) : NAC;
    if (w.op === "=") return rhs;
    if (cur.kind !== "const" || rhs.kind !== "const") return NAC;
    switch (w.op) {
      case "+=": return cval(cur.value + rhs.value);
      case "-=": return cval(cur.value - rhs.value);
      case "*=": return cval(Math.imul(cur.value, rhs.value));
      case "%=": return rhs.value === 0 ? NAC : cval(cur.value % rhs.value);
      default: return NAC;
    }
  };

  // -- fixpoint: env only descends; pruning re-judged each round ------------
  let changed = true;
  let rounds = 0;
  while (changed && rounds++ < 64) {
    changed = false;
    for (const w of writes) {
      const cur = env.get(w.ref)!;
      if (cur.kind === "nac") continue;
      const dead = w.guards.some((g) => {
        const v = evalExpr(g.cond);
        return v.kind === "const" && (v.value !== 0) !== g.whenTruthy;
      });
      if (dead) continue;
      const merged = join(cur, writeValue(w));
      if (merged.kind !== cur.kind || (merged.kind === "const" && cur.kind === "const" && merged.value !== cur.value)) {
        env.set(w.ref, merged);
        changed = true;
      }
    }
  }

  const folded = new Map<string, number>();
  for (const [name, v] of env) if (v.kind === "const") folded.set(name, v.value);
  return folded;
}

function seedValue(seed: ts.Expression, foldConst: (e: ts.Expression) => number | null): SccpValue {
  seed = unparen(seed);
  if (seed.kind === ts.SyntaxKind.TrueKeyword) return cval(1);
  if (seed.kind === ts.SyntaxKind.FalseKeyword) return cval(0);
  const v = foldConst(seed);
  if (v !== null) return cval(v);
  return NAC; // str/list refs (and anything else) never fold
}
