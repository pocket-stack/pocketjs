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
  now(): CivilTime;
  host(): string;
  open(app: string): number | null;
  close(id?: number): boolean;
  focus(id: number): boolean;
  switchWs(id: number): boolean;
  setLayout(layout: LayoutKind): void;
  nextWallpaper(): string;
  timezone(): number;
  setTimezone(minutes: number): void;
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
  "tz",
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

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface CivilTime {
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
  /** 0 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Civil time from an epoch, by arithmetic.
 *
 * The 3DS RTC's epoch is reliable — `Date.now()` is monotonic and correct on
 * hardware — but QuickJS's BREAKDOWN of it is not: `getHours()` intermittently
 * disagreed with the epoch by whole hours, applying the timezone on some reads
 * and not others. Two adjacent frames therefore rendered two different times
 * and the clock appeared to flicker. Everything this app displays is derived
 * here instead, so a wrong reading cannot reach the screen.
 *
 * Days-to-civil is Howard Hinnant's shift-to-March algorithm, which needs no
 * lookup table and no leap-year special cases.
 */
export function civilFromEpoch(epochMs: number, offsetMinutes = 0): CivilTime {
  const total = Math.floor(epochMs / 1000) + offsetMinutes * 60;
  let days = Math.floor(total / 86400);
  const secondOfDay = total - days * 86400;
  const weekday = (((days + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
  days += 719468; // shift the epoch to 0000-03-01
  const era = Math.floor(days / 146097);
  const dayOfEra = days - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const marchMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * marchMonth + 2) / 5) + 1;
  const month = marchMonth < 10 ? marchMonth + 3 : marchMonth - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return {
    year,
    month,
    day,
    weekday,
    hour: Math.floor(secondOfDay / 3600),
    minute: Math.floor((secondOfDay % 3600) / 60),
    second: secondOfDay % 60,
  };
}

/**
 * The device's UTC offset, read ONCE and sanity-checked.
 *
 * A single bad read would otherwise be frozen in, so the value is accepted
 * only if it looks like a real zone: a whole quarter-hour within ±14 h.
 * Anything else means the platform's breakdown is not to be trusted at all
 * and the shell shows UTC.
 */
export function detectOffsetMinutes(epochMs: number, local: Date): number {
  const utc = civilFromEpoch(epochMs, 0);
  let delta = local.getHours() * 60 + local.getMinutes() - (utc.hour * 60 + utc.minute);
  if (delta > 720) delta -= 1440;
  if (delta < -720) delta += 1440;
  if (Math.abs(delta) > 14 * 60 || delta % 15 !== 0) return 0;
  return delta;
}

/** "+08:00" / "-05:30" / "" for UTC itself. */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return "";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** `+8`, `8`, `-5:30`, `+05:45`, `0` — a whole quarter-hour within ±14 h. */
export function parseOffset(text: string): number | null {
  const m = /^([+-]?)(\d{1,2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  const signed = m[1] === "-" ? -minutes : minutes;
  if (Math.abs(signed) > 14 * 60 || signed % 15 !== 0) return null;
  return signed;
}

export function formatClock(time: CivilTime, hour12 = false): string {
  const shown = hour12 ? time.hour % 12 || 12 : time.hour;
  return `${pad2(shown)}:${pad2(time.minute)}`;
}

export function formatDate(time: CivilTime): string {
  return `${DAYS[time.weekday]} ${MONTHS[time.month - 1]} ${time.day} ${time.year}`;
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
        "  tz [+8|-5:30]   clock offset from UTC",
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
    case "tz": {
      // The console's own breakdown of the epoch is not trustworthy (see
      // civilFromEpoch), so the offset is the operator's to state.
      if (args[0] === undefined) return [`UTC${formatOffset(api.timezone())}`];
      const minutes = parseOffset(args[0]);
      if (minutes === null) return ["tz: try +8, -5:30, or 0"];
      api.setTimezone(minutes);
      return [`clock is UTC${formatOffset(minutes)}`];
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
