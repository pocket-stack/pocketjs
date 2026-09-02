// tools/sifli.ts — the PocketJS tool for SiFli SF32LB5x firmware projects
// (hosts/sifli). A project keeps only its app, board files, and assets; this
// tool generates what the SCons build embeds and checks the result.
//
//   bun tools/sifli.ts assets <project>          build every guest in <project>/pocket-sifli.json,
//                                                bake native paks, write src/pocket_assets.S and
//                                                src/pocket_catalog.generated.c, print SHA-256
//   bun tools/sifli.ts bake <in.pak> <out.epic> [--opaque-rgb565=RRGGBB]
//   bun tools/sifli.ts vendor <project>          vendor the staticlib's third-party crates into
//                                                <project>/rust/vendor/crates for offline builds
//   bun tools/sifli.ts build <project> [--board=<board>] [--search=<dir>] [-j<n>]
//   bun tools/sifli.ts audit <main.elf> [--nm=<arm-none-eabi-nm>]
//   bun tools/sifli.ts verify                    the simulator smoke (tests/sifli-sim.test.ts)
//   bun tools/sifli.ts crc <output> [--frames=N] [--assert=<serial log>]
//                                                per-frame CRC32 of the simulator's RGB565 frames
//                                                (512x300, density 2, scale 2) for parity with a
//                                                board built with POCKETJS_FRAME_CRC
//   bun tools/sifli.ts selfcheck <serial log>    apply the acceptance thresholds to
//                                                POCKETJS_SELF_CHECK lines; exits 1 on failure
//
// pocket-sifli.json:
//   {
//     "density": 2, "hz": 60, "framework": "solid",
//     "launcher": "launcher-main",
//     "guests": [
//       { "output": "launcher-main", "title": "Cover Flow",
//         "entry": "app/launcher/launcher-main.tsx", "native": { "opaque": "d9e7ef" } },
//       { "output": "hero-main", "title": "Hero" }
//     ]
//   }
// A guest with `entry` is compiled from the project (with the pocket.config.ts
// next to the entry when one exists, or `config`); without it the output is
// one of this repository's demo apps. `native: true` bakes a .epic pak with
// every image; `native: { opaque }` precomposites PSM_8888 alpha over that
// color into opaque RGB565.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mustRunCommand, printCheck, runCommand, sha256File } from "./native-host-build.ts";
import { bakeNativePak, parseOpaqueRgb } from "./sifli-bake.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUST_DIR = join(ROOT, "hosts", "sifli", "rust");
const DEFAULT_BOARD = "sf32lb58-lcd_n16r32n1_a1_dpi";

interface GuestSpec {
  readonly output: string;
  readonly title?: string;
  readonly entry?: string;
  /** Pocket config for a project entry: a project-relative path, `false` for
   *  none; omitted = the pocket.config.ts next to the entry when it exists. */
  readonly config?: string | false;
  readonly native?: boolean | { readonly opaque?: string };
}

interface SifliManifest {
  readonly density?: number;
  readonly hz?: number;
  readonly framework?: string;
  readonly launcher?: string;
  readonly guests: readonly GuestSpec[];
}

export function loadManifest(projectDir: string): SifliManifest {
  const path = join(projectDir, "pocket-sifli.json");
  if (!existsSync(path)) throw new Error(`${path} not found`);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as SifliManifest;
  if (!Array.isArray(manifest.guests) || manifest.guests.length === 0) {
    throw new Error(`${path}: "guests" must list at least one guest`);
  }
  for (const guest of manifest.guests) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(guest.output)) {
      throw new Error(`${path}: invalid output name "${guest.output}"`);
    }
  }
  if (manifest.launcher && !manifest.guests.some((g) => g.output === manifest.launcher)) {
    throw new Error(`${path}: launcher "${manifest.launcher}" is not a listed guest`);
  }
  return manifest;
}

/** C identifier for a guest: `hero-main` -> `hero`, `cover-flow-main` -> `cover_flow`. */
export function guestIdent(output: string): string {
  return output.replace(/-main$/, "").replace(/[^A-Za-z0-9]/g, "_");
}

function assetsDir(projectDir: string): string {
  return join(projectDir, "assets");
}

