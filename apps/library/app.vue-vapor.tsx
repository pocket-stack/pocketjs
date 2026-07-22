import { computed, onMounted, ref } from "vue";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/vue-vapor/components";
import { spring } from "@pocketjs/framework/vue-vapor/animation";
import { onButtonPress, onFrame } from "@pocketjs/framework/vue-vapor/lifecycle";
import { BTN, focusNode } from "@pocketjs/framework/vue-vapor/input";

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
    blurb: ["Vue Vapor or Solid over a no_std Rust core.", "One JSX app - PSP hardware, PPSSPP or a browser."],
    tileCls:
      "w-14 h-14 rounded-xl shadow-md items-center justify-center translate-y-2 focus:translate-y-0 focus:scale-110 transition-all duration-150 ease-out bg-white border-slate-300 focus:border-slate-900",
    about: true,
  },
];

const LOADING_FRAMES = 48;
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

const GridScreen = (props: { selectedIndex: number; onOpen: (game: Game, index: number) => void }) => {
  const refs: (NodeMirror | undefined)[] = [];
  onMounted(() => {
    const i = props.selectedIndex;
    if (i >= 0) focusNode(refs[i] ?? null);
  });
  return (
    <View class="flex-row gap-4 justify-center items-center grow">
      {GAMES.map((game, i) => (
        <View class="flex-col items-center gap-2">
          <View
            nodeRef={(node: NodeMirror | null) => {
              refs[i] = node ?? undefined;
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

const Loading = (props: { title: string; frame: number }) => {
  const src = computed(() => {
    const i = Math.floor(props.frame / SPINNER_FRAME_STEP) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[i];
  });
  return (
    <View class="flex-col items-center justify-center gap-3 grow">
      <Image class="w-10 h-10" src={src.value} />
      <Text class="text-sm text-slate-600 tracking-wide">LOADING {props.title}...</Text>
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
  let panel: NodeMirror | undefined;
  onMounted(() => {
    if (panel) spring(panel, "translateY", 0);
  });
  return (
    <View
      nodeRef={(node: NodeMirror | null) => {
        panel = node ?? undefined;
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
          <Text class="text-sm text-slate-600">{line}</Text>
        ))}
      </View>
      <Text class="text-xs text-slate-500">TRIANGLE back to library</Text>
    </View>
  );
};

export default function Library() {
  const screen = ref<Screen>("library");
  const selected = ref<Game | null>(null);
  const selectedIndex = ref(-1);
  const loadFrame = ref(0);

  const openGame = (game: Game, index: number) => {
    selected.value = game;
    selectedIndex.value = index;
    if (game.about) {
      screen.value = "detail";
    } else {
      loadFrame.value = 0;
      screen.value = "loading";
    }
  };

  onButtonPress(BTN.TRIANGLE, () => {
    if (screen.value === "detail") screen.value = "library";
  });
  onFrame(() => {
    if (screen.value !== "loading") return;
    const n = loadFrame.value + 1;
    loadFrame.value = n;
    if (n >= LOADING_FRAMES) screen.value = "detail";
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

      {screen.value === "library" ? (
        <>
          <GridScreen selectedIndex={selectedIndex.value} onOpen={openGame} />
          <Text class="text-xs text-slate-500">LEFT / RIGHT move focus - CIRCLE open</Text>
        </>
      ) : null}

      {screen.value === "loading" && selected.value ? <Loading title={selected.value.title} frame={loadFrame.value} /> : null}

      {screen.value === "detail" && selected.value ? <Detail game={selected.value} /> : null}
    </View>
  );
}
