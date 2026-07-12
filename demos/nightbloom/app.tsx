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

import { For, Show, createEffect, onCleanup } from "solid-js";
import { Image, Screen, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import * as hot from "@pocketjs/framework/hot";
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
import {
  createNightbloom,
  FX_LIFE,
  MAX_ENEMY_SHOTS,
  MAX_MOTES,
  PRIMROSE_UNLOCK_MOTES,
  STAMP_AT,
  STAMP_IMPACT,
  type EnemyShot,
  type FloatFx,
  type FoeInst,
  type Nightbloom,
  type PlantState,
  type PlayerShot,
} from "./engine.ts";

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

function DeclarativeStarfield(props: { game: Nightbloom }) {
  const g = props.game;
  const nodes: Array<NodeMirror | undefined> = [];
  const syncStar = (i: number, tick: number) => {
    const s = STARS[i];
    hot.prop(nodes[i], "translateY", (s.y + Math.floor(tick * (s.layer === 1 ? 0.35 : 0.7))) % FIELD.h);
  };
  const syncStars = () => {
    const tick = g.fxTick();
    for (let i = 0; i < STARS.length; i++) syncStar(i, tick);
  };
  onFrame(syncStars);
  return (
    <View debugName="Stars" class="absolute inset-0 overflow-hidden">
      <For each={STARS}>
        {(s, i) => (
          <View
            class={s.layer === 1 ? "absolute w-1 h-1 rounded-full bg-slate-700" : "absolute w-1 h-1 rounded-full bg-slate-500"}
            nodeRef={(node) => {
              const index = i();
              nodes[index] = node;
              syncStar(index, g.fxTick());
            }}
            style={{ insetL: s.x, insetT: 0, translateY: s.y }}
          />
        )}
      </For>
    </View>
  );
}

function NativeStarfield(props: { game: Nightbloom }) {
  let layer: NodeMirror | undefined;
  let lastTick = -2;
  const batch = hot.createParticleBatch(STARS.length);
  const floats = batch.floats;
  const words = batch.words;
  for (let i = 0; i < STARS.length; i++) {
    const at = i * 4;
    floats[at + 2] = 4;
    words[at + 3] = STARS[i].layer === 1 ? 0xff554133 : 0xff8b7464;
  }
  const sync = () => {
    const tick = props.game.fxTick();
    // Stagger decorative/player batches opposite the enemy swarm so the
    // interpreter never packs every layer on the same frame.
    if (tick !== 0 && (tick & 1) === 0) return;
    if (tick === lastTick) return;
    lastTick = tick;
    for (let i = 0; i < STARS.length; i++) {
      const star = STARS[i];
      const at = i * 4;
      floats[at] = star.x;
      floats[at + 1] = (star.y + Math.floor(tick * (star.layer === 1 ? 0.35 : 0.7))) % FIELD.h;
    }
    batch.flushCount(layer, STARS.length);
  };
  onFrame(sync);
  return (
    <View
      debugName="Stars"
      class="absolute inset-0"
      nodeRef={(node) => {
        layer = node;
        sync();
      }}
    />
  );
}

function Starfield(props: { game: Nightbloom }) {
  return hot.supportsParticles() ? <NativeStarfield game={props.game} /> : <DeclarativeStarfield game={props.game} />;
}

function PlayerNode(props: { game: Nightbloom }) {
  const g = props.game;
  const native = hot.supportsParticles();
  let playerNode: NodeMirror | undefined;
  let playerImage: NodeMirror | undefined;
  let nativeAvatarSize = AVATAR_SIZE[0];
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
  const syncAppearance = () => {
    if (!native) return;
    const p = g.active();
    nativeAvatarSize = AVATAR_SIZE[p.stage() - 1];
    hot.prop(playerNode, "width", nativeAvatarSize);
    hot.prop(playerNode, "height", nativeAvatarSize);
    hot.prop(playerNode, "rotate", lean());
    hot.image(playerImage, PLANTS[p.kind].sprites[p.stage() - 1]);
    hot.prop(playerImage, "scaleX", g.facing() * PLANTS[p.kind].artFacing);
  };
  if (native) createEffect(syncAppearance);
  const syncPosition = () => {
    const avatarSize = native ? nativeAvatarSize : size();
    hot.position(
      playerNode,
      g.px() - FIELD.x0 - avatarSize / 2,
      g.py() - FIELD.y0 - avatarSize / 2 + bob(),
    );
    // Mercy-invuln blink rides the same imperative sync: while invulnerable
    // it flips every 4 ticks, and a Solid style binding would re-evaluate
    // the whole style object per frame for the entire window.
    hot.prop(playerNode, "opacity", blink() ? 1 : 0.35);
  };
  onFrame(syncPosition);
  return (
    <View
      debugName="Player"
      class="absolute left-0 top-0 items-center justify-center"
      nodeRef={(node) => {
        playerNode = node;
        syncAppearance();
        syncPosition();
      }}
      style={{
        width: native ? AVATAR_SIZE[0] : size(),
        height: native ? AVATAR_SIZE[0] : size(),
        rotate: native ? 0 : lean(),
      }}
    >
      <Image
        class="w-full h-full"
        src={native ? "p-catnip-1.png" : sprite()}
        nodeRef={(node) => {
          playerImage = node;
          syncAppearance();
        }}
        style={{ scaleX: native ? 1 : g.facing() * PLANTS[g.active().kind].artFacing }}
      />
      <Show when={g.focus()}>
        <View class="absolute w-1 h-1 rounded-full bg-white" style={{ insetL: size() / 2 - 2, insetT: size() / 2 - 2 }} />
      </Show>
    </View>
  );
}

interface MovingEntity {
  id: number;
  x: number;
  y: number;
}

interface Mover {
  node: NodeMirror;
  entity: MovingEntity;
  offsetX: number;
  offsetY: number;
  spinOffset?: number;
  index: number;
}

type MoverRegistry = Mover[];

/** Register one plain-state swarm entity for the Field's single imperative
 *  motion pass. This avoids one Solid effect + style-object allocation per
 *  entity and uses paint-only transforms, so movement never dirties layout. */
function moverRef(
  movers: MoverRegistry,
  entity: MovingEntity,
  offsetX: number,
  offsetY: number,
  spinOffset?: number,
): (node: NodeMirror) => void {
  let mover: Mover | undefined;
  onCleanup(() => {
    if (!mover) return;
    const last = movers.pop();
    if (last && last !== mover) {
      movers[mover.index] = last;
      last.index = mover.index;
    }
  });
  return (node) => {
    mover = { node, entity, offsetX, offsetY, spinOffset, index: movers.length };
    movers.push(mover);
  };
}

function initialMotion(entity: MovingEntity, offsetX: number, offsetY: number): { translateX: number; translateY: number } {
  return {
    translateX: entity.x - FIELD.x0 + offsetX,
    translateY: entity.y - FIELD.y0 + offsetY,
  };
}

function FoeNode(props: { foe: FoeInst; movers: MoverRegistry }) {
  const f = props.foe;
  const def = FOES[f.kind];
  return (
    <View
      debugName="Foe"
      class="absolute left-0 top-0 items-center"
      nodeRef={moverRef(props.movers, f, -13, -13)}
      style={{ ...initialMotion(f, -13, -13), width: 26, height: 30 }}
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
}

const FOE_POOL_SIZE = 6;
const FOE_POOL = Array.from({ length: FOE_POOL_SIZE }, (_, i) => i);

interface FoeSlot {
  root?: NodeMirror;
  image?: NodeMirror;
  hp?: NodeMirror;
  foeId?: number;
}

/** PSP keeps foe structure stable across waves. Spawning, death, and escape
 *  only repaint these slots, avoiding a full Taffy rebuild on combat beats. */
function NativeFoes(props: { game: Nightbloom; movers: MoverRegistry }) {
  const slots: FoeSlot[] = FOE_POOL.map(() => ({}));
  let visible = 0;
  const sync = () => {
    const foes = props.game.foes();
    const nextVisible = Math.min(foes.length, slots.length);
    for (let i = 0; i < nextVisible; i++) {
      const slot = slots[i];
      const foe = foes[i];
      const def = FOES[foe.kind];
      if (slot.foeId !== foe.id) {
        slot.foeId = foe.id;
        hot.image(slot.image, def.sprites[foe.stage - 1]);
        hot.prop(slot.root, "opacity", 1);
      }
      hot.position(slot.root, foe.x - FIELD.x0 - 13, foe.y - FIELD.y0 - 13);
      hot.prop(slot.hp, "scaleX", Math.max(0, foe.hp() / def.hp[foe.stage - 1]));
    }
    for (let i = nextVisible; i < visible; i++) {
      slots[i].foeId = undefined;
      hot.prop(slots[i].root, "opacity", 0);
    }
    visible = nextVisible;
  };
  onFrame(sync);
  return (
    <>
      <For each={FOE_POOL}>
        {(i) => (
          <View
            debugName="FoeSlot"
            class="absolute left-0 top-0 items-center"
            nodeRef={(node) => (slots[i].root = node)}
            style={{ width: 26, height: 30, opacity: 0 }}
          >
            <Image class="w-[26] h-[26]" src="f-wisp-1.png" nodeRef={(node) => (slots[i].image = node)} />
            <View class="absolute left-1 right-1 top-0 h-1 rounded-sm bg-[#02061799]">
              <View
                class="h-1 rounded-sm bg-red-400 origin-left w-full"
                nodeRef={(node) => (slots[i].hp = node)}
              />
            </View>
          </View>
        )}
      </For>
      <For each={props.game.foes().slice(FOE_POOL_SIZE)}>
        {(foe) => <FoeNode foe={foe} movers={props.movers} />}
      </For>
    </>
  );
}

function Foes(props: { game: Nightbloom; movers: MoverRegistry }) {
  return hot.supportsParticles()
    ? <NativeFoes game={props.game} movers={props.movers} />
    : <For each={props.game.foes()}>{(foe) => <FoeNode foe={foe} movers={props.movers} />}</For>;
}

function DeclarativeBossNode(props: { game: Nightbloom }) {
  const g = props.game;
  return (
    <Show when={g.boss()} keyed>
      {(b) => {
        const phase = () => b.def.phases[b.phase()];
        const size = () => phase().size;
        const left = () => (g.fxTick(), b.x - FIELD.x0 - size() / 2);
        const top = () => (g.fxTick(), b.y - FIELD.y0 - size() / 2);
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
              insetL: left(),
              insetT: top(),
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

const MAX_BOSS_SIZE = 66;

/** PSP keeps one pre-bound boss node alive for the whole battle. Position,
 *  phase size, sprite, and the entry flash are paint-only updates. */
function NativeBossNode(props: { game: Nightbloom }) {
  const g = props.game;
  let root: NodeMirror | undefined;
  let image: NodeMirror | undefined;
  let flash: NodeMirror | undefined;
  let visible = false;
  let sprite = "";
  let flashVisible = false;
  const sync = () => {
    const b = g.boss();
    if (!b) {
      if (visible) {
        visible = false;
        hot.prop(root, "opacity", 0);
      }
      if (flashVisible) {
        flashVisible = false;
        hot.prop(flash, "opacity", 0);
      }
      return;
    }
    const phase = b.def.phases[b.phase()];
    const age = g.fxTick() - g.bossFlash();
    const morph = age >= 0 && age < 24 ? age / 24 : -1;
    const pulse = morph >= 0 ? 1.45 - morph * 0.45 : 1;
    if (sprite !== phase.sprite) {
      sprite = phase.sprite;
      hot.image(image, sprite);
    }
    hot.position(root, b.x - FIELD.x0 - MAX_BOSS_SIZE / 2, b.y - FIELD.y0 - MAX_BOSS_SIZE / 2);
    hot.prop(root, "scale", phase.size / MAX_BOSS_SIZE * pulse);
    if (!visible) {
      visible = true;
      hot.prop(root, "opacity", 1);
    }
    if (morph >= 0) {
      flashVisible = true;
      hot.prop(flash, "scale", (20 + morph * 70) / 80);
      hot.prop(flash, "opacity", 1 - morph);
    } else if (flashVisible) {
      flashVisible = false;
      hot.prop(flash, "opacity", 0);
    }
  };
  onFrame(sync);
  return (
    <View
      debugName="BossSlot"
      class="absolute left-0 top-0 w-[66] h-[66] items-center justify-center"
      nodeRef={(node) => { root = node; sync(); }}
      style={{ opacity: 0 }}
    >
      <Image
        class="w-full h-full"
        src="boss-kasa.png"
        nodeRef={(node) => {
          image = node;
          sprite = "";
          sync();
        }}
      />
      <View
        class="absolute w-[80] h-[80] border-2 border-pink-300"
        nodeRef={(node) => (flash = node)}
        style={{ insetL: -7, insetT: -7, opacity: 0 }}
      />
    </View>
  );
}

function BossNode(props: { game: Nightbloom }) {
  return hot.supportsParticles() ? <NativeBossNode game={props.game} /> : <DeclarativeBossNode game={props.game} />;
}

function DeclarativeBossHealth(props: { game: Nightbloom }) {
  return (
    <Show when={props.game.boss()} keyed>
      {(b) => (
        <View class="absolute left-1 right-1 top-1 flex-col gap-1">
          <View class="h-1 rounded-sm bg-[#02061799]">
            <View
              class="h-1 rounded-sm bg-red-400 origin-left w-full"
              style={{ scaleX: (props.game.fxTick(), Math.max(0, b.hp / b.def.phases[b.phase()].hp)) }}
            />
          </View>
        </View>
      )}
    </Show>
  );
}

function NativeBossHealth(props: { game: Nightbloom }) {
  let root: NodeMirror | undefined;
  let fill: NodeMirror | undefined;
  let visible = false;
  const sync = () => {
    const b = props.game.boss();
    if (!b) {
      if (visible) {
        visible = false;
        hot.prop(root, "opacity", 0);
      }
      return;
    }
    hot.prop(fill, "scaleX", Math.max(0, b.hp / b.def.phases[b.phase()].hp));
    if (!visible) {
      visible = true;
      hot.prop(root, "opacity", 1);
    }
  };
  onFrame(sync);
  return (
    <View
      class="absolute left-1 right-1 top-1 flex-col gap-1"
      nodeRef={(node) => { root = node; sync(); }}
      style={{ opacity: 0 }}
    >
      <View class="h-1 rounded-sm bg-[#02061799]">
        <View class="h-1 rounded-sm bg-red-400 origin-left w-full" nodeRef={(node) => (fill = node)} />
      </View>
    </View>
  );
}

function BossHealth(props: { game: Nightbloom }) {
  return hot.supportsParticles()
    ? <NativeBossHealth game={props.game} />
    : <DeclarativeBossHealth game={props.game} />;
}

function EnemyShotNode(props: { shot: EnemyShot; movers: MoverRegistry }) {
  const s = props.shot;
  return s.kind === "mochi" ? (
    <Image
      class="absolute left-0 top-0 w-[12] h-[12]"
      src="shot-mochi.png"
      nodeRef={moverRef(props.movers, s, -6, -6)}
      style={initialMotion(s, -6, -6)}
    />
  ) : (
    <View
      class={
        s.kind === "pink"
          ? "absolute left-0 top-0 w-2 h-2 rounded-full bg-pink-300 border border-pink-100"
          : s.kind === "cyan"
            ? "absolute left-0 top-0 w-2 h-2 rounded-full bg-cyan-300 border border-cyan-100"
            : "absolute left-0 top-0 w-2 h-2 rounded-full bg-amber-300 border border-amber-100"
      }
      nodeRef={moverRef(props.movers, s, -4, -4)}
      style={initialMotion(s, -4, -4)}
    />
  );
}

/** PSP: one retained node + one packed host call per frame. Other hosts keep
 *  the declarative nodes so browser rendering and deterministic tests need no
 *  new host capability. The fill loop writes the packed batch directly —
 *  at 48 bullets a push() closure call per particle is measurable QuickJS
 *  time on the hottest frames the game produces. */
function NativeEnemyShotLayer(props: { game: Nightbloom }) {
  let layer: NodeMirror | undefined;
  const batch = hot.createParticleBatch(MAX_ENEMY_SHOTS);
  const floats = batch.floats;
  const words = batch.words;
  const offX = FIELD.x0 + 4;
  const offY = FIELD.y0 + 4;
  for (let i = 0; i < batch.capacity; i++) floats[i * 4 + 2] = 8;
  let lastTick = -1;
  const sync = () => {
    const tick = props.game.fxTick();
    // The slowest boss bullets move < 1 px per simulation tick. Repainting
    // their retained batch at 30 Hz halves typed-array traffic while keeping
    // collision and simulation on the exact 60 Hz grid.
    if (tick !== 0 && (tick & 1) !== 0) return;
    if (tick === lastTick) return;
    lastTick = tick;
    const shots = props.game.enemyShots();
    let n = shots.length;
    if (n > batch.capacity) n = batch.capacity;
    for (let i = 0; i < n; i++) {
      const shot = shots[i];
      const at = i * 4;
      floats[at] = shot.x - offX;
      floats[at + 1] = shot.y - offY;
      words[at + 3] = shot.color;
    }
    batch.flushCount(layer, n);
  };
  onFrame(sync);
  return (
    <View
      debugName="EnemyShotLayer"
      class="absolute inset-0"
      nodeRef={(node) => {
        layer = node;
        sync();
      }}
    />
  );
}

function EnemyShots(props: { game: Nightbloom; movers: MoverRegistry }) {
  if (hot.supportsParticles()) return <NativeEnemyShotLayer game={props.game} />;
  return <For each={props.game.enemyShots()}>{(shot) => <EnemyShotNode shot={shot} movers={props.movers} />}</For>;
}

function PlayerShotNode(props: { shot: PlayerShot; movers: MoverRegistry }) {
  const s = props.shot;
  return s.kind === "banana" ? (
    <Image
      class="absolute left-0 top-0 w-[14] h-[14]"
      src="shot-banana.png"
      nodeRef={moverRef(props.movers, s, -7, -7, s.id * 40)}
      style={{
        ...initialMotion(s, -7, -7),
        rotate: s.id * 40 % 360,
      }}
    />
  ) : (
    <Image
      class="absolute left-0 top-0 w-[12] h-[12]"
      src={SHOTS.orb.sprite}
      nodeRef={moverRef(props.movers, s, -6, -6)}
      style={initialMotion(s, -6, -6)}
    />
  );
}

function NativePlayerShotLayer(props: { game: Nightbloom }) {
  let layer: NodeMirror | undefined;
  const batch = hot.createParticleBatch(28);
  const floats = batch.floats;
  const words = batch.words;
  const offX = FIELD.x0 + 5;
  const offY = FIELD.y0 + 5;
  for (let i = 0; i < batch.capacity; i++) {
    const at = i * 4;
    // The Image node's PixelLab texture is shared by the whole particle
    // batch. White keeps its authored pearl/prismatic palette intact; there is
    // still only one retained node and one packed host call per repaint.
    floats[at + 2] = 10;
    words[at + 3] = 0xffffffff;
  }
  let lastTick = -1;
  const sync = () => {
    const tick = props.game.fxTick();
    if (tick !== 0 && (tick & 1) === 0) return;
    if (tick === lastTick) return;
    lastTick = tick;
    const shots = props.game.playerShots();
    let n = 0;
    for (let i = 0; i < shots.length && n < batch.capacity; i++) {
      const shot = shots[i];
      if (shot.kind === "banana") continue;
      const at = n * 4;
      floats[at] = shot.x - offX;
      floats[at + 1] = shot.y - offY;
      n++;
    }
    batch.flushCount(layer, n);
  };
  onFrame(sync);
  return (
    <Image
      debugName="PlayerShotLayer"
      class="absolute left-0 top-0 w-0 h-0"
      src={SHOTS.orb.sprite}
      nodeRef={(node) => {
        layer = node;
        sync();
      }}
    />
  );
}

const BANANA_POOL = [0, 1, 2] as const;

function NativeBananas(props: { game: Nightbloom }) {
  const nodes: Array<NodeMirror | undefined> = [];
  let visible = 0;
  const sync = () => {
    const shots = props.game.playerShots();
    let nextVisible = 0;
    const spin = props.game.fxTick() * 9;
    for (let i = 0; i < shots.length && nextVisible < BANANA_POOL.length; i++) {
      const shot = shots[i];
      if (shot.kind !== "banana") continue;
      const node = nodes[nextVisible];
      hot.position(node, shot.x - FIELD.x0 - 7, shot.y - FIELD.y0 - 7);
      hot.prop(node, "rotate", (spin + shot.id * 40) % 360);
      hot.prop(node, "opacity", 1);
      nextVisible++;
    }
    for (let i = nextVisible; i < visible; i++) hot.prop(nodes[i], "opacity", 0);
    visible = nextVisible;
  };
  onFrame(sync);
  return (
    <For each={BANANA_POOL}>
      {(i) => (
        <Image
          class="absolute left-0 top-0 w-[14] h-[14]"
          src="shot-banana.png"
          nodeRef={(node) => { nodes[i] = node; sync(); }}
          style={{ opacity: 0 }}
        />
      )}
    </For>
  );
}

function PlayerShots(props: { game: Nightbloom; movers: MoverRegistry }) {
  if (!hot.supportsParticles()) {
    return <For each={props.game.playerShots()}>{(shot) => <PlayerShotNode shot={shot} movers={props.movers} />}</For>;
  }
  return (
    <>
      <NativePlayerShotLayer game={props.game} />
      <NativeBananas game={props.game} />
    </>
  );
}

function MoteNode(props: { mote: MovingEntity; movers: MoverRegistry }) {
  return (
    <Image
      class="absolute left-0 top-0 w-[10] h-[10]"
      src="mote.png"
      nodeRef={moverRef(props.movers, props.mote, -5, -5)}
      style={initialMotion(props.mote, -5, -5)}
    />
  );
}

function NativeMotes(props: { game: Nightbloom }) {
  let layer: NodeMirror | undefined;
  const batch = hot.createParticleBatch(MAX_MOTES);
  const floats = batch.floats;
  const words = batch.words;
  const offX = FIELD.x0 + 3;
  const offY = FIELD.y0 + 3;
  for (let i = 0; i < batch.capacity; i++) {
    const at = i * 4;
    floats[at + 2] = 6;
    words[at + 3] = 0xff7dd3fc;
  }
  let lastTick = -1;
  const sync = () => {
    const tick = props.game.fxTick();
    if (tick !== 0 && (tick & 1) === 0) return;
    if (tick === lastTick) return;
    lastTick = tick;
    const motes = props.game.motes();
    let n = motes.length;
    if (n > batch.capacity) n = batch.capacity;
    for (let i = 0; i < n; i++) {
      const mote = motes[i];
      const at = i * 4;
      floats[at] = mote.x - offX;
      floats[at + 1] = mote.y - offY;
    }
    batch.flushCount(layer, n);
  };
  onFrame(sync);
  return <View debugName="MoteLayer" class="absolute inset-0" nodeRef={(node) => { layer = node; sync(); }} />;
}

function Motes(props: { game: Nightbloom; movers: MoverRegistry }) {
  return hot.supportsParticles()
    ? <NativeMotes game={props.game} />
    : <For each={props.game.motes()}>{(mote) => <MoteNode mote={mote} movers={props.movers} />}</For>;
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

const FX_POOL = [0, 1, 2, 3] as const;

/** ABGR tone colors matching the declarative classes (amber/cyan/pink/red 300). */
const FX_TONE_COLORS: Record<FloatFx["tone"], number> = {
  lumen: 0xff4dd3fc,
  ward: 0xfff9e867,
  evolve: 0xffd4a8f9,
  hurt: 0xffa5a5fc,
};

interface FxSlot {
  root?: NodeMirror;
  text?: NodeMirror;
  fxId?: number;
}

/** PSP: float fx ("-13", "UP!") repaint four pre-mounted fixed-cell slots.
 *  Mounting one through Solid costs a structural frame AND its text shape
 *  costs a relayout — the frame trace shows each player hit as TWO ~85 ms
 *  frames (fx mount, then its unmount 0.9 s later) without this pool. */
function NativeFxLayer(props: { game: Nightbloom }) {
  const g = props.game;
  const slots: FxSlot[] = FX_POOL.map(() => ({}));
  let visible = 0;
  const sync = () => {
    const fxs = g.fxs();
    const n = Math.min(fxs.length, slots.length);
    if (n === 0 && visible === 0) return;
    const tick = g.fxTick();
    for (let i = 0; i < n; i++) {
      const fx = fxs[i];
      const slot = slots[i];
      const age = Math.min(1, Math.max(0, (tick - fx.born) / FX_LIFE));
      if (slot.fxId !== fx.id) {
        slot.fxId = fx.id;
        hot.text(slot.text, fx.text);
        hot.prop(slot.text, "textColor", FX_TONE_COLORS[fx.tone]);
      }
      hot.position(slot.root, fx.x - FIELD.x0 - 24, fx.y - FIELD.y0 - 12 * age);
      hot.prop(slot.root, "opacity", 1 - age);
    }
    for (let i = n; i < visible; i++) {
      slots[i].fxId = undefined;
      hot.prop(slots[i].root, "opacity", 0);
    }
    visible = n;
  };
  onFrame(sync);
  return (
    <For each={FX_POOL}>
      {(i) => (
        <View
          class="absolute left-0 top-0 items-center"
          nodeRef={(node) => (slots[i].root = node)}
          style={{ opacity: 0, width: 48, height: 14 }}
        >
          <Text
            class="text-xs text-red-300 font-bold text-center"
            nodeRef={(node) => (slots[i].text = node)}
            style={{ width: 48, height: 14 }}
          >-</Text>
        </View>
      )}
    </For>
  );
}

function FxLayer(props: { game: Nightbloom }) {
  return hot.supportsParticles()
    ? <NativeFxLayer game={props.game} />
    : <For each={props.game.fxs()}>{(f) => <FxNode game={props.game} fx={f} />}</For>;
}

function Field(props: { game: Nightbloom }) {
  const g = props.game;
  const movers: MoverRegistry = [];
  onFrame(() => {
    const spinTick = g.fxTick() * 9;
    for (let i = 0; i < movers.length; i++) {
      const mover = movers[i];
      hot.position(
        mover.node,
        mover.entity.x - FIELD.x0 + mover.offsetX,
        mover.entity.y - FIELD.y0 + mover.offsetY,
      );
      if (mover.spinOffset !== undefined) hot.prop(mover.node, "rotate", (spinTick + mover.spinOffset) % 360);
    }
  });
  onCleanup(() => (movers.length = 0));
  return (
    <View
      debugName="Field"
      class="absolute rounded-sm border border-slate-800 bg-[#0b1023] overflow-hidden"
      style={{ insetL: FIELD.x0 - 1, insetT: FIELD.y0 - 1, width: FIELD.w + 2, height: FIELD.h + 2 }}
    >
      <Starfield game={g} />
      <View class="absolute left-0 right-0 h-[1] bg-[#33415566]" style={{ insetT: POC_Y - FIELD.y0 }} />
      <Motes game={g} movers={movers} />
      <Foes game={g} movers={movers} />
      <BossNode game={g} />
      <PlayerShots game={g} movers={movers} />
      <PlayerNode game={g} />
      <EnemyShots game={g} movers={movers} />
      <FxLayer game={g} />
      <Show when={g.wilting()}>
        <View
          class="absolute left-0 right-0 flex-col items-center gap-1"
          style={{ insetT: 96, opacity: ((g.fxTick() >> 3) & 1) === 0 ? 1 : 0.4 }}
        >
          <Text class="text-lg text-red-300 font-bold tracking-wide">LAST BREATH</Text>
          <Text class="text-xs text-red-200 tracking-wide">{"SWITCH NOW  O / L / R   " + g.wiltSeconds() + "s"}</Text>
        </View>
      </Show>
      <BossHealth game={g} />
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
  let track: NodeMirror | undefined;
  const sync = () => {
    if (textW() <= props.width) {
      hot.position(track, 0, 0);
      return;
    }
    const span = textW() + 24;
    hot.position(track, -((props.game.fxTick() * 0.6) % span), 0);
  };
  onFrame(sync);
  return (
    <View class="overflow-hidden" style={{ width: props.width, height: 16 }}>
      <View class="flex-row gap-6" nodeRef={(node) => { track = node; sync(); }}>
        <Text class={props.cls}>{props.text}</Text>
        <Show when={textW() > props.width}>
          <Text class={props.cls}>{props.text}</Text>
        </Show>
      </View>
    </View>
  );
}

function DeclarativeBossPanel(props: { game: Nightbloom }) {
  const g = props.game;
  return (
    <Show when={g.boss()} keyed>
      {(b) => (
        <View class="flex-col gap-1 p-2 rounded-md border border-red-900 bg-[#020617aa]">
          <Marquee game={g} text={b.def.name} cls="text-xs text-red-300 tracking-wide" width={102} />
          <Marquee game={g} text={b.def.phases[b.phase()].card} cls="text-xs text-slate-300" width={102} />
          <Text class="text-xs text-slate-500">{"TIMEOUT " + g.bossCardSeconds() + "s"}</Text>
        </View>
      )}
    </Show>
  );
}

function NativeBossPanel(props: { game: Nightbloom }) {
  const g = props.game;
  let root: NodeMirror | undefined;
  let nameTrack: NodeMirror | undefined;
  let nameText: NodeMirror | undefined;
  let cardTrack: NodeMirror | undefined;
  let cardText: NodeMirror | undefined;
  let timeoutText: NodeMirror | undefined;
  const ticker = (track: NodeMirror | undefined, width: number) => {
    hot.position(track, width <= 102 ? 0 : -((g.fxTick() * 0.6) % (width + 24)), 0);
  };
  let lastTimeout = -1;
  let lastName = "";
  let lastCard = "";
  let nameWidth = 0;
  let cardWidth = 0;
  let visible = false;
  const sync = () => {
    const b = g.boss();
    if (!b) {
      if (visible) {
        visible = false;
        hot.prop(root, "opacity", 0);
      }
      return;
    }
    const name = b.def.name;
    const card = b.def.phases[b.phase()].card;
    if (name !== lastName) {
      lastName = name;
      nameWidth = name.length * 7;
      hot.text(nameText, name);
    }
    if (card !== lastCard) {
      lastCard = card;
      cardWidth = card.length * 7;
      hot.text(cardText, card);
    }
    // Gate on the integer BEFORE building the string: hot.text's own gate
    // would still cook a fresh template literal every frame.
    const timeoutS = g.bossCardSeconds();
    if (timeoutS !== lastTimeout) {
      lastTimeout = timeoutS;
      hot.text(timeoutText, `TIMEOUT ${timeoutS}s`);
    }
    if ((g.fxTick() & 1) === 0) {
      ticker(nameTrack, nameWidth);
      ticker(cardTrack, cardWidth);
    }
    if (!visible) {
      visible = true;
      hot.prop(root, "opacity", 1);
    }
  };
  onFrame(sync);
  return (
    <View
      class="flex-col gap-1 p-2 rounded-md border border-red-900 bg-[#020617aa]"
      nodeRef={(node) => { root = node; sync(); }}
      style={{ height: 62, opacity: 0 }}
    >
      <View class="overflow-hidden" style={{ width: 102, height: 16 }}>
        <View nodeRef={(node) => (nameTrack = node)} style={{ width: 200, height: 16 }}>
          <Text class="text-xs text-red-300 tracking-wide" nodeRef={(node) => (nameText = node)} style={{ width: 200, height: 16 }}>BOSS</Text>
        </View>
      </View>
      <View class="overflow-hidden" style={{ width: 102, height: 16 }}>
        <View nodeRef={(node) => (cardTrack = node)} style={{ width: 200, height: 16 }}>
          <Text class="text-xs text-slate-300" nodeRef={(node) => (cardText = node)} style={{ width: 200, height: 16 }}>SPELL CARD</Text>
        </View>
      </View>
      <Text class="text-xs text-slate-500" nodeRef={(node) => (timeoutText = node)} style={{ width: 102, height: 16 }}>TIMEOUT 0s</Text>
    </View>
  );
}

function BossPanel(props: { game: Nightbloom }) {
  return hot.supportsParticles()
    ? <NativeBossPanel game={props.game} />
    : <DeclarativeBossPanel game={props.game} />;
}

function DeclarativeNightClock(props: { game: Nightbloom }) {
  return <Text class="text-xs text-slate-400">{String(props.game.second()) + "s TO DAWN?"}</Text>;
}

/** A fixed native cell keeps the once-per-second clock repaint out of layout.
 *  Without it each second boundary adds a repeatable 3.5 ms core-tick spike. */
function NativeNightClock(props: { game: Nightbloom }) {
  let node: NodeMirror | undefined;
  let lastSecond = -1;
  const sync = () => {
    const second = props.game.second();
    if (second === lastSecond) return;
    lastSecond = second;
    hot.text(node, `${second}s TO DAWN?`);
  };
  onFrame(sync);
  return (
    <Text
      class="text-xs text-slate-400"
      nodeRef={(next) => {
        node = next;
        lastSecond = -1;
        sync();
      }}
      style={{ width: 102, height: 16 }}
    >0s TO DAWN?</Text>
  );
}

function NightClock(props: { game: Nightbloom }) {
  return hot.supportsParticles()
    ? <NativeNightClock game={props.game} />
    : <DeclarativeNightClock game={props.game} />;
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
        <NightClock game={g} />
      </View>
      <Show when={g.augury() !== ""}>
        <View class="flex-col gap-1 p-2 rounded-md border border-violet-900 bg-[#020617aa]">
          <Text class="text-xs text-violet-300 tracking-wide">AUGURY</Text>
          <Marquee game={g} text={g.augury()} cls="text-xs text-slate-400" width={102} />
        </View>
      </Show>
      <BossPanel game={g} />
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
  const native = hot.supportsParticles();
  let root: NodeMirror | undefined;
  let hpFill: NodeMirror | undefined;
  let lockedOverlay: NodeMirror | undefined;
  let lockedProgress: NodeMirror | undefined;
  const isActive = () => g.activeIdx() === props.idx;
  const wilted = () => p.hp() <= 0;
  const cardClass = () => {
    if (native) return "relative flex-row items-center gap-1 p-1 rounded-md border border-slate-700 bg-slate-900 overflow-hidden";
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
  let lastState = "";
  let lastHp = -1;
  const syncNativeRoster = () => {
    if (native) {
      const hp = p.hp();
      const active = isActive();
      const unlocked = p.unlocked();
      const state = !unlocked ? "locked" : hp <= 0 ? "wilted" : active && g.wilting() ? "danger" : active ? "active" : "idle";
      if (state !== lastState) {
        lastState = state;
        hot.prop(root, "opacity", state === "wilted" ? 0.4 : 1);
        hot.prop(root, "borderColor", state === "danger" ? 0xff7171f8 : state === "active" ? 0xff4dd3fc : 0xff554133);
        hot.prop(root, "bgColor", state === "danger" || state === "active" ? 0xff3b291e : 0xff2a170f);
        hot.prop(lockedOverlay, "opacity", unlocked ? 0 : 1);
      }
      if (!unlocked) {
        hot.text(lockedProgress, `MOTES ${g.motesCollected()}/${PRIMROSE_UNLOCK_MOTES}`);
      }
      const scale = Math.max(0, hp / def.hp[p.stage() - 1]);
      if (scale !== lastHp) {
        lastHp = scale;
        hot.prop(hpFill, "scaleX", scale);
      }
    }
  };
  if (native) createEffect(syncNativeRoster);
  return (
    <Show
      when={native || p.unlocked()}
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
    <View
      class={cardClass()}
      nodeRef={(node) => {
        root = node;
        lastState = "";
        syncNativeRoster();
      }}
    >
      <Show when={!native && reveal() >= 0}>
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
          {native ? (
            <View
              class="h-1 rounded-sm bg-emerald-400 origin-left w-full"
              nodeRef={(node) => {
                hpFill = node;
                lastHp = -1;
                syncNativeRoster();
              }}
            />
          ) : (
            <View
              class="h-1 rounded-sm bg-emerald-400 origin-left w-full"
              style={{ scaleX: Math.max(0, p.hp() / def.hp[p.stage() - 1]) }}
            />
          )}
        </View>
      </View>
      {native && p.kind === "primrose" && (
        <Text
          class="absolute inset-0 text-xs text-slate-500 text-center bg-[#0b1023]"
          nodeRef={(node) => {
            lockedOverlay = node;
            lockedProgress = node;
            lastState = "";
            syncNativeRoster();
          }}
          style={{ height: 28, paddingT: 7 }}
        >MOTES 0/28</Text>
      )}
    </View>
    </Show>
  );
}

/** Score + graze counters. On PSP these change on nearly every boss-window
 *  frame (graze pays +10 a bullet), and a Solid text binding per change costs
 *  effect + relayout; fixed-size right-aligned cells + hot.text keep every
 *  update paint-only. Other hosts keep the declarative texts. */
function DeclarativeScoreboard(props: { game: Nightbloom }) {
  const g = props.game;
  return (
    <>
      <View class="flex-row justify-between items-end">
        <Text class="text-xs text-slate-500 tracking-wide">SCORE</Text>
        <Text class="text-sm text-amber-200 font-bold">{String(g.score())}</Text>
      </View>
      <View class="flex-row justify-between items-end">
        <Text class="text-xs text-slate-500 tracking-wide">GRAZE</Text>
        <Text class="text-xs text-cyan-300">{String(g.graze())}</Text>
      </View>
    </>
  );
}

function NativeScoreboard(props: { game: Nightbloom }) {
  let scoreText: NodeMirror | undefined;
  let grazeText: NodeMirror | undefined;
  let lastScore = -1;
  let lastGraze = -1;
  const sync = () => {
    const score = props.game.score();
    const graze = props.game.graze();
    if (score !== lastScore) {
      lastScore = score;
      hot.text(scoreText, score);
    }
    if (graze !== lastGraze) {
      lastGraze = graze;
      hot.text(grazeText, graze);
    }
  };
  onFrame(sync);
  return (
    <>
      <View class="flex-row justify-between items-end">
        <Text class="text-xs text-slate-500 tracking-wide">SCORE</Text>
        <Text
          class="text-sm text-amber-200 font-bold text-right"
          nodeRef={(node) => { scoreText = node; sync(); }}
          style={{ width: 66, height: 18 }}
        >0</Text>
      </View>
      <View class="flex-row justify-between items-end">
        <Text class="text-xs text-slate-500 tracking-wide">GRAZE</Text>
        <Text
          class="text-xs text-cyan-300 text-right"
          nodeRef={(node) => (grazeText = node)}
          style={{ width: 48, height: 16 }}
        >0</Text>
      </View>
    </>
  );
}

function Scoreboard(props: { game: Nightbloom }) {
  return hot.supportsParticles()
    ? <NativeScoreboard game={props.game} />
    : <DeclarativeScoreboard game={props.game} />;
}

/** The spell-card box. spellReady ticks EVERY battle tick while a cooldown
 *  drains; the native variant repaints the arc through hot.prop quantized to
 *  45 steps (one paint-only op every ~half second) instead of a per-frame
 *  Solid style re-evaluation. */
function DeclarativeSpellBox(props: { game: Nightbloom }) {
  const g = props.game;
  return (
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
  );
}

function NativeSpellBox(props: { game: Nightbloom }) {
  const g = props.game;
  let arc: NodeMirror | undefined;
  let stateText: NodeMirror | undefined;
  let lastSweep = -1;
  let lastReady: boolean | undefined;
  const sync = () => {
    const ready = g.active().spellReady();
    const sweep = ready >= 1 ? 360 : Math.max(8, Math.round(ready * 45) * 8);
    const isReady = ready >= 1;
    if (sweep !== lastSweep) {
      lastSweep = sweep;
      hot.prop(arc, "arcSweep", sweep);
    }
    if (isReady !== lastReady) {
      lastReady = isReady;
      hot.text(stateText, isReady ? "READY" : "CHARGING");
    }
  };
  onFrame(sync);
  return (
    <View class="flex-row items-center gap-2 p-1 rounded-md border border-slate-800 bg-[#020617aa]">
      <View
        class="w-4 h-4 bg-amber-300"
        nodeRef={(node) => { arc = node; sync(); }}
        style={{ arcStart: 0, arcSweep: 360, arcWidth: 2 }}
      />
      <View class="flex-col">
        <Text class="text-xs text-amber-200 tracking-wide">{PLANTS[g.active().kind].spell.name}</Text>
        <Text
          class="text-xs text-slate-500"
          nodeRef={(node) => (stateText = node)}
          style={{ width: 66, height: 16 }}
        >READY</Text>
      </View>
    </View>
  );
}

function SpellBox(props: { game: Nightbloom }) {
  return hot.supportsParticles()
    ? <NativeSpellBox game={props.game} />
    : <DeclarativeSpellBox game={props.game} />;
}

function RightPanel(props: { game: Nightbloom }) {
  const g = props.game;
  return (
    <View
      debugName="RightPanel"
      class="absolute flex-col gap-1 px-2 py-2"
      style={{ insetL: PANEL_R.x0, insetT: 0, width: PANEL_R.w, height: 272 }}
    >
      <Scoreboard game={g} />
      <View class="flex-col gap-1 pt-1">
        <For each={g.roster}>{(p, i) => <RosterCard game={g} idx={i()} plant={p} />}</For>
      </View>
      <View class="grow" />
      <BananaBadge game={g} />
      <SpellBox game={g} />
    </View>
  );
}

function DeclarativeBananaBadge(props: { game: Nightbloom }) {
  const g = props.game;
  return (
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
  );
}

/** PSP: the badge stays mounted and toggles opacity — a form switch must not
 *  pay a subtree mount (the structural-frame hitch) for a HUD ornament. The
 *  hand count repaints through the same sync. */
function NativeBananaBadge(props: { game: Nightbloom }) {
  const g = props.game;
  let root: NodeMirror | undefined;
  const icons: Array<NodeMirror | undefined> = [];
  let visible = false;
  let lastAloft = -1;
  const sync = () => {
    if (g.active().kind !== "primrose") {
      if (visible) {
        visible = false;
        hot.prop(root, "opacity", 0);
      }
      return;
    }
    if (!visible) {
      visible = true;
      hot.prop(root, "opacity", 1);
    }
    const shots = g.playerShots();
    let aloft = 0;
    for (let i = 0; i < shots.length; i++) if (shots[i].kind === "banana") aloft++;
    if (aloft !== lastAloft) {
      lastAloft = aloft;
      for (let i = 0; i < 3; i++) hot.prop(icons[i], "opacity", aloft > i ? 0.25 : 1);
    }
  };
  onFrame(sync);
  return (
    <View
      class="flex-row items-center gap-1 p-1 rounded-md border border-slate-800 bg-[#020617aa]"
      nodeRef={(node) => { root = node; sync(); }}
      style={{ opacity: 0 }}
    >
      <Text class="text-xs text-slate-500 tracking-wide">BANANAS</Text>
      <For each={[0, 1, 2]}>
        {(i) => (
          <Image
            class="w-[12] h-[12]"
            src="shot-banana.png"
            nodeRef={(node) => (icons[i] = node)}
          />
        )}
      </For>
    </View>
  );
}

function BananaBadge(props: { game: Nightbloom }) {
  return hot.supportsParticles()
    ? <NativeBananaBadge game={props.game} />
    : <DeclarativeBananaBadge game={props.game} />;
}

function DeclarativeToastStack(props: { game: Nightbloom }) {
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

const TOAST_POOL = [0, 1, 2] as const;

interface ToastSlot {
  root?: NodeMirror;
  text?: NodeMirror;
}

/** PSP: toasts land in three pre-mounted slots on a fixed 26 px pitch, with
 *  FIXED-SIZE text cells. Both halves matter: mounting a toast box through
 *  Solid is a structural frame, and swapping text in an auto-sized cell
 *  dirties layout — the frame trace shows that relayout as a ~50 ms core
 *  tick on hardware, fired by the player's core verbs (switch, spell). */
function NativeToastStack(props: { game: Nightbloom }) {
  const slots: ToastSlot[] = TOAST_POOL.map(() => ({}));
  let visible = 0;
  let lastToasts: readonly unknown[] | undefined;
  const sync = () => {
    const toasts = props.game.toasts();
    if (toasts === lastToasts) return;
    lastToasts = toasts;
    const n = Math.min(toasts.length, slots.length);
    for (let i = 0; i < n; i++) {
      hot.text(slots[i].text, toasts[i].text);
      hot.prop(slots[i].root, "opacity", 1);
    }
    for (let i = n; i < visible; i++) hot.prop(slots[i].root, "opacity", 0);
    visible = n;
  };
  onFrame(sync);
  return (
    <View debugName="Toasts" class="absolute" style={{ insetL: FIELD.x0, insetT: 24, width: FIELD.w }}>
      <For each={TOAST_POOL}>
        {(i) => (
          <View class="absolute left-0 right-0 items-center" style={{ insetT: i * 26 }}>
            <View
              class="px-2 py-1 rounded-sm bg-[#0f172acc] border border-violet-800"
              nodeRef={(node) => (slots[i].root = node)}
              style={{ opacity: 0 }}
            >
              <Text
                class="text-xs text-violet-200 tracking-wide text-center"
                nodeRef={(node) => (slots[i].text = node)}
                style={{ width: 184, height: 16 }}
              >{" "}</Text>
            </View>
          </View>
        )}
      </For>
    </View>
  );
}

function ToastStack(props: { game: Nightbloom }) {
  return hot.supportsParticles()
    ? <NativeToastStack game={props.game} />
    : <DeclarativeToastStack game={props.game} />;
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
          <Text class="text-xs text-slate-400 pt-1">ONLY THE BLACK MOON CAT FLIES AT DUSK.</Text>
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
  const game = createNightbloom({ paintOnlyShots: hot.supportsParticles() });
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
