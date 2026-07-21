// demos/launcher/app.tsx — the Pocket Launcher: Cover Flow over every
// PSP-admissible app in the repo (LAUNCHER.md).
//
// The deck is the 2D core's perspective pipeline (the same TEX_TRI path
// motions page 4 ships): one perspective root, one 2:1 cover card per app,
// center card flat and pulled toward the viewer, neighbors angled on a rail.
// All motion is native springs on translateX/translateZ/rotateY — steady
// state runs zero per-frame JS. When the host summoned us mid-app (SELECT),
// the frozen frame it captured stretches under a dark scrim, so the deck
// reads as an overlay over the interrupted app.
//
// Hosts without the app* ops (golden/web/vita): appTable() is null — the
// deck still browses (build-time registry), launch is a visible no-op, and
// the footer says why. That degraded mode is what plain goldens exercise.

import { createEffect, createSignal, onMount, Show, untrack } from "solid-js";
import { registerTexture } from "@pocketjs/framework";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { appTable, frozenShot, launchApp } from "@pocketjs/framework/launcher";
import { REGISTRY, type RegistryApp } from "./registry.generated.ts";

/** Card box: 192×96 at left-[144] top-[58] (class literals below — the deck
 *  geometry lives in the transforms, the box never moves). */
/** Rail geometry: first neighbor offset, then per-card spacing. */
const RAIL_FIRST = 124;
const RAIL_STEP = 44;
const RAIL_TILT = 55;
const RAIL_Z = -60;
const FRONT_Z = 46;
/** Cards beyond this offset fade out entirely (the rail dissolves into the
 *  dark backdrop, and the GE never sees their quads — opacity 0 culls). */
const RAIL_VISIBLE = 4;

interface CardTarget {
  translateX: number;
  translateZ: number;
  rotateY: number;
  opacity: number;
}

/** Deck geometry as a CONTINUOUS function of the (possibly fractional)
 *  card offset — held-flow scrubs through it per frame, and the discrete
 *  tween targets are exactly its integer samples. */
function targetFor(offset: number): CardTarget {
  const side = offset < 0 ? -1 : 1;
  const depth = Math.abs(offset);
  /** 0 at deck center, 1 from the first rail slot outward. */
  const near = Math.min(depth, 1);
  const beyond = Math.max(0, depth - 1);
  return {
    translateX: side * (near * RAIL_FIRST + beyond * RAIL_STEP),
    // Deeper rail cards sink slightly so the painter sort keeps the card
    // nearer the center on top on BOTH sides (equal z would tie-break by
    // tree order and stack one rail backwards).
    translateZ: FRONT_Z + (RAIL_Z - 2 - FRONT_Z) * near - beyond * 2,
    rotateY: -side * near * RAIL_TILT,
    opacity:
      depth <= 1
        ? 1 - 0.08 * depth
        : depth <= RAIL_VISIBLE
          ? 0.92
          : Math.max(0, 0.92 * (1 - (depth - RAIL_VISIBLE))),
  };
}

/** Manifest titles read "PocketJS: X" — the deck shows just X. */
function displayTitle(app: RegistryApp): string {
  const title = app.title.replace(/^PocketJS:\s*/, "");
  const cut = title.indexOf(" (");
  return cut > 0 ? title.slice(0, cut) : title;
}

