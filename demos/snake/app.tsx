// demos/snake/app.tsx — "Pocket Snake": the playset grid-game demo app.
//
// The pure sim lives in game.ts; this component wires it to the runtime:
// createGameLoop steps the game at a fixed 1/60 s on the virtual clock
// (hz-invariant, DETERMINISM.md), the render callback flushes the Scene3D
// and refreshes one HUD signal, and the HUD (score panel, length readout,
// game-over card) composes as ordinary flex children over the <Viewport3D>.
// On hosts without a 3D core the viewport is an empty box and the HUD —
// driven by the same deterministic sim — still renders.

import { Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGameLoop } from "../../playset/loop.ts";
import { createHudSignals } from "../../playset/hud.ts";
import { Viewport3D } from "../../playset/scene3d/viewport.ts";
import { createSnakeGame } from "./game.ts";

const INK = "#eef3f7";
const DIM = "#9ca8b3";
const RED = "#f04f5d";
const BLUE = "#6fd0ff";
const GREEN = "#35b34a";

export default function Snake() {
  const game = createSnakeGame();
  // One signal per field, refreshed on the virtual 0.1 s grid — see
  // playset/hud.ts for why a single snapshot signal is a trap on this
  // interpreter (it re-runs every consumer whether or not its value moved).
  const { fields: hud, refresh } = createHudSignals({ read: () => game.hudState() });

  let steps = 0;
  createGameLoop({
    step: (dt, input) => {
      game.step(dt, input);
      steps += 1;
      // Status is the one field a player must never see lag: it gates the
      // GAME OVER card and the restart hint.
      if (steps % 6 === 0 || game.hudState().status !== hud.status()) refresh();
    },
    render: () => game.scene.flush(),
  });

  // No bgColor on the viewport: on native hosts the 3D scene composites
  // UNDER the ui layer, so the viewport (and its ancestors) stay unpainted.
  return (
    <Viewport3D scene={game.scene} class="w-full h-full">
      <View class="w-full h-full flex-col justify-between px-3 py-2">
        {/* Top bar: player score + best left, rival score right */}
        <View class="flex-row items-start justify-between">
          <View class="flex-col gap-1">
            <Text class="text-xl font-bold tracking-wide" style={{ textColor: RED }}>
              {`SCORE ${hud.score()}`}
            </Text>
            <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
              {`BEST ${hud.bestScore()}`}
            </Text>
          </View>
          <Text class="text-xs font-bold tracking-wide" style={{ textColor: BLUE }}>
            {`RIVAL ${hud.rivalScore()}`}
          </Text>
        </View>

        {/* Center: game-over card (restart hint) */}
        <View class="flex-row justify-center">
          <Show when={hud.status() === "gameover"}>
            <View class="flex-col items-center gap-1 px-4 py-2 rounded-lg" style={{ bgColor: "#111417" }}>
              <Text class="text-xl font-bold tracking-wide" style={{ textColor: INK }}>
                GAME OVER
              </Text>
              <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
                {`SCORE ${hud.score()} · PRESS × TO RESTART`}
              </Text>
            </View>
          </Show>
        </View>

        {/* Bottom bar: length left, controls hint right */}
        <View class="flex-row items-end justify-between">
          <Text class="text-sm font-bold tracking-wide" style={{ textColor: GREEN }}>
            {`LENGTH ${hud.length()}`}
          </Text>
          <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
            D-PAD TURN
          </Text>
        </View>
      </View>
    </Viewport3D>
  );
}
