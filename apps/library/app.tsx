// apps/library/app.tsx — "game library" showcase: an XMB-style icon row (the PSP's
// own home menu made real). LEFT/RIGHT move focus (focus:scale-110 + lift —
// the icon quad scales, its label stays crisp: draw.rs keeps glyph cells
// unscaled even inside a scaled parent frame), CIRCLE opens the selected
// tile — an SVG-baked spinner texture cycles through frames while loading
// auto-advances into a detail screen, TRIANGLE returns to the
// grid with focus restored to the tile that opened it (focusNode(), also
// unused elsewhere — the other demos rely purely on d-pad-driven focus).
//
// Design notes: text single-line (docs/DESIGN.md: no auto word-wrap — the blurb is
// pre-split into <Text> lines), every class a FULL literal (the per-tile accent
// border/gradient is baked per entry, never synthesized).

import { createMemo, createSignal, onMount, Show } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { spring } from "@pocketjs/framework/animation";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN, focusNode } from "@pocketjs/framework/input";

type Screen = "library" | "loading" | "detail";

interface Game {
  title: string;
  genre: string;
  playtime: string;
  trophies: string;
  blurb: string[];
  /** grid tile: full literal (icon size + gradient + accent border + focus). */
  tileCls: string;
  /** true for the "ABOUT" tile: no loading screen, no playtime/trophies. */
  about?: boolean;
}

// Every tileCls is a FULL literal (framework/compiler/tailwind.ts resolves style records
// from AST string literals, never from interpolated templates) — shared
// structure is copy-pasted, same convention as cards.tsx's CARDS table.
const GAMES: Game[] = [
  {
    title: "NEON DRIFT",
    genre: "ARCADE RACING",
    playtime: "14H 22M",
    trophies: "18 / 40",
    blurb: ["Drift a synthwave coastline at 200 km/h.", "Three circuits — never lift off the gas."],
    tileCls:
      "w-14 h-14 rounded-xl shadow-md items-center justify-center translate-y-2 focus:translate-y-0 focus:scale-110 transition-all duration-150 ease-out bg-gradient-to-b from-blue-500 to-blue-700 border-blue-300 focus:border-slate-900",
  },
  {
    title: "IRON VANGUARD",
    genre: "MECH ACTION",
    playtime: "31H 05M",
    trophies: "27 / 40",
    blurb: ["Pilot a scrapyard mech at the Vanguard fleet.", "Every boss fight rewrites the arena."],
    tileCls:
      "w-14 h-14 rounded-xl shadow-md items-center justify-center translate-y-2 focus:translate-y-0 focus:scale-110 transition-all duration-150 ease-out bg-gradient-to-b from-rose-400 to-rose-700 border-rose-300 focus:border-slate-900",
  },
  {
    title: "TIDE POOL",
    genre: "PUZZLE",
    playtime: "6H 40M",
    trophies: "9 / 40",
    blurb: ["Rearrange the reef before the tide comes in.", "120 hand-made pools, zero timers."],
    tileCls:
      "w-14 h-14 rounded-xl shadow-md items-center justify-center translate-y-2 focus:translate-y-0 focus:scale-110 transition-all duration-150 ease-out bg-gradient-to-b from-sky-400 to-sky-700 border-sky-300 focus:border-slate-900",
  },
  {
    title: "GHOST WATCH",
    genre: "MYSTERY",
    playtime: "9H 12M",
    trophies: "12 / 40",
    blurb: ["Something in the lighthouse keeps the log.", "Find out before the batteries do."],
    tileCls:
      "w-14 h-14 rounded-xl shadow-md items-center justify-center translate-y-2 focus:translate-y-0 focus:scale-110 transition-all duration-150 ease-out bg-gradient-to-b from-cyan-500 to-cyan-700 border-cyan-300 focus:border-slate-900",
  },
  {
    title: "ABOUT",
    genre: "POCKETJS ENGINE",
    playtime: "",
    trophies: "",
    blurb: ["Solid universal renderer over a no_std Rust core.", "One JSX app — PSP hardware, PPSSPP or a browser."],
    tileCls:
      "w-14 h-14 rounded-xl shadow-md items-center justify-center translate-y-2 focus:translate-y-0 focus:scale-110 transition-all duration-150 ease-out bg-white border-slate-300 focus:border-slate-900",
    about: true,
  },
];

const LOADING_FRAMES = 48; // ~0.8s at 60 Hz — spinner cycles while mounted
const SPINNER_FRAME_STEP = 3;
const SPINNER_FRAMES = [
  "spinner-00.svg",
  "spinner-01.svg",
  "spinner-02.svg",
  "spinner-03.svg",
  "spinner-04.svg",
  "spinner-05.svg",
  "spinner-06.svg",
  "spinner-07.svg",
];

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/** Icon row. Remounts on every return to "library" — onMount restores focus
 *  to the tile that was open (focusNode over the d-pad's own traversal). */
