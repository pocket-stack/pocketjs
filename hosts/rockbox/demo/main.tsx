import { Show, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import ContactsPage from "./contacts-page.tsx";
import InputTestPage from "./input-test-page.tsx";
import StandardPage from "./standard-page.tsx";

const PAGE_COUNT = 3;

function RockboxDemo() {
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
      <Show when={page() === 0}>
        <StandardPage />
      </Show>
      <Show when={page() === 1}>
        <InputTestPage />
      </Show>
      <Show when={page() === 2}>
        <ContactsPage />
      </Show>

    </View>
  );
}

mount(() => <RockboxDemo />);
