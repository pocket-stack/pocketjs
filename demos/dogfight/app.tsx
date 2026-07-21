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

import { Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGameLoop } from "../../playset/loop.ts";
import { createHudSignals } from "../../playset/hud.ts";
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
  // One signal per field, refreshed on the virtual 0.1 s grid — see
  // playset/hud.ts for why a single snapshot signal is a trap on this
  // interpreter (it re-runs every consumer whether or not its value moved).
  const { fields: hud, refresh } = createHudSignals({ read: () => game.hudState() });

  let steps = 0;
  createGameLoop({
    step: (dt, input) => {
      game.step(dt, input);
      steps += 1;
      if (steps % 6 === 0) refresh();
    },
    render: () => game.scene.flush(),
  });

  // Status row budget is tight at 480 px: HP rides in the region slot, the
  // score is abbreviated, and the time slot stays empty.
  // Reads each field through its OWN accessor: FlightHud pulls this inside its
  // reactive getters, so a per-field read means a changing airspeed wakes the
  // airspeed tape and nothing else.
  const hudSource = (): Partial<FlightHudState> => ({
    regionName: hud.failed() ? "MISSION FAILED" : `HP ${pad(hud.health(), 3)}`,
    speed: hud.speed(),
    altitude: hud.altitude(),
    agl: hud.agl(),
    waveLabel: `WAVE ${hud.waveNumber()}`,
    waveDetail: `${hud.banditsAlive()} BANDIT${hud.banditsAlive() === 1 ? "" : "S"}`,
    compassHeadingDegrees: hud.headingDeg(),
    timeText: "",
    scoreText: `SCR ${pad(hud.score(), 4)}`,
    throttle: hud.throttle(),
    pitchDegrees: hud.pitchDeg(),
    rollDegrees: hud.rollDeg(),
    weaponLabel: hud.weaponLabel(),
    lockStatus: hud.lockStatus(),
    gunHeat: hud.gunHeat(),
    pullUpWarning: hud.pullUp(),
  });

  // No bgColor on the viewport: on native hosts the 3D scene composites
  // UNDER the ui layer, so the viewport (and its ancestors) stay unpainted.
  return (
    <Viewport3D scene={game.scene} class="w-full h-full">
      <View class="w-full h-full">
        <FlightHud state={hudSource} width={SCREEN_W} height={SCREEN_H} />

        {/* damage flash — the demo's red vignette as a flat overlay */}
        <Show when={hud.damageFlash() > 0.01}>
          <View
            style={{
              posType: POS_ABSOLUTE,
              insetL: 0,
              insetT: 0,
              width: SCREEN_W,
              height: SCREEN_H,
              bgColor: "#ff2418",
              opacity: hud.damageFlash() * 0.3,
            }}
          />
        </Show>

        {/* combat messages (FOX TWO / SPLASH ONE / WAVE N INBOUND) */}
        <Show when={hud.message() !== ""}>
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
              {hud.message()}
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
            playerPosition={() => hud.playerPosition()}
            playerForward={() => hud.playerForward()}
            contacts={() => hud.contacts()}
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
