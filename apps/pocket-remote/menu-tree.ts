// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/menu-tree.ts — walking the baked menu (menu.ts) the way
// Omarchy's shell walks its own: children in source order, a submenu shown
// only while something under it is visible, a title that falls back to the
// label, "Go" at the root. The daemon's live conditions arrive as sets of
// ids (protocol HostMenu) and are applied here, so the table stays static.

import { MENU, type MenuItem } from "./menu.ts";

export const MENU_ROOT = "root";
/** What Omarchy titles its root menu. */
export const MENU_ROOT_TITLE = "Go";

const BY_ID = new Map<string, MenuItem>();
const CHILDREN = new Map<string, MenuItem[]>();
for (const item of MENU) {
  BY_ID.set(item.id, item);
  const siblings = CHILDREN.get(item.parent);
  if (siblings) siblings.push(item);
  else CHILDREN.set(item.parent, [item]);
}

export function menuItem(id: string): MenuItem | undefined {
  return BY_ID.get(id);
}

/** A row is visible unless its `when` failed; a submenu is visible only
 *  while one of its rows is (the shell's isVisible rule). */
export function menuVisible(item: MenuItem, hidden: ReadonlySet<string>, depth = 0): boolean {
  if (hidden.has(item.id)) return false;
  if (item.kind !== "menu" || depth > 8) return true;
  const rows = CHILDREN.get(item.id) ?? [];
  if (rows.length === 0) return true;
  return rows.some((row) => menuVisible(row, hidden, depth + 1));
}

/** The rows of a submenu, in the shell's order, minus the hidden ones. */
export function menuChildren(parent: string, hidden: ReadonlySet<string> = new Set()): MenuItem[] {
  return (CHILDREN.get(parent) ?? []).filter((item) => menuVisible(item, hidden));
}

export function menuTitle(id: string): string {
  if (id === MENU_ROOT) return MENU_ROOT_TITLE;
  const item = BY_ID.get(id);
  return item ? item.title || item.label : id;
}

/** The parent to go back to from a submenu. */
export function menuParent(id: string): string {
  return BY_ID.get(id)?.parent ?? MENU_ROOT;
}

/** The four coloured-dot emoji Omarchy uses for its update channels; the
 *  remote draws these as themed dots rather than baking emoji. */
export const MENU_DOT_EMOJI: Readonly<Record<string, "ok" | "warn" | "danger">> = {
  "🟢": "ok",
  "🟡": "warn",
  "🟠": "warn",
  "🔴": "danger",
};
