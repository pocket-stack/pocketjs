// demos/rubiks — a Tailwind-authored Rubik cube built from PocketJS 3D faces.
//
// The cube state is a real sticker model: each sticker carries a cubie
// coordinate and an outward normal. Face turns rotate the affected layer's
// positions and normals, so scramble/restore are legal cube-state operations.

import { For, createMemo, createSignal, type Accessor } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

type Axis = "x" | "y" | "z";
type Face = "U" | "R" | "F" | "D" | "L" | "B";

interface Vec3 {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
  z: -1 | 0 | 1;
}

interface FaceMeta {
  axis: Axis;
  sign: -1 | 1;
  title: string;
  dotCls: string;
}

interface Sticker {
  id: string;
  color: Face;
  pos: Vec3;
  normal: Vec3;
}

const FACES: Face[] = ["F", "R", "U", "B", "L", "D"];

const FACE_META: Record<Face, FaceMeta> = {
  U: { axis: "y", sign: 1, title: "UP", dotCls: "w-3 h-3 rounded-full bg-[#f8fafc] border-[#cbd5e1]" },
  R: { axis: "x", sign: 1, title: "RIGHT", dotCls: "w-3 h-3 rounded-full bg-[#ef4444] border-[#991b1b]" },
  F: { axis: "z", sign: 1, title: "FRONT", dotCls: "w-3 h-3 rounded-full bg-[#22c55e] border-[#166534]" },
  D: { axis: "y", sign: -1, title: "DOWN", dotCls: "w-3 h-3 rounded-full bg-[#facc15] border-[#a16207]" },
  L: { axis: "x", sign: -1, title: "LEFT", dotCls: "w-3 h-3 rounded-full bg-[#f97316] border-[#9a3412]" },
  B: { axis: "z", sign: -1, title: "BACK", dotCls: "w-3 h-3 rounded-full bg-[#3b82f6] border-[#1e40af]" },
};

const FACE_CLASSES: Record<Face, string> = {
  F: "absolute left-0 top-0 w-[96] h-[96] translate-z-[48]",
  B: "absolute left-0 top-0 w-[96] h-[96] rotate-y-[180] translate-z-[-48]",
  R: "absolute left-0 top-0 w-[96] h-[96] rotate-y-[90] translate-x-[48]",
  L: "absolute left-0 top-0 w-[96] h-[96] rotate-y-[-90] translate-x-[-48]",
  U: "absolute left-0 top-0 w-[96] h-[96] rotate-x-[90] translate-y-[-48]",
  D: "absolute left-0 top-0 w-[96] h-[96] rotate-x-[-90] translate-y-[48]",
};

const STICKER_POS = [
  "absolute left-[3] top-[3] w-[28] h-[28] rounded-[4px] bg-[#111827] p-[2]",
  "absolute left-[34] top-[3] w-[28] h-[28] rounded-[4px] bg-[#111827] p-[2]",
  "absolute left-[65] top-[3] w-[28] h-[28] rounded-[4px] bg-[#111827] p-[2]",
  "absolute left-[3] top-[34] w-[28] h-[28] rounded-[4px] bg-[#111827] p-[2]",
  "absolute left-[34] top-[34] w-[28] h-[28] rounded-[4px] bg-[#111827] p-[2]",
  "absolute left-[65] top-[34] w-[28] h-[28] rounded-[4px] bg-[#111827] p-[2]",
  "absolute left-[3] top-[65] w-[28] h-[28] rounded-[4px] bg-[#111827] p-[2]",
  "absolute left-[34] top-[65] w-[28] h-[28] rounded-[4px] bg-[#111827] p-[2]",
  "absolute left-[65] top-[65] w-[28] h-[28] rounded-[4px] bg-[#111827] p-[2]",
];

