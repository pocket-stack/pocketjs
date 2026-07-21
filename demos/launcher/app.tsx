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
import { animate, spring } from "@pocketjs/framework/animation";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
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

function targetFor(offset: number): CardTarget {
  if (offset === 0) {
    return { translateX: 0, translateZ: FRONT_Z, rotateY: 0, opacity: 1 };
  }
  const side = offset > 0 ? 1 : -1;
  const depth = Math.abs(offset);
  return {
    // Deeper rail cards sink slightly so the painter sort keeps the card
    // nearer the center on top on BOTH sides (equal z would tie-break by
    // tree order and stack one rail backwards).
    translateX: side * (RAIL_FIRST + (depth - 1) * RAIL_STEP),
    translateZ: RAIL_Z - depth * 2,
    rotateY: -side * RAIL_TILT,
    opacity: depth > RAIL_VISIBLE ? 0 : 0.92,
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

  createEffect(() => {
    const s = sel();
    untrack(() => {
      for (let i = 0; i < apps.length; i++) {
        const el = cardEls[i];
        if (!el) continue;
        const t = targetFor(i - s);
        spring(el, "translateX", t.translateX);
        spring(el, "translateZ", t.translateZ);
        spring(el, "rotateY", t.rotateY);
        animate(el, "opacity", t.opacity, { dur: 160, easing: "out" });
      }
    });
  });

  onMount(() => {
    // Latched everywhere: the summon chord (or a held browse button) must
    // release before it can fire inside the deck.
    onButtonPress(BTN.LEFT, () => setSel((v) => Math.max(0, v - 1)), { latched: true });
    onButtonPress(BTN.RIGHT, () => setSel((v) => Math.min(apps.length - 1, v + 1)), {
      latched: true,
    });
    onButtonPress(BTN.CROSS, () => {
      const app = apps[sel()];
      if (app) launchApp(app.output);
    }, { latched: true });
    const doResume = () => {
      if (resume) launchApp(resume);
    };
    onButtonPress(BTN.SELECT, doResume, { latched: true });
    onButtonPress(BTN.CIRCLE, doResume, { latched: true });
  });

  const selected = () => apps[sel()];

  return (
    <View debugName="LauncherScreen" class="relative w-full h-full bg-[#05060a] overflow-hidden">
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
            <Text class="text-xs text-amber-400">INTERRUPTED · SELECT RESUMES</Text>
          </Show>
        </View>
      </Show>

      <Text class="absolute left-0 bottom-2 w-[480] text-center text-xs text-slate-600">
        {table
          ? resume
            ? "LEFT / RIGHT browse · CROSS launch · SELECT resume"
            : "LEFT / RIGHT browse · CROSS launch"
          : "browse only — this host cannot switch apps"}
      </Text>
    </View>
  );
}