function buildGuest(projectDir: string, manifest: SifliManifest, guest: GuestSpec): void {
  const common = [
    `--outdir=${assetsDir(projectDir)}`,
    `--framework=${manifest.framework ?? "solid"}`,
    `--density=${manifest.density ?? 2}`,
    `--hz=${manifest.hz ?? 60}`,
    "--no-config",
  ];
  if (guest.entry) {
    const entry = resolve(projectDir, guest.entry);
    if (!existsSync(entry)) throw new Error(`${guest.output}: entry ${entry} not found`);
    const configPath = guest.config === false
      ? undefined
      : guest.config
        ? resolve(projectDir, guest.config)
        : join(dirname(entry), "pocket.config.ts");
    const configArgs = configPath && existsSync(configPath)
      ? [`--config=${configPath}`]
      : ["--no-config"];
    if (guest.config && !existsSync(configPath ?? "")) {
      throw new Error(`${guest.output}: config ${configPath} not found`);
    }
    // The project is the working directory so Bun's generated source comments
    // stay relative and the output is deterministic across checkouts.
    mustRunCommand(
      guest.output,
      process.execPath,
      [join(ROOT, "tools", "build.ts"), entry, `--project-root=${projectDir}`,
        ...common.filter((arg) => arg !== "--no-config"), ...configArgs],
      projectDir,
    );
  } else {
    mustRunCommand(
      guest.output,
      process.execPath,
      ["tools/build.ts", guest.output, `--project-root=${ROOT}`, ...common],
      ROOT,
    );
  }
  const js = join(assetsDir(projectDir), `${guest.output}.js`);
  const pak = join(assetsDir(projectDir), `${guest.output}.pak`);
  if (!existsSync(js) || !existsSync(pak)) {
    throw new Error(`${guest.output}: build did not produce ${js} and ${pak}`);
  }
}

function bakeGuest(projectDir: string, guest: GuestSpec): boolean {
  if (!guest.native) return false;
  const pakPath = join(assetsDir(projectDir), `${guest.output}.pak`);
  const opaque = typeof guest.native === "object" ? guest.native.opaque : undefined;
  const baked = bakeNativePak(new Uint8Array(readFileSync(pakPath)), {
    opaqueRgb: opaque ? parseOpaqueRgb(opaque) : undefined,
  });
  writeFileSync(join(assetsDir(projectDir), `${guest.output}.epic`), baked.bytes);
  console.log(`  ${guest.output}.epic: ${baked.images} image(s), ${baked.bytes.length} bytes`);
  return true;
}

function assetsAssembly(guests: readonly { output: string; native: boolean }[]): string {
  const lines = ['/* generated by tools/sifli.ts assets -- do not edit */',
    '    .section .rodata.pocket_assets,"a",%progbits'];
  const embed = (symbol: string, file: string, nul: boolean): void => {
    lines.push(
      "",
      "    .balign 4",
      `    .global ${symbol}_start`,
      `    .global ${symbol}_end`,
      `    .type ${symbol}_start,%object`,
      `${symbol}_start:`,
      `    .incbin "../assets/${file}"`,
      `${symbol}_end:`,
    );
    if (nul) lines.push("    .byte 0");
    lines.push(`    .size ${symbol}_start, ${symbol}_end - ${symbol}_start`);
  };
  for (const guest of guests) {
    const ident = guestIdent(guest.output);
    embed(`pocket_${ident}_js`, `${guest.output}.js`, true);
    embed(`pocket_${ident}_pak`, `${guest.output}.pak`, false);
    if (guest.native) embed(`pocket_${ident}_epic`, `${guest.output}.epic`, false);
  }
  lines.push("");
  return lines.join("\n");
}

function catalogSource(
  manifest: SifliManifest,
  guests: readonly { output: string; title?: string; native: boolean }[],
): string {
  const lines = [
    "/* generated by tools/sifli.ts assets -- do not edit */",
    "#include <stddef.h>",
    "",
    '#include "pocketjs_catalog.h"',
    "",
  ];
  for (const guest of guests) {
    const ident = guestIdent(guest.output);
    for (const kind of guest.native ? ["js", "pak", "epic"] : ["js", "pak"]) {
      lines.push(`extern const uint8_t pocket_${ident}_${kind}_start[];`);
      lines.push(`extern const uint8_t pocket_${ident}_${kind}_end[];`);
    }
  }
  lines.push("", "static const PocketjsGuest g_guests[] = {");
  for (const guest of guests) {
    const ident = guestIdent(guest.output);
    const title = JSON.stringify(guest.title ?? guest.output);
    const epic = guest.native
      ? `pocket_${ident}_epic_start, pocket_${ident}_epic_end`
      : "NULL, NULL";
    lines.push(
      `    {${JSON.stringify(guest.output)}, ${title}, pocket_${ident}_js_start, pocket_${ident}_js_end,`,
      `     pocket_${ident}_pak_start, pocket_${ident}_pak_end, ${epic}},`,
    );
  }
  const launcher = manifest.launcher
    ? guests.findIndex((guest) => guest.output === manifest.launcher)
    : 0;
  lines.push(
    "};",
    "",
    `const PocketjsCatalog pocketjs_catalog = {g_guests, ${guests.length}u, ${launcher}u};`,
    "",
  );
  return lines.join("\n");
}

