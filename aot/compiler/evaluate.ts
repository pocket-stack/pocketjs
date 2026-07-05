// aot/compiler/evaluate.ts — Stage 3: static declaration evaluation (design §11.3).
//
// The static/JSX zone is EXECUTED at build time; the residual script zone is
// NOT. We bridge the two by rewriting every `script(function*(){...})` call to
// `script(<id>)` (recording the generator AST for the residualizer), then
// transpiling + importing the rewritten module so the DSL builders fill the
// shared REGISTRY.

import ts from "typescript";
import { pathToFileURL } from "node:url";

const DSL_DIR = new URL("../dsl", import.meta.url).pathname; // for jsxImportSource
const DSL_INDEX = new URL("../dsl/index.ts", import.meta.url).pathname;

export interface ScriptSite {
  id: number;
  body: ts.FunctionExpression | ts.ArrowFunction;
  file: ts.SourceFile;
}

export interface EvalResult {
  registry: import("../dsl/index.ts").Registry;
  scripts: ScriptSite[];
  checker: ts.TypeChecker;
}

/** Find `script(function*(){...})` calls; returns them in source order. */
function findScriptCalls(sf: ts.SourceFile): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "script" &&
      n.arguments.length === 1
    ) {
      out.push(n);
      return; // do not recurse into the generator body (no nested script())
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // deterministic: by start position
  out.sort((a, b) => a.getStart() - b.getStart());
  return out;
}

export async function evaluateGame(entryPath: string): Promise<EvalResult> {
  const source = await Bun.file(entryPath).text();
  const sf = ts.createSourceFile(entryPath, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);

  const calls = findScriptCalls(sf);
  const scripts: ScriptSite[] = [];
  // Rewrite generator args -> id numbers, from the end to preserve offsets.
  let rewritten = source;
  const edits: { start: number; end: number; text: string }[] = [];
  calls.forEach((call, id) => {
    const arg = call.arguments[0];
    if (!ts.isFunctionExpression(arg) && !ts.isArrowFunction(arg)) {
      throw new Error(`script() argument must be a function expression (script #${id})`);
    }
    scripts.push({ id, body: arg, file: sf });
    edits.push({ start: arg.getStart(sf), end: arg.getEnd(), text: String(id) });
  });
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) rewritten = rewritten.slice(0, e.start) + e.text + rewritten.slice(e.end);

  // Point the @pocketjs/aot import at the concrete DSL module so the executed
  // module shares REGISTRY with the compiler.
  rewritten = rewritten.replace(/(["'])@pocketjs\/aot\1/g, JSON.stringify(DSL_INDEX));

  const js = ts.transpileModule(rewritten, {
    fileName: entryPath,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: DSL_DIR,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText
    .replace(/(["'])@pocketjs\/aot\/jsx-runtime\1/g, JSON.stringify(DSL_DIR + "/jsx-runtime.ts"))
    .replace(/(["'])@pocketjs\/aot\/jsx-dev-runtime\1/g, JSON.stringify(DSL_DIR + "/jsx-dev-runtime.ts"));

  // Execute: write to a sibling temp file so relative/abs imports resolve, then
  // import it. Import the DSL via the SAME absolute path to share REGISTRY.
  const dsl = (await import(DSL_INDEX)) as typeof import("../dsl/index.ts");
  dsl.__resetRegistry();

  const tmp = entryPath + `.__pjgb.${process.pid}.mjs`;
  await Bun.write(tmp, js);
  try {
    await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
  } finally {
    await Bun.file(tmp)
      .exists()
      .then((e) => (e ? Bun.$`rm -f ${tmp}`.quiet() : null))
      .catch(() => {});
  }

  const registry = dsl.__getRegistry();
  if (!registry.game) throw new Error("no defineGame() found in " + entryPath);

  // A throwaway program just to expose a checker for the residualizer.
  const program = ts.createProgram([entryPath], {
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
  });
  return { registry, scripts, checker: program.getTypeChecker() };
}
