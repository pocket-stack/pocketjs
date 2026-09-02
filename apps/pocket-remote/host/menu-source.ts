// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/host/menu-source.ts — Omarchy's menu definition, read
// the way Omarchy reads it. The menu is a JSONC object keyed by dotted ids
// (/usr/share/omarchy/default/omarchy/omarchy-menu.jsonc, extended by
// ~/.config/omarchy/extensions/omarchy-menu.jsonc); the dots define the
// tree, `action` makes a row an action, `target` a link, `provider` a
// runtime-listed submenu, anything else a submenu. `when` and `checked` are
// bash conditions the shell evaluates at open time.
//
// Two readers share this file: the daemon, which runs actions by id and
// evaluates the conditions, and `bun tools/pocket-remote.ts menu`, which
// bakes the tree into the device as apps/pocket-remote/menu.ts. Pure: no
// filesystem, so tests run it bare.

export type MenuKind = "action" | "menu" | "link" | "provider";

export interface MenuEntry {
  id: string;
  /** "root" for a top-level row. */
  parent: string;
  kind: MenuKind;
  /** The icon glyph as written (a Nerd Font symbol, an emoji, or ""). */
  icon: string;
  /** Font family the icon needs when it is not the menu font ("omarchy"
   *  for Omarchy's private logo font). */
  iconFont: string;
  label: string;
  /** Header shown when the submenu is open; defaults to label. */
  title: string;
  /** Link rows: the submenu id they open. */
  target: string;
  action: string;
  provider: string;
  when: string;
  checked: string;
}

/** The raw JSONC row, as Omarchy writes it. */
export interface RawMenuRow {
  icon?: string;
  iconFont?: string;
  label?: string;
  title?: string;
  target?: string;
  action?: string;
  provider?: string;
  when?: string;
  checked?: string;
  aliases?: string[];
  description?: string;
}

/**
 * JSONC to JSON: comments and trailing commas go, strings are left alone
 * (the menu's URLs carry `//` inside string literals).
 */
export function stripJsonc(text: string): string {
  // Two string-aware passes: comments first, then the commas they may have
  // been hiding in front of a closing bracket.
  const withoutComments = scan(text, (source, i) => {
    if (source[i] === "/" && source[i + 1] === "/") {
      let j = i;
      while (j < source.length && source[j] !== "\n") j += 1;
      return { skipTo: j, emit: "" };
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      return { skipTo: end < 0 ? source.length : end + 2, emit: "" };
    }
    return null;
  });
  return scan(withoutComments, (source, i) => {
    if (source[i] !== ",") return null;
    let j = i + 1;
    while (j < source.length && /\s/.test(source[j]!)) j += 1;
    return source[j] === "}" || source[j] === "]" ? { skipTo: i + 1, emit: "" } : null;
  });
}

/** Walk `text` outside of string literals; `rule` may replace a span. */
function scan(text: string, rule: (source: string, i: number) => { skipTo: number; emit: string } | null): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const hit = rule(text, i);
    if (hit) {
      out += hit.emit;
      i = hit.skipTo;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function parseMenuJsonc(text: string): Record<string, RawMenuRow> {
  const parsed = JSON.parse(stripJsonc(text)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("omarchy-menu.jsonc: not an object");
  return parsed as Record<string, RawMenuRow>;
}

export function parentOf(id: string): string {
  const dot = id.lastIndexOf(".");
  return dot < 0 ? "root" : id.slice(0, dot);
}

/**
 * Layers in order (Omarchy's default file, then the user's extension): a row
 * that reuses an id overrides the fields it names and keeps the rest; a new
 * id is appended. Kind is inferred as the shell infers it.
 */
export function normalizeMenu(layers: readonly Record<string, RawMenuRow>[]): MenuEntry[] {
  const merged = new Map<string, RawMenuRow>();
  for (const layer of layers) {
    for (const [id, row] of Object.entries(layer)) {
      if (!row || typeof row !== "object") continue;
      merged.set(id, { ...(merged.get(id) ?? {}), ...row });
    }
  }
  const entries: MenuEntry[] = [];
  for (const [id, row] of merged) {
    const action = typeof row.action === "string" ? row.action : "";
    const target = typeof row.target === "string" ? row.target : "";
    const provider = typeof row.provider === "string" ? row.provider : "";
    const kind: MenuKind = action ? "action" : target ? "link" : provider ? "provider" : "menu";
    entries.push({
      id,
      parent: parentOf(id),
      kind,
      icon: typeof row.icon === "string" ? row.icon : "",
      iconFont: typeof row.iconFont === "string" ? row.iconFont : "",
      label: typeof row.label === "string" ? row.label : id,
      title: typeof row.title === "string" ? row.title : "",
      target,
      action,
      provider,
      when: typeof row.when === "string" ? row.when : "",
      checked: typeof row.checked === "string" ? row.checked : "",
    });
  }
  return entries;
}

/** Children of a row in source order — the order the shell shows them. */
export function childrenOf(entries: readonly MenuEntry[], parent: string): MenuEntry[] {
  return entries.filter((entry) => entry.parent === parent);
}
