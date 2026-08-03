#!/usr/bin/env bun

// Reproducible full-PocketJS firmware builder/flasher for the Waveshare
// ESP32-P4-WIFI6-Touch-LCD-7B.
//
//   bun tools/esp32p4-device.ts build chrome
//   bun tools/esp32p4-device.ts flash chrome --port /dev/cu.usbmodem101

import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { loadBoard } from "../vapor/compiler/boards.ts";
import {
  esp32IdfVersion,
  resolveEspIdfEnvironment,
  type EspIdfEnvironment,
} from "../vapor/compiler/esp32.ts";
import {
  buildEsp32P4Bundle,
  ESP32P4_FRAMEWORK_ROOT,
  type Esp32P4BundleArtifacts,
} from "./esp32p4.ts";
import { ESP32P4_WAVESHARE_7B_BOARD_ID } from "./esp32p4-profile.ts";

export const ESP32P4_IDF_VERSION = "v5.5.4" as const;
export const ESP32P4_RUST_TOOLCHAIN = "nightly-2026-07-02";
export const ESP32P4_RUST_TARGET = "riscv32imafc-esp-espidf";
export const ESP32P4_RUST_CFLAGS = [
  "-mabi=ilp32f",
  "-march=rv32imafc_zicsr_zifencei_xesppie",
  "-Wno-error=incompatible-pointer-types",
  "-fno-pic",
  "-fno-pie",
].join(" ");
export const ESP32P4_RUSTFLAGS = "-C relocation-model=static";
export const ESP32P4_APPLICATION_PARTITION_BYTES = 0xf00000;

const TEMPLATE_ROOT_FILES = [
  "CMakeLists.txt",
  "dependencies.lock",
  "sdkconfig.defaults",
  "partitions.csv",
] as const;
const TEMPLATE_MAIN_FILES = [
  "CMakeLists.txt",
  "idf_component.yml",
  "pocketjs_esp32p4.c",
  "pocketjs_runtime.h",
] as const;
const FIRMWARE_FILENAME = "pocketjs_esp32p4_waveshare_7b.bin";

export type Esp32P4DeviceCommand = "build" | "flash";

export interface Esp32P4DeviceArguments {
  readonly command: Esp32P4DeviceCommand;
  readonly app: string;
  readonly port?: string;
}

export interface Esp32P4DevicePaths {
  readonly frameworkRoot: string;
  readonly outputDirectory: string;
  readonly templateDirectory: string;
  readonly projectDirectory: string;
  readonly mainDirectory: string;
  readonly buildDirectory: string;
  readonly runtimeManifestPath: string;
  readonly rustTargetDirectory: string;
  readonly rustLibraryPath: string;
  readonly firmwareImagePath: string;
  readonly flasherArgsPath: string;
}

export interface Esp32P4GccToolchain {
  readonly gccPath: string;
  readonly arPath: string;
  readonly sysroot: string;
  readonly gccInclude: string;
  readonly gccFixedInclude: string;
  readonly bindgenArguments: string;
}

export interface Esp32P4DeviceBuildResult {
  readonly app: string;
  readonly title: string;
  readonly buildId: string;
  readonly projectDirectory: string;
  readonly buildDirectory: string;
  readonly firmwareImagePath: string;
  readonly firmwareBytes: number;
  readonly rustLibraryPath: string;
  readonly idfEnvironment: EspIdfEnvironment;
}

interface InternalBuildResult {
  readonly result: Esp32P4DeviceBuildResult;
  readonly paths: Esp32P4DevicePaths;
  readonly activatedEnvironment: Record<string, string>;
  readonly idfExecutable: string;
}

class Esp32P4DeviceArgumentError extends Error {}

function argumentError(message: string): Esp32P4DeviceArgumentError {
  return new Esp32P4DeviceArgumentError(`pocket esp32p4 device: ${message}`);
}

export function parseEsp32P4DeviceArgs(
  args: readonly string[],
): Esp32P4DeviceArguments {
  const command = args[0];
  if (command !== "build" && command !== "flash") {
    throw argumentError("expected command build or flash");
  }
  const app = args[1]?.trim();
  if (!app || app.startsWith("--")) {
    throw argumentError(`${command} requires an app name or pocket.json path`);
  }

  let port: string | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      if (port !== undefined) throw argumentError("--port may only be given once");
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw argumentError("--port requires a serial device path");
      }
      port = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--port=")) {
      if (port !== undefined) throw argumentError("--port may only be given once");
      port = argument.slice("--port=".length).trim();
      if (!port) throw argumentError("--port requires a serial device path");
      continue;
    }
    throw argumentError(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (command === "build" && port !== undefined) {
    throw argumentError("--port is only valid with flash");
  }
  return port === undefined ? { command, app } : { command, app, port };
}

