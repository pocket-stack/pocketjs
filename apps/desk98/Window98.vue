<script setup lang="ts">
// One window: raised frame, caption gradient, controls, menu bar, content
// slot. Position/size ride the style prop — translate moves are paint-only,
// and zIndex raises without reordering siblings (a reorder would rebuild the
// whole layout tree). Nothing here registers a handler; app.vue hit-tests
// the raw pointer stream against wm.ts geometry.
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import { CAPTION_ACTIVE, CAPTION_INACTIVE } from "./theme.ts";
import type { WinCtl } from "./state.ts";
import T98 from "./T98.vue";
import CaptionButtons from "./CaptionButtons.vue";

const props = defineProps<{ win: WinCtl; active: boolean }>();
</script>

<template>
  <View
    class="absolute flex-col bg-[#c0c0c0] p-[3] bevel-[#dfdfdf,#000000,#ffffff,#808080]"
    :style="{
      insetL: 0,
      insetT: 0,
      width: props.win.geo.value.w,
      height: props.win.geo.value.h,
      translateX: props.win.geo.value.x,
      translateY: props.win.geo.value.y,
      zIndex: props.win.z.value,
      opacity: props.win.minimized.value ? 0 : 1,
    }"
  >
    <View :class="props.active ? CAPTION_ACTIVE : CAPTION_INACTIVE">
      <Image class="w-[16] h-[16] mr-[3]" :src="props.win.icon" />
      <View class="flex-1 flex-row overflow-hidden">
        <T98 bold :cls="props.active ? 'text-[#ffffff]' : 'text-[#c0c0c0]'" :t="props.win.title" />
      </View>
      <CaptionButtons :win="props.win" />
    </View>
    <View v-if="props.win.menus !== null" class="flex-row items-center h-[18] bg-[#c0c0c0]">
      <View
        v-for="(menu, i) in props.win.menus ?? []"
        :key="menu.label"
        :class="
          props.win.openMenu.value === i
            ? 'h-[17] px-[6] flex-col justify-center bg-[#000080]'
            : 'h-[17] px-[6] flex-col justify-center'
        "
      >
        <T98
          :cls="props.win.openMenu.value === i ? 'text-[#ffffff]' : 'text-[#000000]'"
          :t="menu.label"
        />
      </View>
    </View>
    <View class="flex-1 flex-col overflow-hidden"><slot /></View>
  </View>
</template>
