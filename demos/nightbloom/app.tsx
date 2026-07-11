// demos/nightbloom/app.tsx — NIGHTBLOOM: a vertical danmaku shooter on the
// PocketJS deterministic runtime, in the Imperishable Night grammar: the
// player pilots one plant form at the bottom of a portrait playfield, the
// eternal-night horde descends from the treeline above, and the piloted form
// switches mid-fight — five plants, five shot types, five spell cards.
//
// On the 480x272 landscape screen the field is the classic arcade
// adaptation: a portrait column in the center with HUD panels on both
// sides (the night on the left, the roster on the right).
//
// What it demonstrates, mechanically:
//   - a bullet-hell simulated in fixed 1/60 s micro-ticks, subsample-exact
//     at every simulationHz — the 2 Hz world dodges the SAME spiral;
//   - form-switching as the player verb: five plants with distinct
//     attack/defense stats (homing, pierce, true-damage fan, armored tank,
//     moonlight economy), each evolving I -> II -> III by its own work;
//   - enemy danmaku as native dots from a quantized sine table, plus a
//     midboss and a three-card final boss with Touhou-style timeouts;
//   - graze, a point-of-collection line, per-form spell cards that double
//     as bullet clears — all on the virtual clock.
//
// All sprites and backdrops are PixelLab-generated pixel art committed by
// gen-assets.ts. Every class is a FULL literal and all copy is ASCII (Inter
// has no CJK).

