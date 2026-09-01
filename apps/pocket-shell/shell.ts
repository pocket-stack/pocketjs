// apps/pocket-shell/shell.ts — pocketsh, the terminal applet's command
// interpreter. It is to Pocket Shell what hyprctl is to Hyprland: every
// window-manager verb the chords reach is also a command here, so the same
// state can be driven from a keyboard. Pure: the interpreter takes a
// ShellApi and returns the lines to print, and is unit-tested against a fake.

import type { LayoutKind } from "./wm.ts";

export interface ShellWindow {
  id: number;
  app: string;
  title: string;
  ws: number;
  focused: boolean;
}

export interface ShellApi {
  apps(): readonly string[];
  windows(): ShellWindow[];
  workspace(): number;
  layout(): LayoutKind;
  wallpaper(): string;
  uptimeSeconds(): number;
  now(): Date;
  host(): string;
  open(app: string): number | null;
  close(id?: number): boolean;
  focus(id: number): boolean;
  switchWs(id: number): boolean;
  setLayout(layout: LayoutKind): void;
  nextWallpaper(): string;
  keys(): { title: string; rows: { keys: string; what: string }[] }[];
}

export const COMMANDS = [
  "help",
  "ls",
  "open",
  "close",
  "focus",
  "ws",
  "layout",
  "wall",
  "keys",
  "fetch",
  "date",
  "uptime",
  "echo",
  "clear",
] as const;

export type Command = (typeof COMMANDS)[number];

/** Command names starting with `partial`, for Tab completion. */
export function complete(partial: string): string[] {
  return COMMANDS.filter((c) => c.startsWith(partial));
}

export const CLEAR = "\u0000clear";

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function formatClock(date: Date, hour12 = false): string {
  const h = date.getHours();
  const shown = hour12 ? h % 12 || 12 : h;
  return `${pad2(shown)}:${pad2(date.getMinutes())}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(date: Date): string {
  return `${DAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()} ${date.getFullYear()}`;
}

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${pad2(m)}m ${pad2(s % 60)}s` : `${m}m ${pad2(s % 60)}s`;
}

/** Run one line. Returns output lines; CLEAR as the only line clears the
 *  scrollback. */
export function run(line: string, api: ShellApi): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const [name, ...args] = words;
  switch (name) {
    case "help":
      return [
        "pocketsh — the shell's own hyprctl",
        "  ls              windows on this workspace",
        "  open <app>      " + api.apps().join(" "),
        "  close [id]      close focused or #id",
        "  focus <id>      focus window #id",
        "  ws [1-5]        show or switch workspace",
        "  layout [name]   dwindle | scrolling",
        "  wall [next]     wallpaper",
        "  keys            the chord table",
        "  fetch date uptime echo clear",
      ];
    case "ls": {
      const list = api.windows().filter((w) => w.ws === api.workspace());
      if (list.length === 0) return ["(empty workspace)"];
      return list.map((w) => `${w.focused ? "*" : " "} #${w.id}  ${w.title}`);
    }
    case "open": {
      const app = args[0];
      if (!app) return ["open: which app? " + api.apps().join(" ")];
      const id = api.open(app);
      return id === null ? [`open: no app named '${app}'`] : [`opened ${app} as #${id}`];
    }
    case "close": {
      if (args[0] !== undefined) {
        const id = Number(args[0].replace("#", ""));
        if (!Number.isInteger(id)) return [`close: bad id '${args[0]}'`];
        return api.close(id) ? [`closed #${id}`] : [`close: no window #${id}`];
      }
      return api.close() ? ["closed"] : ["close: nothing focused"];
    }
    case "focus": {
      const id = Number((args[0] ?? "").replace("#", ""));
      if (!Number.isInteger(id)) return ["focus: which id?"];
      return api.focus(id) ? [] : [`focus: no window #${id}`];
    }
    case "ws": {
      if (args[0] === undefined) return [`workspace ${api.workspace()} · ${api.layout()}`];
      const id = Number(args[0]);
      return api.switchWs(id) ? [] : [`ws: workspaces are 1-5`];
    }
    case "layout": {
      if (args[0] === undefined) return [api.layout()];
      if (args[0] !== "dwindle" && args[0] !== "scrolling") return ["layout: dwindle | scrolling"];
      api.setLayout(args[0]);
      return [`workspace ${api.workspace()} is now ${args[0]}`];
    }
    case "wall":
      if (args[0] === "next") return [`wallpaper: ${api.nextWallpaper()}`];
      return [`wallpaper: ${api.wallpaper()} (wall next)`];
    case "keys":
      return api
        .keys()
        .flatMap((group) => [group.title, ...group.rows.map((r) => `  ${r.keys.padEnd(12)} ${r.what}`)]);
    case "fetch": {
      const windows = api.windows();
      return [
        "  ___      pocket-shell @ " + api.host(),
        " /   \\     ws       " + `${api.workspace()} · ${api.layout()}`,
        "|  o  |    windows  " + String(windows.length),
        " \\___/     uptime   " + formatUptime(api.uptimeSeconds()),
        "  | |      theme    tokyo-night",
        "           wall     " + api.wallpaper(),
      ];
    }
    case "date":
      return [`${formatDate(api.now())} ${formatClock(api.now())}`];
    case "uptime":
      return [formatUptime(api.uptimeSeconds())];
    case "echo":
      return [args.join(" ")];
    case "clear":
      return [CLEAR];
    default:
      return [`pocketsh: ${name}: command not found`];
  }
}
