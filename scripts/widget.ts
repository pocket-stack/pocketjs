// bun run widget [app] [flags…] — build + launch the 3D PSP desktop widget
// (pocket3d/examples/handheld, the first pocket-widget runtime; WIDGET.md).
//
//   bun run widget                # the hero demo inside the widget
//   bun run widget im             # any demo (name resolves to <name>-main)
//   bun run widget -- --focus     # extra flags pass through to the binary
//   bun run widget --proof        # headless acceptance: scripted D-pad +
//                                 # CIRCLE taps drive hero to "Count: 2",
//                                 # screenshot lands in dist/
//
// The windowed run stays attached to your terminal — quit with Esc (or
// Ctrl-C). On exit the shell prints its governor receipt:
// "pocket-widget: N ticks, M frames rendered" — a settled app should show
// M ≪ N.
import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2).filter((a) => a !== "--");
const flags = args.filter((a) => a.startsWith("--"));
const names = args.filter((a) => !a.startsWith("--"));
const proof = flags.includes("--proof");
const pass = flags.filter((f) => f !== "--proof");

// Demo names resolve to their mounted -main entry (demos/<name>/main.tsx);
// the bare name would build the side-effect-free component module.
const name = names[0] ?? "hero";
const app = name.includes("/") || name.endsWith("-main") ? name : `${name}-main`;

await $`bun scripts/build.ts ${app}`.cwd(root);
await $`cargo build --release -p handheld`.cwd(`${root}pocket3d`);

const bin = `${root}pocket3d/target/release/handheld`;
const env = { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" };

if (proof) {
  const shot = `${root}dist/handheld-proof.png`;
  await $`${bin} --app ${app} --screenshot ${shot} --frames 90 --tap down@10 --tap circle@30 --tap circle@50 ${pass}`.env(env);
  console.log(
    "\nproof: a D-pad tap focused the app, then two CIRCLE taps went through" +
      '\nthe 3D buttons — with the hero demo the screen reads "Count: 2".' +
      `\n${shot}`,
  );
  await $`open ${shot}`.nothrow();
} else {
  await $`${bin} --app ${app} ${pass}`.env(env);
}