import { For, Show } from "solid-js";
import { Image, Screen, Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import {
  AVATAR_SIZE,
  FIELD,
  FOES,
  FOE_ORDER,
  PANEL_L,
  PANEL_R,
  PLANTS,
  PLANT_ORDER,
  POC_Y,
  SHOTS,
  WAVES,
} from "./data.ts";
import { createNightbloom, FX_LIFE, STAMP_AT, STAMP_IMPACT, type FloatFx, type Nightbloom, type PlantState } from "./engine.ts";

// ---------------------------------------------------------------------------
// Title / endings
// ---------------------------------------------------------------------------

function TitleScreen() {
  return (
    <View debugName="Title" class="absolute inset-0">
      {/* 256x128 scene drawn at 480x240 — a UNIFORM 1.875x (stretching to the
          full 272 screen height would squash the moon); the bottom 32px is a
          letterbox band the legend sits in, tidelight-style. */}
      <Image class="absolute top-0 left-0 w-full h-[240]" src="bg-title.png" />
      <View class="absolute left-0 right-0 bottom-0 h-24 bg-slate-950 opacity-70" />
      <View class="absolute left-0 right-0 top-8 flex-col items-center gap-1">
        <Text class="text-4xl text-pink-200 font-bold tracking-wide">NIGHTBLOOM</Text>
        <Text class="text-xs text-slate-300 tracking-wide">A GARDEN AGAINST THE ETERNAL NIGHT</Text>
      </View>
      <View class="absolute left-0 right-0 bottom-12 flex-col items-center gap-1">
        <Text class="text-sm text-amber-300 tracking-wide animate-pulse">PRESS START</Text>
        <Text class="text-xs text-slate-400">ARROWS FLY   HOLD X FIRE   HOLD [] FOCUS   O SWITCH FORM</Text>
        <Text class="text-xs text-slate-400">{"/\\ SPELL CARD   L R SWITCH   SELECT CODEX"}</Text>
      </View>
      <View class="absolute left-3 right-3 bottom-2 flex-row justify-between">
        <Text class="text-xs text-slate-500">A POCKETJS DANMAKU</Text>
        <Text class="text-xs text-slate-500">EVERY NIGHT IS A TAPE</Text>
      </View>
    </View>
  );
}

/** Chunky gold "art lettering": the same line three times, offset like a
 *  stamped foil title. */
function ArtTitle(props: { text: string; y: number }) {
  return (
    <View class="absolute left-0 right-0" style={{ insetT: props.y, height: 30 }}>
      <Text class="absolute left-0 right-0 text-center text-2xl font-bold tracking-wide text-amber-900" style={{ translateX: 2, translateY: 2 }}>
        {props.text}
      </Text>
      <Text class="absolute left-0 right-0 text-center text-2xl font-bold tracking-wide text-pink-400" style={{ translateX: -1, translateY: -1 }}>
        {props.text}
      </Text>
      <Text class="absolute left-0 right-0 text-center text-2xl font-bold tracking-wide text-amber-100">
        {props.text}
      </Text>
    </View>
  );
}

function EndScreen(props: { game: Nightbloom; win: boolean }) {
  const g = props.game;
  // Only forms that ever WOKE count — a locked card never fought.
  const awakened = () => g.roster.filter((r) => r.unlocked());
  const survivors = () => awakened().filter((r) => r.hp() > 0).length;
  /** The dawn decoration: ONE medal that congratulates you for the wrong
   *  thing, picked in roast order; a spotless run earns suspicion. */
  const medal = (): { title: string; detail: string } => {
    const wilted = awakened().length - survivors();
    if (g.escaped() > 0) return { title: "MERCY MEDAL", detail: g.escaped() + " FOES STROLLED OFF UNHARMED" };
    if (g.hitsTaken() > 0) return { title: "PINCUSHION", detail: "STRUCK " + g.hitsTaken() + " TIMES AND PROUD" };
    if (wilted > 0) return { title: "COMPOST AWARD", detail: wilted + " GARDENERS WILTED ON YOUR WATCH" };
    if (g.cardTimeouts() > 0) return { title: "OUTSTAYED WELCOME", detail: g.cardTimeouts() + " CARDS DIED OF OLD AGE" };
    if (g.motesMissed() > 0) return { title: "LITTERBUG", detail: g.motesMissed() + " MOTES LEFT IN THE GRASS" };
    if (g.graze() === 0) return { title: "PERSONAL SPACE", detail: "NOT ONE GRAZE ALL NIGHT" };
    return { title: "SUSPICIOUSLY PERFECT", detail: "THE NIGHT DEMANDS A REMATCH" };
  };
  /** The arcade count-up: the score rolls in over the first 1.2 s. */
  const shownScore = () => Math.floor(g.score() * Math.min(1, g.endTick() / 72));
  /** Stamp physics: appear huge and tilted, slam to rest, shake the room. */
  const slam = () => Math.min(1, Math.max(0, (g.endTick() - STAMP_AT) / (STAMP_IMPACT - STAMP_AT)));
  const stamped = () => props.win && g.endTick() >= STAMP_AT;
  const SHAKE = [3, -2, 2, -2, 1, -1, 0];
  const shake = () => {
    const n = g.endTick() - STAMP_IMPACT;
    return n >= 0 && n < 14 ? SHAKE[Math.min(6, n >> 1)] : 0;
  };
  return (
    <View debugName="End" class="absolute inset-0" style={{ translateX: shake() }}>
      <Image class="absolute top-0 left-0 w-full h-[240]" src={props.win ? "bg-dawn.png" : "bg-eternal.png"} />
      <View class="absolute inset-0 bg-slate-950 opacity-55" />
      <View class="absolute left-0 right-0 top-3 flex-col items-center gap-1">
        <Text class="text-xs text-slate-300 tracking-wide">{props.win ? "THE DIVA FALLS SILENT" : "THE GARDEN FALLS DARK"}</Text>
        <Text class={props.win ? "text-2xl text-amber-200 font-bold tracking-wide" : "text-2xl text-red-300 font-bold tracking-wide"}>
          {props.win ? "DAWN BREAKS" : "ETERNAL NIGHT"}
        </Text>
      </View>
      {/* act one: the score takes the stage, rolling up arcade-style */}
      <View class="absolute left-0 right-0 flex-col items-center gap-1" style={{ insetT: 74 }}>
        <Text class="text-xs text-slate-400 tracking-wide">SCORE</Text>
        <Text class="text-4xl text-amber-200 font-bold tracking-wide">{String(props.win ? shownScore() : g.score())}</Text>
      </View>
      <View class="absolute left-0 right-0 flex-col items-center gap-1" style={{ insetT: 152, opacity: stamped() ? 0.3 : 1 }}>
        <Text class="text-xs text-slate-400">{"FOES FELLED: " + g.kills() + "   GRAZE: " + g.graze()}</Text>
        <Text class="text-xs text-slate-400">{"GREATEST BLOOM: STAGE " + g.bestStage() + "   SURVIVING FORMS: " + survivors() + " OF " + awakened().length + " AWAKENED"}</Text>
      </View>
      {/* act two: the medal is slapped onto the glass */}
      <Show when={stamped()}>
        <View
          class="absolute left-0 right-0 items-center"
          style={{
            insetT: 96,
            height: 150,
            scale: 3.0 - 2.0 * slam(),
            rotate: -26 + 14 * slam(),
            opacity: 0.3 + 0.7 * slam(),
          }}
        >
          <Image class="absolute w-[120] h-[120]" src="medal.png" style={{ insetL: 180, insetT: 8 }} />
          <ArtTitle text={medal().title} y={52} />
          <View class="absolute left-0 right-0 flex-col items-center" style={{ insetT: 86 }}>
            <View class="px-2 py-1 rounded-sm bg-[#0f172acc] border border-amber-700">
              <Text class="text-xs text-amber-100 tracking-wide">{medal().detail}</Text>
            </View>
          </View>
        </View>
      </Show>
      <View class="absolute left-0 right-0 bottom-1 flex-col items-center">
        <Text class="text-sm text-amber-300 tracking-wide">START  RETURN TO TITLE</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------

/** Two drifting star layers — positions are pure functions of the battle
 *  tick, so the parallax subsamples exactly like everything else. */
const STARS = [
  { x: 22, y: 30, layer: 1 }, { x: 61, y: 120, layer: 1 }, { x: 104, y: 70, layer: 1 },
  { x: 146, y: 180, layer: 1 }, { x: 178, y: 40, layer: 1 }, { x: 35, y: 210, layer: 1 },
  { x: 130, y: 236, layer: 1 }, { x: 88, y: 156, layer: 1 },
  { x: 44, y: 84, layer: 2 }, { x: 96, y: 20, layer: 2 }, { x: 152, y: 130, layer: 2 },
  { x: 14, y: 160, layer: 2 }, { x: 186, y: 220, layer: 2 }, { x: 70, y: 250, layer: 2 },
];

function Starfield(props: { game: Nightbloom }) {
  const g = props.game;
  return (
    <View debugName="Stars" class="absolute inset-0 overflow-hidden">
      <For each={STARS}>
        {(s) => (
          <View
            class={s.layer === 1 ? "absolute w-1 h-1 rounded-full bg-slate-700" : "absolute w-1 h-1 rounded-full bg-slate-500"}
            style={{ insetL: s.x, insetT: (s.y + Math.floor(g.fxTick() * (s.layer === 1 ? 0.35 : 0.7))) % FIELD.h }}
          />
        )}
      </For>
    </View>
  );
}

function PlayerNode(props: { game: Nightbloom }) {
  const g = props.game;
  const sprite = () => {
    const p = g.active();
    return PLANTS[p.kind].sprites[p.stage() - 1];
  };
  /** Pokemon manners: the avatar grows with its stage (the hitbox does not). */
  const size = () => AVATAR_SIZE[g.active().stage() - 1];
  const blink = () => (g.invuln() ? ((g.fxTick() >> 2) & 1) === 0 : true);
  /** Idle breath: a 1.2 s triangle-wave bob, a pure function of the tick. */
  const bob = () => {
    const ph = (g.fxTick() % 72) / 72;
    return (ph < 0.5 ? ph : 1 - ph) * 4 - 1;
  };
  /** Lean into the strafe, danmaku-style. */
  const lean = () => g.lastDx() * 9;
  return (
    <View
      debugName="Player"
      class="absolute items-center justify-center"
      style={{
        insetL: g.px() - FIELD.x0 - size() / 2,
        insetT: g.py() - FIELD.y0 - size() / 2,
        width: size(),
        height: size(),
        translateY: bob(),
        rotate: lean(),
        opacity: blink() ? 1 : 0.35,
      }}
    >
      <Image class="w-full h-full" src={sprite()} style={{ scaleX: g.facing() * PLANTS[g.active().kind].artFacing }} />
      <Show when={g.focus()}>
        <View class="absolute w-1 h-1 rounded-full bg-white" style={{ insetL: size() / 2 - 2, insetT: size() / 2 - 2 }} />
      </Show>
    </View>
  );
}

function FoeNode(props: { game: Nightbloom; foeId: number }) {
  const g = props.game;
  const foe = () => g.foes().find((f) => f.id === props.foeId);
  return (
    <Show when={foe()} keyed>
      {(f) => {
        const def = FOES[f.kind];
        return (
          <View
            debugName="Foe"
            class="absolute items-center"
            style={{ insetL: f.x() - FIELD.x0 - 13, insetT: f.y() - FIELD.y0 - 13, width: 26, height: 30 }}
          >
            <Image class="w-[26] h-[26]" src={def.sprites[f.stage - 1]} />
            <View class="absolute left-1 right-1 top-0 h-1 rounded-sm bg-[#02061799]">
              <View
                class="h-1 rounded-sm bg-red-400 origin-left w-full"
                style={{ scaleX: Math.max(0, f.hp() / def.hp[f.stage - 1]) }}
              />
            </View>
          </View>
        );
      }}
    </Show>
  );
}

function BossNode(props: { game: Nightbloom }) {
  const g = props.game;
  return (
    <Show when={g.boss()} keyed>
      {(b) => {
        const phase = () => b.def.phases[b.phase()];
        const size = () => phase().size;
        /** 0..1 metamorphosis progress (24 ticks), -1 when settled. */
        const morph = () => {
          const at = g.bossFlash();
          if (at < 0) return -1;
          const age = g.fxTick() - at;
          return age >= 0 && age < 24 ? age / 24 : -1;
        };
        return (
          <View
            debugName="Boss"
            class="absolute items-center justify-center"
            style={{
              insetL: b.x() - FIELD.x0 - size() / 2,
              insetT: b.y() - FIELD.y0 - size() / 2,
              width: size(),
              height: size(),
              scale: morph() >= 0 ? 1.45 - morph() * 0.45 : 1,
            }}
          >
            <Image class="w-full h-full" src={phase().sprite} />
            <Show when={morph() >= 0}>
              <View
                class="absolute border-2 border-pink-300"
                style={{
                  width: 20 + morph() * 90,
                  height: 20 + morph() * 90,
                  radius: 10 + morph() * 45,
                  insetL: size() / 2 - 10 - morph() * 45,
                  insetT: size() / 2 - 10 - morph() * 45,
                  opacity: 1 - morph(),
                }}
              />
            </Show>
          </View>
        );
      }}
    </Show>
  );
}

function EnemyShotNode(props: { game: Nightbloom; shotId: number }) {
  const g = props.game;
  const shot = () => g.enemyShots().find((s) => s.id === props.shotId);
  return (
    <Show when={shot()} keyed>
      {(s) =>
        s.kind === "mochi" ? (
          <Image
            class="absolute w-[12] h-[12]"
            src="shot-mochi.png"
            style={{ insetL: s.x() - FIELD.x0 - 6, insetT: s.y() - FIELD.y0 - 6 }}
          />
        ) : (
          <View
            class={
              s.kind === "pink"
                ? "absolute w-2 h-2 rounded-full bg-pink-300 border border-pink-100"
                : s.kind === "cyan"
                  ? "absolute w-2 h-2 rounded-full bg-cyan-300 border border-cyan-100"
                  : "absolute w-2 h-2 rounded-full bg-amber-300 border border-amber-100"
            }
            style={{ insetL: s.x() - FIELD.x0 - 4, insetT: s.y() - FIELD.y0 - 4 }}
          />
        )
      }
    </Show>
  );
}

function PlayerShotNode(props: { game: Nightbloom; shotId: number }) {
  const g = props.game;
  const shot = () => g.playerShots().find((s) => s.id === props.shotId);
  return (
    <Show when={shot()} keyed>
      {(s) =>
        s.kind === "petal" ? (
          <View class="absolute w-1 h-2 rounded-full bg-pink-200" style={{ insetL: s.x() - FIELD.x0 - 2, insetT: s.y() - FIELD.y0 - 4 }} />
        ) : s.kind === "banana" ? (
          <Image
            class="absolute w-[14] h-[14]"
            src="shot-banana.png"
            style={{
              insetL: s.x() - FIELD.x0 - 7,
              insetT: s.y() - FIELD.y0 - 7,
              rotate: ((g.fxTick() * 9 + s.id * 40) % 360),
            }}
          />
        ) : (
          <Image
            class="absolute w-[12] h-[12]"
            src={SHOTS.orb.sprite}
            style={{ insetL: s.x() - FIELD.x0 - 6, insetT: s.y() - FIELD.y0 - 6 }}
          />
        )
      }
    </Show>
  );
}

function FxNode(props: { game: Nightbloom; fx: FloatFx }) {
  const age = () => Math.min(1, Math.max(0, (props.game.fxTick() - props.fx.born) / FX_LIFE));
  const cls = () => {
    if (props.fx.tone === "lumen") return "text-xs text-amber-300 font-bold";
    if (props.fx.tone === "ward") return "text-xs text-cyan-300 font-bold";
    if (props.fx.tone === "evolve") return "text-xs text-pink-300 font-bold";
    return "text-xs text-red-300 font-bold";
  };
  return (
    <View
      class="absolute"
      style={{ insetL: props.fx.x - FIELD.x0 - 10, insetT: props.fx.y - FIELD.y0, translateY: -12 * age(), opacity: 1 - age() }}
    >
      <Text class={cls()}>{props.fx.text}</Text>
    </View>
  );
}

function Field(props: { game: Nightbloom }) {
  const g = props.game;
  return (
    <View
      debugName="Field"
      class="absolute rounded-sm border border-slate-800 bg-[#0b1023] overflow-hidden"
      style={{ insetL: FIELD.x0 - 1, insetT: FIELD.y0 - 1, width: FIELD.w + 2, height: FIELD.h + 2 }}
    >
      <Starfield game={g} />
      <View class="absolute left-0 right-0 h-[1] bg-[#33415566]" style={{ insetT: POC_Y - FIELD.y0 }} />
      <For each={g.motes()}>
        {(m) => (
          <Image class="absolute w-[10] h-[10]" src="mote.png" style={{ insetL: m.x() - FIELD.x0 - 5, insetT: m.y() - FIELD.y0 - 5 }} />
        )}
      </For>
      <For each={g.foes()}>{(f) => <FoeNode game={g} foeId={f.id} />}</For>
      <BossNode game={g} />
      <For each={g.playerShots()}>{(s) => <PlayerShotNode game={g} shotId={s.id} />}</For>
      <PlayerNode game={g} />
      <For each={g.enemyShots()}>{(s) => <EnemyShotNode game={g} shotId={s.id} />}</For>
      <For each={g.fxs()}>{(f) => <FxNode game={g} fx={f} />}</For>
      <Show when={g.wilting()}>
        <View
          class="absolute left-0 right-0 flex-col items-center gap-1"
          style={{ insetT: 96, opacity: ((g.fxTick() >> 3) & 1) === 0 ? 1 : 0.4 }}
        >
          <Text class="text-lg text-red-300 font-bold tracking-wide">LAST BREATH</Text>
          <Text class="text-xs text-red-200 tracking-wide">{"SWITCH NOW  O / L / R   " + g.wiltSeconds() + "s"}</Text>
        </View>
      </Show>
      <Show when={g.boss()} keyed>
        {(b) => (
          <View class="absolute left-1 right-1 top-1 flex-col gap-1">
            <View class="h-1 rounded-sm bg-[#02061799]">
              <View
                class="h-1 rounded-sm bg-red-400 origin-left w-full"
                style={{ scaleX: Math.max(0, b.hp() / b.def.phases[b.phase()].hp) }}
              />
            </View>
          </View>
        )}
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Side panels
// ---------------------------------------------------------------------------

/** Long lines in the narrow panels scroll like a ticker instead of
 *  clipping: two copies loop leftward, driven by the battle tick (so the
 *  marquee subsamples exactly like everything else). Short lines hold
 *  still. Width is estimated from the glyph count. */
function Marquee(props: { game: Nightbloom; text: string; cls: string; width: number }) {
  const textW = () => props.text.length * 7;
  const scroll = () => {
    if (textW() <= props.width) return 0;
    const span = textW() + 24;
    return -((props.game.fxTick() * 0.6) % span);
  };
  return (
    <View class="overflow-hidden" style={{ width: props.width, height: 16 }}>
      <View class="flex-row gap-6" style={{ translateX: scroll() }}>
        <Text class={props.cls}>{props.text}</Text>
        <Show when={textW() > props.width}>
          <Text class={props.cls}>{props.text}</Text>
        </Show>
      </View>
    </View>
  );
}

function LeftPanel(props: { game: Nightbloom }) {
  const g = props.game;
  const phaseName = () => {
    if (g.phase() === "dusk") return "DUSK";
    if (g.phase() === "midnight") return "MIDNIGHT";
    return "WITCHING HOUR";
  };
  return (
    <View
      debugName="LeftPanel"
      class="absolute flex-col gap-1 px-2 py-2"
      style={{ insetL: PANEL_L.x0, insetT: 0, width: PANEL_L.w, height: 272 }}
    >
      <Text class="text-lg text-pink-200 font-bold tracking-wide">NIGHTBLOOM</Text>
      <Text class="text-xs text-slate-500 tracking-wide">THE ETERNAL NIGHT</Text>
      <View class="flex-col gap-1 mt-2 p-2 rounded-md border border-slate-800 bg-[#020617aa]">
        <Text class="text-xs text-violet-300 tracking-wide">{phaseName()}</Text>
        <Text class="text-xs text-slate-400">{"WAVE " + g.waveIdx() + "/" + WAVES.length}</Text>
        <Text class="text-xs text-slate-400">{String(g.second()) + "s TO DAWN?"}</Text>
      </View>
      <Show when={g.augury() !== ""}>
        <View class="flex-col gap-1 p-2 rounded-md border border-violet-900 bg-[#020617aa]">
          <Text class="text-xs text-violet-300 tracking-wide">AUGURY</Text>
          <Marquee game={g} text={g.augury()} cls="text-xs text-slate-400" width={102} />
        </View>
      </Show>
      <Show when={g.boss()} keyed>
        {(b) => (
          <View class="flex-col gap-1 p-2 rounded-md border border-red-900 bg-[#020617aa]">
            <Marquee game={g} text={b.def.name} cls="text-xs text-red-300 tracking-wide" width={102} />
            <Marquee game={g} text={b.def.phases[b.phase()].card} cls="text-xs text-slate-300" width={102} />
            <Text class="text-xs text-slate-500">{"TIMEOUT " + g.bossCardSeconds() + "s"}</Text>
          </View>
        )}
      </Show>
      <View class="grow" />
      <Text class="text-xs text-slate-600">HOLD X FIRE  [] FOCUS</Text>
      <Text class="text-xs text-slate-600">{"O / L / R SWITCH  /\\ SPELL"}</Text>
      <Text class="text-xs text-slate-600">SELECT CODEX</Text>
    </View>
  );
}

/** The reveal's particle tail: offsets grow quadratically so the dust is
 *  densest right behind the shine and thins with distance; rows and colors
 *  are scattered by index. A constant table — the animation is pure
 *  translateX off the reveal progress. */
const SWEEP_TAIL = Array.from({ length: 12 }, (_, i) => ({
  back: 5 + i * i * 0.55 + i * 2,
  y: [4, 22, 12, 28, 8, 18, 26, 6, 15, 24, 10, 20][i],
  cls:
    i % 3 === 0
      ? "absolute w-1 h-1 rounded-full bg-pink-300"
      : i % 3 === 1
        ? "absolute w-1 h-1 rounded-full bg-cyan-300"
        : "absolute w-1 h-1 rounded-full bg-amber-300",
}));

function RosterCard(props: { game: Nightbloom; idx: number; plant: PlantState }) {
  const g = props.game;
  const p = props.plant;
  const def = PLANTS[p.kind];
  const isActive = () => g.activeIdx() === props.idx;
  const wilted = () => p.hp() <= 0;
  const cardClass = () => {
    if (wilted()) return "relative flex-row items-center gap-1 p-1 rounded-md border border-slate-800 bg-slate-900 opacity-40 overflow-hidden";
    if (isActive() && g.wilting()) return "relative flex-row items-center gap-1 p-1 rounded-md border border-red-400 bg-slate-800 overflow-hidden";
    if (isActive()) return "relative flex-row items-center gap-1 p-1 rounded-md border border-amber-300 bg-slate-800 overflow-hidden";
    return "relative flex-row items-center gap-1 p-1 rounded-md border border-slate-700 bg-slate-900 overflow-hidden";
  };
  /** 0..1 progress of the rainbow reveal (48 ticks), -1 when not playing. */
  const reveal = () => {
    const at = p.unlockedAt();
    if (at < 0) return -1;
    const age = g.fxTick() - at;
    return age >= 0 && age < 48 ? age / 48 : -1;
  };
  return (
    <Show
      when={p.unlocked()}
      fallback={
        <View class="flex-row items-center gap-1 p-1 rounded-md border border-slate-800 bg-[#0b1023] opacity-60">
          <View class="w-[20] h-[20] items-center justify-center">
            <Text class="text-sm text-slate-500 font-bold">?</Text>
          </View>
          <View class="flex-col gap-1 grow">
            <Text class="text-xs text-slate-600">? ? ?</Text>
            <View class="h-1 rounded-sm bg-[#02061799]" />
          </View>
        </View>
      }
    >
    <View class={cardClass()}>
      <Show when={reveal() >= 0}>
        <View class="absolute inset-0 rounded-md overflow-hidden">
          {/* the slanted shine head */}
          <View
            class="absolute w-[14] bg-gradient-to-r from-pink-400 to-cyan-300 opacity-70"
            style={{ insetT: -8, height: 52, rotate: 18, translateX: -20 + reveal() * 150 }}
          />
          <View
            class="absolute w-[6] bg-gradient-to-r from-amber-300 to-pink-400 opacity-60"
            style={{ insetT: -8, height: 52, rotate: 18, translateX: -32 + reveal() * 150 }}
          />
          {/* the particle tail — spacing widens away from the head */}
          <For each={SWEEP_TAIL}>
            {(pt) => (
              <View
                class={pt.cls}
                style={{
                  insetT: pt.y,
                  translateX: -20 + reveal() * 150 - pt.back,
                  opacity: Math.max(0, 0.9 - pt.back / 60),
                }}
              />
            )}
          </For>
        </View>
      </Show>
      <Image class="w-[20] h-[20]" src={def.sprites[p.stage() - 1]} />
      <View class="flex-col gap-1 grow">
        <View class="flex-row justify-between items-center">
          <Text class="text-xs text-slate-200">{def.stageNames[p.stage() - 1]}</Text>
          <View class="flex-row gap-[1]">
            <View class={p.stage() >= 1 ? "w-1 h-1 rounded-full bg-pink-300" : "w-1 h-1 rounded-full bg-slate-700"} />
            <View class={p.stage() >= 2 ? "w-1 h-1 rounded-full bg-pink-300" : "w-1 h-1 rounded-full bg-slate-700"} />
            <View class={p.stage() >= 3 ? "w-1 h-1 rounded-full bg-pink-300" : "w-1 h-1 rounded-full bg-slate-700"} />
          </View>
        </View>
        <View class="h-1 rounded-sm bg-[#02061799]">
          <View
            class="h-1 rounded-sm bg-emerald-400 origin-left w-full"
            style={{ scaleX: Math.max(0, p.hp() / def.hp[p.stage() - 1]) }}
          />
        </View>
      </View>
    </View>
    </Show>
  );
}

function RightPanel(props: { game: Nightbloom }) {
  const g = props.game;
  return (
    <View
      debugName="RightPanel"
      class="absolute flex-col gap-1 px-2 py-2"
      style={{ insetL: PANEL_R.x0, insetT: 0, width: PANEL_R.w, height: 272 }}
    >
      <View class="flex-row justify-between items-end">
        <Text class="text-xs text-slate-500 tracking-wide">SCORE</Text>
        <Text class="text-sm text-amber-200 font-bold">{String(g.score())}</Text>
      </View>
      <View class="flex-row justify-between items-end">
        <Text class="text-xs text-slate-500 tracking-wide">GRAZE</Text>
        <Text class="text-xs text-cyan-300">{String(g.graze())}</Text>
      </View>
      <View class="flex-col gap-1 pt-1">
        <For each={g.roster}>{(p, i) => <RosterCard game={g} idx={i()} plant={p} />}</For>
      </View>
      <View class="grow" />
      <Show when={g.active().kind === "primrose"}>
        <View class="flex-row items-center gap-1 p-1 rounded-md border border-slate-800 bg-[#020617aa]">
          <Text class="text-xs text-slate-500 tracking-wide">BANANAS</Text>
          <For each={[0, 1, 2]}>
            {(i) => (
              <Image
                class="w-[12] h-[12]"
                src="shot-banana.png"
                style={{ opacity: g.playerShots().filter((sh) => sh.kind === "banana").length > i ? 0.25 : 1 }}
              />
            )}
          </For>
        </View>
      </Show>
      <View class="flex-row items-center gap-2 p-1 rounded-md border border-slate-800 bg-[#020617aa]">
        <View
          class="w-4 h-4 bg-amber-300"
          style={{ arcStart: 0, arcSweep: Math.max(8, g.active().spellReady() * 360), arcWidth: 2 }}
        />
        <View class="flex-col">
          <Text class="text-xs text-amber-200 tracking-wide">{PLANTS[g.active().kind].spell.name}</Text>
          <Text class="text-xs text-slate-500">{g.active().spellReady() >= 1 ? "READY" : "CHARGING"}</Text>
        </View>
      </View>
    </View>
  );
}

function ToastStack(props: { game: Nightbloom }) {
  return (
    <View debugName="Toasts" class="absolute flex-col items-center gap-1" style={{ insetL: FIELD.x0, insetT: 24, width: FIELD.w }}>
      <For each={props.game.toasts()}>
        {(t) => (
          <View class="px-2 py-1 rounded-sm bg-[#0f172acc] border border-violet-800">
            <Text class="text-xs text-violet-200 tracking-wide">{t.text}</Text>
          </View>
        )}
      </For>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Codex — the almanac of laws (SELECT)
// ---------------------------------------------------------------------------

/** Text does not soft-wrap on the native host — the book is typeset by
 *  hand into short lines, and data laws are split at a word boundary. */
function splitLine(text: string, at: number): [string, string] {
  if (text.length <= at) return [text, ""];
  const cut = text.lastIndexOf(" ", at);
  return cut <= 0 ? [text, ""] : [text.slice(0, cut), text.slice(cut + 1)];
}

function LawLines(props: { text: string; cls: string }) {
  const parts = () => splitLine(props.text, 32);
  return (
    <View class="flex-col">
      <Text class={props.cls}>{parts()[0]}</Text>
      <Show when={parts()[1] !== ""}>
        <Text class={props.cls}>{parts()[1]}</Text>
      </Show>
    </View>
  );
}

const MANUAL_CONTROLS = [
  "ARROWS   FLY, 8-WAY",
  "X HOLD   FIRE",
  "[] HOLD  FOCUS: SLOW + HITBOX",
  "O OR R   NEXT WAKING FORM",
  "L        PREVIOUS FORM",
  "/\\       THE PILOT'S SPELL CARD",
  "START    PAUSE",
];
const MANUAL_BREATH = [
  "PILOT DOWN? SWITCH WITHIN 1.5s",
  "OR THE RUN ENDS. NOBODY ELSE",
  "AWAKE MEANS IT ENDS AT ONCE.",
];
const MANUAL_NIGHT = [
  "SURVIVE TO DAWN: NINE WAVES,",
  "A MIDBOSS, AND THE DIVA'S",
  "THREE CARDS AT THE WITCHING",
  "HOUR. EVERY CARD CHANGES HER.",
];
const MANUAL_GROWTH = [
  "GLOW COMES FROM WOUNDS DEALT,",
  "MOTES TAKEN, BULLETS GRAZED.",
  "STAGES I-II-III: BIGGER FORMS,",
  "WIDER PATTERNS. ABOVE THE HIGH",
  "LINE ALL MOTES COME TO YOU.",
  "SPELLS CLEAR BULLETS, TOO.",
];

function CodexManual() {
  return (
    <View debugName="CodexManual" class="absolute inset-0 bg-[#020617fa] flex-col px-4 py-2 gap-1">
      <View class="flex-row justify-between items-end">
        <Text class="text-lg text-pink-200 font-bold tracking-wide">THE PILOT'S MANUAL</Text>
        <Text class="text-xs text-slate-500">SELECT  NEXT PAGE</Text>
      </View>
      <View class="flex-row gap-3 pt-1">
        <View class="flex-col gap-1" style={{ width: 218 }}>
          <Text class="text-xs text-cyan-300 tracking-wide">CONTROLS</Text>
          <For each={MANUAL_CONTROLS}>{(l) => <Text class="text-xs text-slate-300">{l}</Text>}</For>
          <Text class="text-xs text-red-300 tracking-wide pt-1">THE LAST BREATH</Text>
          <For each={MANUAL_BREATH}>{(l) => <Text class="text-xs text-slate-400">{l}</Text>}</For>
        </View>
        <View class="flex-col gap-1" style={{ width: 218 }}>
          <Text class="text-xs text-violet-300 tracking-wide">THE NIGHT</Text>
          <For each={MANUAL_NIGHT}>{(l) => <Text class="text-xs text-slate-400">{l}</Text>}</For>
          <Text class="text-xs text-amber-300 tracking-wide pt-1">GROWTH</Text>
          <For each={MANUAL_GROWTH}>{(l) => <Text class="text-xs text-slate-400">{l}</Text>}</For>
        </View>
      </View>
    </View>
  );
}

function CodexBestiary() {
  return (
    <View debugName="CodexBestiary" class="absolute inset-0 bg-[#020617fa] flex-col px-4 py-2 gap-1">
      <View class="flex-row justify-between items-end">
        <Text class="text-lg text-pink-200 font-bold tracking-wide">FORMS AND FOES</Text>
        <Text class="text-xs text-slate-500">SELECT  CLOSE</Text>
      </View>
      <View class="flex-row gap-3 pt-1">
        <View class="flex-col gap-1" style={{ width: 218 }}>
          <Text class="text-xs text-cyan-300 tracking-wide">FORMS -- BY THEIR OWN WORK</Text>
          <For each={PLANT_ORDER}>
            {(id) => (
              <View class="flex-col">
                <Text class="text-xs text-slate-200">{PLANTS[id].name}</Text>
                <LawLines text={PLANTS[id].law} cls="text-xs text-slate-500" />
              </View>
            )}
          </For>
          <Text class="text-xs text-slate-400 pt-1">ONLY THE CATNIP FLIES AT DUSK.</Text>
          <Text class="text-xs text-slate-400">ASCEND ONCE: THE SAPLING WAKES.</Text>
          <Text class="text-xs text-slate-400">FELL THE UMBRELLA FOR THE APE.</Text>
        </View>
        <View class="flex-col gap-1" style={{ width: 218 }}>
          <Text class="text-xs text-red-300 tracking-wide">FOES -- WITH THE HOUR</Text>
          <For each={FOE_ORDER}>
            {(id) => (
              <View class="flex-col">
                <Text class="text-xs text-slate-200">{FOES[id].name}</Text>
                <LawLines text={FOES[id].law} cls="text-xs text-slate-500" />
              </View>
            )}
          </For>
          <Text class="text-xs text-slate-400 pt-1">DUSK I, MIDNIGHT II, WITCHING III.</Text>
          <Text class="text-xs text-slate-400">SPARED FOES DRIFT OFF-SCREEN.</Text>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Battle screen
// ---------------------------------------------------------------------------

function BattleScreen(props: { game: Nightbloom }) {
  const g = props.game;
  return (
    <View debugName="Battle" class="absolute inset-0 bg-slate-950">
      <LeftPanel game={g} />
      <Field game={g} />
      <RightPanel game={g} />
      <ToastStack game={g} />
      <Show when={g.paused()}>
        <View class="absolute inset-0 bg-[#020617b3] items-center justify-center flex-col gap-1">
          <Text class="text-2xl text-slate-100 font-bold tracking-wide">PAUSED</Text>
          <Text class="text-xs text-slate-400">START  RESUME</Text>
        </View>
      </Show>
      <Show when={g.codexPage() === 1}>
        <CodexManual />
      </Show>
      <Show when={g.codexPage() === 2}>
        <CodexBestiary />
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function Nightbloom() {
  const game = createNightbloom();
  onFrame((buttons) => game.frame(buttons));
  return (
    <Screen debugName="NightbloomScreen" class="relative w-full h-full bg-slate-950 overflow-hidden">
      <Show when={game.outcome() === "title"}>
        <TitleScreen />
      </Show>
      <Show when={game.outcome() === "battle"}>
        <BattleScreen game={game} />
      </Show>
      <Show when={game.outcome() === "dawn"}>
        <EndScreen game={game} win={true} />
      </Show>
      <Show when={game.outcome() === "eternal"}>
        <EndScreen game={game} win={false} />
      </Show>
    </Screen>
  );
}
