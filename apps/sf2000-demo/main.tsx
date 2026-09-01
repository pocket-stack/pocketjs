import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";

function App() {
  const [count, setCount] = createSignal(0);
  return (
    <View class="w-full h-full flex-col items-center justify-center gap-4 bg-slate-950">
      <Text class="text-xl font-bold text-white">PocketJS on SF2000</Text>
      <Text class="text-base text-slate-300">UniFrog 0.6.3</Text>
      <View
        class="px-4 py-2 rounded-xl bg-emerald-600 focus:bg-emerald-500"
        focusable
        onPress={() => setCount((value) => value + 1)}
      >
        <Text class="text-base font-bold text-white">Confirm: {count()}</Text>
      </View>
    </View>
  );
}

mount(() => <App />);
