import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";

const INPUTS = [
  [BTN.TRIANGLE, "MENU"],
  [BTN.LEFT, "LEFT"],
  [BTN.CIRCLE, "SELECT"],
  [BTN.RIGHT, "RIGHT"],
  [BTN.START, "PLAY"],
  [BTN.UP, "WHEEL -"],
  [BTN.DOWN, "WHEEL +"],
] as const;

function InputPill(props: {
  label: string;
  mask: number;
  active: (mask: number) => boolean;
}) {
  return (
    <View class={props.active(props.mask)
      ? "h-[24] px-[8] flex-row items-center justify-center rounded-[12] bg-[#22c55e]"
      : "h-[24] px-[8] flex-row items-center justify-center rounded-[12] bg-[#263244]"}>
      <Text class={props.active(props.mask)
        ? "text-xs text-[#052e16] font-bold"
        : "text-xs text-[#a9b8cc] font-bold"}>
        {props.label}
      </Text>
    </View>
  );
}

export default function InputTestPage() {
  const [held, setHeld] = createSignal(0);
  const [flash, setFlash] = createSignal(0);
  const [lastInput, setLastInput] = createSignal("NONE");
  const [eventCount, setEventCount] = createSignal(0);
  let previous = 0;
  let flashFrames = 0;

  onFrame((buttons) => {
    const pressed = buttons & ~previous;
    previous = buttons;
    setHeld(buttons);
    if (pressed !== 0) {
      const names = INPUTS
        .filter(([mask]) => (pressed & mask) !== 0)
        .map(([, label]) => label);
      setLastInput(names.join(" + "));
      setEventCount((value) => value + names.length);
      setFlash(pressed);
      flashFrames = 10;
    } else if (flashFrames > 0) {
      flashFrames -= 1;
      if (flashFrames === 0) setFlash(0);
    }
  });

  const active = (mask: number) => ((held() | flash()) & mask) !== 0;

  return (
    <View class="w-[320] h-[240] flex-col bg-[#101722] p-[14]">
      <Text class="text-lg text-white font-bold">Hardware Input Test</Text>
      <Text class="text-xs text-[#7f95b2]">Green means held or recently pulsed</Text>

      <View class="h-[12]" />
      <View class="flex-row flex-wrap gap-[7]">
        {INPUTS.map(([mask, label]) => (
          <InputPill label={label} mask={mask} active={active} />
        ))}
      </View>

      <View class="flex-1" />
      <View class="h-[52] flex-row items-center justify-between px-[11] rounded-[8] bg-[#182334] border border-[#33445d]">
        <View class="flex-col">
          <Text class="text-xs text-[#7f95b2]">LAST EDGE</Text>
          <Text class="text-base text-[#facc15] font-bold">{lastInput()}</Text>
        </View>
        <View class="items-end">
          <Text class="text-xs text-[#7f95b2]">EVENTS</Text>
          <Text class="text-lg text-white font-bold">{eventCount()}</Text>
        </View>
      </View>
    </View>
  );
}