export function assets(projectDir: string): void {
  const manifest = loadManifest(projectDir);
  mkdirSync(assetsDir(projectDir), { recursive: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  const built: { output: string; title?: string; native: boolean }[] = [];
  for (const guest of manifest.guests) {
    console.log(`${guest.output}: building${guest.entry ? ` ${guest.entry}` : " (repository demo)"}`);
    buildGuest(projectDir, manifest, guest);
    built.push({ output: guest.output, title: guest.title, native: bakeGuest(projectDir, guest) });
  }
  writeFileSync(join(projectDir, "src", "pocket_assets.S"), assetsAssembly(built));
  writeFileSync(join(projectDir, "src", "pocket_catalog.generated.c"), catalogSource(manifest, built));
  const manifestLines = ["# generated by tools/sifli.ts assets", ""];
  for (const guest of built) {
    for (const extension of guest.native ? [".js", ".pak", ".epic"] : [".js", ".pak"]) {
      const file = join(assetsDir(projectDir), guest.output + extension);
      const line = `${(guest.output + extension).padEnd(28)} ${String(statSync(file).size).padStart(10)}  ${sha256File(file)}`;
      manifestLines.push(line);
      console.log(`  ${line}`);
    }
  }
  writeFileSync(join(assetsDir(projectDir), "MANIFEST.txt"), manifestLines.join("\n") + "\n");
  console.log(`wrote ${relative(process.cwd(), join(projectDir, "src", "pocket_assets.S"))} and pocket_catalog.generated.c`);
}

export function vendor(projectDir: string): void {
  const vendorDir = join(projectDir, "rust", "vendor", "crates");
  mkdirSync(dirname(vendorDir), { recursive: true });
  const output = mustRunCommand(
    "cargo vendor",
    "cargo",
    ["vendor", "--locked", "--versioned-dirs", "--manifest-path", join(RUST_DIR, "Cargo.toml"), vendorDir],
    projectDir,
  );
  if (output) console.log(output);
  mkdirSync(join(projectDir, ".cargo"), { recursive: true });
  writeFileSync(
    join(projectDir, ".cargo", "config.toml"),
    [
      "# generated by tools/sifli.ts vendor -- offline build of the pocketjs-sifli staticlib.",
      "# hosts/sifli/SConscript runs cargo with this directory as its working directory.",
      "[net]",
      "offline = true",
      "",
      "[source.crates-io]",
      'replace-with = "vendored-sources"',
      "",
      "[source.vendored-sources]",
      'directory = "rust/vendor/crates"',
      "",
    ].join("\n"),
  );
  const commit = runCommand("git", ["rev-parse", "HEAD"], ROOT).stdout.trim();
  writeFileSync(
    join(projectDir, "rust", "vendor", "VENDOR.md"),
    [
      "# Vendored third-party crates",
      "",
      "Generated by `bun tools/sifli.ts vendor` from the PocketJS checkout at",
      `commit \`${commit || "unknown"}\`. Only registry crates live here; the PocketJS`,
      "crates are path dependencies resolved through `POCKETJS_ROOT`.",
      "",
      "Regenerate after `hosts/sifli/rust/Cargo.lock` changes.",
      "",
    ].join("\n"),
  );
  console.log(`vendored into ${vendorDir}`);
}

export function build(projectDir: string, board: string, search: string | undefined, jobs: string): void {
  const sdk = process.env.SIFLI_SDK;
  if (!sdk || !existsSync(join(sdk, "export.sh"))) {
    throw new Error("SIFLI_SDK is not set; source <SiFli-SDK>/export.sh first");
  }
  const args = [`--board=${board}`, `-j${jobs}`];
  if (search) args.push(`--board_search_path=${search}`);
  const result = Bun.spawnSync({
    cmd: ["scons", ...args],
    cwd: join(projectDir, "project"),
    env: { ...process.env, POCKETJS_ROOT: ROOT },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`scons failed (${result.exitCode})`);
}

export function audit(elf: string, nm: string): boolean {
  if (!existsSync(elf)) throw new Error(`${elf} not found`);
  const symbols = mustRunCommand("nm", nm, [elf], dirname(elf)).split("\n");
  const undefinedSymbols = mustRunCommand("nm -u", nm, ["-u", elf], dirname(elf))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const has = (pattern: RegExp): boolean => symbols.some((line) => pattern.test(line));
  let ok = true;
  ok = printCheck("no undefined symbols", undefinedSymbols.length === 0,
    undefinedSymbols.length === 0 ? "clean" : undefinedSymbols.slice(0, 5).join(", ")) && ok;
  ok = printCheck("GPU queue linked", has(/ T pocketjs_gpu_submit$/), "pocketjs_gpu_submit") && ok;
  ok = printCheck("HAL EPIC entry points", has(/ T HAL_EPIC_Init$/) && has(/ T HAL_EPIC_BlendStartEx_IT$/),
    "HAL_EPIC_Init, HAL_EPIC_BlendStartEx_IT") && ok;
  ok = printCheck("EPIC interrupt owned by the component", has(/ T EPIC_IRQHandler$/), "EPIC_IRQHandler") && ok;
  ok = printCheck("no RT-Thread drv_epic", !has(/drv_epic|epic_render/i), "drv_epic symbols absent") && ok;
  ok = printCheck("core ABI linked", has(/ T pocket_core_render_rgb565$/), "pocket_core_render_rgb565") && ok;
  return ok;
}

function verify(): void {
  mustRunCommand("build hero-main", process.execPath,
    ["tools/build.ts", "hero-main", "--density=2", "--hz=60"], ROOT);
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", "--conditions=browser", "tests/sifli-sim.test.ts"],
    cwd: ROOT,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`sifli sim smoke failed (${result.exitCode})`);
}

/** IEEE CRC-32 (reflected, 0xEDB88320): the same digest host_selfcheck.c prints. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const hex8 = (value: number): string => value.toString(16).padStart(8, "0");

/** CRC32 of every frame of `output` at the device viewport, frames 0..N-1 with no input. */
export async function frameCrcs(output: string, frames: number): Promise<string[]> {
  const { bootWorld } = await import("../hosts/sim/sim.ts");
  const world = await bootWorld(output, 60, undefined, undefined,
    { width: 512, height: 300, rasterDensity: 2, renderScale: 2 });
  const crcs: string[] = [];
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0);
    world.tick();
    const pixels = world.renderRgb565();
    crcs.push(hex8(crc32(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength))));
  }
  return crcs;
}

