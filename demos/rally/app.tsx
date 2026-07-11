// demos/rally/app.tsx — "Pocket Rally": the playset end-to-end demo app.
//
// The pure sim lives in game.ts; this component wires it to the runtime:
// createGameLoop steps the game at a fixed 1/60 s on the virtual clock
// (hz-invariant, DETERMINISM.md), the render callback flushes the Scene3D
// and refreshes one HUD signal, and the HUD (lap counter, standings,
// RaceMinimap) composes as ordinary flex children over the <Viewport3D>.
// On hosts without a 3D core the viewport is an empty box and the HUD —
// driven by the same deterministic sim — still renders.

import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGameLoop } from "../../playset/loop.ts";
import { Viewport3D } from "../../playset/scene3d/viewport.ts";
import { RaceMinimap } from "../../playset/modules/user-interface/race-minimap.ts";
import { createRallyGame, LAP_COUNT, RIVAL_ID, TRACK_BOUNDS } from "./game.ts";

const INK = "#e8f0f2";
const DIM = "#8fa3ad";
const LIME = "#b8f34a";
const AMBER = "#fbbf24";

export default function Rally() {
  const game = createRallyGame();
  const [hud, setHud] = createSignal(game.hudState());

  createGameLoop({
    step: (dt, input) => game.step(dt, input),
    render: () => {
      game.scene.flush();
      setHud(game.hudState());
    },
  });

  const statusLine = () =>
    hud().raceState === "FINISHED"
      ? "RACE COMPLETE"
      : `GATES ${hud().checkpointsPassed} · × GAS · ▢ BRAKE`;

  return (
    <Viewport3D scene={game.scene} class="w-full h-full" style={{ bgColor: "#0b1420" }}>
      <View class="w-full h-full flex-col justify-between px-3 py-2">
        {/* Top bar: lap + status left, standings right */}
        <View class="flex-row items-start justify-between">
          <View class="flex-col gap-1">
            <Text class="text-xl font-bold tracking-wide" style={{ textColor: INK }}>
              {`LAP ${hud().lap}/${LAP_COUNT}`}
            </Text>
            <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
              {statusLine()}
            </Text>
          </View>
          <View class="flex-col items-end gap-1">
            <Text class="text-xs font-bold tracking-wide" style={{ textColor: LIME }}>
              {`P1 ${hud().standings[0]}`}
            </Text>
            <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
              {`P2 ${hud().standings[1]}`}
            </Text>
          </View>
        </View>

        {/* Bottom bar: speed left, minimap right */}
        <View class="flex-row items-end justify-between">
          <Text class="text-sm font-bold tracking-wide" style={{ textColor: AMBER }}>
            {`${hud().speed} M/S`}
          </Text>
          <RaceMinimap
            planarBounds={TRACK_BOUNDS}
            width={84}
            height={84}
            padding={6}
            checkpoints={() => game.checkpoints}
            localProgress={() => ({ nextCheckpointIndex: hud().nextCheckpointIndex })}
            localVehicle={() => ({
              position: hud().playerPosition,
              bodyFrame: { forward: hud().playerForward },
            })}
            aiCars={() => [{ id: RIVAL_ID, position: hud().rivalPosition, color: "#5ac8fa" }]}
            aiLeaderId={() => hud().leaderId}
          />
        </View>
      </View>
    </Viewport3D>
  );
}
