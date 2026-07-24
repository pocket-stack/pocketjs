import { createHash } from "node:crypto";
import {
  createReadStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  deploySis,
  isExpectedMtpDevice,
  sanitizeDeviceOutput,
  type CommandResult,
  type CommandRunner,
} from "./symbian-device.ts";
import { setupSymbianToolchain } from "./symbian-bootstrap.ts";
import { resolveSymbianE7BuildPlan } from "./symbian-profile.ts";
import {
  SYMBIAN_DOWNLOADS,
  SYMBIAN_RUNTIME_DOWNLOADS,
  SYMBIAN_TOOLCHAIN,
  symbianDockerDoctorArguments,
  symbianDockerRunArguments,
  symbianDownloadPath,
  symbianDownloadsRoot,
  symbianImplementationDigest,
} from "./symbian-toolchain.ts";
import { pocketStackCacheRoot, withArtifactLock } from "./psp-toolchain.ts";

const root = new URL("..", import.meta.url).pathname;

async function spawn(
  command: string,
  args: readonly string[],
  options: {
    timeoutMs?: number;
    inherit?: boolean;
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<CommandResult> {
  const process = Bun.spawn({
    cmd: [command, ...args],
    cwd: options.cwd,
    env: options.env,
    stdout: options.inherit ? "inherit" : "pipe",
    stderr: options.inherit ? "inherit" : "pipe",
  });
  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        process.kill();
      }, options.timeoutMs)
    : undefined;
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    options.inherit ? Promise.resolve("") : new Response(process.stdout).text(),
    options.inherit ? Promise.resolve("") : new Response(process.stderr).text(),
  ]);
  if (timer) clearTimeout(timer);
  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout,
    stderr: timedOut ? `${stderr}\ncommand timed out` : stderr,
  };
}

const mtpRunner: CommandRunner = (command, args, timeoutMs) =>
  spawn(command, args, { timeoutMs });

function icon(ok: boolean): string {
  return ok ? "✓" : "✗";
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function dockerImageReady(): Promise<boolean> {
  const implementation = symbianImplementationDigest(root);
  const result = await spawn("docker", [
    "image",
    "inspect",
    "--format",
    '{{index .Config.Labels "org.pocketjs.symbian.toolchain"}} {{index .Config.Labels "org.pocketjs.symbian.implementation"}}',
    SYMBIAN_TOOLCHAIN.container.image,
  ], { timeoutMs: 10_000 });
  return result.exitCode === 0 &&
    result.stdout.trim() ===
      `${SYMBIAN_TOOLCHAIN.toolchainVersion} ${implementation}`;
}

async function runCodaUsbProbe(): Promise<CommandResult> {
  const compiler = Bun.which("cc");
  const pkgConfig = Bun.which("pkg-config");
  if (!compiler || !pkgConfig) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "cc and pkg-config are required for the CODA USB probe",
    };
  }

  const [includeDirectory, libraryDirectory] = await Promise.all([
    spawn(pkgConfig, ["--variable=includedir", "libusb-1.0"], {
      timeoutMs: 10_000,
    }),
    spawn(pkgConfig, ["--variable=libdir", "libusb-1.0"], {
      timeoutMs: 10_000,
    }),
  ]);
  if (includeDirectory.exitCode !== 0 || libraryDirectory.exitCode !== 0) {
    return {
      exitCode: includeDirectory.exitCode || libraryDirectory.exitCode,
      stdout: `${includeDirectory.stdout}${libraryDirectory.stdout}`,
      stderr: includeDirectory.stderr || libraryDirectory.stderr ||
        "libusb-1.0 development files are unavailable",
    };
  }
  const include = includeDirectory.stdout.trim();
  const library = libraryDirectory.stdout.trim();
  if (!include || !library) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "libusb-1.0 pkg-config paths are empty",
    };
  }

  const build = mkdtempSync(join(tmpdir(), "pocketjs-coda-usb-"));
  const binary = join(build, "coda-usb-probe");
  try {
    const compiled = await spawn(compiler, [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      join(include, "libusb-1.0"),
      join(root, "tools/symbian/coda-usb-probe.c"),
      "-L",
      library,
      "-lusb-1.0",
      "-o",
      binary,
    ], { timeoutMs: 30_000 });
    if (compiled.exitCode !== 0) return compiled;
    return await spawn(binary, [], { timeoutMs: 30_000 });
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}

