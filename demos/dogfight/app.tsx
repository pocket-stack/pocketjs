// demos/dogfight/app.tsx — "Pocket Dogfight": the playset flight+combat demo.
//
// The pure sim lives in game.ts; this component wires it to the runtime:
// createGameLoop steps the game at a fixed 1/60 s on the virtual clock
// (hz-invariant, DETERMINISM.md), the render callback flushes the Scene3D
// and refreshes one HUD signal, and the cockpit overlay — FlightHud pitch
// tape + data boxes, HeadingRelativeRadar, damage flash, message line —
// composes as ordinary Views over the <Viewport3D>. On hosts without a 3D
// core the viewport is an empty box and the HUD, driven by the same
// deterministic sim, still renders.

import { Show, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGameLoop } from "../../playset/loop.ts";
import { Viewport3D } from "../../playset/scene3d/viewport.ts";
import { FlightHud, type FlightHudState } from "../../playset/modules/user-interface/flight-hud.ts";
import { HeadingRelativeRadar } from "../../playset/modules/user-interface/heading-relative-radar.ts";
import { createDogfightGame } from "./game.ts";

// spec/spec.ts ENUMS ordinals (stable wire values; same idiom as flight-hud.ts).
const POS_ABSOLUTE = 1;
const ALIGN_CENTER = 1;
const FLEX_COL = 1;

const SCREEN_W = 480;
const SCREEN_H = 272;
const RADAR_SIZE = 58;
const RADAR_RANGE = 3600;

function pad(value: number, width: number): string {
  return String(Math.max(0, Math.round(value))).padStart(width, "0");
}

export default function Dogfight() {
  const game = createDogfightGame();
  const [hud, setHud] = createSignal(game.hudState());

  createGameLoop({
    step: (dt, input) => game.step(dt, input),
    render: () => {
      game.scene.flush();
      setHud(game.hudState());
    },
  });

  // Status row budget is tight at 480 px: HP rides in the region slot, the
  // score is abbreviated, and the time slot stays empty.
  const hudSource = (): Partial<FlightHudState> => {
    const h = hud();
    return {
      regionName: h.failed ? "MISSION FAILED" : `HP ${pad(h.health, 3)}`,
      speed: h.speed,
      altitude: h.altitude,
      agl: h.agl,
      waveLabel: `WAVE ${h.waveNumber}`,
      waveDetail: `${h.banditsAlive} BANDIT${h.banditsAlive === 1 ? "" : "S"}`,
      compassHeadingDegrees: h.headingDeg,
      timeText: "",
      scoreText: `SCR ${pad(h.score, 4)}`,
      throttle: h.throttle,
      pitchDegrees: h.pitchDeg,
      rollDegrees: h.rollDeg,
      weaponLabel: h.weaponLabel,
      lockStatus: h.lockStatus,
      gunHeat: h.gunHeat,
      pullUpWarning: h.pullUp,
    };
  };

  // No bgColor on the viewport: on native hosts the 3D scene composites
  // UNDER the ui layer, so the viewport (and its ancestors) stay unpainted.
  return (
    <Viewport3D scene={game.scene} class="w-full h-full">
      <View class="w-full h-full">
        <FlightHud state={hudSource} width={SCREEN_W} height={SCREEN_H} />

        {/* damage flash — the demo's red vignette as a flat overlay */}
        <Show when={hud().damageFlash > 0.01}>
          <View
            style={{
              posType: POS_ABSOLUTE,
              insetL: 0,
              insetT: 0,
              width: SCREEN_W,
              height: SCREEN_H,
              bgColor: "#ff2418",
              opacity: hud().damageFlash * 0.3,
            }}
          />
        </Show>

        {/* combat messages (FOX TWO / SPLASH ONE / WAVE N INBOUND) */}
        <Show when={hud().message !== ""}>
          <View
            style={{
              posType: POS_ABSOLUTE,
              insetT: Math.round(SCREEN_H * 0.62),
              insetL: 0,
              width: SCREEN_W,
              flexDir: FLEX_COL,
              align: ALIGN_CENTER,
            }}
          >
            <Text class="text-sm font-bold tracking-wide" style={{ textColor: "#eafff2" }}>
              {hud().message}
            </Text>
          </View>
        </Show>

        {/* heading-relative radar, bottom-right (the demo's scope corner) */}
        <View
          style={{
            posType: POS_ABSOLUTE,
            insetR: 8,
            insetB: 6,
            width: RADAR_SIZE,
            height: RADAR_SIZE,
          }}
        >
          <HeadingRelativeRadar
            playerPosition={() => hud().playerPosition}
            playerForward={() => hud().playerForward}
            contacts={() => hud().contacts}
            width={RADAR_SIZE}
            height={RADAR_SIZE}
            range={RADAR_RANGE}
            contactColor="#ff4f42"
          />
        </View>
      </View>
    </Viewport3D>
  );
}