const COLOR_CLASSES: Record<Face, string> = {
  U: "w-full h-full rounded-[3px] bg-[#f8fafc] border-[#e2e8f0]",
  R: "w-full h-full rounded-[3px] bg-gradient-to-b from-red-400 to-red-600 border-red-700",
  F: "w-full h-full rounded-[3px] bg-gradient-to-b from-emerald-400 to-emerald-600 border-emerald-700",
  D: "w-full h-full rounded-[3px] bg-gradient-to-b from-yellow-300 to-yellow-500 border-yellow-700",
  L: "w-full h-full rounded-[3px] bg-gradient-to-b from-orange-400 to-orange-600 border-orange-700",
  B: "w-full h-full rounded-[3px] bg-gradient-to-b from-blue-400 to-blue-600 border-blue-700",
};

const FACE_BADGE_ACTIVE =
  "flex-row items-center gap-1 px-1 py-1 rounded-md bg-[#e0f2fe] border-[#38bdf8] shadow";
const FACE_BADGE_IDLE =
  "flex-row items-center gap-1 px-1 py-1 rounded-md bg-[#111827] border-[#253244] shadow";
const FACE_TEXT_ACTIVE = "text-xs font-bold text-[#075985]";
const FACE_TEXT_IDLE = "text-xs font-bold text-[#94a3b8]";

const DEFAULT_RX = -28;
const DEFAULT_RY = -34;
const SCRAMBLE: Face[] = ["R", "U", "F", "L", "D", "B", "R", "F", "U", "L", "B", "D", "R", "U"];

function vec(x: -1 | 0 | 1, y: -1 | 0 | 1, z: -1 | 0 | 1): Vec3 {
  return { x, y, z };
}

function normalFor(face: Face): Vec3 {
  switch (face) {
    case "U": return vec(0, 1, 0);
    case "D": return vec(0, -1, 0);
    case "F": return vec(0, 0, 1);
    case "B": return vec(0, 0, -1);
    case "R": return vec(1, 0, 0);
    case "L": return vec(-1, 0, 0);
  }
}

function posFor(face: Face, row: number, col: number): Vec3 {
  const x = (col - 1) as -1 | 0 | 1;
  const yTop = (1 - row) as -1 | 0 | 1;
  const zBack = (row - 1) as -1 | 0 | 1;
  const zFront = (1 - row) as -1 | 0 | 1;
  switch (face) {
    case "F": return vec(x, yTop, 1);
    case "B": return vec((1 - col) as -1 | 0 | 1, yTop, -1);
    case "R": return vec(1, yTop, (1 - col) as -1 | 0 | 1);
    case "L": return vec(-1, yTop, x);
    case "U": return vec(x, 1, zBack);
    case "D": return vec(x, -1, zFront);
  }
}

function createSolved(): Sticker[] {
  const stickers: Sticker[] = [];
  for (const face of ["U", "R", "F", "D", "L", "B"] as Face[]) {
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        stickers.push({
          id: `${face}${row}${col}`,
          color: face,
          pos: posFor(face, row, col),
          normal: normalFor(face),
        });
      }
    }
  }
  return stickers;
}

