import { Show, createSignal } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { mount } from "@pocketjs/framework/solid";
import ContactsPage from "../../hosts/rockbox/demo/contacts-page.tsx";
import InputTestPage from "../../hosts/rockbox/demo/input-test-page.tsx";

const PAGE_COUNT = 2;

function PocketJSTests() {
  const [page, setPage] = createSignal(0);

  onButtonPress(BTN.LEFT | BTN.RIGHT, (pressed, buttons) => {
    if ((buttons & BTN.CIRCLE) === 0) return;
    if ((pressed & BTN.LEFT) !== 0) {
      setPage((value) => (value + PAGE_COUNT - 1) % PAGE_COUNT);
    } else if ((pressed & BTN.RIGHT) !== 0) {
      setPage((value) => (value + 1) % PAGE_COUNT);
    }
  });

  return (
    <View class="relative w-[320] h-[240] bg-[#10131a] overflow-hidden">
      <Show when={page() === 0}><InputTestPage /></Show>
      <Show when={page() === 1}><ContactsPage /></Show>
    </View>
  );
}

mount(() => <PocketJSTests />);