async function doctor(
  deviceRequired: boolean,
  codaUsbRequired: boolean,
): Promise<boolean> {
  console.log(`PocketJS Symbian doctor (${SYMBIAN_TOOLCHAIN.toolchainVersion})\n`);
  let ok = true;
  const docker = !!Bun.which("docker");
  console.log(`  ${icon(docker)} Docker`);
  ok &&= docker;

  for (const artifact of [...SYMBIAN_DOWNLOADS, ...SYMBIAN_RUNTIME_DOWNLOADS]) {
    const path = symbianDownloadPath(artifact);
    const verified = existsSync(path) && await sha256File(path) === artifact.sha256;
    console.log(
      `  ${icon(verified)} ${artifact.asset}${verified ? "" : " — run setup --yes"}`,
    );
    ok &&= verified;
  }

  const image = docker && await dockerImageReady();
  console.log(`  ${icon(image)} ${SYMBIAN_TOOLCHAIN.container.image}`);
  ok &&= image;
  if (image) {
    const toolchain = await spawn("docker", symbianDockerDoctorArguments(root), {
      timeoutMs: 120_000,
    });
    const ready = toolchain.exitCode === 0;
    console.log(`  ${icon(ready)} native qmake + GCCE + EKA2 package tools`);
    if (!ready) {
      const detail = sanitizeDeviceOutput(toolchain.stderr || toolchain.stdout).trim();
      if (detail) console.log(`      ${detail.split(/\r?\n/)[0]}`);
    }
    ok &&= ready;
  }

  const mtpTools = ["mtp-folders", "mtp-sendfile", "mtp-getfile"]
    .every((tool) => !!Bun.which(tool));
  console.log(
    `  ${icon(mtpTools)} libmtp host tools${mtpTools ? "" : " — brew install libmtp"}`,
  );
  if (deviceRequired) ok &&= mtpTools;

  if (deviceRequired && mtpTools) {
    const folders = await spawn("mtp-folders", [], { timeoutMs: 20_000 });
    const connected = folders.exitCode === 0 && isExpectedMtpDevice(
      `${folders.stdout}\n${folders.stderr}`,
      {
        vendorId: SYMBIAN_TOOLCHAIN.device.usbVendorId,
        productId: SYMBIAN_TOOLCHAIN.device.usbProductId,
        name: SYMBIAN_TOOLCHAIN.device.mtpName,
      },
    );
    console.log(`  ${icon(connected)} Nokia E7 in Nokia Suite / Ovi MTP mode`);
    ok &&= connected;
  }

  if (codaUsbRequired) {
    const coda = await runCodaUsbProbe();
    const output = sanitizeDeviceOutput(coda.stdout);
    const connected = coda.exitCode === 0 &&
      output.includes("CODA USB: ready") &&
      output.includes("CODA Locator: ready");
    console.log(`  ${icon(connected)} CODA USB ping + Locator handshake`);
    const version = output.match(/^CODA version:\s*(.+)$/m)?.[1];
    if (connected && version) console.log(`      ${version}`);
    if (!connected) {
      const detail = sanitizeDeviceOutput(coda.stderr || coda.stdout).trim();
      if (detail) console.log(`      ${detail.split(/\r?\n/)[0]}`);
    }
    ok &&= connected;
  }
  return ok;
}

