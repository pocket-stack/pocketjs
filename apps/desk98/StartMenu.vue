<script setup lang="ts">
// The Start menu: a plain navy gradient banner strip + 26px rows (flyouts
// render as PopupPanels).
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import type { Popup } from "./state.ts";
import T98 from "./T98.vue";

const props = defineProps<{
  x: number;
  y: number;
  h: number;
  items: Popup["items"];
  hover: number;
}>();
</script>

<template>
  <View
    class="absolute flex-row bg-[#c0c0c0] p-[1] bevel-[#dfdfdf,#000000,#ffffff,#808080]"
    :style="{
      insetL: 0,
      insetT: 0,
      translateX: props.x,
      translateY: props.y,
      width: 182,
      height: props.h,
      zIndex: 19000,
    }"
  >
    <View class="w-[24] h-full bg-gradient-to-t from-[#000080] to-[#1084d0]" />
    <View class="flex-1 flex-col">
      <template v-for="(item, i) in props.items" :key="i">
        <View v-if="item.sep" class="h-[8] flex-col justify-center px-[2]">
          <View class="h-[1] bg-[#808080]" />
          <View class="h-[1] bg-[#ffffff]" />
        </View>
        <View
          v-else
          :class="
            props.hover === i && !item.disabled
              ? 'h-[26] flex-row items-center gap-[6] pl-[6] pr-[6] bg-[#000080]'
              : 'h-[26] flex-row items-center gap-[6] pl-[6] pr-[6]'
          "
        >
          <Image class="w-[16] h-[16]" :src="item.icon ?? ''" />
          <View class="flex-1 flex-row">
            <T98
              :cls="
                item.disabled
                  ? 'text-[#808080]'
                  : props.hover === i
                    ? 'text-[#ffffff]'
                    : 'text-[#000000]'
              "
              :t="item.label"
            />
          </View>
          <Image v-if="item.sub" class="w-[8] h-[8]" src="icons/menu-arrow.svg" />
        </View>
      </template>
    </View>
  </View>
</template>
