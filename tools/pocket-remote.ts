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
const HOST_FILES = ["protocol.ts", "actions.ts", "host/wire.ts", "host/hypr.ts", "host/omarchy.ts", "host/serve.ts"];
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
  const install =
    `set -eu; mkdir -p ~/${REMOTE_DIR} ~/.config/systemd/user; ` +
    `tar -xf - -C ~/${REMOTE_DIR}; ` +
    `cp ~/${REMOTE_DIR}/host/${UNIT} ~/.config/systemd/user/${UNIT}; ` +
    `test -x ~/.local/share/mise/shims/node || { echo "node (mise) is missing on the host" >&2; exit 2; }; ` +
    `systemctl --user daemon-reload; systemctl --user enable ${UNIT} >/dev/null 2>&1 || true; ` +
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

function usage(): void {
  console.log(`Pocket Remote host tool

  bun tools/pocket-remote.ts deploy-host <ssh host>
  bun tools/pocket-remote.ts logs <ssh host> [-n N]
  bun tools/pocket-remote.ts status <ssh host>
  bun tools/pocket-remote.ts relay <ssh host> [--name <beacon name>] [--local-port 8623]
  bun tools/pocket-remote.ts client <host[:port]> [--for seconds] [-- <json line>...]`);
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