export default function Launcher() {
  // The host table is the runtime truth for what is embedded; the generated
  // registry carries display data (titles + baked covers). Show their
  // intersection, in registry order. No table -> browse-only degraded mode.
  const table = appTable();
  const apps = table
    ? REGISTRY.filter((r) => table.apps.some((a) => a.output === r.output))
    : [...REGISTRY];
  const shot = frozenShot();
  if (shot >= 0) registerTexture("launcher.shot", shot);
  const resume = table?.resume ?? null;
  const resumeIndex = apps.findIndex((a) => a.output === resume);

  const [sel, setSel] = createSignal(resumeIndex >= 0 ? resumeIndex : 0);
  const cardEls: (NodeMirror | undefined)[] = new Array(apps.length);

  // Held-flow scrub position: non-null while a browse input streams the
  // deck through FRACTIONAL offsets (per-frame jump()s, which kill any
  // running tween on the props they touch). Null = at-rest / tweening.
  let pos: number | null = null;

  const applyCards = (
    at: number,
    set: (el: NodeMirror, prop: "translateX" | "translateZ" | "rotateY" | "opacity", v: number) => void,
  ) => {
    for (let i = 0; i < apps.length; i++) {
      const el = cardEls[i];
      if (!el) continue;
      const t = targetFor(i - at);
      set(el, "translateX", t.translateX);
      set(el, "translateZ", t.translateZ);
      set(el, "rotateY", t.rotateY);
      set(el, "opacity", t.opacity);
    }
  };
  /** Glide every card to the integer deck position (from wherever it is —
   *  a discrete step's previous target or a released scrub's fraction). */
  const applyTweens = (s: number) =>
    applyCards(s, (el, prop, v) => animate(el, prop, v, { dur: 140, easing: "out" }));
  /** Scrub: place every card for a fractional position RIGHT NOW. */
  const applyFlow = (p: number) => applyCards(p, (el, prop, v) => jump(el, prop, v));

  createEffect(() => {
    const s = sel();
    untrack(() => {
      // While flowing, jump() owns the cards; the release path below tweens
      // home explicitly. (Tweens on discrete presses only — springs felt
      // right but let a mashed d-pad outrun the deck; real-hardware find.)
      if (pos === null) applyTweens(s);
    });
  });

  const clampSel = (v: number) => Math.min(apps.length - 1, Math.max(0, v));
  const stepSel = (delta: number) => setSel((v) => clampSel(v + delta));

  onMount(() => {
    // Latched everywhere: the summon chord (or a held browse button) must
    // release before it can fire inside the deck.
    onButtonPress(BTN.LEFT, () => stepSel(-1), { latched: true });
    onButtonPress(BTN.RIGHT, () => stepSel(1), { latched: true });

    // Held-flow browsing: while the L/R triggers (or a d-pad direction past
    // the key-repeat delay) stay down, the deck position advances a
    // FRACTION of a card every frame and the cards are jumped to it — one
    // continuous stream, no per-card stop. Release tweens from the exact
    // fraction to the nearest card. The title tracks round(pos) live, so
    // what reads as centered is always what CROSS launches.
    const FLOW_TRIGGER = 18 / 60; // cards per frame, trigger stream
    const FLOW_DPAD = 11 / 60; //   cards per frame, held d-pad
    const DPAD_DELAY = 15; //       frames before a held d-pad flows
    let dpadHeld = 0;
    let flowOrigin = 0; // deck position where the current flow began
    onFrame((buttons: number) => {
      const tl = (buttons & BTN.LTRIGGER) !== 0;
      const tr = (buttons & BTN.RTRIGGER) !== 0;
      const dl = (buttons & BTN.LEFT) !== 0;
      const dr = (buttons & BTN.RIGHT) !== 0;
      dpadHeld = dl !== dr ? dpadHeld + 1 : 0;
      let dir = 0;
      let speed = 0;
      if (tl !== tr) {
        dir = tr ? 1 : -1;
        speed = FLOW_TRIGGER;
      } else if (dl !== dr && dpadHeld > DPAD_DELAY) {
        dir = dr ? 1 : -1;
        speed = FLOW_DPAD;
      }
      if (dir !== 0) {
        if (pos === null) {
          pos = sel();
          flowOrigin = pos;
        }
        pos = Math.min(apps.length - 1, Math.max(0, pos + dir * speed));
        applyFlow(pos);
        const r = Math.round(pos);
        if (r !== sel()) setSel(r);
      } else if (pos !== null) {
        let settle = Math.round(pos);
        // A tap shorter than half a card still moves one: a flow that ends
        // displaced from its origin never rounds back onto it — step in the
        // displacement's direction instead (the deck wall is the only thing
        // allowed to hold a card in place).
        if (settle === flowOrigin && pos !== flowOrigin) {
          settle = clampSel(flowOrigin + Math.sign(pos - flowOrigin));
        }
        pos = null;
        setSel(settle);
        // sel() may be unchanged (the effect will not re-run) — glide home
        // from the released fraction regardless.
        applyTweens(settle);
      }
    });
    // CIRCLE confirms (the console's home convention — CROSS-as-confirm had
    // users launching with O and landing in the RESUME app every time);
    // CROSS and SELECT both back out to the interrupted app.
    onButtonPress(BTN.CIRCLE, () => {
      const app = apps[sel()];
      if (app) launchApp(app.output);
    }, { latched: true });
    const doResume = () => {
      if (resume) launchApp(resume);
    };
    onButtonPress(BTN.SELECT, doResume, { latched: true });
    onButtonPress(BTN.CROSS, doResume, { latched: true });
  });

  const selected = () => apps[sel()];

  return (
    <View debugName="LauncherScreen" class="relative w-full h-full bg-[#05060a] overflow-hidden">
      {/* The stage: a baked Aqua-era gradient (scripts/launcher.ts renders
          it next to the covers) — black floor, cool center glow behind the
          deck, faint sheen under the cards. Stretched 256×128 → full screen
          with bilinear, like the frozen shot. */}
      <Image class="absolute left-0 top-0 w-[480] h-[272]" src="covers/launcher-bg.png" />
      <Show when={shot >= 0}>
        {/* The interrupted app's last frame, stretched back to full screen
            under a scrim — the "overlay" illusion (LAUNCHER.md). */}
        <Image class="absolute left-0 top-0 w-[480] h-[272]" src="launcher.shot" />
        <View class="absolute left-0 top-0 w-[480] h-[272] bg-[#05060a] opacity-75" />
      </Show>

      <View debugName="Header" class="absolute left-4 top-3 flex-col">
        <Text class="text-xs text-slate-500 tracking-wide">POCKET LAUNCHER</Text>
      </View>
      <Text class="absolute right-4 top-3 text-xs text-slate-500">
        {`${apps.length} APPS`}
      </Text>

      <Show
        when={apps.length > 0}
        fallback={
          <Text class="absolute left-0 top-[128] w-[480] text-center text-sm text-slate-400">
            No apps embedded — build with scripts/launcher.ts
          </Text>
        }
      >
        <View debugName="Deck" class="absolute inset-0 perspective-[620]">
          {apps.map((app, i) => {
            const t = targetFor(i - untrack(sel));
            return (
              <View
                ref={(el: NodeMirror) => (cardEls[i] = el)}
                debugName="Card"
                class="absolute left-[144] top-[58] w-[192] h-[96]"
                style={{
                  translateX: t.translateX,
                  translateZ: t.translateZ,
                  rotateY: t.rotateY,
                  opacity: t.opacity,
                }}
              >
                <Image class="absolute left-0 top-0 w-[192] h-[96]" src={app.cover} />
              </View>
            );
          })}
        </View>

        <View debugName="TitleBlock" class="absolute left-0 top-[196] w-[480] flex-col items-center gap-1">
          <Text class="text-xl text-slate-100 font-bold">{displayTitle(selected())}</Text>
          <Text class="text-xs text-slate-500">
            {`${sel() + 1} / ${apps.length} · ${selected().id}`}
          </Text>
          <Show when={resume && selected().output === resume}>
            <Text class="text-xs text-amber-400">INTERRUPTED · SELECT / CROSS RESUMES</Text>
          </Show>
        </View>
      </Show>

      <Text class="absolute left-0 bottom-2 w-[480] text-center text-xs text-slate-600">
        {table
          ? resume
            ? "hold L / R to flow · CIRCLE launch · CROSS back"
            : "LEFT / RIGHT browse · hold L / R to flow · CIRCLE launch"
          : "browse only — this host cannot switch apps"}
      </Text>
    </View>
  );
}
