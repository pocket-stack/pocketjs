// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/actions.ts — the fixed vocabulary the remote's own
// controls ask the laptop for, in one table read by BOTH ends: the device
// renders labels from it, the daemon runs exactly the command it names and
// nothing else. The wire carries an action id, never a command string.
//
// Omarchy's menu is not in this table: the device carries the menu tree
// (menu.ts) and names a row by id; the daemon runs that row from its own
// parse of omarchy-menu.jsonc (host/menu-source.ts). This table is for the
// controls the remote draws itself — the strip, the control centre, the
// empty stage's launchers.
//
// Every command is the one Omarchy binds to the equivalent key
// (/usr/share/omarchy/default/hypr/bindings/*.lua, Omarchy 4.0), so the
// remote behaves exactly like the keyboard would.

export type ActionGroup = "launch" | "workspace" | "toggle" | "capture" | "media";

export type ActionRun =
  /** argv, spawned directly (no shell). */
  | { exec: string[] }
  /** A Hyprland dispatcher as a Lua expression (Hyprland 0.5x's request
   *  socket takes `dispatch <lua>` and evaluates `hl.dispatch(<lua>)`; the
   *  old `dispatch workspace 1` grammar is gone). Constructors are the ones
   *  Omarchy's own bindings use. */
  | { dispatch: string };

export interface ActionDef {
  id: ActionId;
  label: string;
  group: ActionGroup;
  run: ActionRun;
}

export type ActionId =
  // launch
  | "terminal"
  | "browser"
  | "files"
  // workspace
  | "wsPrev"
  | "wsNext"
  | "layout"
  // toggle
  | "nightlight"
  // capture
  | "screenshot"
  // media
  | "play"
  | "next"
  | "prev";

const omarchy = (...argv: string[]): ActionRun => ({ exec: argv });
const dispatch = (line: string): ActionRun => ({ dispatch: line });

export const ACTIONS: readonly ActionDef[] = [
  // -- launch (SUPER + Return / B / F) -----------------------------------------
  { id: "terminal", label: "Terminal", group: "launch", run: omarchy("omarchy-launch-terminal") },
  { id: "browser", label: "Browser", group: "launch", run: omarchy("omarchy-launch-browser") },
  { id: "files", label: "Files", group: "launch", run: omarchy("omarchy-launch-nautilus") },

  // -- workspace -------------------------------------------------------------
  { id: "wsPrev", label: "Previous", group: "workspace", run: dispatch('hl.dsp.focus({ workspace = "e-1" })') },
  { id: "wsNext", label: "Next", group: "workspace", run: dispatch('hl.dsp.focus({ workspace = "e+1" })') },
  { id: "layout", label: "Layout", group: "workspace", run: omarchy("omarchy-hyprland-workspace-layout-toggle") },

  // -- toggle ----------------------------------------------------------------
  { id: "nightlight", label: "Nightlight", group: "toggle", run: omarchy("omarchy-toggle-nightlight") },

  // -- capture ---------------------------------------------------------------
  { id: "screenshot", label: "Screenshot", group: "capture", run: omarchy("omarchy-capture-screenshot") },

  // -- media -----------------------------------------------------------------
  { id: "play", label: "Play / pause", group: "media", run: omarchy("omarchy-shell", "media", "playPause") },
  { id: "next", label: "Next track", group: "media", run: omarchy("omarchy-shell", "media", "next") },
  { id: "prev", label: "Previous track", group: "media", run: omarchy("omarchy-shell", "media", "previous") },
];

const BY_ID = new Map<ActionId, ActionDef>(ACTIONS.map((action) => [action.id, action]));

export function actionById(id: string): ActionDef | undefined {
  return BY_ID.get(id as ActionId);
}

export function actionsOf(group: ActionGroup): ActionDef[] {
  return ACTIONS.filter((action) => action.group === group);
}

/** The empty stage's launch chips, in reading order. */
export const LAUNCHERS: readonly ActionId[] = ["terminal", "browser", "files"];
