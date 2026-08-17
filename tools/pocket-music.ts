// Pocket Music: build/run the PocketJS app and its macOS click-wheel daemon.

import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = join(REPOSITORY, "hosts/ipodnano/PocketMusicDaemon.m");
const BUILD_DIRECTORY = join(REPOSITORY, ".pocket/pocket-music/bin");
const BUILD_BINARY = join(BUILD_DIRECTORY, "pocket-music-daemon");
const INSTALL_DIRECTORY = join(homedir(), "Library/Application Support/Pocket Music");
const INSTALL_BINARY = join(INSTALL_DIRECTORY, "pocket-music-daemon");
const SOCKET = join(INSTALL_DIRECTORY, "pocket-music.sock");
const LAUNCH_AGENT = join(
  homedir(),
  "Library/LaunchAgents/dev.pocket-stack.pocket-music.daemon.plist",
);

export interface IPodNanoFacts {
  readonly connected: boolean;
  readonly vendorId?: number;
  readonly productId?: number;
  readonly serial?: string;
  readonly model?: "ipod-nano-2g";
}

export function parseIPodNanoUSB(ioreg: string): IPodNanoFacts {
  const block =
    ioreg.match(/\+-o (?:iPod|Rockbox media player)@[^\n]*[\s\S]*?(?=\n\s*[+|]?-o |$)/)?.[0] ??
    "";
  const vendorId = Number(block.match(/"idVendor"\s*=\s*(\d+)/)?.[1]);
  const productId = Number(block.match(/"idProduct"\s*=\s*(\d+)/)?.[1]);
  const serial = block.match(/"USB Serial Number"\s*=\s*"([^"]+)"/)?.[1];
  if (!block || !Number.isInteger(vendorId) || !Number.isInteger(productId)) {
    return { connected: false };
  }
  return {
    connected: true,
    vendorId,
    productId,
    ...(serial ? { serial } : {}),
    ...(vendorId === 0x05ac && productId === 0x1260 ? { model: "ipod-nano-2g" as const } : {}),
  };
}

export function parseIPodFilesystem(diskutil: string): "hfs" | "fat32" | "unknown" {
  if (/Apple_HFS\s+iPod\s/i.test(diskutil)) return "hfs";
  if (/(Microsoft Basic Data|DOS_FAT_32|Windows_FAT_32)\s+iPod\s/i.test(diskutil)) {
    return "fat32";
  }
  return "unknown";
}

async function run(command: string[], label: string, env = process.env): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: REPOSITORY,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exit = await process.exited;
  if (exit !== 0) throw new Error(`${label} failed with exit code ${exit}`);
}

async function buildAppProof(): Promise<void> {
  const proofDirectory = mkdtempSync(join(tmpdir(), "pocket-music-proof-"));
  const socket = join(proofDirectory, "daemon.sock");
  const env = { ...process.env, POCKET_MUSIC_SOCKET: socket };
  const fixture = Bun.spawn([BUILD_BINARY, "--fixture"], {
    cwd: REPOSITORY,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt += 1) {
      if (fixture.exitCode !== null) {
        throw new Error(`Pocket Music fixture exited with code ${fixture.exitCode}`);
      }
      await Bun.sleep(20);
    }
    if (!existsSync(socket)) throw new Error("Pocket Music fixture did not create its socket");
    await run(
      [
        "bun",
        "tools/widget.ts",
        "--stage",
        "pocket-music",
        "--screenshot",
        "dist/pocket-music-proof.png",
        "--frames",
        "120",
        "--expect-ui-hash",
        "0xba84c1ade3dbcc3f",
        "--focus",
      ],
      "Pocket Music app build",
      env,
    );
  } finally {
    if (fixture.exitCode === null) fixture.kill("SIGTERM");
    await fixture.exited;
    rmSync(proofDirectory, { recursive: true, force: true });
  }
}

export async function buildDaemon(output = BUILD_BINARY): Promise<void> {
  mkdirSync(dirname(output), { recursive: true });
  await run(
    [
      "xcrun",
      "clang",
      "-fobjc-arc",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-framework",
      "Foundation",
      "-framework",
      "AppKit",
      "-framework",
      "IOKit",
      SOURCE,
      "-o",
      output,
    ],
    "Pocket Music daemon build",
  );
  await run(["codesign", "--force", "--sign", "-", output], "Pocket Music daemon signing");
  await run([output, "--self-test"], "Pocket Music daemon self-test");
}

function launchAgentPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.pocket-stack.pocket-music.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_BINARY}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>POCKET_MUSIC_SOCKET</key>
    <string>${SOCKET}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${join(INSTALL_DIRECTORY, "daemon.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(INSTALL_DIRECTORY, "daemon.log")}</string>
</dict>
</plist>
`;
}

async function installDaemon(): Promise<void> {
  await buildDaemon(INSTALL_BINARY);
  mkdirSync(dirname(LAUNCH_AGENT), { recursive: true });
  writeFileSync(LAUNCH_AGENT, launchAgentPlist(), { mode: 0o600 });
  await run(["plutil", "-lint", LAUNCH_AGENT], "LaunchAgent validation");
  const domain = `gui/${process.getuid?.() ?? 0}`;
  Bun.spawnSync(["launchctl", "bootout", domain, LAUNCH_AGENT], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await run(["launchctl", "bootstrap", domain, LAUNCH_AGENT], "LaunchAgent install");
  await run(
    ["launchctl", "kickstart", "-k", `${domain}/dev.pocket-stack.pocket-music.daemon`],
    "Pocket Music daemon start",
  );
  console.log(`Pocket Music daemon installed: ${INSTALL_BINARY}`);
}

async function doctor(): Promise<void> {
  const [ioreg, disks, hid] = await Promise.all([
    $`ioreg -p IOUSB -l -w 0`.text(),
    $`diskutil list`.text(),
    $`ioreg -r -c IOHIDDevice -l -w 0`.text(),
  ]);
  const device = parseIPodNanoUSB(ioreg);
  const filesystem = parseIPodFilesystem(disks);
  console.log(`device: ${device.model === "ipod-nano-2g" ? "iPod nano 2G (05ac:1260)" : "not verified"}`);
  console.log(`serial: ${device.serial ?? "unavailable"}`);
  console.log(`filesystem: ${filesystem}`);
  const rockboxInstalled = ["/Volumes/iPod", "/Volumes/IPOD"].some((mount) =>
    existsSync(join(mount, ".rockbox/rockbox-info.txt")),
  );
  console.log(`rockbox: ${rockboxInstalled ? "installed" : "not installed"}`);
  console.log(`hid: ${/"VendorID"\s*=\s*1452[\s\S]*"ProductID"\s*=\s*4704/.test(hid) ? "available" : "not enumerated"}`);
  console.log(`daemon: ${existsSync(INSTALL_BINARY) ? "installed" : "not installed"}`);
  if (device.model !== "ipod-nano-2g") throw new Error("the attached device is not iPod nano 2G");
  if (filesystem === "hfs") {
    console.log("gate: Rockbox requires FAT32; back up and restore/format the iPod before installation");
  }
}

function usage(message?: string): never {
  if (message) console.error(`pocket-music: ${message}\n`);
  console.error(
    "usage: bun pocket-music doctor\n" +
      "       bun pocket-music build\n" +
      "       bun pocket-music daemon [--fixture] [--no-seize]\n" +
      "       bun pocket-music run [pocket-stage flags]\n" +
      "       bun pocket-music install-daemon",
  );
  process.exit(message ? 2 : 0);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage();
  switch (command) {
    case "doctor":
      if (args.length) usage("doctor takes no arguments");
      await doctor();
      break;
    case "build":
      if (args.length) usage("build takes no arguments");
      await buildDaemon();
      await buildAppProof();
      break;
    case "daemon":
      if (args.some((arg) => arg !== "--fixture" && arg !== "--no-seize")) {
        usage("daemon accepts only --fixture and --no-seize");
      }
      await buildDaemon();
      await run([BUILD_BINARY, ...args], "Pocket Music daemon");
      break;
    case "run":
      await run(["bun", "tools/widget.ts", "--stage", "pocket-music", ...args], "Pocket Music");
      break;
    case "install-daemon":
      if (args.length) usage("install-daemon takes no arguments");
      await installDaemon();
      break;
    default:
      usage(`unknown command ${command}`);
  }
}

if (import.meta.main) await main();