export function resolveEsp32P4DevicePaths(
  frameworkRoot = ESP32P4_FRAMEWORK_ROOT,
): Esp32P4DevicePaths {
  const root = resolve(frameworkRoot);
  const outputDirectory = join(root, "dist", "esp32p4");
  const projectDirectory = join(outputDirectory, "gen-waveshare-7b");
  const rustTargetDirectory = join(outputDirectory, "rust-target");
  const buildDirectory = join(projectDirectory, "build");
  return {
    frameworkRoot: root,
    outputDirectory,
    templateDirectory: join(root, "hosts", "esp32p4", "waveshare-7b"),
    projectDirectory,
    mainDirectory: join(projectDirectory, "main"),
    buildDirectory,
    runtimeManifestPath: join(root, "hosts", "esp32p4", "runtime", "Cargo.toml"),
    rustTargetDirectory,
    rustLibraryPath: join(
      rustTargetDirectory,
      ESP32P4_RUST_TARGET,
      "release",
      "libpocketjs_esp32p4_runtime.a",
    ),
    firmwareImagePath: join(buildDirectory, FIRMWARE_FILENAME),
    flasherArgsPath: join(buildDirectory, "flasher_args.json"),
  };
}

/** Refuse to recursively remove anything except this checkout's generated project. */
export function assertSafeEsp32P4GeneratedProject(
  projectDirectory: string,
  frameworkRoot: string,
): void {
  const root = resolve(frameworkRoot);
  const project = resolve(projectDirectory);
  const expected = join(root, "dist", "esp32p4", "gen-waveshare-7b");
  if (project !== expected || relative(root, project).startsWith("..")) {
    throw new Error(`refusing to replace non-generated ESP32-P4 path: ${project}`);
  }
}

function requireRegularFile(path: string, description: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${description} not found: ${path}`);
  }
}

function requireDirectory(path: string, description: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${description} not found: ${path}`);
  }
}

function filesEqual(left: string, right: string): boolean {
  return readFileSync(left).equals(readFileSync(right));
}

/** Stage only the source template contract, never its ignored local build state. */
export function stageEsp32P4DeviceProject(
  bundle: Esp32P4BundleArtifacts,
  paths = resolveEsp32P4DevicePaths(bundle.frameworkRoot),
): void {
  if (resolve(bundle.frameworkRoot) !== paths.frameworkRoot) {
    throw new Error("ESP32-P4 bundle and generated project belong to different checkouts");
  }
  assertSafeEsp32P4GeneratedProject(paths.projectDirectory, paths.frameworkRoot);
  for (const file of TEMPLATE_ROOT_FILES) {
    requireRegularFile(join(paths.templateDirectory, file), `ESP32-P4 template ${file}`);
  }
  for (const file of TEMPLATE_MAIN_FILES) {
    requireRegularFile(
      join(paths.templateDirectory, "main", file),
      `ESP32-P4 template main/${file}`,
    );
  }
  requireRegularFile(bundle.javascriptPath, "ESP32-P4 JavaScript bundle");
  requireRegularFile(bundle.pakPath, "ESP32-P4 asset pak");

  rmSync(paths.projectDirectory, { recursive: true, force: true });
  mkdirSync(paths.mainDirectory, { recursive: true });
  for (const file of TEMPLATE_ROOT_FILES) {
    copyFileSync(join(paths.templateDirectory, file), join(paths.projectDirectory, file));
  }
  for (const file of TEMPLATE_MAIN_FILES) {
    copyFileSync(
      join(paths.templateDirectory, "main", file),
      join(paths.mainDirectory, file),
    );
  }
  copyFileSync(bundle.javascriptPath, join(paths.mainDirectory, "app.js"));
  copyFileSync(bundle.pakPath, join(paths.mainDirectory, "app.pak"));

  for (const file of TEMPLATE_ROOT_FILES) {
    if (!filesEqual(join(paths.templateDirectory, file), join(paths.projectDirectory, file))) {
      throw new Error(`staged ESP32-P4 template file changed while copying: ${file}`);
    }
  }
  for (const file of TEMPLATE_MAIN_FILES) {
    if (
      !filesEqual(
        join(paths.templateDirectory, "main", file),
        join(paths.mainDirectory, file),
      )
    ) {
      throw new Error(`staged ESP32-P4 template file changed while copying: main/${file}`);
    }
  }
}

