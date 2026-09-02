// apps/pocket-remote/host/omarchy.ts — the Omarchy side of the daemon: run
// one whitelisted action, read and set the audio and display levels, read
// the theme palette, type text. Everything here shells out to the same
// commands Omarchy binds to its keys, so the OSD, the sink resolution and
// the theme machinery are Omarchy's own.

import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ActionDef } from "../actions.ts";
import type { ThemeColors } from "../protocol.ts";
import { hyprDispatch } from "./hypr.ts";

const execFileAsync = promisify(execFile);

export interface Log {
  (message: string): void;
}

/** Fire-and-forget: the desktop command's output goes to the journal. */
export function runDetached(argv: string[], log: Log): void {
  const [command, ...args] = argv;
  if (!command) return;
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", (error) => log(`${command}: ${error.message}`));
    child.unref();
  } catch (error) {
    log(`${command}: ${(error as Error).message}`);
  }
}

export async function runAction(action: ActionDef, hyprDir: string, log: Log): Promise<void> {
  if ("dispatch" in action.run) {
    const reply = await hyprDispatch(hyprDir, action.run.dispatch);
    if (reply.trim() !== "ok") log(`dispatch ${action.run.dispatch}: ${reply.trim().split("\n")[0]}`);
    return;
  }
  runDetached(action.run.exec, log);
}

// ---------------------------------------------------------------------------
// levels
// ---------------------------------------------------------------------------

async function capture(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout: 3000 });
  return stdout;
}

/** The sink Omarchy's own volume keys move (resolves through any DSP sink). */
async function outputSink(): Promise<string> {
  try {
    const sink = (await capture("omarchy-audio-output-sink", [])).trim();
    if (sink) return sink;
  } catch {
    // fall through
  }
  return "@DEFAULT_AUDIO_SINK@";
}

/** Parse `pactl get-sink-volume` (first channel's percentage). */
export function parsePactlVolume(text: string): number | null {
  const match = text.match(/(\d+)%/);
  return match ? Number(match[1]) / 100 : null;
}

/** Parse `brightnessctl -m`: device,class,current,percent%,max. */
export function parseBrightnessctl(text: string): number | null {
  const first = text.trim().split("\n")[0] ?? "";
  const fields = first.split(",");
  const percent = fields[3];
  if (!percent) return null;
  const value = Number(percent.replace("%", ""));
  return Number.isFinite(value) ? value / 100 : null;
}

export interface Levels {
  vol: number;
  mute: boolean;
  bri: number;
}

export async function readLevels(): Promise<Levels> {
  const sink = await outputSink();
  const [volumeText, muteText, brightnessText] = await Promise.all([
    capture("pactl", ["get-sink-volume", sink]).catch(() => ""),
    capture("pactl", ["get-sink-mute", sink]).catch(() => ""),
    capture("brightnessctl", ["-m"]).catch(() => ""),
  ]);
  return {
    vol: parsePactlVolume(volumeText) ?? 0,
    mute: /yes/.test(muteText),
    bri: parseBrightnessctl(brightnessText) ?? 0,
  };
}

/**
 * Set the output volume to an absolute level through Omarchy's own script,
 * which only knows relative steps: read, diff, step. That keeps the OSD and
 * the DSP-sink resolution Omarchy's.
 */
export async function setVolume(level: number, log: Log): Promise<void> {
  const target = Math.round(Math.max(0, Math.min(1, level)) * 100);
  const sink = await outputSink();
  const current = parsePactlVolume(await capture("pactl", ["get-sink-volume", sink]).catch(() => ""));
  const from = current === null ? target : Math.round(current * 100);
  const delta = target - from;
  if (delta === 0) {
    // Still show the OSD, so the laptop acknowledges the touch.
    runDetached(["omarchy-audio-output-volume", "+0"], log);
    return;
  }
  runDetached(["omarchy-audio-output-volume", delta > 0 ? `+${delta}` : `${delta}`], log);
}

export function toggleMute(log: Log): void {
  runDetached(["omarchy-audio-output-volume", "mute-toggle"], log);
}

export function setBrightness(level: number, log: Log): void {
  const target = Math.round(Math.max(0.01, Math.min(1, level)) * 100);
  runDetached(["omarchy-brightness-display", `${target}%`], log);
}

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------

const STATE_DIR = join(homedir(), ".local/state/omarchy/current");

export function currentThemeName(): string {
  try {
    return readFileSync(join(STATE_DIR, "theme.name"), "utf8").trim() || "tokyo-night";
  } catch {
    return "tokyo-night";
  }
}

/** Where a theme's files live: the user's own themes first, then Omarchy's. */
export function themeDirectory(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    join(homedir(), ".config/omarchy/themes", name),
    join(env.OMARCHY_PATH ?? "/usr/share/omarchy", "themes", name),
  ];
  return candidates.find((dir) => existsSync(join(dir, "colors.toml"))) ?? null;
}

