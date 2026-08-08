// apps/3ds-demo/app.tsx — the 400x240 top-screen demo for the 3ds-dev host.
//
// Everything on this screen is a check the host must pass, placed so a wrong
// answer is visible in one look at the captured frame:
//
//   - four corner brackets and four edge ticks pinned with absolute insets:
//     they touch all four edges, and the ticks straddle (200, 120), only when
//     the host runs the app at 400x240 with rasterDensity 1. A 480x272
//     viewport pushes the right and bottom brackets off the panel; a
//     transposed target moves the ticks off the edge midpoints.
//   - orient-key.svg, a 64x64 texture drawn 1:1 — four flat quadrants (so an
//     8x8 tile ordering bug scrambles visibly), a white diagonal (destroyed by
//     any transpose), a 2px white ring (edge/UV clamp), and a dark notch in
//     the RED quadrant marking the top-left corner (a vertical flip moves it
//     into the blue quadrant).
//   - text at five sizes (12/14/16/18/24 px, regular and bold), so a font-atlas
//     or baseline bug shows up on more than one glyph run.
//   - three focusable tiles in a row and a RESET button on the row above:
//     LEFT/RIGHT and UP/DOWN both have somewhere to go, and focus emphasis is
//     a native focus: variant (no JS runs on a focus change).
//   - the circle pad, decoded to -1..1 by the framework's deadzone, drives a
//     dot inside a 72px well and prints the host's raw packed sample.
//
// The root paints the whole panel slate-950, so a host that skips the clear or
// mis-sizes the first quad leaves uncleared VRAM showing around the fill.

import { createSignal } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { analogRaw, analogX, analogY, onFrame } from "@pocketjs/framework/lifecycle";

/** Pad-well geometry: the dot travels +/- this many px from the well center. */
const PAD_TRAVEL = 26;

interface Tile {
  label: string;
  /** tile body class (base + focus variants, per-accent border). */
  cls: string;
  /** the counter's accent, applied to the value line. */
  value: string;
}

const TILES: Tile[] = [
  {
    label: "LAYOUT",
    cls: "flex-col items-start gap-1 w-[120] p-2 rounded-lg border border-slate-700 bg-slate-900 translate-y-[2] focus:bg-slate-800 focus:border-red-400 focus:translate-y-[0] transition-all duration-150 ease-out",
    value: "text-lg text-red-400 font-bold",
  },
  {
    label: "TEXTURE",
    cls: "flex-col items-start gap-1 w-[120] p-2 rounded-lg border border-slate-700 bg-slate-900 translate-y-[2] focus:bg-slate-800 focus:border-emerald-400 focus:translate-y-[0] transition-all duration-150 ease-out",
    value: "text-lg text-emerald-400 font-bold",
  },
  {
    label: "INPUT",
    cls: "flex-col items-start gap-1 w-[120] p-2 rounded-lg border border-slate-700 bg-slate-900 translate-y-[2] focus:bg-slate-800 focus:border-amber-400 focus:translate-y-[0] transition-all duration-150 ease-out",
    value: "text-lg text-amber-400 font-bold",
  },
];

