// demos/library.tsx — "game library" showcase: an XMB-style icon row (the PSP's
// own home menu made real). LEFT/RIGHT move focus (focus:scale-110 + lift —
// the icon quad scales, its label stays crisp: draw.rs keeps glyph cells
// unscaled even inside a scaled parent frame), CIRCLE opens the selected
// tile — an SVG-baked spinner texture cycles through frames while loading
// auto-advances into a detail screen, TRIANGLE returns to the
// grid with focus restored to the tile that opened it (focusNode(), also
// unused elsewhere — the other demos rely purely on d-pad-driven focus).
//
// Design notes: text single-line (DESIGN.md: no auto word-wrap — the blurb is
// pre-split into <text> lines), every class a FULL literal (the per-tile accent
// border/gradient is baked per entry, never synthesized).

import { createMemo, createSignal, onMount, Show } from "solid-js";
import { spring } from "../src/anim.ts";
import { BTN } from "../spec/spec.ts";
import { focusNode } from "../src/input.ts";
import type { NodeMirror } from "../src/renderer.ts";

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

// Every tileCls is a FULL literal (compiler/tailwind.ts resolves style records
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
    genre: "PSP-UI ENGINE",
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
// Frame driver (wired by library-main.tsx): edge-detects TRIANGLE (back) and
// steps the loading screen's frame-capped auto-advance. Runs BEFORE the
// engine's own input/focus/onPress pass (mount-main.tsx wraps frame).
// ---------------------------------------------------------------------------

const [screen, setScreen] = createSignal<Screen>("library");
const [selected, setSelected] = createSignal<Game | null>(null);
const [selectedIndex, setSelectedIndex] = createSignal(-1);
const [loadFrame, setLoadFrame] = createSignal(0);
let prevButtons = 0;

export function libraryFrame(buttons: number): void {
  const pressed = buttons & ~prevButtons;
  prevButtons = buttons;
  if (screen() === "loading") {
    const n = loadFrame() + 1;
    setLoadFrame(n);
    if (n >= LOADING_FRAMES) setScreen("detail");
    return;
  }
  if (screen() === "detail" && pressed & BTN.TRIANGLE) {
    setScreen("library");
  }
}

function openGame(game: Game, index: number): void {
  setSelected(game);
  setSelectedIndex(index);
  if (game.about) {
    setScreen("detail");
  } else {
    setLoadFrame(0);
    setScreen("loading");
  }
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/** Icon row. Remounts on every return to "library" — onMount restores focus
 *  to the tile that was open (focusNode over the d-pad's own traversal). */
function Grid() {
  const refs: (NodeMirror | undefined)[] = [];
  onMount(() => {
    const i = selectedIndex();
    if (i >= 0) focusNode(refs[i] ?? null);
  });
  return (
    <view class="flex-row gap-4 justify-center items-center grow">
      {GAMES.map((game, i) => (
        <view class="flex-col items-center gap-2">
          <view ref={refs[i]} class={game.tileCls} focusable onPress={() => openGame(game, i)}>
            <Show when={game.about}>
              <image class="w-9 h-9" src="logo.png" />
            </Show>
          </view>
          <text class="text-xs text-slate-900 font-bold">{game.title}</text>
        </view>
      ))}
    </view>
  );
}

/** SVG-baked spinner — frame-cycled instead of rotating an image quad, because
 *  the v1 texture op is axis-aligned and should stay cheap on PSP. */
function Loading(props: { title: string }) {
  const src = createMemo(() => {
    const i = Math.floor(loadFrame() / SPINNER_FRAME_STEP) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[i];
  });
  return (
    <view class="flex-col items-center justify-center gap-3 grow">
      <image class="w-10 h-10" src={src()} />
      <text class="text-sm text-slate-600 tracking-wide">LOADING {props.title}...</text>
    </view>
  );
}

function DetailStat(props: { label: string; value: string }) {
  return (
    <view class="flex-col items-end">
      <text class="text-lg text-blue-600 font-bold">{props.value}</text>
      <text class="text-xs text-slate-500 tracking-wide">{props.label}</text>
    </view>
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
    <view
      ref={panel}
      style={{ translateY: 18 }}
      class="flex-col gap-3 p-4 grow rounded-xl shadow-md bg-white border-slate-200"
    >
      <view class="flex-row items-end justify-between">
        <view class="flex-col gap-1">
          <text class="text-xs text-blue-600 tracking-wide">{props.game.genre}</text>
          <text class="text-2xl text-slate-950 font-bold">{props.game.title}</text>
        </view>
        <Show when={!props.game.about}>
          <view class="flex-row gap-4">
            <DetailStat label="PLAYTIME" value={props.game.playtime} />
            <DetailStat label="TROPHIES" value={props.game.trophies} />
          </view>
        </Show>
      </view>
      <view class="flex-col gap-1">
        {props.game.blurb.map((line) => (
          <text class="text-sm text-slate-600">{line}</text>
        ))}
      </view>
      <text class="text-xs text-slate-500">TRIANGLE back to library</text>
    </view>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function Library() {
  return (
    <view class="relative flex-col w-full h-full p-4 gap-3 bg-gradient-to-b from-slate-50 to-slate-100">
      <view class="flex-row items-end justify-between">
        <view class="flex-col">
          <text class="text-xs text-blue-600 tracking-wide">PSP-UI SHOWCASE</text>
          <text class="text-2xl text-slate-950 font-bold">Game Library</text>
        </view>
        <text class="text-xs text-slate-500">5 TITLES</text>
      </view>

      <Show when={screen() === "library"}>
        <Grid />
        <text class="text-xs text-slate-500">LEFT / RIGHT move focus · CIRCLE open</text>
      </Show>

      <Show when={screen() === "loading" && selected()}>
        <Loading title={selected()!.title} />
      </Show>

      <Show when={screen() === "detail" && selected()}>
        <Detail game={selected()!} />
      </Show>
    </view>
  );
}