function sameVec(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function axisValue(v: Vec3, axis: Axis): -1 | 0 | 1 {
  return v[axis];
}

function rotateVec(v: Vec3, axis: Axis, dir: -1 | 1): Vec3 {
  if (axis === "x") {
    return dir === 1 ? vec(v.x, (-v.z) as -1 | 0 | 1, v.y) : vec(v.x, v.z, (-v.y) as -1 | 0 | 1);
  }
  if (axis === "y") {
    return dir === 1 ? vec(v.z, v.y, (-v.x) as -1 | 0 | 1) : vec((-v.z) as -1 | 0 | 1, v.y, v.x);
  }
  return dir === 1 ? vec((-v.y) as -1 | 0 | 1, v.x, v.z) : vec(v.y, (-v.x) as -1 | 0 | 1, v.z);
}

function turn(state: readonly Sticker[], face: Face): Sticker[] {
  const meta = FACE_META[face];
  const dir = (-meta.sign) as -1 | 1;
  return state.map((s) => {
    if (axisValue(s.pos, meta.axis) !== meta.sign) return s;
    return {
      ...s,
      pos: rotateVec(s.pos, meta.axis, dir),
      normal: rotateVec(s.normal, meta.axis, dir),
    };
  });
}

function slotFor(face: Face, p: Vec3): number {
  let row = 0;
  let col = 0;
  switch (face) {
    case "F":
      row = 1 - p.y;
      col = p.x + 1;
      break;
    case "B":
      row = 1 - p.y;
      col = 1 - p.x;
      break;
    case "R":
      row = 1 - p.y;
      col = 1 - p.z;
      break;
    case "L":
      row = 1 - p.y;
      col = p.z + 1;
      break;
    case "U":
      row = p.z + 1;
      col = p.x + 1;
      break;
    case "D":
      row = 1 - p.z;
      col = p.x + 1;
      break;
  }
  return row * 3 + col;
}

function faceGrid(state: readonly Sticker[], face: Face): Sticker[] {
  const normal = normalFor(face);
  const grid = new Array<Sticker>(9);
  for (const sticker of state) {
    if (sameVec(sticker.normal, normal)) grid[slotFor(face, sticker.pos)] = sticker;
  }
  return grid;
}

function FacePlane(props: { face: Face; stickers: Accessor<Sticker[]> }) {
  return (
    <View class={FACE_CLASSES[props.face]}>
      <View class="absolute inset-0 rounded-[8px] bg-[#020617] border-[#020617] shadow-md" />
      <For each={faceGrid(props.stickers(), props.face)}>
        {(sticker, i) => (
          <View class={STICKER_POS[i()]}>
            <View class={COLOR_CLASSES[sticker.color]} />
          </View>
        )}
      </For>
    </View>
  );
}

export default function Rubiks() {
  const [stickers, setStickers] = createSignal<Sticker[]>(createSolved());
  const [selected, setSelected] = createSignal<Face>("F");
  const [status, setStatus] = createSignal("SOLVED");
  const [moves, setMoves] = createSignal(0);
  const selectedMeta = createMemo(() => FACE_META[selected()]);
  let cubeNode: NodeMirror | undefined;
  let rx = DEFAULT_RX;
  let ry = DEFAULT_RY;

  const setView = (nextRx: number, nextRy: number) => {
    rx = Math.max(-74, Math.min(58, nextRx));
    ry = nextRy;
    if (!cubeNode) return;
    animate(cubeNode, "rotateX", rx, { dur: 260, easing: "out" });
    animate(cubeNode, "rotateY", ry, { dur: 260, easing: "out" });
  };
  const cycleFace = (delta: number) => {
    const index = FACES.indexOf(selected());
    const next = FACES[(index + delta + FACES.length) % FACES.length];
    setSelected(next);
    setStatus(FACE_META[next].title);
  };
  const turnSelected = () => {
    const face = selected();
    setStickers((state) => turn(state, face));
    setMoves((n) => n + 1);
    setStatus(`TURN ${face}`);
  };
  const scramble = () => {
    setStickers(SCRAMBLE.reduce((state, face) => turn(state, face), createSolved()));
    setMoves(SCRAMBLE.length);
    setStatus("MIXED");
    setView(-22, 42);
  };
  const restore = () => {
    setStickers(createSolved());
    setMoves(0);
    setStatus("SOLVED");
    setView(DEFAULT_RX, DEFAULT_RY);
  };

  onButtonPress(BTN.LEFT, () => setView(rx, ry - 28));
  onButtonPress(BTN.RIGHT, () => setView(rx, ry + 28));
  onButtonPress(BTN.UP, () => setView(rx - 18, ry));
  onButtonPress(BTN.DOWN, () => setView(rx + 18, ry));
  onButtonPress(BTN.LTRIGGER, () => cycleFace(-1));
  onButtonPress(BTN.RTRIGGER, () => cycleFace(1));
  onButtonPress(BTN.CIRCLE, turnSelected);
  onButtonPress(BTN.SQUARE, scramble);
  onButtonPress(BTN.CROSS, restore);

  return (
    <View class="w-full h-full overflow-hidden bg-gradient-to-b from-[#0b1020] to-[#151015]">
      <View class="absolute left-[12] top-[12] w-[120] flex-col gap-2">
        <Text class="text-xs font-bold tracking-wide text-[#7dd3fc]">TAILWIND 3D</Text>
        <Text class="text-2xl font-bold text-[#f8fafc]">Rubik</Text>
        <View class="flex-row items-center gap-1">
          <View class={selectedMeta().dotCls} />
          <Text class="text-sm font-bold text-[#e2e8f0]">{selectedMeta().title}</Text>
        </View>
        <View class="flex-row gap-1 flex-wrap">
          <For each={FACES}>
            {(face) => (
              <View class={selected() === face ? FACE_BADGE_ACTIVE : FACE_BADGE_IDLE}>
                <View class={FACE_META[face].dotCls} />
                <Text class={selected() === face ? FACE_TEXT_ACTIVE : FACE_TEXT_IDLE}>{face}</Text>
              </View>
            )}
          </For>
        </View>
      </View>

      <View class="absolute left-[134] top-[10] w-[212] h-[242]">
        <View class="absolute left-[35] top-[188] w-[142] h-[16] rounded-full bg-[#020617] opacity-70" />
        <View class="absolute left-[18] top-[16] w-[176] h-[176] perspective-[560]">
          <View
            ref={(node) => {
              cubeNode = node;
            }}
            class="absolute left-[40] top-[40] w-[96] h-[96]"
            style={{ rotateX: DEFAULT_RX, rotateY: DEFAULT_RY, translateZ: -20 }}
          >
            <FacePlane face="B" stickers={stickers} />
            <FacePlane face="L" stickers={stickers} />
            <FacePlane face="D" stickers={stickers} />
            <FacePlane face="F" stickers={stickers} />
            <FacePlane face="R" stickers={stickers} />
            <FacePlane face="U" stickers={stickers} />
          </View>
        </View>
      </View>

      <View class="absolute right-[12] top-[14] w-[118] flex-col gap-2">
        <View class="flex-row justify-between items-center px-2 py-1 rounded-lg bg-[#111827] border-[#253244] shadow">
          <Text class="text-xs font-bold text-[#94a3b8]">STATE</Text>
          <Text class="text-xs font-bold text-[#f8fafc]">{status()}</Text>
        </View>
        <View class="flex-row justify-between items-center px-2 py-1 rounded-lg bg-[#111827] border-[#253244] shadow">
          <Text class="text-xs font-bold text-[#94a3b8]">MOVES</Text>
          <Text class="text-xs font-bold text-[#facc15]">{moves()}</Text>
        </View>
        <View class="flex-col gap-1 px-2 py-2 rounded-lg bg-[#111827] border-[#253244] shadow">
          <View class="flex-row justify-between">
            <Text class="text-xs text-[#cbd5e1]">DPAD</Text>
            <Text class="text-xs font-bold text-[#7dd3fc]">VIEW</Text>
          </View>
          <View class="flex-row justify-between">
            <Text class="text-xs text-[#cbd5e1]">L / R</Text>
            <Text class="text-xs font-bold text-[#7dd3fc]">FACE</Text>
          </View>
          <View class="flex-row justify-between">
            <Text class="text-xs text-[#cbd5e1]">O</Text>
            <Text class="text-xs font-bold text-[#22c55e]">TURN</Text>
          </View>
          <View class="flex-row justify-between">
            <Text class="text-xs text-[#cbd5e1]">SQ</Text>
            <Text class="text-xs font-bold text-[#facc15]">MIX</Text>
          </View>
          <View class="flex-row justify-between">
            <Text class="text-xs text-[#cbd5e1]">X</Text>
            <Text class="text-xs font-bold text-[#f8fafc]">RESET</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
