import { ref } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/vue-vapor/components";
import { animate } from "@pocketjs/framework/vue-vapor/animation";
import { onFrame } from "@pocketjs/framework/vue-vapor/lifecycle";

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

export default function Notifications() {
  const items = ref<Notice[]>([...INITIAL]);
  const dismissingId = ref<string | null>(null);
  const dismissFrame = ref(0);
  const riseOffsets = ref<Record<string, number>>({});
  const riseQueued = ref<string[]>([]);
  const riseFrame = ref(0);
  const rowRefs = new Map<string, NodeMirror>();

  const hasRise = () => Object.keys(riseOffsets.value).length > 0 || riseQueued.value.length > 0;

  onFrame(() => {
    if (riseQueued.value.length > 0) {
      for (const id of riseQueued.value) {
        const row = rowRefs.get(id);
        if (row) animate(row, "translateY", 0, { dur: 180, easing: "out" });
      }
      riseQueued.value = [];
      riseFrame.value = 0;
    } else if (Object.keys(riseOffsets.value).length > 0) {
      const n = riseFrame.value + 1;
      riseFrame.value = n;
      if (n >= ROW_RISE_FRAMES) {
        riseOffsets.value = {};
        riseFrame.value = 0;
      }
    }

    const id = dismissingId.value;
    if (id === null) return;
    const n = dismissFrame.value + 1;
    dismissFrame.value = n;
    if (n >= DISMISS_FRAMES) {
      const before = items.value;
      const removedIndex = before.findIndex((it) => it.id === id);
      const rising = removedIndex < 0 ? [] : before.slice(removedIndex + 1).map((it) => it.id);
      if (rising.length > 0) {
        riseOffsets.value = Object.fromEntries(rising.map((rid) => [rid, ROW_RISE_PX]));
        riseQueued.value = rising;
      }
      rowRefs.delete(id);
      items.value = before.filter((it) => it.id !== id);
      dismissingId.value = null;
      dismissFrame.value = 0;
    }
  });

  const dismiss = (id: string, el: NodeMirror | undefined) => {
    if (dismissingId.value !== null || hasRise() || !el) return;
    dismissingId.value = id;
    dismissFrame.value = 0;
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
        <Text class="text-xs text-slate-500">{items.value.length} UNREAD</Text>
      </View>

      <View class="flex-col gap-1">
        {items.value.map((item, i) => {
          let el: NodeMirror | undefined;
          return (
            <View
              nodeRef={(row: NodeMirror | null) => {
                if (row) rowRefs.set(item.id, row);
              }}
              class="flex-col"
              style={{ translateY: riseOffsets.value[item.id] ?? 0 }}
            >
              <View
                nodeRef={(node: NodeMirror | null) => {
                  el = node ?? undefined;
                  if (el) {
                    animate(el, "opacity", 1, { dur: 250, delay: i * 70, easing: "out" });
                    animate(el, "translateX", 0, { dur: 250, delay: i * 70, easing: "out" });
                  }
                }}
                style={{ opacity: 0, translateX: 16 }}
                class="flex-row items-center gap-3 p-1 rounded-lg shadow bg-white border-slate-200 focus:bg-blue-50 focus:border-blue-500 transition-colors duration-150"
                focusable
                onPress={() => dismiss(item.id, el)}
              >
                <View class={item.dotCls} />
                <View class="flex-col grow">
                  <Text class="text-xs text-slate-950 font-bold">{item.title}</Text>
                  <Text class="text-xs text-slate-600">{item.message}</Text>
                </View>
                <Text class="text-xs text-slate-500">{item.time}</Text>
              </View>
            </View>
          );
        })}
      </View>

      {items.value.length === 0 ? (
        <View class="grow flex-col items-center justify-center rounded-xl shadow bg-white border-slate-200">
          <Text class="text-sm text-slate-500">ALL CLEAR</Text>
        </View>
      ) : null}

      <Text class="text-xs text-slate-500">UP / DOWN move focus - CIRCLE dismiss</Text>
    </View>
  );
}
