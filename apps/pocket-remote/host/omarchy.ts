// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/host/omarchy.ts — the Omarchy side of the daemon: run
// one whitelisted action, read and set the audio and display levels, read
// the theme palette, type text. Everything here shells out to the same
// commands Omarchy binds to its keys, so the OSD, the sink resolution and
// the theme machinery are Omarchy's own.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ActionDef } from "../actions.ts";
import type { HostCc, ThemeColors } from "../protocol.ts";
import { hyprDispatch } from "./hypr.ts";
import { type MenuEntry, normalizeMenu, parseMenuJsonc } from "./menu-source.ts";

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

// ---------------------------------------------------------------------------
// network (the control centre's Wi-Fi tile)
// ---------------------------------------------------------------------------

/** Parse `omarchy-network-status`: `type\tssid\tsignal\tfreq`. */
export function parseNetworkStatus(text: string): { type: string; ssid: string; sig: number } {
  const [type = "", ssid = "", signal = ""] = text.trim().split("\n")[0]?.split("\t") ?? [];
  const sig = Number(signal);
  return { type: type || "disconnected", ssid, sig: Number.isFinite(sig) ? Math.max(0, Math.min(100, Math.round(sig))) : 0 };
}

/** Parse `nmcli -t radio wifi`: enabled / disabled. */
export function parseRadio(text: string): boolean {
  return /enabled/i.test(text);
}

export async function readWifi(): Promise<HostCc["wifi"]> {
  const [radio, status] = await Promise.all([
    capture("nmcli", ["-t", "radio", "wifi"]).catch(() => ""),
    capture("omarchy-network-status", []).catch(() => ""),
  ]);
  const net = parseNetworkStatus(status);
  const on = parseRadio(radio);
  return {
    on: on ? 1 : 0,
    ssid: on && net.type === "wifi" ? net.ssid : net.type === "ethernet" ? "ethernet" : "",
    sig: net.type === "wifi" ? net.sig : 0,
  };
}

export function setWifi(on: boolean, log: Log): void {
  runDetached(["nmcli", "radio", "wifi", on ? "on" : "off"], log);
}

// ---------------------------------------------------------------------------
// now playing (MPRIS over the session bus, through busctl)
// ---------------------------------------------------------------------------

/** MPRIS bus names out of `busctl --user --json=short list`. */
export function parseMprisNames(json: string): string[] {
  try {
    const rows = JSON.parse(json) as { name?: unknown }[];
    return rows
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter((name) => name.startsWith("org.mpris.MediaPlayer2."));
  } catch {
    return [];
  }
}

/** `busctl --json=short` encodes a variant as `{ type, data }`. */
function variantData(value: unknown): unknown {
  return value && typeof value === "object" && "data" in (value as Record<string, unknown>)
    ? (value as { data: unknown }).data
    : value;
}

/** Playback status and track out of `GetAll org.mpris.MediaPlayer2.Player`. */
export function parseMprisPlayer(json: string): HostCc["media"] | null {
  try {
    const parsed = JSON.parse(json) as { data?: unknown[] };
    const props = variantData(parsed.data?.[0]) as Record<string, unknown> | undefined;
    if (!props || typeof props !== "object") return null;
    const status = String(variantData(props.PlaybackStatus) ?? "");
    const metadata = (variantData(props.Metadata) ?? {}) as Record<string, unknown>;
    const title = variantData(metadata["xesam:title"]);
    const artist = variantData(metadata["xesam:artist"]);
    return {
      st: status === "Playing" ? "playing" : status === "Paused" ? "paused" : "none",
      title: typeof title === "string" ? title.slice(0, 60) : "",
      artist: Array.isArray(artist) ? artist.filter((a): a is string => typeof a === "string").join(", ").slice(0, 60) : "",
    };
  } catch {
    return null;
  }
}

const NOTHING_PLAYING: HostCc["media"] = { st: "none", title: "", artist: "" };

/** The playing player, else the first paused one, else nothing. */
export async function readMedia(): Promise<HostCc["media"]> {
  const names = parseMprisNames(await capture("busctl", ["--user", "--json=short", "list"]).catch(() => "[]"));
  let paused: HostCc["media"] | null = null;
  for (const name of names) {
    const player = parseMprisPlayer(
      await capture("busctl", [
        "--user", "--json=short", "call", name, "/org/mpris/MediaPlayer2",
        "org.freedesktop.DBus.Properties", "GetAll", "s", "org.mpris.MediaPlayer2.Player",
      ]).catch(() => ""),
    );
    if (!player) continue;
    if (player.st === "playing") return player;
    if (player.st === "paused" && !paused) paused = player;
  }
  return paused ?? NOTHING_PLAYING;
}

// ---------------------------------------------------------------------------
// Omarchy's menu
// ---------------------------------------------------------------------------

const MENU_ID = /^[a-z0-9][a-z0-9._-]*$/i;

/** The menu as this machine defines it: Omarchy's default file, then the
 *  user's extension. */
