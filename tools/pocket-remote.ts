// tools/pocket-remote.ts — operate the Pocket Remote daemon on an Omarchy
// machine from this Mac, and bridge the iPod to it when the machine's
// firewall is in the way.
//
//   bun tools/pocket-remote.ts deploy-host <ssh host>   copy the daemon, install the user unit, restart
//   bun tools/pocket-remote.ts logs <ssh host> [-n 80]  journal tail
//   bun tools/pocket-remote.ts status <ssh host>        unit status + listener
//   bun tools/pocket-remote.ts relay <ssh host>         ssh -L tunnel (local 8623) + LAN beacon from this Mac
//   bun tools/pocket-remote.ts client <host:port>       a scripted device, for checking a daemon
//
// Why a relay: Omarchy ships ufw with incoming DROP (only ssh is open), so the
// iPod cannot reach tcp 8622 on the laptop directly. The relay forwards the
// wire over the ssh connection that IS allowed and answers the LAN beacon
// from the Mac, so the device connects to the Mac and the Mac to the laptop.
// Once `sudo ufw allow from <lan> to any port 8622 proto tcp` has been run on
// the laptop, start the daemon with --beacon instead and drop the relay.

import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeMenu, parseMenuJsonc, type MenuEntry } from "../apps/pocket-remote/host/menu-source.ts";
import { REMOTE_APP, REMOTE_PROTO, type ClientLine, type HostLine, parseLines } from "../apps/pocket-remote/protocol.ts";
import {
  encodeBeacon,
  encodeCtrl,
  encodeFrame,
  FrameParser,
  WIRE_BEACON_PORT,
  WIRE_MAGIC,
  WIRE_MSG,
  WIRE_PORT,
  WIRE_VERSION,
} from "../apps/pocket-remote/host/wire.ts";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const APP_DIR = join(REPOSITORY, "apps/pocket-remote");
/** Files the daemon needs on the Omarchy machine (no repository there). */
const HOST_FILES = [
  "LICENSE",
  "protocol.ts",
  "actions.ts",
  "host/wire.ts",
  "host/hypr.ts",
  "host/omarchy.ts",
  "host/menu-source.ts",
  "host/serve.ts",
  "host/pointer/pocket-pointer.c",
  "host/pointer/wlr-virtual-pointer-unstable-v1.xml",
];
const REMOTE_DIR = ".local/share/pocket-remote";
const UNIT = "pocket-remote.service";