export function themeList(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set<string>();
  for (const dir of [join(env.OMARCHY_PATH ?? "/usr/share/omarchy", "themes"), join(homedir(), ".config/omarchy/themes")]) {
    try {
      for (const entry of readdirSync(dir)) {
        if (existsSync(join(dir, entry, "colors.toml"))) names.add(entry);
      }
    } catch {
      // missing directory
    }
  }
  return [...names].sort();
}

/** Parse Omarchy's colors.toml: flat `key = "#rrggbb"` lines. */
export function parseColorsToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#[^"]*$/, (m) => (raw.includes('"') ? m : "")).trim();
    const match = raw.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?(#[0-9a-fA-F]{6})/);
    if (match) out[match[1]!] = match[2]!.toLowerCase();
    void line;
  }
  return out;
}

/** The remote's palette from a theme's colours, with Tokyo Night fallbacks
 *  for keys a theme leaves out. */
export function paletteFrom(colors: Record<string, string>): ThemeColors {
  const pick = (keys: string[], fallback: string): string => {
    for (const key of keys) if (colors[key]) return colors[key]!;
    return fallback;
  };
  return {
    bg: pick(["background", "bg"], "#1a1b26"),
    bgDark: pick(["dark_background", "dark_bg", "darker_background", "background"], "#13141c"),
    fg: pick(["foreground", "fg"], "#a9b1d6"),
    fgDim: pick(["dark_foreground", "dark_fg", "color8"], "#565f89"),
    accent: pick(["accent", "blue", "color4"], "#7aa2f7"),
    red: pick(["red", "color1"], "#f7768e"),
    green: pick(["green", "color2"], "#9ece6a"),
    yellow: pick(["yellow", "color3"], "#e0af68"),
    blue: pick(["blue", "color4"], "#7aa2f7"),
    magenta: pick(["magenta", "purple", "color5"], "#bb9af7"),
    cyan: pick(["cyan", "color6"], "#449dab"),
    muted: pick(["color8", "dark_foreground"], "#414868"),
  };
}

export function readTheme(): { name: string; colors: ThemeColors; list: string[] } {
  const name = currentThemeName();
  const dir = themeDirectory(name);
  let colors: Record<string, string> = {};
  if (dir) {
    try {
      colors = parseColorsToml(readFileSync(join(dir, "colors.toml"), "utf8"));
    } catch {
      colors = {};
    }
  }
  return { name, colors: paletteFrom(colors), list: themeList() };
}

export function themeStateDirectory(): string {
  return STATE_DIR;
}

export function setThemeByName(name: string, list: string[], log: Log): boolean {
  if (!list.includes(name)) {
    log(`theme ${name}: not installed`);
    return false;
  }
  runDetached(["omarchy-theme-set", name], log);
  return true;
}

// ---------------------------------------------------------------------------
// typing
// ---------------------------------------------------------------------------

/** Keysyms the remote may send: xkb names wtype understands. Letters,
 *  digits and a few punctuation names carry modifiers (ctrl+c, alt+.). */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "Return", "BackSpace", "Tab", "ISO_Left_Tab", "Escape", "space", "Delete", "Insert",
  "Left", "Right", "Up", "Down", "Home", "End", "Page_Up", "Page_Down",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  "minus", "equal", "bracketleft", "bracketright", "semicolon", "apostrophe", "grave",
  "backslash", "comma", "period", "slash",
]);

const MODIFIERS: ReadonlySet<string> = new Set(["ctrl", "alt", "shift", "super"]);

/** wtype argv for one key with modifiers held around it: press mods, key,
 *  release mods in reverse. Null when the key or a modifier is not allowed. */
export function wtypeArgs(key: string, mods: readonly string[] = []): string[] | null {
  if (!ALLOWED_KEYS.has(key)) return null;
  if (mods.some((m) => !MODIFIERS.has(m))) return null;
  const unique = [...new Set(mods)];
  return [
    ...unique.flatMap((m) => ["-M", m]),
    "-k",
    key,
    ...unique.slice().reverse().flatMap((m) => ["-m", m]),
  ];
}

export function typeText(text: string, log: Log): void {
  // wtype types its argument literally; cap it so a runaway line cannot
  // flood the focused window.
  const clipped = Array.from(text).slice(0, 256).join("");
  if (clipped.length === 0) return;
  runDetached(["wtype", "--", clipped], log);
}

export function pressKey(key: string, log: Log, mods: readonly string[] = []): boolean {
  const args = wtypeArgs(key, mods);
  if (!args) return false;
  runDetached(["wtype", ...args], log);
  return true;
}
