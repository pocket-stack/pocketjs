<script setup lang="ts">
// One 7-seg digit, 13×23, red on black.
//    a
//  f   b        segments: bit 0..6 = a b c d e f g
//    g
//  e   c
//    d
import { View } from "@pocketjs/framework/vue-vapor/components";

const props = defineProps<{ ch: string }>();

const SEGS: Record<string, number> = {
  "0": 0b0111111,
  "1": 0b0000110,
  "2": 0b1011011,
  "3": 0b1001111,
  "4": 0b1100110,
  "5": 0b1101101,
  "6": 0b1111101,
  "7": 0b0000111,
  "8": 0b1111111,
  "9": 0b1101111,
  "-": 0b1000000,
  " ": 0,
};
const on = (bit: number): boolean => (((SEGS[props.ch] ?? 0) >> bit) & 1) === 1;
</script>

<template>
  <View class="w-[13] h-[23] bg-[#000000] relative">
    <View :class="on(0) ? 'absolute left-[2] top-[1] w-[9] h-[2] bg-[#ff0000]' : 'absolute left-[2] top-[1] w-[9] h-[2] bg-[#3a0000]'" />
    <View :class="on(1) ? 'absolute left-[10] top-[2] w-[2] h-[9] bg-[#ff0000]' : 'absolute left-[10] top-[2] w-[2] h-[9] bg-[#3a0000]'" />
    <View :class="on(2) ? 'absolute left-[10] top-[12] w-[2] h-[9] bg-[#ff0000]' : 'absolute left-[10] top-[12] w-[2] h-[9] bg-[#3a0000]'" />
    <View :class="on(3) ? 'absolute left-[2] top-[20] w-[9] h-[2] bg-[#ff0000]' : 'absolute left-[2] top-[20] w-[9] h-[2] bg-[#3a0000]'" />
    <View :class="on(4) ? 'absolute left-[1] top-[12] w-[2] h-[9] bg-[#ff0000]' : 'absolute left-[1] top-[12] w-[2] h-[9] bg-[#3a0000]'" />
    <View :class="on(5) ? 'absolute left-[1] top-[2] w-[2] h-[9] bg-[#ff0000]' : 'absolute left-[1] top-[2] w-[2] h-[9] bg-[#3a0000]'" />
    <View :class="on(6) ? 'absolute left-[2] top-[10] w-[9] h-[3] bg-[#ff0000]' : 'absolute left-[2] top-[10] w-[9] h-[3] bg-[#3a0000]'" />
  </View>
</template>