export function parseNulEnvironment(bytes: Uint8Array): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const entry of Buffer.from(bytes).toString("utf8").split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
}

function shellForActivation(): string {
  const configured = process.env.SHELL;
  if (
    configured &&
    existsSync(configured) &&
    (basename(configured) === "bash" || basename(configured) === "zsh")
  ) {
    return configured;
  }
  const shell = Bun.which("zsh") ?? Bun.which("bash");
  if (!shell) throw new Error("ESP-IDF requires bash or zsh to source export.sh");
  return shell;
}

async function captureProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<Uint8Array> {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(
      `command failed (${exitCode}): ${command} ${args.join(" ")}` +
        (detail ? `\n${detail}` : ""),
    );
  }
  return new Uint8Array(stdout);
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`command failed (${exitCode}): ${command} ${args.join(" ")}`);
  }
}

function findExecutable(name: string, environment: Record<string, string>): string {
  const candidates = isAbsolute(name)
    ? [name]
    : (environment.PATH ?? "").split(":").filter(Boolean).map((directory) =>
      join(directory, name)
    );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return resolve(candidate);
    } catch {
      // Keep looking through the activated PATH.
    }
  }
  throw new Error(`executable ${name} not found in the activated ESP-IDF environment`);
}

function readIdfRelease(idfPath: string): string {
  const versionPath = join(idfPath, "tools", "cmake", "version.cmake");
  requireRegularFile(versionPath, "ESP-IDF version metadata");
  const source = readFileSync(versionPath, "utf8");
  const part = (name: "MAJOR" | "MINOR" | "PATCH"): string => {
    const value = source.match(new RegExp(`set\\(IDF_VERSION_${name}\\s+([0-9]+)\\)`))?.[1];
    if (!value) throw new Error(`cannot read ESP-IDF ${name.toLowerCase()} version from ${versionPath}`);
    return value;
  };
  return `v${part("MAJOR")}.${part("MINOR")}.${part("PATCH")}`;
}

async function activateEspIdfEnvironment(
  idfEnvironment: EspIdfEnvironment,
): Promise<Record<string, string>> {
  const exportScript = join(idfEnvironment.idfPath, "export.sh");
  requireRegularFile(exportScript, `${idfEnvironment.idfVersion} ESP-IDF export script`);
  const baseEnvironment = {
    ...processEnvironment(),
    IDF_PATH: idfEnvironment.idfPath,
    IDF_TOOLS_PATH: idfEnvironment.idfToolsPath,
  };
  const bytes = await captureProcess(
    shellForActivation(),
    [
      "-lc",
      'source "$1/export.sh" >/dev/null && env -0',
      "pocketjs-esp32p4-idf",
      idfEnvironment.idfPath,
    ],
    { env: baseEnvironment },
  );
  return parseNulEnvironment(bytes);
}

