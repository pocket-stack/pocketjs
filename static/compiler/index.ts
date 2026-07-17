// static/compiler/index.ts — the Pocket Static compile pipeline.
//
//   evaluate (declaration zone runs, residual zone frozen as ASTs)
//   -> compile scripts (generator ASTs -> bytecode, per-target text pages)
//   -> build model (layouts, actors, warps, budgets)
//   -> patch fixups (warp/actor symbols -> operands)
//   -> link (blobs + tables)
//   -> target packager (native art, data emission, toolchain)   [targets/*]

import type { TargetName } from "../spec/isa.ts";
import { TARGETS } from "../spec/isa.ts";
import { Ctx } from "./context.ts";
import { evaluateGame } from "./evaluate.ts";
import { linkGame, type LinkedGame } from "./link.ts";
import { buildModel, patchFixups } from "./model.ts";
import { compileScripts } from "./script.ts";
import { resolveHelperImports, type Sites } from "./sites.ts";

export interface DebugInfo {
  target: TargetName;
  vars: Record<string, number>;
  flags: Record<string, number>;
  /** Text id -> page text ("\n" line breaks, "{vNN}" fmt slots). */
  texts: string[];
  maps: Record<string, number>;
  actors: Record<string, { map: number; slot: number }>;
  scripts: Record<string, number>;
}

export interface CompileOutput {
  target: TargetName;
  linked: LinkedGame;
  sites: Sites;
  debug: DebugInfo;
}

export async function compileGame(entryPath: string, target: TargetName): Promise<CompileOutput> {
  const { sites, game, registry } = await evaluateGame(entryPath);
  await resolveHelperImports(sites, entryPath);
  const ctx = new Ctx(target);
  const scripts = compileScripts(sites, ctx);
  const model = buildModel(game, registry, ctx, TARGETS[target]);
  patchFixups(scripts.blob, ctx, model);
  const linked = linkGame(model, ctx, scripts.blob, scripts.table);

  const debug: DebugInfo = {
    target,
    vars: ctx.varNames,
    flags: ctx.flagNames,
    texts: ctx.textDebug,
    maps: model.mapIndex,
    actors: model.actorSlots,
    scripts: Object.fromEntries(sites.scriptIds),
  };
  return { target, linked, sites, debug };
}
