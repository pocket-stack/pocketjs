<script setup lang="ts">
// Generic popup menu panel (context menus, dropdowns, start flyouts).
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import type { Popup } from "./state.ts";
import T98 from "./T98.vue";

const props = defineProps<{ popup: Popup; hover: number }>();
</script>

<template>
  <View
    class="absolute flex-col bg-[#c0c0c0] p-[1] bevel-[#dfdfdf,#000000,#ffffff,#808080]"
    :style="{
      insetL: 0,
      insetT: 0,
      translateX: props.popup.x,
      translateY: props.popup.y,
      width: props.popup.w,
      zIndex: 20000,
    }"
  >
    <template v-for="(item, i) in props.popup.items" :key="i">
      <View v-if="item.sep" class="h-[8] flex-col justify-center px-[1]">
        <View class="h-[1] bg-[#808080]" />
        <View class="h-[1] bg-[#ffffff]" />
      </View>
      <View
        v-else
        :class="
          props.hover === i && !item.disabled
            ? 'h-[18] flex-row items-center gap-[5] pl-[4] pr-[8] bg-[#000080]'
            : 'h-[18] flex-row items-center gap-[5] pl-[4] pr-[8]'
        "
      >
        <Image v-if="item.icon" class="w-[16] h-[16]" :src="item.icon" />
        <View v-else class="w-[16] h-[16]" />
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
        <T98
          v-if="item.shortcut"
          :cls="
            item.disabled
              ? 'text-[#808080]'
              : props.hover === i
                ? 'text-[#ffffff]'
                : 'text-[#000000]'
          "
          :t="item.shortcut ?? ''"
        />
        <Image v-if="item.sub" class="w-[8] h-[8] ml-[2]" src="icons/menu-arrow.svg" />
      </View>
    </template>
  </View>
</template>
