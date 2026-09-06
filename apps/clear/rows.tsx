// The todo row pool: a fixed set of row nodes mounted once and re-assigned
// to todos after every mutation (app.tsx layout()). Each slot captures its
// NodeMirrors (row, slider front, swipe icons, strike-through bar) so ALL
// motion goes through jump()/animate() — the only reactive state per slot is
// its text, done-look and lift refs.

import { shallowRef, type ShallowRef } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import { ROW_H } from "./metrics.ts";
import { CLEAR_COLOR_PALETTE, type ClearPalette } from "./palette.ts";

/** Off-canvas parking spot for unassigned row slots. */
export const PARKED_Y = 4000;

export interface RowSlot {
  node: NodeMirror | null;
  front: NodeMirror | null;
  check: NodeMirror | null;
  cross: NodeMirror | null;
  strike: NodeMirror | null;
  text: ReturnType<typeof shallowRef<string>>;
  done: ReturnType<typeof shallowRef<boolean>>;
  lift: ShallowRef<number>;
  todoId: number;
  /** Current resting y (display index * ROW_H). */
  y: number;
  /** Mid-exit animation: layout() must not repark or reuse it yet. */
  busy: boolean;
  gradFrom: string;
  gradTo: string;
  /** Measured title width (strike-through line length). */
  textW: number;
  textFor: string;
}

export function makeSlots(count: number): RowSlot[] {
  return Array.from({ length: count }, () => ({
    node: null,
    front: null,
    check: null,
    cross: null,
    strike: null,
    text: shallowRef(""),
    done: shallowRef(false),
    lift: shallowRef(0),
    todoId: -1,
    y: PARKED_Y,
    busy: false,
    gradFrom: "",
    gradTo: "",
    textW: 0,
    textFor: "",
  }));
}

/** Snap every transient swipe/edit visual back to rest: slider home and
 *  opaque, icons hidden, strike collapsed. (Row y is the caller's.) */
export function resetSlotMotion(slot: RowSlot): void {
  if (slot.node) jump(slot.node, "translateX", 0);
  if (slot.front) {
    jump(slot.front, "translateX", 0);
    jump(slot.front, "opacity", 1);
  }
  if (slot.check) jump(slot.check, "opacity", 0);
  if (slot.cross) jump(slot.cross, "opacity", 0);
  if (slot.strike) jump(slot.strike, "scaleX", 0);
}

export function renderRow(
  slot: RowSlot,
  palette: ClearPalette = CLEAR_COLOR_PALETTE,
) {
  return (
    <View
      nodeRef={(node) => {
        slot.node = node ?? null;
      }}
      class="absolute left-0 right-0 top-0 h-[62]"
      style={{ zIndex: slot.lift.value, shadow: slot.lift.value ? 3 : 0 }}
    >
      <View
        nodeRef={(node) => {
          slot.check = node ?? null;
        }}
        class="absolute left-0 top-0"
        style={{ width: ROW_H, height: ROW_H, opacity: 0 }}
      >
        {/* Both strokes overshoot the valley center (23, 39.5) by half a
            thickness so the rotated bars overlap into one clean joint. */}
        <View
          class="absolute"
          style={{ insetL: 9.3, insetT: 31.3, width: 19, height: 7, rotate: 45, bgColor: palette.completeIcon }}
        />
        <View
          class="absolute"
          style={{ insetL: 15.3, insetT: 25.8, width: 35, height: 7, rotate: -45, bgColor: palette.completeIcon }}
        />
      </View>
      <View
        nodeRef={(node) => {
          slot.cross = node ?? null;
        }}
        class="absolute right-0 top-0"
        style={{ width: ROW_H, height: ROW_H, opacity: 0 }}
      >
        <View
          class="absolute"
          style={{ insetL: 15, insetT: 28, width: 32, height: 7, rotate: 45, bgColor: palette.deleteIcon }}
        />
        <View
          class="absolute"
          style={{ insetL: 15, insetT: 28, width: 32, height: 7, rotate: -45, bgColor: palette.deleteIcon }}
        />
      </View>
      <View
        nodeRef={(node) => {
          slot.front = node ?? null;
        }}
        class="absolute inset-0 bg-gradient-to-b"
        style={{ gradFrom: palette.flapFrom, gradTo: palette.flapTo }}
      >
        <View class="absolute left-0 right-0 top-0" style={{ height: 1, bgColor: palette.edgeLight }} />
        <View class="absolute left-0 right-0 bottom-0" style={{ height: 1, bgColor: palette.edgeDark }} />
        <View class="absolute inset-0 flex-row items-center pl-3">
          <Text
            class="text-xl font-bold"
            style={{ textColor: slot.done.value ? palette.doneText : palette.foreground }}
          >
            {slot.text.value}
          </Text>
        </View>
        <View
          nodeRef={(node) => {
            slot.strike = node ?? null;
          }}
          class="absolute"
          style={{
            insetL: 12,
            insetT: 30,
            height: 2,
            width: 0,
            originX: -0.5,
            scaleX: 0,
            bgColor: palette.foreground,
          }}
        />
      </View>
    </View>
  );
}
