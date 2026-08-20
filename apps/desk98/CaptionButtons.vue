<script setup lang="ts">
// Caption controls, flush right and flush against each other (wm.ts
// captionButtonXs mirrors this row). Press feedback inverts the bevel and
// nudges the glyph one px — app.vue owns the hit testing and drives
// win.pressedBtn off the raw pointer stream.
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import type { CaptionButton } from "./wm.ts";
import type { WinCtl } from "./state.ts";

const props = defineProps<{ win: WinCtl }>();

const BTN_ICON: Record<CaptionButton, string> = {
  min: "icons/cap-min.svg",
  max: "icons/cap-max.svg",
  close: "icons/cap-close.svg",
};

const srcFor = (btn: CaptionButton): string =>
  btn === "max" && props.win.maximized.value ? "icons/cap-restore.svg" : BTN_ICON[btn];
</script>

<template>
  <View class="flex-row items-center">
    <View
      v-for="btn in props.win.buttons"
      :key="btn"
      :class="
        props.win.pressedBtn.value === btn
          ? 'w-[16] h-[14] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#000000,#ffffff,#808080,#dfdfdf]'
          : 'w-[16] h-[14] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]'
      "
    >
      <Image
        :class="props.win.pressedBtn.value === btn ? 'w-[8] h-[8] ml-[1] mt-[1]' : 'w-[8] h-[8]'"
        :src="srcFor(btn)"
      />
    </View>
  </View>
</template>