function run(cmd: string[], input?: string): string {
  const result = Bun.spawnSync({ cmd, stdin: input === undefined ? "inherit" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${result.exitCode}):\n${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function ssh(host: string, command: string, input?: string): string {
  return run(["ssh", "-o", "BatchMode=yes", host, command], input);
}

async function deployHost(host: string): Promise<void> {
  // One tar over ssh: the six daemon files and the unit, into the user's home.
  const tar = Bun.spawnSync({
    cmd: ["tar", "-cf", "-", "-C", APP_DIR, ...HOST_FILES, "host/pocket-remote.service"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  const archive = Buffer.from(tar.stdout);
  // The pointer helper is built on the machine: wayland-scanner turns the
  // vendored protocol XML into a header and a stub, cc links them against
  // libwayland-client. Both ship with Omarchy (base-devel, wayland).
  const buildPointer =
    `cd ~/${REMOTE_DIR}/host/pointer && ` +
    "wayland-scanner client-header wlr-virtual-pointer-unstable-v1.xml wlr-virtual-pointer-unstable-v1-client-protocol.h && " +
    "wayland-scanner private-code wlr-virtual-pointer-unstable-v1.xml wlr-virtual-pointer-unstable-v1-protocol.c && " +
    "cc -O2 -o pocket-pointer pocket-pointer.c wlr-virtual-pointer-unstable-v1-protocol.c $(pkg-config --cflags --libs wayland-client) && cd ~";
  const install =
    `set -eu; mkdir -p ~/${REMOTE_DIR} ~/.config/systemd/user; ` +
    `tar -xf - -C ~/${REMOTE_DIR}; ` +
    `cp ~/${REMOTE_DIR}/host/${UNIT} ~/.config/systemd/user/${UNIT}; ` +
    `test -x ~/.local/share/mise/shims/node || { echo "node (mise) is missing on the host" >&2; exit 2; }; ` +
    `if command -v wayland-scanner >/dev/null && command -v cc >/dev/null; then ${buildPointer}; else echo "no wayland-scanner/cc: the trackpad's pointer helper was not built" >&2; fi; ` +
    `systemctl --user daemon-reload; systemctl --user enable ${UNIT} >/dev/null 2>&1 || true; systemctl --user reset-failed ${UNIT} >/dev/null 2>&1 || true; ` +
    `systemctl --user restart ${UNIT}; sleep 1; systemctl --user is-active ${UNIT}`;
  const result = Bun.spawnSync({ cmd: ["ssh", "-o", "BatchMode=yes", host, install], stdin: archive, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`deploy failed (${result.exitCode}):\n${result.stderr.toString().trim()}`);
  console.log(`deployed to ${host}:~/${REMOTE_DIR}; ${UNIT} ${result.stdout.toString().trim()}`);
  console.log(ssh(host, `journalctl --user -u ${UNIT} -n 5 --no-pager -o cat`));
}

function logs(host: string, lines: number): void {
  console.log(ssh(host, `journalctl --user -u ${UNIT} -n ${lines} --no-pager -o cat`));
}

function status(host: string): void {
  console.log(ssh(host, `systemctl --user status ${UNIT} --no-pager 2>&1 | head -12; ss -ltn | grep -E ':${WIRE_PORT} ' || echo 'no listener on ${WIRE_PORT}'`));
}

/** The relay's local port: 8622 is often taken on a developer Mac (the
 *  pocket-youtube companion holds it), and the beacon carries the port. */
const RELAY_PORT = 8623;

/** ssh -L tunnel to the daemon + a beacon from this Mac naming this Mac. */
async function relay(host: string, name: string, localPort: number): Promise<void> {
  const tunnel = Bun.spawn({
    cmd: ["ssh", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-N", "-L", `0.0.0.0:${localPort}:127.0.0.1:${WIRE_PORT}`, host],
    stdout: "inherit",
    stderr: "inherit",
  });
  const udp = createSocket("udp4");
  const payload = encodeBeacon(REMOTE_APP, name, localPort);
  udp.bind(() => {
    udp.setBroadcast(true);
    setInterval(() => udp.send(payload, WIRE_BEACON_PORT, "255.255.255.255", () => {}), 1000);
    console.log(`relay: tcp ${localPort} on this Mac -> ${host}:${WIRE_PORT} over ssh; beacon "${name}" on udp ${WIRE_BEACON_PORT}`);
  });
  const stop = () => {
    tunnel.kill();
    udp.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const code = await tunnel.exited;
  console.error(`relay: ssh tunnel exited (${code})`);
  udp.close();
  process.exit(code === 0 ? 0 : 1);
}

/**
 * A scripted device: connect, hello, print what the daemon mirrors, run the
 * lines given after `--` (JSON), then hang up. Verifies a daemon end to end
 * without an iPod in hand.
 */
async function client(target: string, lines: string[], seconds: number): Promise<void> {
  const [hostName, portText] = target.split(":");
  const port = Number(portText ?? WIRE_PORT);
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: hostName, port });
    const parser = new FrameParser();
    let acked = false;
    socket.on("connect", () => {
      const app = new TextEncoder().encode(REMOTE_APP);
      const hello = new Uint8Array(7 + app.length);
      new DataView(hello.buffer).setUint32(0, WIRE_MAGIC, true);
      hello[4] = WIRE_VERSION;
      hello[6] = app.length;
      hello.set(app, 7);
      socket.write(hello);
    });
    socket.on("data", (chunk: Buffer) => {
      let bytes = new Uint8Array(chunk);
      if (!acked) {
        if (bytes.length < 8) return;
        acked = true;
        bytes = bytes.slice(8);
        const helloLine: ClientLine = { t: "hello", proto: REMOTE_PROTO, device: `client on ${hostname()}` };
        socket.write(encodeCtrl(JSON.stringify(helloLine)));
        setTimeout(() => {
          for (const line of lines) socket.write(encodeCtrl(line));
        }, 400);
        setTimeout(() => {
          socket.end();
          resolve();
        }, seconds * 1000);
      }
      for (const frame of parser.push(bytes)) {
        if (frame.type === WIRE_MSG.ping) {
          socket.write(encodeFrame(WIRE_MSG.pong, frame.payload));
          continue;
        }
        if (frame.type !== WIRE_MSG.ctrl) continue;
        for (const line of parseLines<HostLine>(new TextDecoder().decode(frame.payload))) {
          const text = JSON.stringify(line);
          console.log(text.length > 400 ? `${text.slice(0, 400)}… (${text.length} bytes)` : text);
        }
      }
    });
    socket.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// menu: bake Omarchy's menu tree into the device
// ---------------------------------------------------------------------------

const MENU_DEFAULT_PATH = "/usr/share/omarchy/default/omarchy/omarchy-menu.jsonc";
const MENU_OUT = join(APP_DIR, "menu.ts");

/** Glyphs for rows whose icon lives in Omarchy's private logo font, which
 *  the remote cannot carry: AI agents get the robot, the updater the update
 *  arrows, anything else a dot. */
const ROBOT = "\u{F06A9}";
const UPDATE = "\u{F06B0}";
const DOT = "\u{F0765}";

function deviceIcon(entry: MenuEntry): string {
  if (entry.iconFont === "omarchy") {
    if (entry.id === "update.omarchy") return UPDATE;
    if (entry.id.startsWith("setup.default.agent.") || entry.id.startsWith("install.ai.")) return ROBOT;
    return DOT;
  }
  return entry.icon;
}

/**
 * Read omarchy-menu.jsonc from an Omarchy machine (or a local copy) and write
 * apps/pocket-remote/menu.ts: every row's id, parent, kind, icon, label and
 * title in the shell's own order, plus whether it carries a `when` or a
 * `checked` condition (the daemon evaluates those live). The device shows
 * this table; the daemon runs actions from its own live parse by id, so a row
 * the device names has to exist on the machine as well.
 */
function bakeMenu(source: string, omarchyVersion: string | undefined): void {
  let text: string;
  let version = omarchyVersion ?? "";
  if (existsSync(source)) {
    text = readFileSync(source, "utf8");
  } else {
    text = ssh(source, `cat ${MENU_DEFAULT_PATH}`);
    if (!version) version = ssh(source, "omarchy-version").trim();
  }
  const entries = normalizeMenu([parseMenuJsonc(text)]);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  const digest = hasher.digest("hex").slice(0, 12);
  const rows = entries.map((entry) => {
    const fields = [
      `id: ${JSON.stringify(entry.id)}`,
      `parent: ${JSON.stringify(entry.parent)}`,
      `kind: ${JSON.stringify(entry.kind)}`,
      `icon: ${JSON.stringify(deviceIcon(entry))}`,
      `label: ${JSON.stringify(entry.label)}`,
    ];
    if (entry.title) fields.push(`title: ${JSON.stringify(entry.title)}`);
    if (entry.when) fields.push("when: true");
    if (entry.checked) fields.push("checked: true");
    return `  { ${fields.join(", ")} },`;
  });
  const out = `// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/menu.ts — GENERATED by \`bun tools/pocket-remote.ts menu\`
// from Omarchy ${version || "?"}'s omarchy-menu.jsonc (sha256 ${digest}). Do not edit;
// regenerate against the machine after an Omarchy update.
//
// The device's copy of Omarchy's menu tree: every row's id, parent, kind,
// icon, label and title, in the shell's own order. Icons are the Nerd Font
// glyphs the file spells (written literally so the build's codepoint scan
// bakes them); rows whose icon lives in Omarchy's private logo font carry a
// Material stand-in. \`when\` and \`checked\` mark rows the daemon evaluates
// live — it sends the hidden and the checked ids, the table stays static.

export type MenuKind = "action" | "menu" | "link" | "provider";

export interface MenuItem {
  id: string;
  /** "root" for a top-level row. */
  parent: string;
  kind: MenuKind;
  icon: string;
  label: string;
  /** Header when the submenu is open; defaults to label. */
  title?: string;
  /** Visibility depends on a condition the daemon reports. */
  when?: true;
  /** A tick depends on a condition the daemon reports. */
  checked?: true;
}

export const MENU_OMARCHY_VERSION = ${JSON.stringify(version)};
export const MENU_SOURCE_DIGEST = ${JSON.stringify(digest)};

export const MENU: readonly MenuItem[] = [
${rows.join("\n")}
];
`;
  writeFileSync(MENU_OUT, out);
  const kinds = new Map<string, number>();
  for (const entry of entries) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
  console.log(
    `wrote ${MENU_OUT}: ${entries.length} rows from Omarchy ${version || "?"} (${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")})`,
  );
}

// ---------------------------------------------------------------------------
// shots: the screens, rendered in the headless sim
// ---------------------------------------------------------------------------

/**
 * Boot the built bundle in the sim, feed it a desktop the way the daemon
 * would, walk it through its states and write each as a PNG. What the README
 * shows, and what a change is checked against by eye before it is flashed.
 */
async function shots(outDir: string): Promise<void> {
  const { bootWorld } = await import("../hosts/sim/sim.ts");
  const { encodePNG } = await import("../tests/png.ts");
  const { STAGE, TAB_W, CC_BUTTON, MODE, MODE_HALF_W, SHEET_LIST, sheetRowRect, BALL_HOME } = await import("../apps/pocket-remote/layout.ts");
  const APPS = [
    "Chromium", "Files", "Foot", "GIMP", "Ghostty", "Localsend", "Neovim", "Nautilus",
    "Signal", "Spotify", "Steam", "Text Editor", "Thunderbird", "Zed",
  ].map((name) => ({ i: name.toLowerCase().replace(/ /g, "-"), n: name }));
  const { keyboardKeys } = await import("../apps/pocket-remote/keyboard-layout.ts");
  type Store = import("../apps/pocket-remote/store.ts").RemoteStore;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(outDir, { recursive: true });

  const world = await bootWorld("pocket-remote-main", 60, undefined, undefined, { width: 480, height: 320 });
  const store = (globalThis as { __pocketRemote?: Store }).__pocketRemote;
  if (!store) throw new Error("the bundle did not publish its store");
  const pack = (x: number, y: number, id = 0): number => (id << 18) | (y << 9) | x;
  const frames = (n: number, touches: number[] = []) => {
    for (let i = 0; i < n; i += 1) world.frame(0, undefined, touches);
  };
  const tap = (x: number, y: number) => {
    frames(2, [pack(x, y)]);
    frames(1);
  };
  const hold = (x: number, y: number, n = 30) => {
    frames(n, [pack(x, y)]);
  };
  const shot = (name: string) => {
    const pixels = world.render();
    writeFileSync(join(outDir, `${name}.png`), encodePNG(Buffer.from(pixels), 480, 320));
    console.log(`  ${name}.png`);
  };

  frames(1);
  shot("connect");
  store.applyLine({ t: "hello", proto: REMOTE_PROTO, name: "x1nano-omarchy", omarchy: "4.0.1-1", auth: "ok" });
  store.applyLine({ t: "levels", vol: 0.55, bri: 0.7 });
  store.applyLine({
    t: "cc",
    wifi: { on: 1, ssid: "Petite Auberge", sig: 54 },
    media: { st: "playing", title: "Blue in Green", artist: "Miles Davis" },
  });
  store.applyLine({ t: "menu", hide: ["system.hibernate", "trigger.capture.screenrecord.stop"], check: ["setup.default.terminal.foot", "update.channel.stable"] });
  store.applyLine({ t: "apps", seq: 0, a: APPS });
  store.applyLine({
    t: "state",
    mon: { w: 1440, h: 900 },
    ws: [{ id: 1, n: 3 }, { id: 2, n: 1 }, { id: 3, n: 0 }],
    active: 1,
    focus: "0x1",
    layout: "dwindle",
    win: [
      { a: "0x1", c: "foot", ti: "evan@x1nano-omarchy:~", ws: 1, x: 12, y: 38, w: 701, h: 850 },
      { a: "0x2", c: "chromium", ti: "Omarchy Manual", ws: 1, x: 725, y: 38, w: 703, h: 420 },
      { a: "0x3", c: "nautilus", ti: "Downloads", ws: 1, x: 725, y: 470, w: 703, h: 418 },
      { a: "0x4", c: "mpv", ti: "Blue in Green", ws: 1, x: 900, y: 500, w: 420, h: 260, f: 1 },
      { a: "0x5", c: "nvim", ti: "layout.ts", ws: 2, x: 12, y: 38, w: 1416, h: 850 },
    ],
  });
  frames(40);
  shot("stage");

  // hold the floating tile: the popup
  const fit = store.fit()!;
  const px = Math.round(fit.ox + (900 + 210) * fit.s);
  const py = Math.round(fit.oy + (500 + 130) * fit.s);
  hold(px, py, 30);
  frames(12, [pack(px, py)]);
  shot("popup");
  frames(1);
  tap(px, STAGE.y + 8);
  frames(10);

  // the control centre, sticky
  tap(CC_BUTTON.x + CC_BUTTON.w / 2, CC_BUTTON.y + CC_BUTTON.h / 2);
  frames(20);
  shot("control-centre");
  tap(40, 300);
  frames(10);

  // the menu sheet: root, a submenu, the applications list
  const tapRow = (id: string) => {
    const at = store.sheetRows().findIndex((row) => row.id === id);
    if (at < 0) throw new Error(`no sheet row ${id} (have ${store.sheetRows().map((r) => r.id).join(", ")})`);
    const r = sheetRowRect(at);
    tap(SHEET_LIST.x + r.x + 60, SHEET_LIST.y + r.y + 20 - store.sheetScroller.offset());
  };
  tap(BALL_HOME.x + 22, BALL_HOME.y + 22);
  frames(20);
  shot("menu-root");
  tapRow("trigger");
  frames(20);
  shot("menu-trigger");
  tapRow("trigger.toggle");
  frames(20);
  shot("menu-toggle");
  store.sheetBack();
  store.sheetBack();
  frames(20);
  tapRow("apps");
  frames(20);
  shot("menu-apps");
  tap(10, 300);
  frames(10);

  // the deck, with a key held
  tap(MODE.x + MODE_HALF_W + 17, MODE.y + 11);
  frames(15);
  shot("deck");
  const f = keyboardKeys("lower").find((k) => k.def.label === "f")!;
  frames(4, [pack(f.x + f.w / 2, f.y + f.h / 2)]);
  shot("deck-key");
  frames(1);
  frames(10);
  hold(f.x + f.w / 2, f.y + f.h / 2, 30);
  frames(12, [pack(f.x + f.w / 2, f.y + f.h / 2)]);
  shot("deck-variants");
  frames(1);

  // back to the stage, then an empty workspace: the launch bar is fixed, so
  // there is nothing on the stage but the hint.
  tap(MODE.x + 17, MODE.y + 11);
  frames(10);
  tap(6 + TAB_W * 4 + TAB_W / 2, 14);
  frames(30);
  shot("empty");
  console.log(`wrote ${outDir}`);
}

function usage(): void {
  console.log(`Pocket Remote host tool

  bun tools/pocket-remote.ts deploy-host <ssh host>
  bun tools/pocket-remote.ts logs <ssh host> [-n N]
  bun tools/pocket-remote.ts status <ssh host>
  bun tools/pocket-remote.ts relay <ssh host> [--name <beacon name>] [--local-port 8623]
  bun tools/pocket-remote.ts client <host[:port]> [--for seconds] [-- <json line>...]
  bun tools/pocket-remote.ts menu <ssh host | omarchy-menu.jsonc> [--omarchy <version>]
  bun tools/pocket-remote.ts shots <out dir>                     render the screens in the headless sim`);
}

async function main(args: string[]): Promise<void> {
  const [command, target] = args;
  switch (command) {
    case "deploy-host":
      if (!target) throw new Error("deploy-host needs an ssh host");
      await deployHost(target);
      break;
    case "logs": {
      if (!target) throw new Error("logs needs an ssh host");
      const at = args.indexOf("-n");
      logs(target, at >= 0 ? Number(args[at + 1]) : 40);
      break;
    }
    case "status":
      if (!target) throw new Error("status needs an ssh host");
      status(target);
      break;
    case "relay": {
      if (!target) throw new Error("relay needs an ssh host");
      const at = args.indexOf("--name");
      const portAt = args.indexOf("--local-port");
      await relay(
        target,
        at >= 0 ? (args[at + 1] ?? hostname()) : `${target} via ${hostname().replace(/\.local$/, "")}`,
        portAt >= 0 ? Number(args[portAt + 1]) : RELAY_PORT,
      );
      break;
    }
    case "shots":
      if (!target) throw new Error("shots needs an output directory");
      await shots(target);
      break;
    case "menu": {
      if (!target) throw new Error("menu needs an ssh host or a path to omarchy-menu.jsonc");
      const at = args.indexOf("--omarchy");
      bakeMenu(target, at >= 0 ? args[at + 1] : undefined);
      break;
    }
    case "client": {
      if (!target) throw new Error("client needs host[:port]");
      const dash = args.indexOf("--");
      const forAt = args.indexOf("--for");
      const seconds = forAt >= 0 ? Number(args[forAt + 1]) : 3;
      await client(target, dash >= 0 ? args.slice(dash + 1) : [], seconds);
      break;
    }
    default:
      usage();
      if (command && command !== "help" && command !== "--help") throw new Error(`unknown command ${command}`);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
