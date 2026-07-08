#!/usr/bin/env node
// @pocketjs/cli — the PocketJS toolchain CLI (flutter/react-native doctor
// style). Zero dependencies; plain Node >= 18.
//
//   pocketjs doctor          diagnose the local toolchain
//   pocketjs setup [--yes]   install what doctor found missing (best effort)
//   pocketjs create <name>   scaffold a demo app inside a PocketJS checkout
//   pocketjs dev|build|psp|hw|psplink|devtools|tape [...args]
//                            passthrough to the checkout's bun scripts
//
// The PSP toolchain pin below MUST match scripts/psp.ts in the framework
// checkout — the CLI only diagnoses/installs, the build scripts consume.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const NIGHTLY = "nightly-2026-05-28";
const C = {
  ok: (s) => `\x1b[32m✓\x1b[0m ${s}`,
  bad: (s) => `\x1b[31m✗\x1b[0m ${s}`,
  warn: (s) => `\x1b[33m!\x1b[0m ${s}`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const which = (bin) => {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
};
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

// ---------------------------------------------------------------------------
// Checkout discovery
// ---------------------------------------------------------------------------

function findCheckout(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).name === "@pocketjs/framework") return dir;
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function sdkCandidates(root) {
  const home = homedir();
  const out = [process.env.PSP_SDK].filter(Boolean);
  if (root) {
    // Mirrors the candidate order in scripts/psp.ts.
    out.push(join(root, "mipsel-sony-psp"));
    out.push(join(root, "dreamcart", "mipsel-sony-psp"));
  }
  out.push(join(home, "code", "dreamcart", "mipsel-sony-psp"));
  return out;
}

function checks() {
  const root = findCheckout();
  const isMac = platform() === "darwin";
  const llvm = isMac
    ? ["/opt/homebrew/opt/llvm/bin/clang", "/usr/local/opt/llvm/bin/clang"].find(existsSync) ?? null
    : which("clang");
  const toolchains = run("rustup", ["toolchain", "list"]) ?? "";
  const targets = run("rustup", ["target", "list", "--installed"]) ?? "";
  const sdk = sdkCandidates(root).find((p) => existsSync(join(p, "psp", "lib", "libc.a"))) ?? null;
  return {
    root,
    isMac,
    core: [
      { name: "bun", ok: !!which("bun"), hint: "curl -fsSL https://bun.sh/install | bash" },
      { name: "rustup", ok: !!which("rustup"), hint: "curl https://sh.rustup.rs -sSf | sh" },
      {
        name: "Rust stable + wasm32-unknown-unknown (web host)",
        ok: targets.includes("wasm32-unknown-unknown"),
        fix: ["rustup", ["target", "add", "wasm32-unknown-unknown"]],
      },
      {
        name: "PocketJS checkout",
        ok: !!root,
        hint: "git clone https://github.com/pocket-stack/pocketjs && cd pocketjs",
        detail: root ?? undefined,
      },
    ],
    psp: [
      {
        name: `Rust ${NIGHTLY} (PSP builds)`,
        ok: toolchains.includes(NIGHTLY),
        fix: ["rustup", ["toolchain", "install", NIGHTLY, "--component", "rust-src"]],
      },
      { name: "cargo-psp", ok: !!which("cargo-psp"), fix: ["cargo", ["install", "cargo-psp"]] },
      {
        name: "Homebrew LLVM (TARGET_CFLAGS clang)",
        ok: !!llvm,
        fix: isMac ? ["brew", ["install", "llvm"]] : null,
        hint: isMac ? undefined : "install clang/llvm via your distro's package manager",
        detail: llvm ?? undefined,
      },
      {
        name: "rust-psp SDK (mipsel-sony-psp)",
        ok: !!sdk,
        hint: "set PSP_SDK=/path/to/mipsel-sony-psp (contains psp/lib/libc.a)",
        detail: sdk ?? undefined,
      },
      {
        name: "PSPLINK host tools (usbhostfs_pc + pspsh)",
        ok: !!which("usbhostfs_pc") && !!which("pspsh"),
        hint: "build from https://github.com/pspdev/psplinkusb (or the pspdev toolchain)",
      },
    ],
    optional: [
      {
        name: "PPSSPPHeadless (emulator E2E)",
        ok: existsSync(join(homedir(), "ppsspp-src", "build", "PPSSPPHeadless")) || !!process.env.PPSSPP_HEADLESS,
        hint: "source-build PPSSPP with headless, or set PPSSPP_HEADLESS",
      },
      { name: "ImageMagick (frame decoding)", ok: !!which("magick"), fix: isMac ? ["brew", ["install", "imagemagick"]] : null },
    ],
  };
}

