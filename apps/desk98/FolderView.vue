<script setup lang="ts">
// Explorer details view: column headers, icon rows, "(empty)", the status
// bar with an object count and the resize grip.
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import type { FolderData } from "./state.ts";
import T98 from "./T98.vue";

const props = defineProps<{ data: FolderData; resizable: boolean }>();
const d = props.data;
</script>

<template>
  <View class="flex-1 flex-col">
    <View class="flex-1 flex-col bg-[#ffffff] bevel-[#808080,#ffffff,#000000,#dfdfdf] p-[1] overflow-hidden">
      <View class="h-[17] flex-row shrink-0">
        <View class="flex-1 flex-row items-center px-[6] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]">
          <T98 t="Name" />
        </View>
        <View class="w-[64] flex-row items-center justify-end px-[6] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]">
          <T98 t="Size" />
        </View>
        <View class="w-[104] flex-row items-center px-[6] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]">
          <T98 t="Type" />
        </View>
      </View>
      <View
        v-for="(row, i) in d.rows"
        :key="row.name"
        :class="
          d.selected.value === i
            ? 'h-[17] flex-row items-center px-[2] bg-[#000080] shrink-0'
            : 'h-[17] flex-row items-center px-[2] shrink-0'
        "
      >
        <Image class="w-[16] h-[16] mr-[4]" :src="row.icon" />
        <View class="flex-1 flex-row overflow-hidden">
          <T98 :cls="d.selected.value === i ? 'text-[#ffffff]' : 'text-[#000000]'" :t="row.name" />
        </View>
        <View class="w-[60] flex-row justify-end">
          <T98 :cls="d.selected.value === i ? 'text-[#ffffff]' : 'text-[#000000]'" :t="row.size" />
        </View>
        <View class="w-[100] flex-row pl-[6]">
          <T98 :cls="d.selected.value === i ? 'text-[#ffffff]' : 'text-[#000000]'" :t="row.type" />
        </View>
      </View>
      <View v-if="d.rows.length === 0" class="flex-1 flex-col justify-center items-center">
        <T98 cls="text-[#808080]" t="(empty)" />
      </View>
    </View>
    <View class="h-[20] flex-row items-end gap-[2] pt-[2]">
      <View class="flex-1 h-[18] flex-row items-center px-[6] bevel-[#808080,#ffffff]">
        <T98 :t="`${d.rows.length} object(s)`" />
      </View>
      <Image v-if="props.resizable" class="w-[16] h-[16]" src="icons/grip.svg" />
    </View>
  </View>
</template>
