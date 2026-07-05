// native-3ds/gen-game.ts — embed the built app bundle + asset pack into the C
// host as generated headers (mirrors dreamcart runtime-3ds/gen-game.ts and the
// PSP build.rs POCKETJS_APP embed). Called by scripts/3ds.ts after the app is
// built for the "3ds" device profile.
//
//   bun native-3ds/gen-game.ts <app>    (reads dist/<app>.js + dist/<app>.pak)

const here = new URL(".", import.meta.url).pathname; // native-3ds/
const dist = new URL("../dist/", import.meta.url).pathname;
const app = Bun.argv[2] || process.env.POCKETJS_APP || "hero";

/** Emit `static const unsigned char NAME[] = {...,0}; static const unsigned NAME_LEN = n;`. */
function emitBytes(name: string, bytes: Uint8Array): string {
  let body = "";
  for (let i = 0; i < bytes.length; i++) {
    body += bytes[i] + ",";
    if ((i & 31) === 31) body += "\n";
  }
  return (
    `static const unsigned char ${name}[] = {\n${body}0\n};\n` +
    `static const unsigned ${name}_LEN = ${bytes.length};\n`
  );
}

// App JS bundle -> source/game_js.h (NUL-terminated already by the trailing 0;
// JS_Eval here is given the exact GAME_JS_LEN, so no separate NUL needed).
const jsPath = dist + app + ".js";
if (!(await Bun.file(jsPath).exists())) {
  console.error(`native-3ds gen-game: ${jsPath} missing — run \`bun scripts/build.ts ${app} --device=3ds\` first`);
  process.exit(1);
}
const js = new TextEncoder().encode(await Bun.file(jsPath).text());
await Bun.write(here + "source/game_js.h", `// AUTO-GENERATED from dist/${app}.js by gen-game.ts\n` + emitBytes("GAME_JS", js));

// Asset pack (styles.bin + font atlases + images) -> source/game_pak.h. Fed to
// the core natively by pj_feed_pak before eval. Empty when the app has no pak.
const pakPath = dist + app + ".pak";
const pak = (await Bun.file(pakPath).exists())
  ? new Uint8Array(await Bun.file(pakPath).arrayBuffer())
  : new Uint8Array(0);
await Bun.write(here + "source/game_pak.h", `// AUTO-GENERATED from dist/${app}.pak by gen-game.ts\n` + emitBytes("GAME_PAK", pak));

console.log(`native-3ds gen-game: embedded ${app} (js ${js.length}B, pak ${pak.length}B) -> source/game_{js,pak}.h`);