export default function ThreeDsDemo() {
  const [counts, setCounts] = createSignal([0, 0, 0]);
  const [padX, setPadX] = createSignal(0);
  const [padY, setPadY] = createSignal(0);
  const [padRaw, setPadRaw] = createSignal(analogRaw());
  // Signals hold === equality, so a resting stick sets nothing and the tree
  // stays untouched for the whole run.
  onFrame(() => {
    setPadX(analogX());
    setPadY(analogY());
    setPadRaw(analogRaw());
  });
  const total = () => counts().reduce((sum, n) => sum + n, 0);
  const bump = (i: number) =>
    setCounts((prev) => prev.map((n, j) => (j === i ? n + 1 : n)));
  const padLabel = () => `0x${padRaw().toString(16).padStart(4, "0")}`;

  return (
    <View debugName="ThreeDsScreen" class="relative flex-col w-full h-full bg-slate-950 overflow-hidden">
      {/* Edge ticks straddling the middle of each edge: (200, 120). */}
      <View class="absolute left-[196] top-0 w-[8] h-[3] bg-slate-500" />
      <View class="absolute left-[196] bottom-0 w-[8] h-[3] bg-slate-500" />
      <View class="absolute left-0 top-[116] w-[3] h-[8] bg-slate-500" />
      <View class="absolute right-0 top-[116] w-[3] h-[8] bg-slate-500" />

      {/* Corner brackets, one color each, drawn from the screen edge. */}
      <View class="absolute left-0 top-0 w-[18] h-[3] bg-red-500" />
      <View class="absolute left-0 top-0 w-[3] h-[18] bg-red-500" />
      <View class="absolute right-0 top-0 w-[18] h-[3] bg-emerald-500" />
      <View class="absolute right-0 top-0 w-[3] h-[18] bg-emerald-500" />
      <View class="absolute left-0 bottom-0 w-[18] h-[3] bg-blue-500" />
      <View class="absolute left-0 bottom-0 w-[3] h-[18] bg-blue-500" />
      <View class="absolute right-0 bottom-0 w-[18] h-[3] bg-amber-500" />
      <View class="absolute right-0 bottom-0 w-[3] h-[18] bg-amber-500" />

      <View debugName="Content" class="flex-col w-full h-full p-3 gap-2">
        <View debugName="Header" class="flex-row items-center justify-between">
          <View class="flex-row items-center gap-2">
            <Image class="w-8 h-8 rounded-lg" src="logo.png" />
            <View class="flex-col">
              <Text class="text-base text-slate-50 font-bold tracking-wide">PocketJS on 3DS</Text>
              <Text class="text-xs text-slate-400 tracking-wide">TOP SCREEN · PICA200</Text>
            </View>
          </View>
          <View class="px-2 py-1 rounded-md border border-slate-600 bg-slate-900">
            <Text class="text-sm text-emerald-400 font-bold">400 × 240</Text>
          </View>
        </View>

        <View debugName="Middle" class="flex-row items-start gap-3">
          <Image debugName="OrientKey" class="w-16 h-16" src="orient-key.svg" />

          <View debugName="Score" class="flex-col items-start grow gap-1">
            <Text class="text-xs text-slate-500 tracking-wide">PRESSES</Text>
            <Text class="text-2xl text-slate-50 font-bold">{total()}</Text>
            <View
              class="px-2 py-1 rounded-md border border-slate-700 bg-slate-900 focus:bg-cyan-900 focus:border-cyan-400 transition-colors duration-150"
              focusable
              onPress={() => setCounts([0, 0, 0])}
            >
              <Text class="text-sm text-cyan-300 font-bold">RESET</Text>
            </View>
          </View>

          <View debugName="Pad" class="flex-col items-center gap-1">
            <View class="relative w-[72] h-[72] rounded-lg border border-slate-700 bg-slate-900">
              <View class="absolute left-[33] top-[33] w-[6] h-[6] rounded-full bg-slate-700" />
              <View
                class="absolute left-[31] top-[31] w-[10] h-[10] rounded-full bg-cyan-400"
                style={{
                  translateX: Math.round(padX() * PAD_TRAVEL),
                  translateY: Math.round(padY() * PAD_TRAVEL),
                }}
              />
            </View>
            <Text class="text-xs text-slate-400 tracking-wide">PAD {padLabel()}</Text>
          </View>
        </View>

        <View debugName="TileRow" class="flex-row gap-2">
          {TILES.map((tile, i) => (
            <View class={tile.cls} focusable onPress={() => bump(i)}>
              <Text class="text-xs text-slate-400 tracking-wide">{tile.label}</Text>
              <Text class={tile.value}>{counts()[i]}</Text>
            </View>
          ))}
        </View>

        <Text class="text-xs text-slate-500 tracking-wide">
          D-PAD FOCUS · A CONFIRMS · CIRCLE PAD MOVES THE DOT
        </Text>
      </View>
    </View>
  );
}