function Grid(props: { selectedIndex: () => number; onOpen: (game: Game, index: number) => void }) {
  const refs: (NodeMirror | undefined)[] = [];
  onMount(() => {
    const i = props.selectedIndex();
    if (i >= 0) focusNode(refs[i] ?? null);
  });
  return (
    <View debugName="Grid" class="flex-row gap-4 justify-center items-center grow">
      {GAMES.map((game, i) => (
        <View class="flex-col items-center gap-2">
          <View ref={refs[i]} class={game.tileCls} focusable onPress={() => props.onOpen(game, i)}>
            <Show when={game.about}>
              <Image class="w-9 h-9" src="logo.png" />
            </Show>
          </View>
          <Text class="text-xs text-slate-900 font-bold">{game.title}</Text>
        </View>
      ))}
    </View>
  );
}

/** SVG-baked spinner — frame-cycled instead of rotating an image quad, because
 *  the v1 texture op is axis-aligned and should stay cheap on PSP. */
function Loading(props: { title: string; frame: () => number }) {
  const src = createMemo(() => {
    const i = Math.floor(props.frame() / SPINNER_FRAME_STEP) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[i];
  });
  return (
    <View debugName="Loading" class="flex-col items-center justify-center gap-3 grow">
      <Image class="w-10 h-10" src={src()} />
      <Text class="text-sm text-slate-600 tracking-wide">LOADING {props.title}...</Text>
    </View>
  );
}

function DetailStat(props: { label: string; value: string }) {
  return (
    <View debugName="DetailStat" class="flex-col items-end">
      <Text class="text-lg text-blue-600 font-bold">{props.value}</Text>
      <Text class="text-xs text-slate-500 tracking-wide">{props.label}</Text>
    </View>
  );
}

/** Springs up into place on open; colors are static from the first frame so the
 *  panel never fades through the default dark style. */
function Detail(props: { game: Game }) {
  let panel: NodeMirror | undefined;
  onMount(() => {
    if (panel) spring(panel, "translateY", 0);
  });
  return (
    <View
      ref={panel}
      debugName="Detail"
      style={{ translateY: 18 }}
      class="flex-col gap-3 p-4 grow rounded-xl shadow-md bg-white border-slate-200"
    >
      <View class="flex-row items-end justify-between">
        <View class="flex-col gap-1">
          <Text class="text-xs text-blue-600 tracking-wide">{props.game.genre}</Text>
          <Text class="text-2xl text-slate-950 font-bold">{props.game.title}</Text>
        </View>
        <Show when={!props.game.about}>
          <View class="flex-row gap-4">
            <DetailStat label="PLAYTIME" value={props.game.playtime} />
            <DetailStat label="TROPHIES" value={props.game.trophies} />
          </View>
        </Show>
      </View>
      <View class="flex-col gap-1">
        {props.game.blurb.map((line) => (
          <Text class="text-sm text-slate-600">{line}</Text>
        ))}
      </View>
      <Text class="text-xs text-slate-500">TRIANGLE back to library</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function Library() {
  const [screen, setScreen] = createSignal<Screen>("library");
  const [selected, setSelected] = createSignal<Game | null>(null);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);
  const [loadFrame, setLoadFrame] = createSignal(0);

  const openGame = (game: Game, index: number) => {
    setSelected(game);
    setSelectedIndex(index);
    if (game.about) {
      setScreen("detail");
    } else {
      setLoadFrame(0);
      setScreen("loading");
    }
  };

  onButtonPress(BTN.TRIANGLE, () => {
    if (screen() === "detail") setScreen("library");
  });
  onFrame(() => {
    if (screen() !== "loading") return;
    const n = loadFrame() + 1;
    setLoadFrame(n);
    if (n >= LOADING_FRAMES) setScreen("detail");
  });

  return (
    <View debugName="LibraryScreen" class="relative flex-col w-full h-full p-4 gap-3 bg-gradient-to-b from-slate-50 to-slate-100">
      <View debugName="Header" class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-blue-600 tracking-wide">POCKETJS SHOWCASE</Text>
          <Text class="text-2xl text-slate-950 font-bold">Game Library</Text>
        </View>
        <Text class="text-xs text-slate-500">5 TITLES</Text>
      </View>

      <Show when={screen() === "library"}>
        <Grid selectedIndex={selectedIndex} onOpen={openGame} />
        <Text class="text-xs text-slate-500">LEFT / RIGHT move focus · CIRCLE open</Text>
      </Show>

      <Show when={screen() === "loading" && selected()}>
        <Loading title={selected()!.title} frame={loadFrame} />
      </Show>

      <Show when={screen() === "detail" && selected()}>
        <Detail game={selected()!} />
      </Show>
    </View>
  );
}