function shellWords(words: readonly string[]): string {
  return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

export function createEsp32P4RustEnvironment(
  activatedEnvironment: Record<string, string>,
  toolchain: Esp32P4GccToolchain,
  rustTargetDirectory: string,
): Record<string, string> {
  return {
    ...activatedEnvironment,
    CARGO_TARGET_DIR: resolve(rustTargetDirectory),
    CARGO_TARGET_RISCV32IMAFC_ESP_ESPIDF_RUSTFLAGS: ESP32P4_RUSTFLAGS,
    CC_riscv32imafc_esp_espidf: toolchain.gccPath,
    AR_riscv32imafc_esp_espidf: toolchain.arPath,
    CFLAGS_riscv32imafc_esp_espidf: ESP32P4_RUST_CFLAGS,
    BINDGEN_EXTRA_CLANG_ARGS: toolchain.bindgenArguments,
  };
}

async function resolveGccToolchain(
  activatedEnvironment: Record<string, string>,
): Promise<Esp32P4GccToolchain> {
  const gccPath = findExecutable("riscv32-esp-elf-gcc", activatedEnvironment);
  const arPath = findExecutable("riscv32-esp-elf-ar", activatedEnvironment);
  const query = async (argument: string): Promise<string> => {
    const output = await captureProcess(gccPath, [argument], { env: activatedEnvironment });
    const value = Buffer.from(output).toString("utf8").trim();
    if (!value) throw new Error(`${gccPath} returned no value for ${argument}`);
    return resolve(value);
  };
  const [sysroot, gccInclude, gccFixedInclude] = await Promise.all([
    query("-print-sysroot"),
    query("-print-file-name=include"),
    query("-print-file-name=include-fixed"),
  ]);
  const systemInclude = join(sysroot, "include");
  requireDirectory(sysroot, "RISC-V GCC sysroot");
  requireDirectory(gccInclude, "RISC-V GCC include directory");
  requireDirectory(gccFixedInclude, "RISC-V GCC fixed include directory");
  requireDirectory(systemInclude, "RISC-V GCC system include directory");
  const bindgenArguments = shellWords([
    "--target=riscv32-unknown-elf",
    `--sysroot=${sysroot}`,
    "-isystem",
    gccInclude,
    "-isystem",
    gccFixedInclude,
    "-isystem",
    systemInclude,
  ]);
  return { gccPath, arPath, sysroot, gccInclude, gccFixedInclude, bindgenArguments };
}

function firmwareBuildId(paths: Esp32P4DevicePaths): string {
  const hasher = createHash("sha256");
  hasher.update(`${ESP32P4_IDF_VERSION}\0${ESP32P4_RUST_TOOLCHAIN}\0`);
  hasher.update(`${ESP32P4_RUST_TARGET}\0${ESP32P4_RUST_CFLAGS}\0${ESP32P4_RUSTFLAGS}\0`);
  const inputs = [
    ...TEMPLATE_ROOT_FILES.map((file) => join(paths.projectDirectory, file)),
    ...TEMPLATE_MAIN_FILES.map((file) => join(paths.mainDirectory, file)),
    join(paths.mainDirectory, "app.js"),
    join(paths.mainDirectory, "app.pak"),
    paths.rustLibraryPath,
  ];
  for (const path of inputs) {
    requireRegularFile(path, "ESP32-P4 build-id input");
    hasher.update(`${relative(paths.frameworkRoot, path)}\0`);
    hasher.update(readFileSync(path));
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 16);
}

function requireSafeAppTitle(title: string): string {
  // The template injects this cache string into a quoted C definition. Reject
  // CMake list/C-string metacharacters until that boundary owns escaping.
  if (!title || /[;"\\\r\n]/.test(title)) {
    throw new Error(
      `ESP32-P4 app title cannot contain semicolon, quote, backslash, or newline: ` +
        JSON.stringify(title),
    );
  }
  return title;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateEsp32P4FlasherArgs(
  value: unknown,
  buildDirectory: string,
): { readonly appOffset: number; readonly flashFiles: readonly string[] } {
  if (!isRecord(value) || !isRecord(value.flash_files)) {
    throw new Error("ESP32-P4 flasher_args.json has no flash_files map");
  }
  const flashFiles: string[] = [];
  for (const [offsetText, file] of Object.entries(value.flash_files)) {
    const offset = Number.parseInt(offsetText, 0);
    if (!Number.isSafeInteger(offset) || offset <= 0) {
      throw new Error(`unsafe ESP32-P4 flash offset ${JSON.stringify(offsetText)}`);
    }
    if (typeof file !== "string" || !file) {
      throw new Error(`invalid ESP32-P4 flash file at ${offsetText}`);
    }
    const path = resolve(buildDirectory, file);
    const pathWithinBuild = relative(resolve(buildDirectory), path);
    if (pathWithinBuild.startsWith("..") || isAbsolute(pathWithinBuild)) {
      throw new Error(`ESP32-P4 flash file escapes its build directory: ${file}`);
    }
    requireRegularFile(path, `ESP32-P4 segmented flash image at ${offsetText}`);
    if (statSync(path).size === 0) {
      throw new Error(`ESP32-P4 segmented flash image is empty: ${path}`);
    }
    flashFiles.push(path);
  }
  if (!isRecord(value.app) || value.app.offset !== "0x10000") {
    throw new Error("ESP32-P4 app image must be described at offset 0x10000");
  }
  if (value.app.file !== FIRMWARE_FILENAME) {
    throw new Error(`ESP32-P4 flasher app is not ${FIRMWARE_FILENAME}`);
  }
  for (const requiredOffset of ["0x2000", "0x8000", "0x10000"]) {
    if (!(requiredOffset in value.flash_files)) {
      throw new Error(`ESP32-P4 flasher args omit required segment ${requiredOffset}`);
    }
  }
  return { appOffset: 0x10000, flashFiles };
}

function validateBuildOutputs(paths: Esp32P4DevicePaths): number {
  const templateLock = join(paths.templateDirectory, "dependencies.lock");
  const generatedLock = join(paths.projectDirectory, "dependencies.lock");
  if (!filesEqual(templateLock, generatedLock)) {
    throw new Error(
      "ESP-IDF changed the generated dependencies.lock; refresh the reviewed board template lock",
    );
  }
  requireRegularFile(paths.flasherArgsPath, "ESP32-P4 flasher arguments");
  let flasherArgs: unknown;
  try {
    flasherArgs = JSON.parse(readFileSync(paths.flasherArgsPath, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON in ${paths.flasherArgsPath}`, { cause: error });
  }
  validateEsp32P4FlasherArgs(flasherArgs, paths.buildDirectory);
  requireRegularFile(paths.firmwareImagePath, "ESP32-P4 application image");
  const firmwareBytes = statSync(paths.firmwareImagePath).size;
  if (firmwareBytes === 0 || firmwareBytes > ESP32P4_APPLICATION_PARTITION_BYTES) {
    throw new Error(
      `ESP32-P4 application image is ${firmwareBytes} bytes; partition limit is ` +
        `${ESP32P4_APPLICATION_PARTITION_BYTES}`,
    );
  }
  return firmwareBytes;
}

async function buildWithContext(app: string): Promise<InternalBuildResult> {
  const paths = resolveEsp32P4DevicePaths();
  const bundle = await buildEsp32P4Bundle(app);
  const board = loadBoard(ESP32P4_WAVESHARE_7B_BOARD_ID);
  const idfEnvironment = resolveEspIdfEnvironment(board);
  const expectedVersion = esp32IdfVersion(board);
  if (expectedVersion !== ESP32P4_IDF_VERSION || idfEnvironment.idfVersion !== expectedVersion) {
    throw new Error(
      `Waveshare ESP32-P4 requires ${ESP32P4_IDF_VERSION}, got ${idfEnvironment.idfVersion}`,
    );
  }
  const actualVersion = readIdfRelease(idfEnvironment.idfPath);
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `ESP-IDF release mismatch: ${idfEnvironment.idfPath} is ${actualVersion}, ` +
        `but this board requires ${expectedVersion}`,
    );
  }

  const activatedEnvironment = await activateEspIdfEnvironment(idfEnvironment);
  const idfExecutable = findExecutable("idf.py", activatedEnvironment);
  const rustupExecutable = findExecutable("rustup", activatedEnvironment);
  const gccToolchain = await resolveGccToolchain(activatedEnvironment);
  const rustEnvironment = createEsp32P4RustEnvironment(
    activatedEnvironment,
    gccToolchain,
    paths.rustTargetDirectory,
  );
  const rustupTool = async (tool: "cargo" | "rustc"): Promise<string> => {
    const output = await captureProcess(
      rustupExecutable,
      ["which", tool, "--toolchain", ESP32P4_RUST_TOOLCHAIN],
      { env: activatedEnvironment },
    );
    const path = Buffer.from(output).toString("utf8").trim();
    requireRegularFile(path, `${ESP32P4_RUST_TOOLCHAIN} ${tool}`);
    return resolve(path);
  };
  // Calling `rustup run ... cargo` alone is insufficient when another rustc
  // appears earlier in an activated PATH: Cargo resolves its compiler again.
  // Pin both executables to the dated toolchain so build-std cannot silently
  // mix a Homebrew stable compiler with the nightly Cargo frontend.
  const [cargoExecutable, rustcExecutable] = await Promise.all([
    rustupTool("cargo"),
    rustupTool("rustc"),
  ]);
  rustEnvironment.RUSTC = rustcExecutable;
  rustEnvironment.RUSTUP_TOOLCHAIN = ESP32P4_RUST_TOOLCHAIN;
  requireRegularFile(paths.runtimeManifestPath, "ESP32-P4 Rust runtime manifest");
  await runProcess(
    cargoExecutable,
    [
      "build",
      "--manifest-path",
      paths.runtimeManifestPath,
      "--release",
      "--locked",
      "--lib",
      "--target",
      ESP32P4_RUST_TARGET,
      "--features",
      "esp-idf",
      "-Z",
      "build-std=std,panic_abort",
    ],
    { cwd: paths.frameworkRoot, env: rustEnvironment },
  );
  requireRegularFile(paths.rustLibraryPath, "ESP32-P4 Rust static library");
  if (statSync(paths.rustLibraryPath).size === 0) {
    throw new Error(`ESP32-P4 Rust static library is empty: ${paths.rustLibraryPath}`);
  }

  stageEsp32P4DeviceProject(bundle, paths);
  const buildId = firmwareBuildId(paths);
  const appTitle = requireSafeAppTitle(bundle.plan.app.title);
  const idfBuildEnvironment = {
    ...activatedEnvironment,
    POCKETJS_REPO_ROOT: paths.frameworkRoot,
    POCKETJS_RUST_LIB: paths.rustLibraryPath,
  };
  await runProcess(
    idfExecutable,
    [
      "-C",
      paths.projectDirectory,
      "-B",
      paths.buildDirectory,
      "-D",
      `POCKETJS_REPO_ROOT=${paths.frameworkRoot}`,
      "-D",
      `POCKETJS_RUST_LIB=${paths.rustLibraryPath}`,
      "-D",
      `POCKETJS_APP_TITLE=${appTitle}`,
      "-D",
      `POCKETJS_BUILD_ID=${buildId}`,
      "build",
    ],
    { cwd: paths.frameworkRoot, env: idfBuildEnvironment },
  );
  const firmwareBytes = validateBuildOutputs(paths);
  return {
    paths,
    activatedEnvironment: idfBuildEnvironment,
    idfExecutable,
    result: {
      app: bundle.plan.app.output,
      title: bundle.plan.app.title,
      buildId,
      projectDirectory: paths.projectDirectory,
      buildDirectory: paths.buildDirectory,
      firmwareImagePath: paths.firmwareImagePath,
      firmwareBytes,
      rustLibraryPath: paths.rustLibraryPath,
      idfEnvironment,
    },
  };
}

export async function buildEsp32P4Device(
  app: string,
): Promise<Esp32P4DeviceBuildResult> {
  return (await buildWithContext(app)).result;
}

export async function flashEsp32P4Device(
  app: string,
  port?: string,
): Promise<Esp32P4DeviceBuildResult> {
  const built = await buildWithContext(app);
  const args = [
    "-C",
    built.paths.projectDirectory,
    "-B",
    built.paths.buildDirectory,
  ];
  if (port) args.push("-p", port);
  // idf.py reads flasher_args.json and writes the bootloader, partition table,
  // and application at their generated offsets. Never substitute write_flash.
  args.push("flash");
  await runProcess(built.idfExecutable, args, {
    cwd: built.paths.frameworkRoot,
    env: built.activatedEnvironment,
  });
  return built.result;
}

function printUsage(): void {
  console.error(
    "usage: bun tools/esp32p4-device.ts build <stock-app | path/to/pocket.json>\n" +
      "       bun tools/esp32p4-device.ts flash <stock-app | path/to/pocket.json> [--port /dev/cu.*]",
  );
}

export async function esp32P4DeviceMain(args: readonly string[]): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printUsage();
    return;
  }
  const parsed = parseEsp32P4DeviceArgs(args);
  const result = parsed.command === "build"
    ? await buildEsp32P4Device(parsed.app)
    : await flashEsp32P4Device(parsed.app, parsed.port);
  const relativeImage = relative(ESP32P4_FRAMEWORK_ROOT, result.firmwareImagePath);
  console.log(
    `PocketJS ESP32-P4 ${parsed.command}: ${result.app} build=${result.buildId} ` +
      `${result.firmwareBytes} bytes -> ${relativeImage}`,
  );
}

if (import.meta.main) {
  try {
    await esp32P4DeviceMain(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Esp32P4DeviceArgumentError) printUsage();
    process.exitCode = 1;
  }
}
