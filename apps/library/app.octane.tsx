import { useLayoutEffect, useRef, useState } from "octane";
import { Image, Sprite, Text, View, type NodeMirror } from "@pocketjs/framework/octane/components";
import { spring } from "@pocketjs/framework/octane/animation";
import { useButtonPress, useFrame } from "@pocketjs/framework/octane/lifecycle";
import { BTN, focusNode } from "@pocketjs/framework/octane/input";
import { frameworkName } from "@pocketjs/framework/octane";

type Screen = "library" | "loading" | "detail";

interface Game {
  title: string;
  genre: string;
  playtime: string;
  trophies: string;
  blurb: string[];
  tileCls: string;
  about?: boolean;
}

const GAMES: Game[] = [
  {
    title: "NEON DRIFT",
    genre: "ARCADE RACING",
    playtime: "14H 22M",
    trophies: "18 / 40",
    blurb: ["Drift a synthwave coastline at 200 km/h.", "Three circuits - never lift off the gas."],
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
    blurb: [`${frameworkName()} or Solid over a no_std Rust core.`, "One JSX app - PSP hardware, PPSSPP or a browser."],
    tileCls:
      "w-14 h-14 rounded-xl shadow-md items-center justify-center translate-y-2 focus:translate-y-0 focus:scale-110 transition-all duration-150 ease-out bg-white border-slate-300 focus:border-slate-900",
    about: true,
  },
];

const LOADING_FRAMES = 48;

const GridScreen = (props: { selectedIndex: number; onOpen: (game: Game, index: number) => void }) => {
  const refs = useRef<(NodeMirror | undefined)[]>([]);
  useLayoutEffect(() => {
    const i = props.selectedIndex;
    if (i >= 0) focusNode(refs.current[i] ?? null);
  }, []);
  return (
    <View class="flex-row gap-4 justify-center items-center grow">
      {GAMES.map((game, i) => (
        <View key={game.title} class="flex-col items-center gap-2">
          <View
            nodeRef={(node: NodeMirror | null) => {
              refs.current[i] = node ?? undefined;
            }}
            class={game.tileCls}
            focusable
            onPress={() => props.onOpen(game, i)}
          >
            {game.about ? <Image class="w-9 h-9" src="logo.png" /> : null}
          </View>
          <Text class="text-xs text-slate-900 font-bold">{game.title}</Text>
        </View>
      ))}
    </View>
  );
};

// The spinner rides the native sprite channel (sprites.json atlas, host
// auto-play): a per-frame Octane state tick would replay the whole root
// for every spinner frame on the PSP.
const Loading = (props: { title: string }) => {
  return (
    <View class="flex-col items-center justify-center gap-3 grow">
      <Sprite class="w-10 h-10" sprite="spinner-atlas.svg" />
      <Text class="text-sm text-slate-600 tracking-wide">{`LOADING ${props.title}...`}</Text>
    </View>
  );
};

const DetailStat = (props: { label: string; value: string }) => {
  return (
    <View class="flex-col items-end">
      <Text class="text-lg text-blue-600 font-bold">{props.value}</Text>
      <Text class="text-xs text-slate-500 tracking-wide">{props.label}</Text>
    </View>
  );
};

const Detail = (props: { game: Game }) => {
  const panel = useRef<NodeMirror | null>(null);
  useLayoutEffect(() => {
    if (panel.current) spring(panel.current, "translateY", 0);
  }, []);
  return (
    <View
      nodeRef={(node: NodeMirror | null) => {
        panel.current = node;
      }}
      style={{ translateY: 18 }}
      class="flex-col gap-3 p-4 grow rounded-xl shadow-md bg-white border-slate-200"
    >
      <View class="flex-row items-end justify-between">
        <View class="flex-col gap-1">
          <Text class="text-xs text-blue-600 tracking-wide">{props.game.genre}</Text>
          <Text class="text-2xl text-slate-950 font-bold">{props.game.title}</Text>
        </View>
        {!props.game.about ? (
          <View class="flex-row gap-4">
            <DetailStat label="PLAYTIME" value={props.game.playtime} />
            <DetailStat label="TROPHIES" value={props.game.trophies} />
          </View>
        ) : null}
      </View>
      <View class="flex-col gap-1">
        {props.game.blurb.map((line) => (
          <Text key={line} class="text-sm text-slate-600">
            {line}
          </Text>
        ))}
      </View>
      <Text class="text-xs text-slate-500">TRIANGLE back to library</Text>
    </View>
  );
};

export default function Library() {
  const [screen, setScreen] = useState<Screen>("library");
  const [selected, setSelected] = useState<Game | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  // Loading is a fixed-length phase whose motion is native (Sprite atlas):
  // count it in a ref and commit exactly one state change at the end.
  const loadTick = useRef(0);

  const openGame = (game: Game, index: number) => {
    setSelected(game);
    setSelectedIndex(index);
    if (game.about) {
      setScreen("detail");
    } else {
      loadTick.current = 0;
      setScreen("loading");
    }
  };

  useButtonPress(BTN.TRIANGLE, () => {
    if (screen === "detail") setScreen("library");
  });
  useFrame(() => {
    if (screen !== "loading") return;
    loadTick.current += 1;
    if (loadTick.current >= LOADING_FRAMES) setScreen("detail");
  });

  return (
    <View class="relative flex-col w-full h-full p-4 gap-3 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-blue-600 tracking-wide">POCKETJS SHOWCASE</Text>
          <Text class="text-2xl text-slate-950 font-bold">Game Library</Text>
        </View>
        <Text class="text-xs text-slate-500">5 TITLES</Text>
      </View>

      {screen === "library" ? (
        <>
          <GridScreen selectedIndex={selectedIndex} onOpen={openGame} />
          <Text class="text-xs text-slate-500">LEFT / RIGHT move focus - CIRCLE open</Text>
        </>
      ) : null}

      {screen === "loading" && selected ? <Loading title={selected.title} /> : null}

      {screen === "detail" && selected ? <Detail game={selected} /> : null}
    </View>
  );
}
