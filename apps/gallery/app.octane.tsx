import { useEffect, useRef, useState } from "octane";
import {
  ActionBar,
  FocusScope,
  Gallery,
  Grid,
  Lazy,
  Screen,
  Sprite,
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/octane/components";
import { useButtonPress } from "@pocketjs/framework/octane/lifecycle";
import { BTN, focusNode } from "@pocketjs/framework/octane/input";
import { GALLERY_PAGES, TILES_PER_PAGE, TILE_SRCS } from "./tiles.ts";

const REVEAL_FRAMES = 16;
const PAGE_TITLE = ["SYNTHWAVE", "GOLDEN HOUR", "EVERGREEN", "NEBULA"];
const PAGE_SUB = ["neon coast drive", "warm analog haze", "deep forest floor", "far outer dark"];
const PAGE_COUNT_LABEL = ["01 / 04", "02 / 04", "03 / 04", "04 / 04"];
const PAGE_BG = [
  "relative flex-col w-full h-full items-center bg-gradient-to-b from-blue-900 to-slate-950",
  "relative flex-col w-full h-full items-center bg-gradient-to-b from-orange-900 to-slate-950",
  "relative flex-col w-full h-full items-center bg-gradient-to-b from-emerald-900 to-slate-950",
  "relative flex-col w-full h-full items-center bg-gradient-to-b from-violet-900 to-slate-950",
];

const TILE_LABEL = [
  "OUTRUN", "NEON", "MIRAGE", "PULSE", "CHROME", "MIDNIGHT",
  "EMBER", "DUSK", "AMBER", "SANDS", "COPPER", "FLARE",
  "FERN", "MOSS", "PINE", "JADE", "TIDE", "GROVE",
  "QUASAR", "COMET", "ORBIT", "VIOLET", "NOVA", "DRIFT",
];

const TILE_FRAME =
  "w-[68] h-[68] rounded-lg items-center justify-center bg-slate-900 border-slate-700 focus:scale-110 focus:border-white transition-transform duration-150 ease-out";

function Loading(props: { title: string }) {
  // Native sprite channel: zero per-frame JS (a state tick would replay the
  // whole root for every spinner frame on the PSP).
  return (
    <View class="flex-col items-center justify-center gap-2 grow">
      <Sprite class="w-9 h-9" sprite="spinner-atlas.svg" />
      <Text class="text-xs text-slate-300 tracking-wide">{`LOADING ${props.title}`}</Text>
    </View>
  );
}

function TileGrid(props: {
  page: number;
  current: number;
  onSelect: (label: string) => void;
}) {
  const start = props.page * TILES_PER_PAGE;
  const srcs = TILE_SRCS.slice(start, start + TILES_PER_PAGE);
  const refs = useRef<(NodeMirror | undefined)[]>([]);

  useEffect(() => {
    if (props.current === props.page) focusNode(refs.current[0] ?? null);
  }, [props.current, props.page]);

  return (
    <Grid active columns={3} gap={8} class="flex-row flex-wrap items-start justify-center w-[264]">
      {srcs.map((src, k) => (
        <View key={src} class="flex-col items-center gap-1 w-[78]">
          <View
            nodeRef={(node: NodeMirror | null) => {
              refs.current[k] = node ?? undefined;
            }}
            class={TILE_FRAME}
            focusable
            onPress={() => props.onSelect(TILE_LABEL[start + k])}
          >
            <Sprite class="w-[64] h-[64] rounded-lg" sprite={src} />
          </View>
          <Text class="text-xs text-slate-200 font-bold">{TILE_LABEL[start + k]}</Text>
        </View>
      ))}
    </Grid>
  );
}

function Page(props: {
  index: number;
  current: number;
  onSelect: (label: string) => void;
}) {
  const isCurrent = props.current === props.index;
  return (
    <View class={PAGE_BG[props.index]}>
      <View class="w-full flex-row items-end justify-between px-4 pt-2 pb-1">
        <View class="flex-col">
          <Text class="text-xs text-slate-300 tracking-wide">{PAGE_SUB[props.index]}</Text>
          <Text class="text-xl text-white font-bold">{PAGE_TITLE[props.index]}</Text>
        </View>
        <Text class="text-xs text-slate-300">{PAGE_COUNT_LABEL[props.index]}</Text>
      </View>
      <FocusScope active={isCurrent} restoreFocus={false} class="grow w-full flex-col items-center justify-center">
        <Lazy when={true} reveal={REVEAL_FRAMES} fallback={() => <Loading title={PAGE_TITLE[props.index]} />}>
          <TileGrid page={props.index} current={props.current} onSelect={props.onSelect} />
        </Lazy>
      </FocusScope>
      <View class="w-full h-9 shrink-0" />
    </View>
  );
}

export default function GalleryDemo() {
  const [page, setPage] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);

  useButtonPress(BTN.RTRIGGER, () => {
    (globalThis as any).__dbgR = ((globalThis as any).__dbgR ?? 0) + 1;
  });
  useButtonPress(BTN.LTRIGGER, () => {
    (globalThis as any).__dbgL = ((globalThis as any).__dbgL ?? 0) + 1;
  });

  return (
    <Screen class="relative w-full h-full bg-slate-950 overflow-hidden">
      <Gallery
        count={GALLERY_PAGES}
        page={page}
        onPageChange={(next) => {
          (globalThis as any).__dbgPC = ((globalThis as any).__dbgPC ?? []).concat(next);
          setPage(next);
          setViewing(null);
        }}
        duration={300}
        easing="out"
        renderPage={(i) => <Page index={i} current={page} onSelect={(label: string) => setViewing(label)} />}
      />

      <ActionBar class="absolute left-3 right-3 bottom-2 flex-row items-center justify-between px-3 py-1 rounded-lg shadow-md bg-slate-900 border-slate-700">
        <View class="flex-row items-center gap-2">
          {Array.from({ length: GALLERY_PAGES }).map((_, i) => (
            <View key={i} class={page === i ? "w-4 h-1 rounded-full bg-white" : "w-1 h-1 rounded-full bg-slate-600"} />
          ))}
        </View>
        <Text class="text-xs text-slate-400">
          {viewing ? "VIEWING  " + viewing : "L / R  FLIP    D-PAD  MOVE    CIRCLE  VIEW"}
        </Text>
      </ActionBar>
    </Screen>
  );
}
