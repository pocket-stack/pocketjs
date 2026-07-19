// static/compiler/evaluate.ts — run the declaration zone, freeze the
// residual zone.
//
// The trick (proven across aot/cine/saga/edge): parse the entry module, note
// every `script(<generator>)` call site (source order = registration order),
// REWRITE each generator argument to its numeric id, redirect the
// "@pocketjs/static" import to this repo's dsl module, transpile, write a
// temp .mjs BESIDE the entry (so its relative imports still resolve), and
// dynamic-import it. The executed module fills REGISTRY with declarations
// while the compiler keeps the generator ASTs for lowering.

import { unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { REGISTRY, resetRegistry, type GameDecl, type Registry } from "../rpg/dsl.ts";
import { collectSites, type Sites } from "./sites.ts";

export interface Evaluated {
  sites: Sites;
  game: GameDecl;
  registry: Registry;
}

const DSL_PATH = resolve(import.meta.dir, "..", "rpg", "dsl.ts");
let evalCounter = 0;

export async function evaluateGame(entry: string): Promise<Evaluated> {
  const entryPath = resolve(entry);
  const source = await Bun.file(entryPath).text();
  const file = ts.createSourceFile(entryPath, source, ts.ScriptTarget.ES2022, true);
  const sites = collectSites(file);

  // Rewrites, applied back-to-front so spans stay valid.
  const edits: { start: number; end: number; text: string }[] = [];
  for (const site of sites.scripts) {
    edits.push({ start: site.fn.getStart(file), end: site.fn.getEnd(), text: String(site.id) });
  }
  const visitImports = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      if (spec === "@pocketjs/static" || spec === "@pocketjs/static/rpg") {
        edits.push({
          start: node.moduleSpecifier.getStart(file),
          end: node.moduleSpecifier.getEnd(),
          text: JSON.stringify(DSL_PATH),
        });
      }
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(file);

  let rewritten = source;
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) rewritten = rewritten.slice(0, e.start) + e.text + rewritten.slice(e.end);

  const js = ts.transpileModule(rewritten, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: false,
    },
    fileName: entryPath,
  }).outputText;

  const temp = join(dirname(entryPath), `.__static.${process.pid}.${evalCounter++}.mjs`);
  await Bun.write(temp, js);
  resetRegistry();
  try {
    await import(temp);
  } finally {
    await unlink(temp).catch(() => {});
  }

  if (!REGISTRY.game) throw new Error(`${entryPath}: the module never called defineGame()`);
  if (REGISTRY.scriptCount !== sites.scripts.length) {
    throw new Error(
      `${entryPath}: ${sites.scripts.length} script(...) sites in source but ${REGISTRY.scriptCount} registered at run time — scripts must be created unconditionally at module top level`,
    );
  }
  return {
    sites,
    game: REGISTRY.game,
    registry: { ...REGISTRY, tilesets: [...REGISTRY.tilesets], sprites: [...REGISTRY.sprites] },
  };
}