/** `[PocketJS] crc frame=<n> ... crc=<hex>` lines of a serial log, by frame index. */
export function parseCrcLog(text: string): Map<number, string> {
  const crcs = new Map<number, string>();
  for (const match of text.matchAll(/\[PocketJS\] crc frame=(\d+) hash=[0-9a-fA-F]+ crc=([0-9a-fA-F]{8})/g)) {
    crcs.set(Number(match[1]), match[2].toLowerCase());
  }
  return crcs;
}

async function crc(output: string, frames: number, assertLog: string | undefined): Promise<boolean> {
  const expected = await frameCrcs(output, frames);
  const board = assertLog ? parseCrcLog(readFileSync(assertLog, "utf8")) : undefined;
  let ok = true;
  let compared = 0;
  for (let frame = 0; frame < expected.length; frame++) {
    const actual = board?.get(frame);
    if (board && actual === undefined) {
      console.log(`frame ${frame} crc=${expected[frame]} (not in log)`);
      continue;
    }
    if (board) compared++;
    const status = board ? (actual === expected[frame] ? " ok" : ` MISMATCH board=${actual}`) : "";
    console.log(`frame ${frame} crc=${expected[frame]}${status}`);
    if (board && actual !== expected[frame]) ok = false;
  }
  if (board) {
    console.log(`${compared} frame(s) compared, ${ok ? "all equal" : "mismatches found"}`);
    if (compared === 0) ok = false;
  }
  return ok;
}

export interface SelfCheckLine {
  readonly frame: number;
  readonly mismatchPermille: number;
  readonly psnr: number;
  readonly maxDelta: number;
  readonly gradients: number;
  readonly copies: number;
  readonly vglite: number;
}

export function parseSelfCheckLog(text: string): SelfCheckLine[] {
  const lines: SelfCheckLine[] = [];
  const pattern =
    /\[PocketJS\] selfcheck frame=(\d+) mismatch=\d+\/\d+ \((\d+)\.(\d)%\) psnr=(\d+)\.(\d) maxd=(\d+) crc_hw=[0-9a-f]+ crc_sw=[0-9a-f]+ gpu=(\d+)\/(\d+)\/(\d+)\/(\d+) sw=\d+ vg=(\d+)/g;
  for (const match of text.matchAll(pattern)) {
    lines.push({
      frame: Number(match[1]),
      mismatchPermille: Number(match[2]) * 10 + Number(match[3]),
      psnr: Number(match[4]) + Number(match[5]) / 10,
      maxDelta: Number(match[6]),
      gradients: Number(match[8]),
      copies: Number(match[10]),
      vglite: Number(match[11]),
    });
  }
  return lines;
}

