// apps/pocket-remote/host/serve.ts — the Omarchy-side daemon for Pocket
// Remote. Runs on the Omarchy machine as a user service:
//
//   node serve.ts [--port 8622] [--beacon] [--name <picker name>]
//
// Node >= 23.6 (native type stripping); Omarchy installs Node through mise,
// so `~/.local/share/mise/shims/node` is the interpreter the unit uses.
//
// What it does: listens for PKNT connections from the remote, mirrors
// Hyprland (one snapshot per change, debounced) plus the volume, brightness
// and theme to every connected device, and runs the commands the device asks
// for — never a command string off the wire, only ids from actions.ts.
//
// Trust: the LAN is not a trust boundary. A device that has not been seen
// before is put on hold and a dialog appears on the desktop (hyprland-dialog)
// asking whether to allow it; the answer is remembered by address in
// ~/.local/state/pocket-remote/allowed.json. Until allowed, a device sees the
// mirror but its commands are dropped.

import { createServer, type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { actionById } from "../actions.ts";
import {
  type ClientLine,
  type HostLine,
  type HostState,
  parseLines,
  REMOTE_APP,
  REMOTE_PROTO,
} from "../protocol.ts";
import { hyprBatch, hyprDirectory, hyprDispatch, luaWindow, luaWorkspace, snapshot, STATE_EVENTS, watchEvents } from "./hypr.ts";
import {
  pressKey,
  readLevels,
  readTheme,
  runAction,
  setBrightness,
  setThemeByName,
  setVolume,
  themeStateDirectory,
  toggleMute,
  typeText,
} from "./omarchy.ts";
import {
  encodeBeacon,
  encodeCtrl,
  encodeFrame,
  encodeHelloAck,
  FrameParser,
  parseHello,
  WIRE_BEACON_PORT,
  WIRE_MSG,
  WIRE_PORT,
} from "./wire.ts";

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

interface Options {
  port: number;
  beacon: boolean;
  name: string;
  /** Skip the approval dialog (every device allowed) — for tests only. */
  trustAll: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { port: WIRE_PORT, beacon: false, name: hostname(), trustAll: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--beacon") options.beacon = true;
    else if (arg === "--name") options.name = argv[++i] ?? options.name;
    else if (arg === "--trust-all") options.trustAll = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("node serve.ts [--port 8622] [--beacon] [--name <picker name>]");
      process.exit(0);
    }
  }
  return options;
}

const options = parseOptions(process.argv.slice(2));
const log = (message: string) => console.log(`[remote] ${new Date().toISOString().slice(11, 19)} ${message}`);

// ---------------------------------------------------------------------------
// allow list
// ---------------------------------------------------------------------------

const STATE_HOME = join(homedir(), ".local/state/pocket-remote");
const ALLOWED_PATH = join(STATE_HOME, "allowed.json");

function readAllowed(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(ALLOWED_PATH, "utf8")) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeAllowed(allowed: Set<string>): void {
  mkdirSync(STATE_HOME, { recursive: true });
  writeFileSync(ALLOWED_PATH, JSON.stringify([...allowed].sort(), null, 2) + "\n");
}

const allowed = readAllowed();
const denied = new Set<string>();
let dialogOpen: Promise<Verdict> | null = null;

type Verdict = "allow" | "deny" | "timeout";

/** Ask on the desktop. One dialog at a time; a second device waits. A
 *  dialog nobody answers is not a refusal: the device stays pending and is
 *  asked again when it next connects. */
function askApproval(address: string, device: string): Promise<Verdict> {
  const run = () =>
    new Promise<Verdict>((resolve) => {
      execFile(
        "hyprland-dialog",
        [
          "--title",
          "Pocket Remote",
          "--apptitle",
          "A remote wants to control this desktop",
          "--text",
          `${device} at ${address} is asking to connect as a Pocket Remote. Allow it to switch workspaces, launch apps, change volume and type here?`,
          "--buttons",
          "Allow;Deny",
        ],
        { timeout: 120_000 },
        (error, stdout) => {
          if (error) {
            log(`dialog: ${error.message}`);
            resolve("timeout");
            return;
          }
          const answer = stdout.trim().toLowerCase();
          resolve(answer.startsWith("allow") ? "allow" : answer.startsWith("deny") ? "deny" : "timeout");
        },
      );
    });
  const next: Promise<Verdict> = (dialogOpen ?? Promise.resolve<Verdict>("timeout")).then(run, run);
  dialogOpen = next;
  next.finally(() => {
    if (dialogOpen === next) dialogOpen = null;
  });
  return next;
}

