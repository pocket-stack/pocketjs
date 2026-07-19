// static/compiler/context.ts — the per-target compile context: interners for
// texts/vars/flags, script directory, and cross-stage fixups. One Ctx per
// (game, target) pair — text pagination is target-shaped, so bytecode is too.

import { TARGETS, VAR_USER_MAX, VM_FLAGS, type TargetName, type TargetSpec } from "../spec/isa.ts";
import { RPG_BUDGET } from "../spec/rpg.ts";
import { encodeOption, encodePage, richToDebugString, wrapPages, type RichText } from "./text.ts";

export interface TextRecord {
  /** Token stream (already page-shaped). */
  tokens: Uint8Array;
  /** Debug representation for e2e lookup ("PAGE:..." / "OPT:..."). */
  debug: string;
}

export interface WarpFixup {
  /** Offset of the 4 operand bytes (map,x,y,dir) in the script blob. */
  at: number;
  dest: string; // "map:entrance"
  where: string; // error context
}

export interface ActorFixup {
  /** Offset of the slot operand byte in the script blob. */
  at: number;
  actorId: string;
  where: string;
}

export class Ctx {
  readonly target: TargetSpec;
  readonly texts: TextRecord[] = [];
  private textIndex = new Map<string, number>();
  private varIds = new Map<string, number>();
  private flagIds = new Map<string, number>();
  /** Filled by the script stage; offsets patched by the link stage. */
  warpFixups: WarpFixup[] = [];
  actorFixups: ActorFixup[] = [];

  constructor(target: TargetName) {
    this.target = TARGETS[target];
  }

  // --- texts ---------------------------------------------------------------
  private internTokens(tokens: Uint8Array, debug: string): number {
    const key = Buffer.from(tokens).toString("latin1");
    const hit = this.textIndex.get(key);
    if (hit !== undefined) return hit;
    if (this.texts.length >= RPG_BUDGET.MAX_TEXTS) {
      throw new Error(`text budget exceeded (${RPG_BUDGET.MAX_TEXTS})`);
    }
    const id = this.texts.length;
    this.texts.push({ tokens, debug });
    this.textIndex.set(key, id);
    return id;
  }

  /** Intern a say() body; returns one text id per page. */
  internPages(rt: RichText, where: string): number[] {
    const pages = wrapPages(rt, this.target, where);
    return pages.map((page) => {
      const tokens = encodePage(page);
      const debug = page.map(richToDebugString).join("\n");
      return this.internTokens(tokens, debug);
    });
  }

  /** Intern a single-line choice option. */
  internOption(rt: RichText, where: string): number {
    const tokens = encodeOption(rt, this.target.textCols - 2, where); // 2 cells for the cursor
    return this.internTokens(tokens, richToDebugString(rt));
  }

  // --- vars / flags ----------------------------------------------------------
  varId(name: string, where: string): number {
    const hit = this.varIds.get(name);
    if (hit !== undefined) return hit;
    const id = this.varIds.size;
    if (id >= VAR_USER_MAX) throw new Error(`${where}: var budget exceeded (${VAR_USER_MAX} user vars)`);
    this.varIds.set(name, id);
    return id;
  }

  flagId(name: string, where: string): number {
    const hit = this.flagIds.get(name);
    if (hit !== undefined) return hit;
    const id = this.flagIds.size;
    if (id >= VM_FLAGS) throw new Error(`${where}: flag budget exceeded (${VM_FLAGS})`);
    this.flagIds.set(name, id);
    return id;
  }

  get varNames(): Record<string, number> {
    return Object.fromEntries(this.varIds);
  }
  get flagNames(): Record<string, number> {
    return Object.fromEntries(this.flagIds);
  }
  /** Text debug strings by id (e2e page lookup). */
  get textDebug(): string[] {
    return this.texts.map((t) => t.debug);
  }
}
