// saga/compiler/evaluate.ts — execute the declaration zone, capture cue ASTs.
// Same bridge as aot: every `cue(function*(){...})` argument is recorded and
// replaced by its id, then the rewritten module is transpiled and imported so
// the DSL builders fill the shared registry. Temp module names carry a
// per-process counter because Bun caches modules by path.

import ts from "typescript";
import { pathToFileURL } from "node:url";

const DSL_INDEX = new URL("../dsl/index.ts", import.meta.url).pathname;

let evalCounter = 0;

export interface CueSite {
  id: number;
  body: ts.FunctionExpression | ts.ArrowFunction;
  file: ts.SourceFile;
}

export interface EvalResult {
  registry: import("../dsl/index.ts").Registry;
  cues: CueSite[];
}

function findCueCalls(sf: ts.SourceFile): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "cue" &&
      n.arguments.length === 1
    ) {
      out.push(n);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  out.sort((a, b) => a.getStart() - b.getStart());
  return out;
}

export async function evaluateFilm(entryPath: string): Promise<EvalResult> {
  const source = await Bun.file(entryPath).text();
  const sf = ts.createSourceFile(entryPath, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);

  const calls = findCueCalls(sf);
  const cues: CueSite[] = [];
  const edits: { start: number; end: number; text: string }[] = [];
  calls.forEach((call, id) => {
    const arg = call.arguments[0];
    if (!ts.isFunctionExpression(arg) && !ts.isArrowFunction(arg)) {
      throw new Error(`cue() argument must be a function expression (cue #${id})`);
    }
    cues.push({ id, body: arg, file: sf });
    edits.push({ start: arg.getStart(sf), end: arg.getEnd(), text: String(id) });
  });
  edits.sort((a, b) => b.start - a.start);
  let rewritten = source;
  for (const e of edits) rewritten = rewritten.slice(0, e.start) + e.text + rewritten.slice(e.end);
  rewritten = rewritten.replace(/(["'])@pocketjs\/saga\1/g, JSON.stringify(DSL_INDEX));

  const js = ts.transpileModule(rewritten, {
    fileName: entryPath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const dsl = (await import(DSL_INDEX)) as typeof import("../dsl/index.ts");
  dsl.__resetRegistry();

  const tmp = entryPath + `.__saga.${process.pid}.${evalCounter++}.mjs`;
  await Bun.write(tmp, js);
  try {
    await import(pathToFileURL(tmp).href);
  } finally {
    await Bun.file(tmp)
      .exists()
      .then((e) => (e ? Bun.$`rm -f ${tmp}`.quiet() : null))
      .catch(() => {});
  }

  const registry = dsl.__getRegistry();
  if (!registry.film) throw new Error("no defineFilm() found in " + entryPath);
  return { registry, cues };
}