function doctor() {
  const c = checks();
  const section = (title, items) => {
    console.log("\n" + C.bold(title));
    for (const it of items) {
      const line = it.ok ? C.ok(it.name) : title === "Optional" ? C.warn(it.name) : C.bad(it.name);
      console.log("  " + line + (it.detail ? C.dim(`  (${it.detail})`) : ""));
      if (!it.ok && (it.hint || it.fix)) {
        console.log("      " + C.dim(it.fix ? `fix: ${it.fix[0]} ${it.fix[1].join(" ")}` : it.hint));
      }
    }
  };
  console.log(C.bold("PocketJS doctor"));
  section("Core (web/desktop development)", c.core);
  section("PSP hardware builds", c.psp);
  section("Optional", c.optional);
  const missing = [...c.core, ...c.psp].filter((i) => !i.ok).length;
  console.log(
    "\n" +
      (missing === 0
        ? C.ok("Everything looks good.")
        : C.warn(`${missing} issue(s) found — run ${C.bold("pocketjs setup")} to fix the installable ones.`)),
  );
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

async function confirm(question) {
  if (process.argv.includes("--yes") || process.argv.includes("-y")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(`${question} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function setup() {
  const c = checks();
  const fixable = [...c.core, ...c.psp, ...c.optional].filter((i) => !i.ok && i.fix);
  const manual = [...c.core, ...c.psp].filter((i) => !i.ok && !i.fix);
  if (fixable.length === 0 && manual.length === 0) {
    console.log(C.ok("Nothing to do — the toolchain is complete."));
    return;
  }
  for (const it of fixable) {
    const [cmd, args] = it.fix;
    if (!(await confirm(`Install ${C.bold(it.name)} via \`${cmd} ${args.join(" ")}\`?`))) continue;
    console.log(C.dim(`$ ${cmd} ${args.join(" ")}`));
    const r = spawnSync(cmd, args, { stdio: "inherit" });
    console.log(r.status === 0 ? C.ok(it.name) : C.bad(`${it.name} (exit ${r.status})`));
  }
  if (manual.length > 0) {
    console.log("\n" + C.bold("Manual steps remaining:"));
    for (const it of manual) console.log("  " + C.warn(it.name) + "\n      " + C.dim(it.hint ?? ""));
  }
  console.log("\nRe-run " + C.bold("pocketjs doctor") + " to verify.");
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

const APP_TSX = (title) => `// ${title} — scaffolded by \`pocketjs create\`.
import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

export default function App() {
  const [count, setCount] = createSignal(0);
  onButtonPress(BTN.CROSS, () => setCount((n) => n + 1));
  return (
    <View class="w-full h-full flex-col items-center justify-center gap-4 bg-slate-950">
      <View class="w-[48] h-[48] rounded-[12px] bg-indigo-500 animate-spin" />
      <Text class="text-xl text-white font-bold">{\`Count: \${count()}\`}</Text>
      <Text class="text-sm text-slate-400">Press CROSS (Z / Enter) to count</Text>
    </View>
  );
}
`;

const MAIN_TSX = (title) => `// @title PocketJS: ${title}
import App from "./app.tsx";
import { mount } from "@pocketjs/framework";

mount(() => <App />);
`;

const CONFIG_TS = `import { definePocketConfig } from "@pocketjs/framework/config";

export default definePocketConfig({
  framework: "solid",
  // theme: { keyframes: { … }, animation: { … } }  — see /docs and the
  // "Baking Motion" post for the animation surface.
});
`;

function create(name) {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(C.bad("usage: pocketjs create <kebab-case-name>"));
    process.exit(1);
  }
  const root = findCheckout();
  if (!root) {
    console.error(C.bad("not inside a PocketJS checkout — clone https://github.com/pocket-stack/pocketjs first"));
    process.exit(1);
  }
  const dir = join(root, "demos", name);
  if (existsSync(dir)) {
    console.error(C.bad(`demos/${name} already exists`));
    process.exit(1);
  }
  const title = name.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.tsx"), APP_TSX(title));
  writeFileSync(join(dir, "main.tsx"), MAIN_TSX(title));
  writeFileSync(join(dir, "pocket.config.ts"), CONFIG_TS);
  console.log(C.ok(`demos/${name} scaffolded`));
  console.log(C.dim(`  pocketjs dev ${name}-main     # browser at http://127.0.0.1:8130/`));
  console.log(C.dim(`  pocketjs psp ${name} --release  # PSP EBOOT`));
}

// ---------------------------------------------------------------------------
// passthrough
// ---------------------------------------------------------------------------

const SCRIPTS = { dev: "scripts/dev.ts", build: "scripts/build.ts", psp: "scripts/psp.ts", hw: "scripts/hw.ts", psplink: "scripts/psplink.ts", devtools: "scripts/devtools.ts", tape: "scripts/tape.ts" };

function passthrough(cmd, args) {
  const root = findCheckout();
  if (!root) {
    console.error(C.bad(`\`pocketjs ${cmd}\` must run inside a PocketJS checkout`));
    process.exit(1);
  }
  if (!which("bun")) {
    console.error(C.bad("bun not found — run `pocketjs setup`"));
    process.exit(1);
  }
  const r = spawnSync("bun", [join(root, SCRIPTS[cmd]), ...args], { stdio: "inherit", cwd: root });
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const [, , cmd, ...rest] = process.argv;
const HELP = `${C.bold("pocketjs")} — the PocketJS toolchain CLI

  pocketjs doctor            diagnose bun / Rust / PSP toolchain / PSPLINK
  pocketjs setup [--yes]     install what doctor found missing
  pocketjs create <name>     scaffold demos/<name> in a PocketJS checkout
  pocketjs dev <app>-main    build + serve an app in the browser
  pocketjs build <app>       build an app bundle + pak
  pocketjs psp <app>         build the PSP EBOOT
  pocketjs hw <app>          build + run on a real PSP over PSPLINK
  pocketjs psplink           interactive multi-app switcher on a real PSP
  pocketjs devtools [app]    DevTools panel + USB debug bridge (one command)
  pocketjs tape <cmd> …      record / replay / inspect input tapes headlessly
`;

switch (cmd) {
  case "doctor":
    doctor();
    break;
  case "setup":
    await setup();
    break;
  case "create":
    create(rest[0]);
    break;
  case "dev":
  case "build":
  case "psp":
  case "hw":
  case "psplink":
  case "devtools":
  case "tape":
    passthrough(cmd, rest);
    break;
  case "--version":
  case "-v":
    console.log(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version);
    break;
  default:
    console.log(HELP);
    process.exitCode = cmd && cmd !== "--help" && cmd !== "help" ? 1 : 0;
}
