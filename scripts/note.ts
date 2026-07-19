// bun run note [flags…] — build + launch the markdown sticky note
// (pocket3d/examples/note-widget over demos/note, the flat pocket-widget
// runtime; WIDGET.md §2b).
//
//   bun run note                    # your note (~/.pocket-note.md)
//   bun run note -- --file todo.md  # any markdown file
//   bun run note -- --width 380 --height 520
//   bun run note --proof            # headless acceptance: click into the
//                                   # sample, type, autosave round-trips,
//                                   # screenshot lands in dist/
//
// The windowed run stays attached to your terminal — ⌘Q quits (or Ctrl-C
// here). On exit the shell prints its governor receipt:
// "pocket-widget: N ticks, M frames rendered" — a settled note should show
// M ≪ N (measured: 2 frames over 481 ticks).
import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2).filter((a) => a !== "--");
const proof = args.includes("--proof");
const pass = args.filter((f) => f !== "--proof");

await $`bun scripts/build.ts note-main --density=2`.cwd(root);
await $`cargo build --release -p note-widget`.cwd(`${root}pocket3d`);

const bin = `${root}pocket3d/target/release/note-widget`;
const env = { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" };

if (proof) {
  const shot = `${root}dist/note-proof.png`;
  const file = `${root}dist/note-proof.md`;
  await $`rm -f ${file}`;
  await $`${bin} --file ${file} --screenshot ${shot} --frames 130 --click 200,300@10 --type PROOF-@30 ${pass}`.env(
    env,
  );
  const saved = (await Bun.file(file).text()).includes("PROOF-");
  if (!saved) throw new Error("note proof: autosave round-trip missed the typed text");
  console.log(
    "\nproof: a click dropped the caret into the sample note, typing landed" +
      "\nat it, and the debounced autosave wrote the file back out." +
      `\n${shot}`,
  );
  await $`open ${shot}`.nothrow();
} else {
  await $`${bin} ${pass}`.env(env);
}
