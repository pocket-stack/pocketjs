// demos/runner/app.tsx — "Pocket Runner": the 3-lane endless runner app.
//
// The pure sim lives in game.ts; this component wires it to the runtime:
// createGameLoop steps the game at a fixed 1/60 s on the virtual clock
// (hz-invariant, DETERMINISM.md), the render callback flushes the Scene3D
// and refreshes one HUD signal, and the HUD (score/coins/distance, boost
// pill, start / game-over cards) composes as flex children over the
// <Viewport3D>. On hosts without a 3D core the viewport is an empty box and
// the HUD — driven by the same deterministic sim — still renders.

import { createSignal, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGameLoop } from "../../playset/loop.ts";
import { Viewport3D } from "../../playset/scene3d/viewport.ts";
import { createRunnerGame } from "./game.ts";

const INK = "#10243d";
const DIM = "#4a6076";
const GOLD = "#b8860b";
const RED = "#d92c3a";
const CARD = "#f4fbffee";

export default function Runner() {
  const game = createRunnerGame();
  const [hud, setHud] = createSignal(game.hudState());

  createGameLoop({
    step: (dt, input) => game.step(dt, input),
    render: () => {
      game.scene.flush();
      setHud(game.hudState());
    },
  });

  // No bgColor on the viewport: on native hosts the 3D scene composites
  // UNDER the ui layer, so the viewport (and its ancestors) stay unpainted.
  return (
    <Viewport3D scene={game.scene} class="w-full h-full">
      <View class="w-full h-full flex-col justify-between px-3 py-2">
        {/* Top bar: score + coins left, distance + boost right */}
        <View class="flex-row items-start justify-between">
          <View class="flex-col gap-1">
            <Text class="text-xl font-bold tracking-wide" style={{ textColor: INK }}>
              {`SCORE ${hud().score}`}
            </Text>
            <Text class="text-xs tracking-wide" style={{ textColor: GOLD }}>
              {`● ${hud().coins} COINS`}
            </Text>
          </View>
          <View class="flex-col items-end gap-1">
            <Text class="text-sm font-bold tracking-wide" style={{ textColor: INK }}>
              {`${hud().distance} M`}
            </Text>
            <Show when={hud().boostActive}>
              <Text class="text-xs font-bold tracking-wide" style={{ textColor: RED }}>
                BOOST!
              </Text>
            </Show>
          </View>
        </View>

        {/* Center card: start / game-over flow */}
        <Show when={hud().status !== "running"}>
          <View class="flex-row justify-center">
            <View class="flex-col items-center gap-1 rounded-xl px-5 py-3" style={{ bgColor: CARD }}>
              <Text class="text-xl font-bold tracking-wide" style={{ textColor: hud().status === "gameOver" ? RED : INK }}>
                {hud().status === "gameOver" ? "GAME OVER" : "POCKET RUNNER"}
              </Text>
              <Show when={hud().status === "gameOver"}>
                <Text class="text-sm tracking-wide" style={{ textColor: DIM }}>
                  {`SCORE ${hud().finalScore}`}
                </Text>
              </Show>
              <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
                {hud().status === "gameOver" ? "PRESS × TO RUN AGAIN" : "PRESS × TO START"}
              </Text>
            </View>
          </View>
        </Show>

        {/* Bottom hint (light pills so the text reads over the dark road) */}
        <View class="flex-row justify-between items-end">
          <View class="rounded-md px-2 py-1" style={{ bgColor: CARD }}>
            <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
              ◀ ▶ LANES · × JUMP · ▼ SLIDE
            </Text>
          </View>
          <View class="rounded-md px-2 py-1" style={{ bgColor: CARD }}>
            <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
              {`${hud().speed} M/S`}
            </Text>
          </View>
        </View>
      </View>
    </Viewport3D>
  );
}
