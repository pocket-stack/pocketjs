import { useLayoutEffect, useRef, useState } from "octane";
import { Text, View, type NodeMirror } from "@pocketjs/framework/octane/components";
import { animate } from "@pocketjs/framework/octane/animation";
import { useFrame } from "@pocketjs/framework/octane/lifecycle";

interface Notice {
  id: string;
  title: string;
  message: string;
  time: string;
  dotCls: string;
}

const INITIAL: Notice[] = [
  { id: "update", title: "UPDATE AVAILABLE", message: "Firmware 6.61 is ready to install.", time: "2m ago", dotCls: "w-2 h-2 rounded-full bg-sky-500" },
  { id: "friend", title: "FRIEND REQUEST", message: "RIDGE_FOX wants to join your session.", time: "14m ago", dotCls: "w-2 h-2 rounded-full bg-emerald-500" },
  { id: "battery", title: "LOW BATTERY", message: "12% remaining - plug in soon.", time: "35m ago", dotCls: "w-2 h-2 rounded-full bg-amber-500" },
  { id: "trophy", title: "TROPHY UNLOCKED", message: '"First Contact" - Iron Vanguard.', time: "1h ago", dotCls: "w-2 h-2 rounded-full bg-blue-500" },
];

const DISMISS_FRAMES = 16;
const ROW_RISE_PX = 42;
const ROW_RISE_FRAMES = 16;

interface NoticeRowProps {
  key?: string;
  item: Notice;
  index: number;
  rise: number;
  onRowRef: (id: string, row: NodeMirror) => void;
  onDismiss: (id: string, el: NodeMirror | undefined) => void;
}

function NoticeRow(props: NoticeRowProps) {
  const el = useRef<NodeMirror | null>(null);

  useLayoutEffect(() => {
    const card = el.current;
    if (card) {
      animate(card, "opacity", 1, { dur: 250, delay: props.index * 70, easing: "out" });
      animate(card, "translateX", 0, { dur: 250, delay: props.index * 70, easing: "out" });
    }
  }, []);

  return (
    <View
      nodeRef={(row: NodeMirror | null) => {
        if (row) props.onRowRef(props.item.id, row);
      }}
      class="flex-col"
      style={{ translateY: props.rise }}
    >
      <View
        nodeRef={el}
        style={{ opacity: 0, translateX: 16 }}
        class="flex-row items-center gap-3 p-1 rounded-lg shadow bg-white border-slate-200 focus:bg-blue-50 focus:border-blue-500 transition-colors duration-150"
        focusable
        onPress={() => props.onDismiss(props.item.id, el.current ?? undefined)}
      >
        <View class={props.item.dotCls} />
        <View class="flex-col grow">
          <Text class="text-xs text-slate-950 font-bold">{props.item.title}</Text>
          <Text class="text-xs text-slate-600">{props.item.message}</Text>
        </View>
        <Text class="text-xs text-slate-500">{props.item.time}</Text>
      </View>
    </View>
  );
}

export default function Notifications() {
  const [items, setItems] = useState<Notice[]>([...INITIAL]);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [riseOffsets, setRiseOffsets] = useState<Record<string, number>>({});
  const rowRefs = useRef(new Map<string, NodeMirror>());
  // Phase timers live in refs: the motion itself is native animate() tweens,
  // so JS only needs to know when a phase ENDS. Counting in state would
  // replay the whole root every frame of every dismissal on the PSP.
  const riseQueued = useRef<string[]>([]);
  const riseTick = useRef(0);
  const dismissTick = useRef(0);

  const hasRise = () => Object.keys(riseOffsets).length > 0 || riseQueued.current.length > 0;

  useFrame(() => {
    if (riseQueued.current.length > 0) {
      for (const id of riseQueued.current) {
        const row = rowRefs.current.get(id);
        if (row) animate(row, "translateY", 0, { dur: 180, easing: "out" });
      }
      riseQueued.current = [];
      riseTick.current = 0;
    } else if (Object.keys(riseOffsets).length > 0) {
      riseTick.current += 1;
      if (riseTick.current >= ROW_RISE_FRAMES) {
        setRiseOffsets({});
        riseTick.current = 0;
      }
    }

    const id = dismissingId;
    if (id === null) return;
    dismissTick.current += 1;
    if (dismissTick.current >= DISMISS_FRAMES) {
      const before = items;
      const removedIndex = before.findIndex((it) => it.id === id);
      const rising = removedIndex < 0 ? [] : before.slice(removedIndex + 1).map((it) => it.id);
      if (rising.length > 0) {
        setRiseOffsets(Object.fromEntries(rising.map((rid) => [rid, ROW_RISE_PX])));
        riseQueued.current = rising;
      }
      rowRefs.current.delete(id);
      setItems(before.filter((it) => it.id !== id));
      setDismissingId(null);
      dismissTick.current = 0;
    }
  });

  const dismiss = (id: string, el: NodeMirror | undefined) => {
    if (dismissingId !== null || hasRise() || !el) return;
    setDismissingId(id);
    dismissTick.current = 0;
    animate(el, "opacity", 0, { dur: 200, easing: "out" });
    animate(el, "translateX", 24, { dur: 200, easing: "out" });
  };

  return (
    <View class="flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-blue-600 tracking-wide">POCKETJS SHOWCASE</Text>
          <Text class="text-2xl text-slate-950 font-bold">Notifications</Text>
        </View>
        <Text class="text-xs text-slate-500">{`${items.length} UNREAD`}</Text>
      </View>

      <View class="flex-col gap-1">
        {items.map((item, i) => (
          <NoticeRow
            key={item.id}
            item={item}
            index={i}
            rise={riseOffsets[item.id] ?? 0}
            onRowRef={(id: string, row: NodeMirror) => {
              rowRefs.current.set(id, row);
            }}
            onDismiss={dismiss}
          />
        ))}
      </View>

      {items.length === 0 ? (
        <View class="grow flex-col items-center justify-center rounded-xl shadow bg-white border-slate-200">
          <Text class="text-sm text-slate-500">ALL CLEAR</Text>
        </View>
      ) : null}

      <Text class="text-xs text-slate-500">UP / DOWN move focus - CIRCLE dismiss</Text>
    </View>
  );
}
