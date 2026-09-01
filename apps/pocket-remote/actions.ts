// apps/pocket-remote/actions.ts — the whole vocabulary the remote can ask the
// laptop for, in one table read by BOTH ends: the device renders labels and
// groups from it, the daemon runs exactly the command it names and nothing
// else. The wire carries an action id, never a command string, so a device
// on the LAN can only ever pick from this list.
//
// Every command is the one Omarchy binds to the equivalent key
// (/usr/share/omarchy/default/hypr/bindings/*.lua, Omarchy 4.0) or the one
// its menu runs (omarchy-menu.jsonc), so the remote behaves exactly like the
// keyboard would.

export type ActionGroup =
  | "launch"
  | "window"
  | "workspace"
  | "toggle"
  | "capture"
  | "style"
  | "system"
  | "media";

export type ActionRun =
  /** argv, spawned directly (no shell). */
  | { exec: string[] }
  /** `hyprctl dispatch <...>` over the Hyprland socket. */
  | { dispatch: string };

export interface ActionDef {
  id: ActionId;
  label: string;
  group: ActionGroup;
  run: ActionRun;
  /** Destructive: the device requires a press-and-hold, not a tap. */
  hold?: true;
}

export type ActionId =
  // launch
  | "menu"
  | "apps"
  | "terminal"
  | "browser"
  | "files"
  | "editor"
  | "keybindings"
  | "emoji"
  | "clipboard"
  // window
  | "close"
  | "fullscreen"
  | "maximize"
  | "float"
  | "pseudo"
  | "split"
  | "pop"
  | "group"
  | "cycle"
  | "focusL"
  | "focusR"
  | "focusU"
  | "focusD"
  | "swapL"
  | "swapR"
  | "swapU"
  | "swapD"
  | "widen"
  | "narrow"
  // workspace
  | "wsPrev"
  | "wsNext"
  | "wsBack"
  | "scratchpad"
  | "toScratchpad"
  | "layout"
  // toggle
  | "nightlight"
  | "awake"
  | "bar"
  | "silence"
  | "gaps"
  | "transparency"
  | "dismiss"
  // capture
  | "screenshot"
  | "record"
  | "recordStop"
  | "ocr"
  | "color"
  | "qr"
  // style
  | "bgNext"
  | "themePicker"
  // system
  | "lock"
  | "screensaver"
  | "suspend"
  | "closeAll"
  // media
  | "play"
  | "next"
  | "prev"
  | "outputSwitch";

const omarchy = (...argv: string[]): ActionRun => ({ exec: argv });
const dispatch = (line: string): ActionRun => ({ dispatch: line });

