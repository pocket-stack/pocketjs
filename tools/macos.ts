// bun run macos [app] [flags…] — build + launch a PocketJS app on the gpui
// macOS host (hosts/macos over the macos-app target; docs/BACKENDS.md).
//
//   bun run macos                    # the note, native text (the flagship)
//   bun run macos hero               # a fixed-viewport console demo,
//                                    # size-locked + baked glyphs
//   bun run macos note -- --file todo.md
//   bun run macos note --proof       # headless-ish acceptance: scripted
//                                    # typing, autosave round-trips, quits
//
// Everything host-facing derives from the platform contract: the manifest
// resolves against POCKET_TARGETS["macos-app"], and the plan's viewport,
// density and features become host flags (--fixed, --native-text, --editor).
// The windowed run stays attached to your terminal — ⌘Q quits. On exit the
// host prints its governor receipt: "pocket-macos: N ticks, M frames
// rendered" — a settled app should show M ≪ N.
import { existsSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { $ } from "bun";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

const root = new URL("..", import.meta.url).pathname;
// The host and the gpui backend are git-only crates (npm files map ships
// this wrapper for parity with tools/note.ts, whose widget host is git-only
// too) — fail with directions instead of a cargo error mid-build.
if (!existsSync(`${root}hosts/macos/Cargo.toml`)) {
  console.error(
    "bun run macos needs a git checkout: hosts/macos and engine/backends/gpui are not part of the npm package (github.com/pocket-stack/pocketjs).",
  );
  process.exit(1);
}
const argv = process.argv.slice(2).filter((a) => a !== "--");
const proof = argv.includes("--proof");
const rest = argv.filter((f) => f !== "--proof");
const appArg = rest[0] && !rest[0].startsWith("--") ? rest.shift()! : "note";
const appDir = appArg.replace(/-main$/, "");

const manifestPath = `${root}apps/${appDir}/pocket.json`;
if (!existsSync(manifestPath)) {
  throw new Error(`pocket-macos: no manifest at apps/${appDir}/pocket.json`);
}
const manifest = await Bun.file(manifestPath).json();
const resolution = validateAndResolveBuildPlan(manifest, { target: "macos-app" });
if (!resolution.ok) {
  throw new Error(
    `pocket-macos: ${appDir} did not resolve against macos-app: ${resolution.diagnostics
      .map((d) => `${d.path || "/"}: ${d.message}`)
      .join("; ")}`,
  );
}
const plan = resolution.plan;
const planPath = `${root}.pocket/macos-app/${plan.app.output}.plan.json`;
mkdirSync(resolvePath(planPath, ".."), { recursive: true });
await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");

await $`bun tools/build.ts --plan=${planPath} --project-root=${root}`.cwd(root);
await $`cargo build --release`.cwd(`${root}hosts/macos`);

const bin = `${root}hosts/macos/target/release/pocket-macos`;
const env = { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" };

// Every host flag derives from the resolved plan (issue #295 landed the
// companion list and viewport policy in it):
//   fixed        — plan.viewport.policy (size-locked run)
//   native-text  — text.layout.native resolved true (host installs the
//                  CoreText measurer before mount)
//   companions   — plan.companions: the svc names the app speaks; the host
//                  builds its svcOpen allowlist from exactly this list
//   editor       — the NOTE companion dialect (apps/note/svc.ts) — wired
//                  when the app declares the "note" companion
const fixed = plan.viewport.policy === "fixed";
const editor = plan.companions.includes("note");
const flags: string[] = [
  "--app",
  plan.app.output,
  "--title",
  plan.app.title,
  "--viewport",
  `${plan.viewport.logical[0]}x${plan.viewport.logical[1]}`,
  "--density",
  String(plan.viewport.rasterDensity),
];
if (fixed) flags.push("--fixed");
if (plan.features["text.layout.native"]) flags.push("--native-text");
if (plan.companions.length > 0) flags.push("--companions", plan.companions.join(","));
if (editor) flags.push("--editor");

if (proof && !editor) {
  console.error(
    "bun run macos --proof drives the NOTE companion protocol (scripted typing + autosave); " +
      `${appDir} declares [${plan.companions.join(", ")}]. Script other apps with the host's ` +
      "--mouse/--key/--type/--click flags directly.",
  );
  process.exit(1);
}
if (proof) {
  const file = `${root}dist/macos-proof.md`;
  await $`rm -f ${file}`;
  // Click the header's pencil toggle (note-widget's proof coordinates),
  // then type — the debounced autosave must round-trip the text.
  await $`${bin} ${flags} --file ${file} --click 350,15@10 --type PROOF-GPUI-@40 --quit-after 220`.env(
    env,
  );
  const saved = (await Bun.file(file).text().catch(() => "")).includes("PROOF-GPUI-");
  if (!saved) throw new Error("macos proof: autosave round-trip missed the typed text");
  console.log("\nproof: typing landed at the caret through the svc protocol and the\ndebounced autosave wrote the file back out through the gpui host.");
} else {
  const fileFlags =
    editor && !rest.some((f) => f === "--file")
      ? ["--file", `${process.env.HOME}/.pocket-note.md`]
      : [];
  await $`${bin} ${flags} ${fileFlags} ${rest}`.env(env);
}