async function buildProbe(): Promise<string> {
  if (!await dockerImageReady()) {
    throw new Error("Symbian container is not ready; run `pocket symbian setup --yes`");
  }
  const output = resolve(root, "dist/symbian");
  mkdirSync(output, { recursive: true });
  const outputLockId = createHash("sha256").update(output).digest("hex");
  const outputLock = join(
    pocketStackCacheRoot(),
    `symbian/.locks/probe-output-${outputLockId}.lock`,
  );
  await withArtifactLock(outputLock, async () => {
    const built = await spawn("docker", symbianDockerRunArguments(
      "/usr/local/bin/pocketjs-symbian-build-probe",
      [],
      { repository: root, output },
    ), { inherit: true, cwd: root });
    if (built.exitCode !== 0) throw new Error("Symbian probe build failed");
  }, { timeoutMs: 10 * 60_000, staleMs: 30 * 60_000 });
  const sis = resolve(root, SYMBIAN_TOOLCHAIN.probe.output);
  if (!existsSync(sis)) throw new Error(`probe build did not produce ${sis}`);
  return sis;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function buildApp(
  manifestPath: string,
  sisVersion: string,
): Promise<string> {
  const version = sisVersion.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)$/);
  if (!version || version.slice(1).some((part) => Number(part) > 32767)) {
    throw new Error(
      "SIS version must be three decimal components from 0 through 32767",
    );
  }
  if (!await dockerImageReady()) {
    throw new Error("Symbian container is not ready; run `pocket symbian setup --yes`");
  }
  for (const artifact of SYMBIAN_RUNTIME_DOWNLOADS) {
    const path = symbianDownloadPath(artifact);
    if (!existsSync(path) || await sha256File(path) !== artifact.sha256) {
      throw new Error(
        `missing pinned ${artifact.asset}; run \`pocket symbian setup --yes\``,
      );
    }
  }

  const absoluteManifest = resolve(manifestPath);
  const manifest = JSON.parse(readFileSync(absoluteManifest, "utf8")) as unknown;
  const plan = resolveSymbianE7BuildPlan(manifest);
  if (!/^[A-Za-z0-9._-]+$/.test(plan.app.output)) {
    throw new Error(`unsafe Symbian app output name ${JSON.stringify(plan.app.output)}`);
  }

  const outputRoot = resolve(root, "dist/symbian");
  const payload = resolve(outputRoot, "build", plan.app.output);
  const rustTarget = resolve(outputRoot, ".cargo-symbian");
  mkdirSync(payload, { recursive: true });
  await Bun.write(resolve(payload, "plan.json"), JSON.stringify(plan, null, 2) + "\n");

  const appBuild = await spawn("bun", [
    "tools/build.ts",
    `--plan=${resolve(payload, "plan.json")}`,
    `--project-root=${root}`,
    `--outdir=${payload}`,
  ], { inherit: true, cwd: root });
  if (appBuild.exitCode !== 0) throw new Error("PocketJS Symbian guest build failed");
  copyFileSync(resolve(payload, `${plan.app.output}.js`), resolve(payload, "app.js"));
  copyFileSync(resolve(payload, `${plan.app.output}.pak`), resolve(payload, "app.pak"));

  const coreDirectory = resolve(root, "engine/symbian");
  const rustBuild = await spawn("cargo", [
    "build",
    "--release",
    "--locked",
    "--target",
    "targets/armv6-symbian-eabi.json",
    "-Z",
    "json-target-spec",
    "-Z",
    "build-std=core,alloc,compiler_builtins",
    "-Z",
    "build-std-features=compiler-builtins-mem",
  ], {
    inherit: true,
    cwd: coreDirectory,
    env: { ...process.env, CARGO_TARGET_DIR: rustTarget },
  });
  if (rustBuild.exitCode !== 0) throw new Error("PocketJS Symbian Rust core build failed");
  copyFileSync(
    resolve(
      rustTarget,
      "armv6-symbian-eabi/release/libpocketjs_symbian_core.a",
    ),
    resolve(payload, "libpocketjs_symbian_core.a"),
  );

  mkdirSync(outputRoot, { recursive: true });
  const outputLockId = createHash("sha256").update(outputRoot).digest("hex");
  const outputLock = join(
    pocketStackCacheRoot(),
    `symbian/.locks/runtime-output-${outputLockId}.lock`,
  );
  await withArtifactLock(outputLock, async () => {
    const built = await spawn("docker", symbianDockerRunArguments(
      "/usr/local/bin/pocketjs-symbian-build-app",
      [plan.app.output, sisVersion],
      {
        repository: root,
        output: outputRoot,
        downloads: symbianDownloadsRoot(),
      },
    ), { inherit: true, cwd: root });
    if (built.exitCode !== 0) throw new Error("Symbian PocketJS runtime build failed");
  }, { timeoutMs: 20 * 60_000, staleMs: 60 * 60_000 });

  const sis = resolve(root, SYMBIAN_TOOLCHAIN.runtime.output);
  if (!existsSync(sis)) throw new Error(`runtime build did not produce ${sis}`);
  return sis;
}