export function loadMenu(env: NodeJS.ProcessEnv = process.env): MenuEntry[] {
  const layers = [
    join(env.OMARCHY_PATH ?? "/usr/share/omarchy", "default/omarchy/omarchy-menu.jsonc"),
    join(homedir(), ".config/omarchy/extensions/omarchy-menu.jsonc"),
  ]
    .filter((path) => existsSync(path))
    .map((path) => parseMenuJsonc(readFileSync(path, "utf8")));
  return normalizeMenu(layers);
}

/** Run one row the way the shell runs it: an action's command under bash,
 *  a provider or link summoned on the desktop. False for an unknown id. */
export function runMenuEntry(entries: readonly MenuEntry[], id: string, log: Log): boolean {
  if (!MENU_ID.test(id)) return false;
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return false;
  if (entry.kind === "action" && entry.action) {
    runDetached(["bash", "-lc", entry.action], log);
    return true;
  }
  runDetached(["omarchy-menu", "summon", entry.kind === "link" && entry.target ? entry.target : entry.id], log);
  return true;
}

/**
 * Evaluate every `when` and `checked` in one bash run, the way the shell
 * does at open time. Returns the rows hidden by a failing `when` and the
 * rows whose `checked` holds.
 */
export async function evaluateMenuConditions(entries: readonly MenuEntry[]): Promise<{ hide: string[]; check: string[] }> {
  const lines: string[] = [];
  for (const entry of entries) {
    if (!MENU_ID.test(entry.id)) continue;
    if (entry.when) lines.push(`if ( ${entry.when} ) >/dev/null 2>&1; then :; else printf 'w %s\\n' '${entry.id}'; fi`);
    if (entry.checked) lines.push(`if ( ${entry.checked} ) >/dev/null 2>&1; then printf 'c %s\\n' '${entry.id}'; fi`);
  }
  if (lines.length === 0) return { hide: [], check: [] };
  const { stdout } = await execFileAsync("bash", ["-lc", lines.join("\n")], { timeout: 30_000, maxBuffer: 1 << 20 });
  const hide: string[] = [];
  const check: string[] = [];
  for (const line of stdout.split("\n")) {
    const [kind, id] = line.split(" ");
    if (!id || !MENU_ID.test(id)) continue;
    if (kind === "w") hide.push(id);
    else if (kind === "c") check.push(id);
  }
  return { hide: hide.sort(), check: check.sort() };
}

// ---------------------------------------------------------------------------
// the pointer (host/pointer/pocket-pointer.c)
// ---------------------------------------------------------------------------

const BUTTON_CODES = { l: 272, r: 273, m: 274 } as const;

/** One long-lived virtual pointer, fed one command per line. Started on
 *  first use, restarted after it dies, silent about it beyond the log. */
export class Pointer {
  private child: ChildProcess | null = null;
  private ready = false;
  private queue: string[] = [];
  private failedAt = 0;
  private scrolling = false;
  private scrollEnd: ReturnType<typeof setTimeout> | null = null;
  private readonly binary: string;
  private readonly log: Log;

  // No parameter properties: Node runs this file with type stripping, which
  // erases annotations but cannot rewrite constructor(private x) syntax.
  constructor(binary?: string, log?: Log) {
    this.binary = binary ?? join(dirname(fileURLToPath(import.meta.url)), "pointer/pocket-pointer");
    this.log = log ?? (() => {});
  }

  available(): boolean {
    return existsSync(this.binary);
  }

  private start(): void {
    if (this.child || Date.now() < this.failedAt) return;
    if (!this.available()) {
      if (!this.failedAt) this.log(`pointer: ${this.binary} is missing — redeploy with tools/pocket-remote.ts deploy-host`);
      this.failedAt = Date.now() + 30_000;
      return;
    }
    const child = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready") && !this.ready) {
        this.ready = true;
        this.log("pointer: virtual pointer ready");
        for (const line of this.queue.splice(0)) child.stdin?.write(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => this.log(`pointer: ${chunk.toString().trim()}`));
    const gone = () => {
      if (this.child === child) {
        this.child = null;
        this.ready = false;
        this.failedAt = Date.now() + 2000;
      }
    };
    child.on("exit", (code) => {
      if (code !== 0) this.log(`pointer: exited ${code}`);
      gone();
    });
    child.on("error", (error) => {
      this.log(`pointer: ${error.message}`);
      gone();
    });
  }

  private write(line: string): void {
    this.start();
    if (this.child && this.ready) this.child.stdin?.write(line);
    else if (this.queue.length < 64) this.queue.push(line);
  }

  move(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.write(`m ${dx.toFixed(2)} ${dy.toFixed(2)}\n`);
  }

  button(b: "l" | "r" | "m", down: boolean): void {
    this.write(`b ${BUTTON_CODES[b]} ${down ? 1 : 0}\n`);
  }

  click(b: "l" | "r" | "m"): void {
    this.button(b, true);
    this.button(b, false);
  }

  /** Finger scrolling: a stream of deltas, ended a moment after the last. */
  scroll(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.scrolling = true;
    this.write(`s ${dy.toFixed(2)} ${dx.toFixed(2)}\n`);
    if (this.scrollEnd) clearTimeout(this.scrollEnd);
    this.scrollEnd = setTimeout(() => {
      this.scrollEnd = null;
      if (this.scrolling) {
        this.scrolling = false;
        this.write("e\n");
      }
    }, 120);
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
