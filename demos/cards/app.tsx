// demos/cards/app.tsx — "card carousel" showcase: three feature cards in a row,
// LEFT/RIGHT d-pad moves focus (native focus: variants lift + brighten the
// focused card — zero JS on focus change), CIRCLE flips a <Show> detail panel
// that springs up into place without color fades. Two slow
// gradient streaks drift behind everything (long native tweens started once
// on mount — deterministic fixed-dt, no per-frame JS).
//
// Design notes: rounded/shadowed surfaces are emitted by the core itself,
// focus emphasis = translate-y lift + bg/border color (never scale — glyphs
// don't scale), all text single-line, every class a FULL literal.

import { Show, Text, View, type NodeMirror } from "psp-ui/components";
import { animate, spring } from "psp-ui/animation";
import { createSignal, onMount } from "psp-ui/reactivity";

interface Card {
  title: string;
  caption: string;
  detail: string;
  /** card body class (base + focus variants, per-accent border). */
  cls: string;
  /** gradient accent strip on the card. */
  strip: string;
  /** vertical accent bar in the detail panel. */
  bar: string;
}

const CARDS: Card[] = [
  {
    title: "Layout",
    caption: "Flexbox via Taffy",
    detail: "Rows, columns, gaps and insets — solved natively in Rust.",
    cls: "flex-col gap-1 p-3 w-[136] rounded-xl shadow-md overflow-hidden bg-white border-slate-200 translate-y-1 focus:bg-blue-50 focus:border-blue-500 focus:translate-y-0 transition-all duration-150 ease-out",
    strip: "h-1 w-full rounded-sm bg-gradient-to-r from-blue-500 to-blue-600",
    bar: "w-1 h-7 bg-blue-500",
  },
  {
    title: "Motion",
    caption: "Springs and tweens",
    detail: "Fixed-dt springs and tweens tick natively at 60 FPS.",
    cls: "flex-col gap-1 p-3 w-[136] rounded-xl shadow-md overflow-hidden bg-white border-slate-200 translate-y-1 focus:bg-emerald-50 focus:border-emerald-500 focus:translate-y-0 transition-all duration-150 ease-out",
    strip: "h-1 w-full rounded-sm bg-gradient-to-r from-emerald-500 to-emerald-600",
    bar: "w-1 h-7 bg-emerald-500",
  },
  {
    title: "Input",
    caption: "D-pad and focus",
    detail: "Native focus variants respond before JS even wakes up.",
    cls: "flex-col gap-1 p-3 w-[136] rounded-xl shadow-md overflow-hidden bg-white border-slate-200 translate-y-1 focus:bg-amber-50 focus:border-amber-500 focus:translate-y-0 transition-all duration-150 ease-out",
    strip: "h-1 w-full rounded-sm bg-gradient-to-r from-amber-500 to-amber-600",
    bar: "w-1 h-7 bg-amber-500",
  },
];

/** Detail panel — remounts (keyed <Show>) per card, so the translate-y spring
 *  replays on every open; colors are static on the first visible frame. */
function Detail(props: { card: Card }) {
  let el: NodeMirror | undefined;
  onMount(() => {
    if (el) spring(el, "translateY", 0);
  });
  return (
    <View
      ref={el}
      style={{ translateY: 22 }}
      class="flex-row items-center gap-3 p-3 rounded-xl shadow-md bg-white border-slate-200"
    >
      <View class={props.card.bar} />
      <View class="flex-col gap-1">
        <Text class="text-sm text-slate-950 font-bold">{props.card.title}</Text>
        <Text class="text-xs text-slate-600">{props.card.detail}</Text>
      </View>
    </View>
  );
}

export default function Cards() {
  const [open, setOpen] = createSignal(-1);
  const selected = () => (open() >= 0 ? CARDS[open()] : undefined);

  let streakA: NodeMirror | undefined;
  let streakB: NodeMirror | undefined;
  onMount(() => {
    // Slow ambient drift: one long linear tween each, declared once — the
    // Rust core owns the motion from here (zero steady-state JS).
    if (streakA) animate(streakA, "translateX", 300, { dur: 20000, easing: "linear" });
    if (streakB) animate(streakB, "translateX", -260, { dur: 26000, easing: "linear" });
  });

  return (
    <View class="relative flex-col w-full h-full p-4 gap-3 bg-slate-50 overflow-hidden">
      <View
        ref={streakA}
        class="absolute left-0 top-[58] w-64 h-1 rounded-full opacity-50 bg-gradient-to-r from-blue-300 to-transparent"
        style={{ translateX: 24 }}
      />
      <View
        ref={streakB}
        class="absolute left-[210] top-[246] w-56 h-1 rounded-full opacity-40 bg-gradient-to-l from-cyan-300 to-transparent"
        style={{ translateX: 0 }}
      />

      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-blue-600 tracking-wide">PSP-UI SHOWCASE</Text>
          <Text class="text-2xl text-slate-950 font-bold">Feature Cards</Text>
        </View>
        <Text class="text-xs text-slate-500">3 MODULES</Text>
      </View>

      <View class="flex-row gap-3">
        {CARDS.map((card, i) => (
          <View
            class={card.cls}
            focusable
            onPress={() => setOpen(open() === i ? -1 : i)}
          >
            <View class={card.strip} />
            <Text class="text-sm text-slate-950 font-bold">{card.title}</Text>
            <Text class="text-xs text-slate-600">{card.caption}</Text>
          </View>
        ))}
      </View>

      <View class="grow flex-col">
        <Show when={selected()} keyed>
          {(card) => <Detail card={card} />}
        </Show>
      </View>

      <Text class="text-xs text-slate-500">LEFT / RIGHT move focus · CIRCLE toggle details</Text>
    </View>
  );
}
