import { computed, ref } from "vue";
import { Button, onButton } from "../../host/input.ts";
import { SCREEN } from "../../host/screen.ts";

export default () => {
  const x = ref(0);
  const y = ref(0);
  const value = ref(0);
  const position = computed(() => x.value + y.value);

  onButton((button) => {
    if (button === Button.A) value.value = value.value + 1;
    else if (button === Button.B) value.value = value.value - 1;
    else if (button === Button.Right) x.value = x.value + 1;
    else if (button === Button.Left) x.value = x.value - 1;
    else if (button === Button.Up) y.value = y.value - 1;
    else if (button === Button.Down) y.value = y.value + 1;
  });

  return (
    <>
      <row y={0} class="bg-white text-black align-center">
        {SCREEN.width === 50 ? "POCKET VAPOR PLAYDATE" : "POCKET VAPOR SIX BUTTON"}
      </row>
      <row y={2}>{"DPAD X "}{x.value}{" Y "}{y.value}</row>
      <row y={3} class="bg-black text-white">{"A/B VALUE "}{value.value}</row>
      <row y={4}>{"X+Y "}{position.value}</row>
      <row y={5}>{"A +1   B -1"}</row>
      <row y={6}>{"DPAD MOVES X/Y"}</row>
    </>
  );
};
