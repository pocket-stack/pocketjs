// Apply PocketJS USB branding to a Rockbox source tree and build the nano 2G core.

import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const POCKETJS_USB_LOGO = join(
  REPOSITORY,
  "hosts/ipodnano/rockbox/usblogo.128x37x16.bmp",
);
const ROCKBOX_USB_LOGO = "apps/bitmaps/native/usblogo.128x37x16.bmp";

export interface BmpFacts {
  readonly width: number;
  readonly height: number;
  readonly bitsPerPixel: number;
}

export function parseBmpFacts(bytes: Uint8Array): BmpFacts {
  if (bytes.byteLength < 30 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error("USB logo is not a Windows BMP");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getInt32(18, true),
    height: Math.abs(view.getInt32(22, true)),
    bitsPerPixel: view.getUint16(28, true),
  };
}

export function applyPocketJSUsbLogo(rockboxSource: string): string {
  const configure = join(rockboxSource, "tools/configure");
  const destination = join(rockboxSource, ROCKBOX_USB_LOGO);
  if (!existsSync(configure) || !existsSync(destination)) {
    throw new Error(`${rockboxSource} is not a Rockbox source tree with the nano USB logo`);
  }
  const facts = parseBmpFacts(readFileSync(POCKETJS_USB_LOGO));
  if (facts.width !== 128 || facts.height !== 37 || facts.bitsPerPixel !== 24) {
    throw new Error(`unexpected PocketJS USB logo format: ${JSON.stringify(facts)}`);
  }
  copyFileSync(POCKETJS_USB_LOGO, destination);
  return destination;
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exit = await child.exited;
  if (exit !== 0) throw new Error(`${command[0]} exited with code ${exit}`);
}

async function build(
  rockboxSource: string,
  buildDirectory: string,
  compilerPrefix?: string,
): Promise<void> {
  const logo = applyPocketJSUsbLogo(rockboxSource);
  mkdirSync(buildDirectory, { recursive: true });
  const configure = [
    join(rockboxSource, "tools/configure"),
    "--target=ipodnano2g",
    "--type=N",
    ...(compilerPrefix ? [`--compiler-prefix=${compilerPrefix}`] : []),
  ];
  await run(configure, buildDirectory);
  await run(
    ["make", `-j${Math.max(1, availableParallelism())}`, "bin"],
    buildDirectory,
  );
  const output = join(buildDirectory, "rockbox.ipod");
  if (!existsSync(output)) throw new Error("Rockbox build did not produce rockbox.ipod");
  const hash = new Bun.CryptoHasher("sha256").update(readFileSync(output)).digest("hex");
  console.log(`PocketJS USB logo: ${logo}`);
  console.log(`Rockbox firmware: ${output}`);
  console.log(`SHA-256: ${hash}`);
}

function usage(message?: string): never {
  if (message) console.error(`ipodnano-rockbox: ${message}\n`);
  console.error(
    "usage: bun ipodnano:rockbox apply <rockbox-source>\n" +
      "       bun ipodnano:rockbox build <rockbox-source> <build-directory> " +
      "[--compiler-prefix=<prefix>]",
  );
  process.exit(message ? 2 : 0);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage();
  if (command === "apply") {
    if (args.length !== 1) usage("apply requires one Rockbox source directory");
    console.log(`PocketJS USB logo: ${applyPocketJSUsbLogo(args[0]!)}`);
    return;
  }
  if (command === "build") {
    const compilerArg = args.find((arg) => arg.startsWith("--compiler-prefix="));
    const positional = args.filter((arg) => !arg.startsWith("--compiler-prefix="));
    if (positional.length !== 2 || args.some((arg) => arg.startsWith("--") && arg !== compilerArg)) {
      usage("build requires source and build directories");
    }
    await build(
      positional[0]!,
      positional[1]!,
      compilerArg?.slice("--compiler-prefix=".length),
    );
    return;
  }
  usage(`unknown command ${command}`);
}

if (import.meta.main) await main();
