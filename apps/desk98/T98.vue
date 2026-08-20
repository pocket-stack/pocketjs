<script setup lang="ts">
// W95FA text. Slots 19/20/21 ride the style prop — the class table never
// sees them (baked per-app via pak.json, docs in gen-assets.ts). Text rides
// the `t` prop (interpolation inside the Text host is the proven vapor
// shape); `cls` replaces the class attr so nothing falls through to attrs.
import { Text } from "@pocketjs/framework/vue-vapor/components";
import { FONT, FONT_B, FONT_XL } from "./theme.ts";

const props = defineProps<{ t: string; cls?: string; bold?: boolean; xl?: boolean }>();
</script>

<template>
  <Text
    :class="props.cls ?? 'text-[#000000]'"
    :style="{ fontSlot: props.xl ? FONT_XL : props.bold ? FONT_B : FONT }"
  >{{ props.t }}</Text>
</template>