// ---------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------

interface Conn {
  socket: Socket;
  address: string;
  parser: FrameParser;
  hello: Uint8Array | null;
  device: string;
  auth: "ok" | "pending" | "denied";
  lastSeen: number;
}

const conns = new Set<Conn>();

function sendLine(conn: Conn, line: HostLine): void {
  try {
    conn.socket.write(encodeCtrl(JSON.stringify(line)));
  } catch (error) {
    log(`send to ${conn.address}: ${(error as Error).message}`);
  }
}

function broadcast(line: HostLine): void {
  for (const conn of conns) if (conn.hello === null) sendLine(conn, line);
}

// ---------------------------------------------------------------------------
// mirror
// ---------------------------------------------------------------------------

const hyprDir = hyprDirectory();
let lastState: HostState | null = null;
let lastLevels: { vol: number; mute: boolean; bri: number } | null = null;
let theme = readTheme();
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotBusy = false;
let snapshotDirty = false;

async function refreshState(): Promise<void> {
  if (snapshotBusy) {
    snapshotDirty = true;
    return;
  }
  snapshotBusy = true;
  try {
    const state = await snapshot(hyprDir);
    const text = JSON.stringify(state);
    if (!lastState || JSON.stringify(lastState) !== text) {
      lastState = state;
      broadcast(state);
    }
  } catch (error) {
    log(`snapshot: ${(error as Error).message}`);
  } finally {
    snapshotBusy = false;
    if (snapshotDirty) {
      snapshotDirty = false;
      scheduleSnapshot(20);
    }
  }
}

/** Debounce: Hyprland emits bursts (a window open is 4-5 events). */
function scheduleSnapshot(delayMs = 30): void {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    void refreshState();
  }, delayMs);
}

async function refreshLevels(force = false): Promise<void> {
  try {
    const levels = await readLevels();
    if (
      force ||
      !lastLevels ||
      Math.abs(levels.vol - lastLevels.vol) > 0.004 ||
      levels.mute !== lastLevels.mute ||
      Math.abs(levels.bri - lastLevels.bri) > 0.004
    ) {
      lastLevels = levels;
      const line: HostLine = { t: "levels", vol: levels.vol, bri: levels.bri };
      if (levels.mute) line.mute = 1;
      broadcast(line);
    }
  } catch (error) {
    log(`levels: ${(error as Error).message}`);
  }
}

function refreshTheme(): void {
  const next = readTheme();
  if (JSON.stringify(next) === JSON.stringify(theme)) return;
  theme = next;
  broadcast({ t: "theme", name: theme.name, colors: theme.colors, list: theme.list });
  log(`theme -> ${theme.name}`);
}