/**
 * Acceptance: frames whose hardware work is fills, A8 blends, and 1:1
 * copies must match exactly; EPIC gradients and scaled blits allow
 * psnr >= 45 dB, maxd <= 8, mismatch <= 0.5 %; VG Lite frames allow
 * psnr >= 38 dB and mismatch <= 3 %; below 35 dB is a failure everywhere.
 */
export function judgeSelfCheck(line: SelfCheckLine): string | undefined {
  if (line.psnr < 35) return `psnr ${line.psnr} < 35`;
  if (line.vglite > 0) {
    if (line.psnr < 38) return `VG Lite psnr ${line.psnr} < 38`;
    if (line.mismatchPermille > 30) return `VG Lite mismatch ${line.mismatchPermille / 10}% > 3%`;
    return undefined;
  }
  if (line.gradients > 0 || line.copies > 0) {
    if (line.psnr < 45) return `EPIC psnr ${line.psnr} < 45`;
    if (line.maxDelta > 8) return `EPIC maxd ${line.maxDelta} > 8`;
    if (line.mismatchPermille > 5) return `EPIC mismatch ${line.mismatchPermille / 10}% > 0.5%`;
    return undefined;
  }
  if (line.mismatchPermille > 0 || line.maxDelta > 0) return "exact path differs from the software rasterizer";
  return undefined;
}

function selfcheck(logPath: string): boolean {
  const lines = parseSelfCheckLog(readFileSync(logPath, "utf8"));
  if (lines.length === 0) {
    console.log(`${logPath}: no selfcheck lines (build with POCKETJS_SELF_CHECK)`);
    return false;
  }
  let ok = true;
  for (const line of lines) {
    const verdict = judgeSelfCheck(line);
    console.log(`frame ${line.frame}: psnr=${line.psnr} maxd=${line.maxDelta} mismatch=${line.mismatchPermille / 10}% vg=${line.vglite} ${verdict ? `FAIL (${verdict})` : "ok"}`);
    if (verdict) ok = false;
  }
  return ok;
}

function flag(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  switch (command) {
    case "assets":
      assets(resolve(positional[0] ?? "."));
      break;
    case "bake": {
      const [input, output] = positional;
      if (!input || !output) throw new Error("usage: bun tools/sifli.ts bake <in.pak> <out.epic> [--opaque-rgb565=RRGGBB]");
      const opaque = flag(rest, "opaque-rgb565");
      const baked = bakeNativePak(new Uint8Array(readFileSync(input)), {
        opaqueRgb: opaque ? parseOpaqueRgb(opaque) : undefined,
      });
      writeFileSync(output, baked.bytes);
      console.log(`native pak: ${baked.images} image(s), ${baked.bytes.length} bytes -> ${output}`);
      break;
    }
    case "vendor":
      vendor(resolve(positional[0] ?? "."));
      break;
    case "build":
      build(resolve(positional[0] ?? "."), flag(rest, "board") ?? DEFAULT_BOARD, flag(rest, "search"),
        rest.find((arg) => /^-j\d+$/.test(arg))?.slice(2) ?? "8");
      break;
    case "audit":
      if (!positional[0]) throw new Error("usage: bun tools/sifli.ts audit <main.elf> [--nm=<arm-none-eabi-nm>]");
      if (!audit(resolve(positional[0]), flag(rest, "nm") ?? "arm-none-eabi-nm")) process.exit(1);
      break;
    case "verify":
      verify();
      break;
    case "crc":
      if (!positional[0]) throw new Error("usage: bun tools/sifli.ts crc <output> [--frames=N] [--assert=<log>]");
      if (!(await crc(positional[0], Number(flag(rest, "frames") ?? "60"), flag(rest, "assert")))) process.exit(1);
      break;
    case "selfcheck":
      if (!positional[0]) throw new Error("usage: bun tools/sifli.ts selfcheck <serial log>");
      if (!selfcheck(resolve(positional[0]))) process.exit(1);
      break;
    default:
      console.error(`usage: bun tools/sifli.ts <assets|bake|vendor|build|audit|verify> ... (${basename(import.meta.path)})`);
      process.exit(2);
  }
}
