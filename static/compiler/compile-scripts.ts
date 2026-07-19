// static/compiler/compile-scripts.ts — front-door for turning a game module's
// residual zone into runnable bytecode: parse, collect sites, compile all
// scripts. Used by the full game pipeline and directly by unit tests /
// the story simulator (which run the result on vm/ref.ts).

import type { TargetName } from "../spec/isa.ts";
import { Ctx } from "./context.ts";
import { collectSites, parseSource, type Sites } from "./sites.ts";
import { compileScripts, type CompiledScripts } from "./script.ts";

export interface ScriptCompileResult extends CompiledScripts {
  ctx: Ctx;
  sites: Sites;
}

export function compileScriptSource(
  source: string,
  target: TargetName = "gba",
  fileName = "game.ts",
): ScriptCompileResult {
  const file = parseSource(source, fileName);
  const sites = collectSites(file);
  const ctx = new Ctx(target);
  const compiled = compileScripts(sites, ctx);
  return { ...compiled, ctx, sites };
}