function sendMirror(conn: Conn): void {
  sendLine(conn, { t: "theme", name: theme.name, colors: theme.colors, list: theme.list });
  if (lastLevels) {
    const line: HostLine = { t: "levels", vol: lastLevels.vol, bri: lastLevels.bri };
    if (lastLevels.mute) line.mute = 1;
    sendLine(conn, line);
  }
  if (lastState) sendLine(conn, lastState);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function dispatchLogged(lua: string): Promise<void> {
  const reply = await hyprDispatch(hyprDir, lua);
  if (reply.trim() !== "ok") log(`dispatch ${lua}: ${reply.trim().split("\n")[0]}`);
}

async function batchLogged(luaDispatchers: string[]): Promise<void> {
  const reply = await hyprBatch(hyprDir, luaDispatchers);
  if (reply.trim() !== "ok") log(`batch ${luaDispatchers.join(" ")}: ${reply.trim().split("\n")[0]}`);
}

async function handle(conn: Conn, line: ClientLine): Promise<void> {
  if (line.t === "hello") {
    conn.device = typeof line.device === "string" ? line.device.slice(0, 40) : "device";
    if (line.proto !== REMOTE_PROTO) log(`${conn.address}: proto ${line.proto} (ours ${REMOTE_PROTO})`);
    if (options.trustAll || allowed.has(conn.address)) conn.auth = "ok";
    else if (denied.has(conn.address)) conn.auth = "denied";
    else conn.auth = "pending";
    sendLine(conn, { t: "hello", proto: REMOTE_PROTO, name: options.name, omarchy: omarchyVersion, auth: conn.auth });
    sendMirror(conn);
    if (conn.auth !== "pending") log(`${conn.device} at ${conn.address}: ${conn.auth === "ok" ? "allowed" : "denied"}`);
    if (conn.auth === "pending") {
      log(`${conn.device} at ${conn.address} asks to connect — dialog on screen`);
      const verdict = await askApproval(conn.address, conn.device);
      if (verdict === "allow") {
        allowed.add(conn.address);
        writeAllowed(allowed);
        conn.auth = "ok";
      } else if (verdict === "deny") {
        denied.add(conn.address);
        conn.auth = "denied";
      }
      log(`${conn.address}: ${verdict}`);
      if (conns.has(conn) && verdict !== "timeout") sendLine(conn, { t: "auth", auth: conn.auth });
    }
    return;
  }
  if (conn.auth !== "ok") return;

  switch (line.t) {
    case "act": {
      const action = actionById(line.id);
      if (!action) {
        log(`${conn.address}: unknown action ${JSON.stringify(line.id)}`);
        return;
      }
      await runAction(action, hyprDir, log);
      scheduleSnapshot();
      if (action.group === "media" || action.id === "nightlight") setTimeout(() => void refreshLevels(), 300);
      return;
    }
    case "ws": {
      const target = luaWorkspace(Number(line.n), line.rel === 1);
      if (!target) return;
      await dispatchLogged(`hl.dsp.focus({ workspace = ${target} })`);
      scheduleSnapshot();
      return;
    }
    case "win": {
      const window = typeof line.a === "string" ? luaWindow(line.a) : null;
      if (!window) return;
      switch (line.op) {
        case "focus":
          await dispatchLogged(`hl.dsp.focus({ window = ${window} })`);
          break;
        case "close":
          await dispatchLogged(`hl.dsp.window.close({ window = ${window} })`);
          break;
        case "swap":
          if (!["l", "r", "u", "d"].includes(line.dir)) return;
          await batchLogged([`hl.dsp.focus({ window = ${window} })`, `hl.dsp.window.swap({ direction = "${line.dir}" })`]);
          break;
        case "move": {
          const target = luaWorkspace(Number(line.n));
          if (!target) return;
          await dispatchLogged(`hl.dsp.window.move({ window = ${window}, workspace = ${target}, follow = false })`);
          break;
        }
      }
      scheduleSnapshot();
      return;
    }
    case "vol": {
      const v = Number(line.v);
      if (!Number.isFinite(v)) return;
      await setVolume(v, log);
      setTimeout(() => void refreshLevels(), 150);
      return;
    }
    case "bri": {
      const v = Number(line.v);
      if (!Number.isFinite(v)) return;
      setBrightness(v, log);
      setTimeout(() => void refreshLevels(), 300);
      return;
    }
    case "mute":
      toggleMute(log);
      setTimeout(() => void refreshLevels(), 150);
      return;
    case "media": {
      const action = actionById(line.op === "play" ? "play" : line.op === "next" ? "next" : "prev");
      if (action) await runAction(action, hyprDir, log);
      return;
    }
    case "type":
      if (typeof line.text === "string") typeText(line.text, log);
      return;
    case "key": {
      const mods: string[] = Array.isArray(line.mods) ? (line.mods as unknown[]).filter((m): m is string => typeof m === "string") : [];
      if (typeof line.k === "string" && !pressKey(line.k, log, mods)) {
        log(`${conn.address}: key ${line.k}${mods.length ? `+${mods.join("+")}` : ""} not allowed`);
      }
      return;
    }
    case "theme":
      if (typeof line.name === "string" && setThemeByName(line.name, theme.list, log)) {
        setTimeout(refreshTheme, 1500);
        setTimeout(refreshTheme, 4000);
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

let omarchyVersion = "";
execFile("omarchy-version", [], { timeout: 3000 }, (error, stdout) => {
  if (!error) omarchyVersion = stdout.trim();
});

const server = createServer((socket) => {
  const address = socket.remoteAddress?.replace(/^::ffff:/, "") ?? "?";
  const conn: Conn = {
    socket,
    address,
    parser: new FrameParser(),
    hello: new Uint8Array(0),
    device: "device",
    auth: "pending",
    lastSeen: Date.now(),
  };
  socket.setNoDelay(true);
  conns.add(conn);
  log(`connection from ${address}`);
  socket.on("data", (chunk: Buffer) => {
    conn.lastSeen = Date.now();
    try {
      let bytes = new Uint8Array(chunk);
      if (conn.hello !== null) {
        const merged = new Uint8Array(conn.hello.length + bytes.length);
        merged.set(conn.hello);
        merged.set(bytes, conn.hello.length);
        const hello = parseHello(merged);
        if (hello === null) {
          conn.hello = merged;
          return;
        }
        if (hello.app !== REMOTE_APP) throw new Error(`unknown app "${hello.app}"`);
        conn.hello = null;
        socket.write(encodeHelloAck());
        bytes = merged.slice(hello.consumed);
      }
      for (const frame of conn.parser.push(bytes)) {
        if (frame.type === WIRE_MSG.pong) continue;
        if (frame.type !== WIRE_MSG.ctrl) continue; // forward compatibility
        const text = new TextDecoder().decode(frame.payload);
        for (const line of parseLines<ClientLine>(text)) {
          handle(conn, line).catch((error) => log(`${address}: ${(error as Error).message}`));
        }
      }
    } catch (error) {
      log(`dropping ${address}: ${(error as Error).message}`);
      socket.destroy();
    }
  });
  const gone = () => {
    if (conns.delete(conn)) log(`${address} disconnected`);
  };
  socket.on("close", gone);
  socket.on("error", (error) => {
    log(`${address}: ${error.message}`);
    gone();
  });
});

server.listen(options.port, "0.0.0.0", () => {
  log(`listening on tcp ${options.port} (hyprland at ${hyprDir})`);
});

// ping every 2 s; drop after 10 s of silence (the wire's liveness rule)
let pingToken = 1;
setInterval(() => {
  const now = Date.now();
  for (const conn of conns) {
    if (now - conn.lastSeen > 10_000) {
      log(`${conn.address} silent, dropping`);
      conn.socket.destroy();
      conns.delete(conn);
      continue;
    }
    const token = new Uint8Array(4);
    new DataView(token.buffer).setUint32(0, pingToken++ >>> 0, true);
    conn.socket.write(encodeFrame(WIRE_MSG.ping, token));
  }
}, 2000);

// discovery beacon (off by default: on a firewalled box the relay beacons)
if (options.beacon) {
  const udp = createSocket("udp4");
  const payload = encodeBeacon(REMOTE_APP, options.name, options.port);
  udp.bind(() => {
    udp.setBroadcast(true);
    setInterval(() => udp.send(payload, WIRE_BEACON_PORT, "255.255.255.255", () => {}), 1000);
    log(`beacon on udp ${WIRE_BEACON_PORT}`);
  });
}

// mirror sources
watchEvents(
  hyprDir,
  (event) => {
    if (STATE_EVENTS.has(event.name)) scheduleSnapshot();
  },
  log,
);
void refreshState();
void refreshLevels(true);
setInterval(() => void refreshLevels(), 1000);
setInterval(() => scheduleSnapshot(), 5000); // belt and braces for missed events
try {
  const stateDir = themeStateDirectory();
  if (existsSync(stateDir)) watch(stateDir, () => setTimeout(refreshTheme, 500));
} catch (error) {
  log(`theme watch: ${(error as Error).message}`);
}
setInterval(refreshTheme, 10_000);