export const ACTIONS: readonly ActionDef[] = [
  // -- launch (SUPER + ...) --------------------------------------------------
  { id: "menu", label: "Menu", group: "launch", run: omarchy("omarchy-menu", "toggle") },
  { id: "apps", label: "Apps", group: "launch", run: omarchy("omarchy-menu", "toggle", "apps") },
  { id: "terminal", label: "Terminal", group: "launch", run: omarchy("omarchy-launch-terminal") },
  { id: "browser", label: "Browser", group: "launch", run: omarchy("omarchy-launch-browser") },
  { id: "files", label: "Files", group: "launch", run: omarchy("omarchy-launch-nautilus") },
  { id: "editor", label: "Editor", group: "launch", run: omarchy("omarchy-launch-editor") },
  { id: "keybindings", label: "Keys", group: "launch", run: omarchy("omarchy-menu-keybindings") },
  { id: "emoji", label: "Emoji", group: "launch", run: omarchy("omarchy-shell", "shell", "toggle", "omarchy.emojis") },
  { id: "clipboard", label: "Clipboard", group: "launch", run: omarchy("omarchy-menu-clipboard") },

  // -- window ----------------------------------------------------------------
  { id: "close", label: "Close", group: "window", run: dispatch("killactive"), hold: true },
  { id: "fullscreen", label: "Full screen", group: "window", run: dispatch("fullscreen 0") },
  { id: "maximize", label: "Full width", group: "window", run: dispatch("fullscreen 1") },
  { id: "float", label: "Float", group: "window", run: dispatch("togglefloating") },
  { id: "pseudo", label: "Pseudo", group: "window", run: dispatch("pseudo") },
  { id: "split", label: "Split", group: "window", run: dispatch("togglesplit") },
  { id: "pop", label: "Pop out", group: "window", run: omarchy("omarchy-hyprland-window-pop") },
  { id: "group", label: "Group", group: "window", run: dispatch("togglegroup") },
  { id: "cycle", label: "Next window", group: "window", run: dispatch("cyclenext") },
  { id: "focusL", label: "Focus left", group: "window", run: dispatch("movefocus l") },
  { id: "focusR", label: "Focus right", group: "window", run: dispatch("movefocus r") },
  { id: "focusU", label: "Focus up", group: "window", run: dispatch("movefocus u") },
  { id: "focusD", label: "Focus down", group: "window", run: dispatch("movefocus d") },
  { id: "swapL", label: "Swap left", group: "window", run: dispatch("swapwindow l") },
  { id: "swapR", label: "Swap right", group: "window", run: dispatch("swapwindow r") },
  { id: "swapU", label: "Swap up", group: "window", run: dispatch("swapwindow u") },
  { id: "swapD", label: "Swap down", group: "window", run: dispatch("swapwindow d") },
  { id: "widen", label: "Wider", group: "window", run: dispatch("resizeactive 100 0") },
  { id: "narrow", label: "Narrower", group: "window", run: dispatch("resizeactive -100 0") },

  // -- workspace -------------------------------------------------------------
  { id: "wsPrev", label: "Previous", group: "workspace", run: dispatch("workspace e-1") },
  { id: "wsNext", label: "Next", group: "workspace", run: dispatch("workspace e+1") },
  { id: "wsBack", label: "Former", group: "workspace", run: dispatch("workspace previous") },
  { id: "scratchpad", label: "Scratchpad", group: "workspace", run: dispatch("togglespecialworkspace scratchpad") },
  { id: "toScratchpad", label: "To scratchpad", group: "workspace", run: dispatch("movetoworkspacesilent special:scratchpad") },
  { id: "layout", label: "Layout", group: "workspace", run: omarchy("omarchy-hyprland-workspace-layout-toggle") },

  // -- toggle ----------------------------------------------------------------
  { id: "nightlight", label: "Nightlight", group: "toggle", run: omarchy("omarchy-toggle-nightlight") },
  { id: "awake", label: "Stay awake", group: "toggle", run: omarchy("omarchy-toggle-idle") },
  { id: "bar", label: "Menu bar", group: "toggle", run: omarchy("omarchy-toggle-bar") },
  { id: "silence", label: "Silence", group: "toggle", run: omarchy("omarchy-toggle-notification-silencing") },
  { id: "gaps", label: "Gaps", group: "toggle", run: omarchy("omarchy-hyprland-window-gaps-toggle") },
  { id: "transparency", label: "Transparency", group: "toggle", run: omarchy("omarchy-hyprland-window-transparency-toggle") },
  { id: "dismiss", label: "Dismiss alerts", group: "toggle", run: omarchy("omarchy-shell", "notifications", "dismissAll") },

  // -- capture ---------------------------------------------------------------
  { id: "screenshot", label: "Screenshot", group: "capture", run: omarchy("omarchy-capture-screenshot") },
  { id: "record", label: "Record", group: "capture", run: omarchy("omarchy-capture-screenrecording") },
  { id: "recordStop", label: "Stop record", group: "capture", run: omarchy("omarchy-capture-screenrecording", "--stop-recording") },
  { id: "ocr", label: "Copy text", group: "capture", run: omarchy("omarchy-capture-text") },
  { id: "color", label: "Pick colour", group: "capture", run: omarchy("hyprpicker", "-a") },
  { id: "qr", label: "Read QR", group: "capture", run: omarchy("omarchy-capture-qr") },

  // -- style -----------------------------------------------------------------
  { id: "bgNext", label: "Next wallpaper", group: "style", run: omarchy("omarchy-theme-bg-next") },
  { id: "themePicker", label: "Theme menu", group: "style", run: omarchy("omarchy-menu", "toggle", "theme") },

  // -- system ----------------------------------------------------------------
  { id: "lock", label: "Lock", group: "system", run: omarchy("omarchy-system-lock") },
  { id: "screensaver", label: "Screensaver", group: "system", run: omarchy("omarchy-launch-screensaver", "force") },
  { id: "suspend", label: "Suspend", group: "system", run: omarchy("systemctl", "suspend"), hold: true },
  { id: "closeAll", label: "Close all", group: "system", run: omarchy("omarchy-hyprland-window-close-all"), hold: true },

  // -- media -----------------------------------------------------------------
  { id: "play", label: "Play / pause", group: "media", run: omarchy("omarchy-shell", "media", "playPause") },
  { id: "next", label: "Next track", group: "media", run: omarchy("omarchy-shell", "media", "next") },
  { id: "prev", label: "Previous track", group: "media", run: omarchy("omarchy-shell", "media", "previous") },
  { id: "outputSwitch", label: "Audio output", group: "media", run: omarchy("omarchy-audio-output-switch") },
];

const BY_ID = new Map<ActionId, ActionDef>(ACTIONS.map((action) => [action.id, action]));

export function actionById(id: string): ActionDef | undefined {
  return BY_ID.get(id as ActionId);
}

export function actionsOf(group: ActionGroup): ActionDef[] {
  return ACTIONS.filter((action) => action.group === group);
}

/** The dock: the nine things a remote is reached for, in reading order. The
 *  tenth slot opens the pad with everything else. */
export const DOCK: readonly ActionId[] = [
  "menu",
  "terminal",
  "browser",
  "files",
  "editor",
  "fullscreen",
  "float",
  "screenshot",
];

/** Pad pages, in tab order, with the actions each shows. */
export const PAD_PAGES: readonly { id: ActionGroup | "theme"; label: string; actions: ActionId[] }[] = [
  {
    id: "window",
    label: "Window",
    actions: ["fullscreen", "maximize", "float", "pseudo", "split", "pop", "group", "cycle", "widen", "narrow", "close"],
  },
  {
    id: "workspace",
    label: "Desk",
    actions: ["wsPrev", "wsNext", "wsBack", "scratchpad", "toScratchpad", "layout", "apps", "keybindings", "emoji", "clipboard"],
  },
  {
    id: "toggle",
    label: "Toggle",
    actions: ["nightlight", "awake", "bar", "silence", "gaps", "transparency", "dismiss", "outputSwitch"],
  },
  {
    id: "capture",
    label: "Capture",
    actions: ["screenshot", "record", "recordStop", "ocr", "color", "qr"],
  },
  { id: "theme", label: "Theme", actions: ["bgNext", "themePicker"] },
  {
    id: "system",
    label: "System",
    actions: ["lock", "screensaver", "suspend", "closeAll"],
  },
];
