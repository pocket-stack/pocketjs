import { useLayoutEffect, useRef, useState } from "octane";
import { Text, View, type NodeMirror } from "@pocketjs/framework/octane/components";
import { animate, spring } from "@pocketjs/framework/octane/animation";

interface Card {
  title: string;
  caption: string;
  detail: string;
  cls: string;
  strip: string;
  bar: string;
}

const CARDS: Card[] = [
  {
    title: "Layout",
    caption: "Flexbox via Taffy",
    detail: "Rows, columns, gaps and insets - solved natively in Rust.",
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

const Detail = (props: { card: Card; key?: string | number }) => {
  const el = useRef<NodeMirror | null>(null);
  useLayoutEffect(() => {
    if (el.current) spring(el.current, "translateY", 0);
  }, []);
  return (
    <View
      nodeRef={el}
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
};

export default function Cards() {
  const [open, setOpen] = useState(-1);
  const streakA = useRef<NodeMirror | null>(null);
  const streakB = useRef<NodeMirror | null>(null);

  useLayoutEffect(() => {
    if (streakA.current) animate(streakA.current, "translateX", 300, { dur: 20000, easing: "linear" });
    if (streakB.current) animate(streakB.current, "translateX", -260, { dur: 26000, easing: "linear" });
  }, []);

  return (
    <View class="relative flex-col w-full h-full p-4 gap-3 bg-slate-50 overflow-hidden">
      <View
        nodeRef={streakA}
        class="absolute left-0 top-[58] w-64 h-1 rounded-full opacity-50 bg-gradient-to-r from-blue-300 to-transparent"
        style={{ translateX: 24 }}
      />
      <View
        nodeRef={streakB}
        class="absolute left-[210] top-[246] w-56 h-1 rounded-full opacity-40 bg-gradient-to-l from-cyan-300 to-transparent"
        style={{ translateX: 0 }}
      />

      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-blue-600 tracking-wide">POCKETJS SHOWCASE</Text>
          <Text class="text-2xl text-slate-950 font-bold">Feature Cards</Text>
        </View>
        <Text class="text-xs text-slate-500">3 MODULES</Text>
      </View>

      <View class="flex-row gap-3">
        {CARDS.map((card, i) => (
          <View
            key={card.title}
            class={card.cls}
            focusable
            onPress={() => {
              setOpen(open === i ? -1 : i);
            }}
          >
            <View class={card.strip} />
            <Text class="text-sm text-slate-950 font-bold">{card.title}</Text>
            <Text class="text-xs text-slate-600">{card.caption}</Text>
          </View>
        ))}
      </View>

      <View class="grow flex-col">{open >= 0 ? <Detail key={open} card={CARDS[open]} /> : null}</View>

      <Text class="text-xs text-slate-500">LEFT / RIGHT move focus - CIRCLE toggle details</Text>
    </View>
  );
}
