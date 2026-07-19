// static/compiler/sites.ts — find the residual zone in a game module: every
// `script(function* (...) {...})` call site (in source order — the same order
// the executed declaration zone registers them, since both follow top-level
// statement order), plus the helper generator functions macros expand from.

import ts from "typescript";

export interface ScriptSite {
  id: number;
  fn: ts.FunctionExpression;
  /** The const name it is bound to, if any (enables s.call(Name)). */
  name?: string;
}

export interface Sites {
  file: ts.SourceFile;
  scripts: ScriptSite[];
  /** const/function name -> generator AST usable as an inline macro. */
  helpers: Map<string, ts.FunctionExpression | ts.FunctionDeclaration>;
  /** const name -> script id (for s.call resolution). */
  scriptIds: Map<string, number>;
}

export function parseSource(sourceText: string, fileName = "game.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
}

/**
 * Macros may live in imported modules (e.g. @pocketjs/static/rpg/battle):
 * parse each imported helper module and merge its top-level generator
 * functions into sites.helpers. AST-only — helper modules never execute.
 */
export async function resolveHelperImports(sites: Sites, entryPath: string): Promise<void> {
  const { dirname, join, resolve } = await import("node:path");
  const seen = new Set<string>();
  const scan = async (file: ts.SourceFile, filePath: string): Promise<void> => {
    const imports: string[] = [];
    ts.forEachChild(file, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
    });
    for (const spec of imports) {
      let target: string | undefined;
      if (spec === "@pocketjs/static/rpg/battle") {
        target = resolve(import.meta.dir, "..", "rpg", "battle.ts");
      } else if (spec.startsWith("./") || spec.startsWith("../")) {
        target = resolve(dirname(filePath), spec.endsWith(".ts") ? spec : `${spec}.ts`);
      }
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const text = await Bun.file(target).text().catch(() => null);
      if (text === null) continue;
      const mod = parseSource(text, target);
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.name) {
          if (!sites.helpers.has(node.name.text)) sites.helpers.set(node.name.text, node);
          return;
        }
        if (ts.isVariableStatement(node)) {
          for (const d of node.declarationList.declarations) {
            if (
              ts.isIdentifier(d.name) &&
              d.initializer &&
              ts.isFunctionExpression(d.initializer) &&
              d.initializer.asteriskToken &&
              !sites.helpers.has(d.name.text)
            ) {
              sites.helpers.set(d.name.text, d.initializer);
            }
          }
          return;
        }
      };
      ts.forEachChild(mod, visit);
      await scan(mod, target);
    }
  };
  await scan(sites.file, entryPath);
  void join;
}

const isScriptCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "script" &&
  node.arguments.length === 1 &&
  ts.isFunctionExpression(node.arguments[0]) &&
  node.arguments[0].asteriskToken !== undefined;

export function collectSites(file: ts.SourceFile): Sites {
  const scripts: ScriptSite[] = [];
  const helpers = new Map<string, ts.FunctionExpression | ts.FunctionDeclaration>();
  const scriptIds = new Map<string, number>();

  const visit = (node: ts.Node, constName?: string): void => {
    if (isScriptCall(node)) {
      const id = scripts.length;
      scripts.push({ id, fn: node.arguments[0] as ts.FunctionExpression, name: constName });
      if (constName !== undefined) scriptIds.set(constName, id);
      return; // do not descend into script bodies looking for more sites
    }
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (isScriptCall(d.initializer)) {
          visit(d.initializer, d.name.text);
        } else if (ts.isFunctionExpression(d.initializer) && d.initializer.asteriskToken) {
          helpers.set(d.name.text, d.initializer);
        } else {
          ts.forEachChild(d.initializer, (c) => visit(c));
        }
      }
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.name) {
      helpers.set(node.name.text, node);
      return;
    }
    ts.forEachChild(node, (c) => visit(c));
  };
  ts.forEachChild(file, (c) => visit(c));

  return { file, scripts, helpers, scriptIds };
}
