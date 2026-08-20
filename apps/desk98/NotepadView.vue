<script setup lang="ts">
// Notepad content: the white sunken well, per-row text with the selection
// highlight (navy segment, white text), the IME preedit underline and the
// blinking caret. Selection state lives in the Doc (notepad.ts anchor);
// app.vue drives it off the raw pointer/key stream.
import { View } from "@pocketjs/framework/vue-vapor/components";
import type { PadData } from "./state.ts";
import { rowSelSpan } from "./notepad.ts";
import { measure, PAD_LINE_H } from "./programs.ts";
import T98 from "./T98.vue";

const props = defineProps<{ data: PadData; active: boolean }>();
const d = props.data;

const caretRow = (): number => d.doc.value.caret.row;
const caretX = (): number => {
  const doc = d.doc.value;
  const line = doc.lines[doc.caret.row] ?? "";
  const pre = d.preedit.value;
  const head = line.slice(0, doc.caret.col);
  return measure(pre ? head + pre.s.slice(0, pre.c) : head);
};

/** Row text split at the selection edges; one segment when unselected. */
const segs = (line: string, row: number): { t: string; sel: boolean }[] => {
  const span = rowSelSpan(d.doc.value, row);
  if (!span) return [{ t: line, sel: false }];
  return [
    { t: line.slice(0, span.from), sel: false },
    { t: line.slice(span.from, span.to), sel: true },
    { t: line.slice(span.to), sel: false },
  ];
};
</script>

<template>
  <View class="flex-1 flex-col bg-[#ffffff] bevel-[#808080,#ffffff,#000000,#dfdfdf] overflow-hidden">
    <View class="flex-1 relative overflow-hidden">
      <View
        class="absolute left-[3] top-[3] right-0 flex-col"
        :style="{ translateY: -d.scroll.value }"
      >
        <View
          v-for="(line, row) in d.doc.value.lines"
          :key="row"
          class="h-[16] flex-row items-center"
        >
          <template v-if="row === caretRow() && d.preedit.value">
            <T98 :t="line.slice(0, d.doc.value.caret.col)" />
            <View class="flex-col">
              <T98 :t="d.preedit.value.s" />
              <View class="h-[1] bg-[#000000]" />
            </View>
            <T98 :t="line.slice(d.doc.value.caret.col)" />
          </template>
          <template v-else>
            <template v-for="(seg, si) in segs(line, row)" :key="si">
              <View v-if="seg.sel" class="bg-[#000080] flex-row">
                <T98 cls="text-[#ffffff]" :t="seg.t" />
              </View>
              <T98 v-else :t="seg.t" />
            </template>
          </template>
        </View>
      </View>
      <View
        v-if="props.active"
        class="absolute w-[1] h-[14] bg-[#000000] animate-caret"
        :style="{
          insetL: 0,
          insetT: 0,
          translateX: 3 + caretX(),
          translateY: 3 + caretRow() * PAD_LINE_H - d.scroll.value + 1,
        }"
      />
    </View>
  </View>
</template>