async function deploy(path: string): Promise<void> {
  const sis = resolve(path);
  const missing = ["mtp-folders", "mtp-sendfile", "mtp-getfile"]
    .filter((tool) => !Bun.which(tool));
  if (missing.length > 0) {
    throw new Error(`missing ${missing.join(", ")}; install with \`brew install libmtp\``);
  }
  const lock = join(pocketStackCacheRoot(), "symbian/.locks/mtp-device.lock");
  const result = await withArtifactLock(lock, () => deploySis(sis, mtpRunner, {
    storage: SYMBIAN_TOOLCHAIN.device.deployStorage,
    folder: SYMBIAN_TOOLCHAIN.device.deployFolder,
    vendorId: SYMBIAN_TOOLCHAIN.device.usbVendorId,
    productId: SYMBIAN_TOOLCHAIN.device.usbProductId,
    deviceName: SYMBIAN_TOOLCHAIN.device.mtpName,
    timeoutMs: 45_000,
  }), { timeoutMs: 2 * 60_000, staleMs: 5 * 60_000 });
  console.log(`PocketJS Symbian deploy verified`);
  console.log(`  file: ${result.localName}`);
  console.log(`  destination: ${SYMBIAN_TOOLCHAIN.device.deployStorage}/${SYMBIAN_TOOLCHAIN.device.deployFolder}`);
  console.log(`  SHA-256: ${result.sha256}`);
  console.log("  copied and read back byte-for-byte; installation still requires confirmation on the E7");
}

const args = Bun.argv.slice(2);
const command = args[0] ?? "help";
const HELP = `PocketJS Nokia E7 / Symbian toolchain

  pocket symbian doctor [--device]  inspect the isolated build chain and optional USB device
  pocket symbian doctor --coda-usb  verify CODA over the E7 USB interface 4
  pocket symbian setup --yes        fetch pinned SDK inputs and build the amd64 toolchain
  pocket symbian build probe        build and self-sign the visible Qt probe SIS
  pocket symbian build app --manifest <pocket.json> [--sis-version 1.0.0]
                                    build a target-bound PocketJS E7 runtime SIS
  pocket symbian deploy <sis>       copy to Mass memory/Installs and verify by MTP readback
  pocket symbian coda usb           run the CODA USB ping + Locator handshake
`;

try {
  switch (command) {
    case "doctor":
      if (!await doctor(
        args.includes("--device"),
        args.includes("--coda-usb"),
      )) process.exitCode = 1;
      break;
    case "setup":
      if (!args.includes("--yes")) {
        throw new Error(
          "setup downloads archived Nokia SDK material for local development; re-run with --yes",
        );
      }
      await setupSymbianToolchain();
      break;
    case "build":
      if (args[1] === "probe") {
        console.log(`PocketJS Symbian probe: ${await buildProbe()}`);
        break;
      }
      if (args[1] === "app") {
        const manifest = flagValue(args.slice(2), "--manifest");
        if (!manifest) {
          throw new Error(
            "usage: pocket symbian build app --manifest <pocket.json> [--sis-version 1.0.0]",
          );
        }
        const sisVersion = flagValue(args.slice(2), "--sis-version") ??
          SYMBIAN_TOOLCHAIN.runtime.sisVersion;
        console.log(`PocketJS Symbian runtime: ${await buildApp(manifest, sisVersion)}`);
        break;
      }
      throw new Error(
        "usage: pocket symbian build probe | build app --manifest <pocket.json>",
      );
    case "deploy":
      if (!args[1]) throw new Error("usage: pocket symbian deploy <path-to.sis>");
      await deploy(args[1]);
      break;
    case "coda": {
      if (args[1] !== "usb") throw new Error("usage: pocket symbian coda usb");
      const coda = await runCodaUsbProbe();
      if (coda.stdout) process.stdout.write(sanitizeDeviceOutput(coda.stdout));
      if (coda.stderr) process.stderr.write(sanitizeDeviceOutput(coda.stderr));
      if (coda.exitCode !== 0) throw new Error("CODA USB handshake failed");
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(HELP);
      throw new Error(`unknown Symbian command ${JSON.stringify(command)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
