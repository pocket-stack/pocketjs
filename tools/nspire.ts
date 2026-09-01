import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import {
  NSPIRE_CX2_DEV_TARGET_ID,
  resolveNspireCx2BuildPlan,
} from "./nspire-profile.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const hostDirectory = join(repository, "hosts/nspire");
const outputDirectory = join(repository, "dist/nspire");
const planPath = join(repository, ".pocket/nspire-cx2-dev/plan.json");
const embeddedPath = join(hostDirectory, "build/app_data.c");
const defaultManifest = join(repository, "hosts/nspire/demo.pocket.json");
const quickJsRevision = "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b";
const quickJsCheckout = join(outputDirectory, "quickjs-rs");
const quickJsPatch = join(repository, "tools/nspire/quickjs-cx2.patch");
const command = Bun.argv[2] ?? "doctor";

function run(executable: string, args: readonly string[], cwd = repository): void {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed (${result.exitCode})`);
  }
}

function which(name: string): string | undefined {
  return Bun.which(name) ?? undefined;
}

function doctor(): void {
  const checks = [
    ["Bun", which("bun")],
    ["Rustup", which("rustup")],
    ["Ndless compiler", which("nspire-gcc")],
    ["Ndless linker", which("nspire-ld")],
    ["Ndless packer", which("genzehn")],
    ["Ndless program wrapper", which("make-prg")],
  ] as const;
  for (const [label, path] of checks) {
    console.log(`${path ? "[ok]" : "[missing]"} ${label}: ${path ?? "not on PATH"}`);
  }
  const qjs = quickJsSource();
  console.log(`${qjs ? "[ok]" : "[missing]"} pinned QuickJS: ${qjs ?? "run bun nspire bootstrap"}`);
  if (checks.some(([, path]) => !path) || !qjs) process.exitCode = 1;
}

function quickJsSource(): string | undefined {
  const configured = process.env.POCKETJS_QUICKJS_DIR;
  if (configured && existsSync(join(configured, "quickjs.c"))) {
    return dirname(dirname(dirname(configured)));
  }
  const nested = join(quickJsCheckout, "libquickjs-sys/embed/quickjs/quickjs.c");
  return existsSync(nested) ? quickJsCheckout : undefined;
}

function bootstrap(): void {
  if (!existsSync(join(quickJsCheckout, ".git"))) {
    mkdirSync(outputDirectory, { recursive: true });
    run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "https://github.com/pocket-stack/quickjs-rs.git",
      quickJsCheckout,
    ]);
  }
  run("git", ["-C", quickJsCheckout, "checkout", "--detach", quickJsRevision]);
  const revision = Bun.spawnSync({
    cmd: ["git", "-C", quickJsCheckout, "rev-parse", "HEAD"],
    stdout: "pipe",
  }).stdout.toString().trim();
  if (revision !== quickJsRevision) throw new Error(`unexpected QuickJS revision ${revision}`);
  const reverse = Bun.spawnSync({
    cmd: ["git", "-C", quickJsCheckout, "apply", "--reverse", "--check", quickJsPatch],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (reverse.exitCode !== 0) {
    run("git", ["-C", quickJsCheckout, "apply", "--check", quickJsPatch]);
    run("git", ["-C", quickJsCheckout, "apply", quickJsPatch]);
  }
  console.log(`PocketJS Nspire: pinned QuickJS ready at ${quickJsCheckout}`);
}

function currentPlan(manifestPath: string): ResolvedBuildPlan {
  return resolveNspireCx2BuildPlan(JSON.parse(readFileSync(manifestPath, "utf8")));
}

function cArray(name: string, bytes: Uint8Array): string {
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    rows.push(
      `  ${[...bytes.subarray(offset, offset + 16)]
        .map((value) => `0x${value.toString(16).padStart(2, "0")}`)
        .join(", ")},`,
    );
  }
  return [
    `const unsigned char ${name}[] = {`,
    ...rows,
    "};",
    `const unsigned int ${name}_len = ${bytes.length}u;`,
    "",
  ].join("\n");
}

function bundle(manifestPath: string): void {
  const plan = currentPlan(manifestPath);
  const inputs = extractHostBuildInputs(plan, { expectedTarget: NSPIRE_CX2_DEV_TARGET_ID });
  mkdirSync(dirname(planPath), { recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(dirname(embeddedPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  run(process.execPath, [
    join(repository, "tools/build.ts"),
    `--plan=${planPath}`,
    `--project-root=${repository}`,
    `--outdir=${outputDirectory}`,
  ]);
  const jsPath = join(outputDirectory, `${inputs.appOutput}.js`);
  const pakPath = join(outputDirectory, `${inputs.appOutput}.pak`);
  if (!existsSync(jsPath) || !existsSync(pakPath)) {
    throw new Error("PocketJS Nspire compiler did not emit JavaScript and pak artifacts");
  }
  writeFileSync(
    embeddedPath,
    cArray("pocket_app_js", readFileSync(jsPath)) +
      cArray("pocket_app_pak", readFileSync(pakPath)),
  );
  console.log(`PocketJS Nspire: embedded guest -> ${embeddedPath}`);
}

function build(manifestPath: string): void {
  bundle(manifestPath);
  const quickjs = quickJsSource();
  if (!quickjs) throw new Error("pinned QuickJS is absent; run bun nspire bootstrap");
  run("make", [`QUICKJS_DIR=${quickjs}`], hostDirectory);
  console.log(`PocketJS Nspire: ${join(outputDirectory, "pocketjs-cx2.tns")}`);
}

const manifestArg = Bun.argv.find((value) => value.startsWith("--manifest="));
const manifestPath = resolve(manifestArg?.slice("--manifest=".length) ?? defaultManifest);
if (command === "doctor") doctor();
else if (command === "bootstrap") bootstrap();
else if (command === "bundle") bundle(manifestPath);
else if (command === "build") build(manifestPath);
else if (command === "clean") {
  rmSync(join(hostDirectory, "build"), { recursive: true, force: true });
  rmSync(planPath, { force: true });
  console.log("PocketJS Nspire: generated host and plan files removed");
} else {
  console.error("usage: bun nspire <doctor|bootstrap|bundle|build|clean> [--manifest=path]");
  process.exit(1);
}
