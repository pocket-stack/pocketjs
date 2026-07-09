// Input tester v6: IMPERATIVE character movement.
// The character node's translateX/Y is set directly via host ops in onFrame,
// bypassing Solid reactivity entirely. This is the "Law 1" pattern: the JS
// mirror tree is for structure, not hot-path property updates. Only 2 FFI
// calls per frame for the character — no signal propagation cost.
//
// Visual elements (stick dot, buttons, mode) still use signals but are
// throttled to every 4th frame since they're not gameplay-critical.

import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { getOps } from "@pocketjs/framework";
import { BTN, normalizeAnalog } from "@pocketjs/framework/input";
import { PROP } from "../../spec/spec.ts";

function abgr(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const C = {
  bg: abgr("#0a0e1a"), off: abgr("#1e293b"), on: abgr("#22d3ee"),
  char: abgr("#fbbf24"), charDir: abgr("#92400e"),
  stick: abgr("#60a5fa"), dim: abgr("#334155"), label: abgr("#94a3b8"),
  digital: abgr("#f87171"), panel: abgr("#111827"),
};

interface BtnDef { mask: number; x: number; y: number; w: number; h: number }
const BTNS: BtnDef[] = [
  { mask: BTN.LTRIGGER, x: 30, y: 200, w: 70, h: 14 },
  { mask: BTN.RTRIGGER, x: 380, y: 200, w: 70, h: 14 },
  { mask: BTN.UP, x: 90, y: 222, w: 16, h: 16 },
  { mask: BTN.DOWN, x: 90, y: 254, w: 16, h: 16 },
  { mask: BTN.LEFT, x: 74, y: 238, w: 16, h: 16 },
  { mask: BTN.RIGHT, x: 106, y: 238, w: 16, h: 16 },
  { mask: BTN.TRIANGLE, x: 374, y: 222, w: 16, h: 16 },
  { mask: BTN.CIRCLE, x: 390, y: 238, w: 16, h: 16 },
  { mask: BTN.CROSS, x: 374, y: 254, w: 16, h: 16 },
  { mask: BTN.SQUARE, x: 358, y: 238, w: 16, h: 16 },
  { mask: BTN.SELECT, x: 210, y: 242, w: 28, h: 10 },
  { mask: BTN.START, x: 242, y: 242, w: 28, h: 10 },
];

export default function InputTest() {
  // Character node ref — updated imperatively, NOT via signals.
  let charNode: NodeMirror | undefined;

  // Visual-only signals (throttled).
  const [sx, setSx] = createSignal(0.5);
  const [sy, setSy] = createSignal(0.5);
  const [mode, setMode] = createSignal(0);

  // Pre-compute getter/setter pairs to avoid per-frame array destructuring
  // (each destructuring allocates a temp array that QuickJS GC may not collect
  // promptly on 333MHz PSP → OOM over minutes).
  interface BtnState { mask: number; get: Accessor<boolean>; set: (v: boolean) => void }
  const btnStates: BtnState[] = BTNS.map((b) => {
    const [get, set] = createSignal(false);
    return { mask: b.mask, get, set };
  });

  let curX = 240;
  let curY = 110;
  let frameCount = 0;
  const SPEED = 5;

  // Cache ops once — avoid per-frame lookup.
  const ops = getOps();

  onFrame((buttons: number, lax?: number, lay?: number) => {
    frameCount++;

    // Buttons — no per-frame allocation (pre-cached getters/setters).
    for (let i = 0; i < btnStates.length; i++) {
      const bs = btnStates[i];
      const held = (buttons & bs.mask) !== 0;
      if (bs.get() !== held) bs.set(held);
    }

    // normalizeAnalog returns -1..1 (deadzone + rescale). Host already
    // snapped deadzone, so 0 = truly idle.
    const adx = lax !== undefined ? normalizeAnalog(lax) : 0;
    const ady = lay !== undefined ? normalizeAnalog(lay) : 0;

    // Throttled visual updates — stick dot in 0..1 space.
    if (frameCount % 8 === 0) {
      setSx(0.5 + adx * 0.5);
      setSy(0.5 + ady * 0.5);
    }

    // Movement.
    let dx = 0;
    let dy = 0;
    let speed = SPEED;
    let m = 0;

    if (adx > 0.01 || adx < -0.01 || ady > 0.01 || ady < -0.01) {
      const amag = Math.sqrt(adx * adx + ady * ady);
      dx = adx / amag;
      dy = ady / amag;
      speed = Math.min(1, amag) * SPEED;
      m = 1;
    }

    if (buttons & BTN.LEFT) { dx -= 1; m = 2; }
    if (buttons & BTN.RIGHT) { dx += 1; m = 2; }
    if (buttons & BTN.UP) { dy -= 1; m = 2; }
    if (buttons & BTN.DOWN) { dy += 1; m = 2; }
    if (m === 2) { speed = SPEED; }

    if (frameCount % 8 === 0) setMode(m);

    if (dx === 0 && dy === 0) return;

    const mag = Math.sqrt(dx * dx + dy * dy);
    curX = Math.max(16, Math.min(curX + (dx / mag) * speed, 464));
    curY = Math.max(16, Math.min(curY + (dy / mag) * speed, 190));

    // IMPERATIVE: direct host ops, no signal propagation.
    if (charNode) {
      ops.setProp(charNode.id, PROP.translateX, curX - 10);
      ops.setProp(charNode.id, PROP.translateY, curY - 10);
    }
  });

  const modeCol = () => mode() === 1 ? C.stick : mode() === 2 ? C.digital : C.dim;
  const modeText = () => mode() === 1 ? "ANALOG" : mode() === 2 ? "D-PAD" : "IDLE";

  const SX = 16, SY = 16, SW = 96, SH = 60;
  const dotX = () => SX + sx() * SW - 3;
  const dotY = () => SY + sy() * SH - 3;

  return (
    <View debugName="InputTest" class="w-full h-full" style={{ bgColor: C.bg }}>
      {/* Top panel */}
      <View class="absolute" style={{ translateX: 0, translateY: 0, width: 480, height: 92, bgColor: C.panel }}>
        <View class="absolute" style={{ translateX: SX, translateY: SY, width: SW, height: SH, bgColor: C.off }} />
        <View class="absolute" style={{ translateX: SX, translateY: SY + SH / 2, width: SW, height: 1, bgColor: C.dim }} />
        <View class="absolute" style={{ translateX: SX + SW / 2, translateY: SY, width: 1, height: SH, bgColor: C.dim }} />
        <View class="absolute w-1 h-1" style={{ translateX: dotX(), translateY: dotY(), width: 6, height: 6, bgColor: C.stick }} />
        <Text class="absolute text-xs" style={{ translateX: SX, translateY: SY + SH + 4, textColor: C.label }}>STICK</Text>
        <Text class="absolute text-xs" style={{ translateX: 200, translateY: 20, textColor: C.label }}>INPUT TEST</Text>
        <View class="absolute w-3 h-3" style={{ translateX: 200, translateY: 40, bgColor: modeCol() }} />
        <Text class="absolute text-xs" style={{ translateX: 212, translateY: 38, textColor: C.label }}>{modeText()}</Text>
      </View>

      {/* Character — ref only, position set imperatively (no signal) */}
      <View ref={charNode} debugName="Char" class="absolute w-5 h-5 rounded-sm" style={{ translateX: 230, translateY: 100, bgColor: C.char }} />

      {/* Gamepad buttons */}
      {btnStates.map((bs, i) => {
        const b = BTNS[i];
        return <View class="absolute" style={{ translateX: b.x, translateY: b.y, width: b.w, height: b.h, bgColor: bs.get() ? C.on : C.off }} />;
      })}

      {/* Button labels (static) */}
      <Text class="absolute text-xs" style={{ translateX: 56, translateY: 201, textColor: C.label }}>L</Text>
      <Text class="absolute text-xs" style={{ translateX: 408, translateY: 201, textColor: C.label }}>R</Text>
      <Text class="absolute text-xs" style={{ translateX: 210, translateY: 241, textColor: C.label }}>SEL</Text>
      <Text class="absolute text-xs" style={{ translateX: 244, translateY: 241, textColor: C.label }}>STA</Text>
    </View>
  );
}
