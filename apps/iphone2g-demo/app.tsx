import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

export default function IPhone2GDemo() {
  const [tapCount, setTapCount] = createSignal(0);

  return (
    <View
      debugName="IPhone2GScreen"
      class="w-full h-full flex-col justify-between p-5 bg-slate-950"
    >
      <View class="flex-col gap-2">
        <Text class="text-xs tracking-wide text-cyan-300">
          POCKETJS DEVICE LAB
        </Text>
        <Text class="text-3xl font-bold text-white">iPhone 2G</Text>
        <Text class="text-sm text-slate-300">iPhone OS 3.1.3 / 7E18 / 320 x 480</Text>
      </View>

      <View class="flex-col gap-3">
        <Text class="text-sm text-slate-300">
          Touch the button to verify input.
        </Text>
        <View
          debugName="TouchTarget"
          class="h-24 items-center justify-center rounded-xl shadow-md bg-blue-600 border-blue-400 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
          focusable
          onPress={() => setTapCount((count) => count + 1)}
        >
          <Text class="text-xl font-bold text-white">TAP ME</Text>
        </View>
        <Text class="text-lg font-bold text-cyan-300">
          Touch count: {tapCount()}
        </Text>
      </View>

      <Text class="text-xs text-slate-500">Touch-only PocketJS smoke demo</Text>
    </View>
  );
}
