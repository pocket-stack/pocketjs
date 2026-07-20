// demos/rally/app.tsx — "Pocket Rally": the playset end-to-end demo app.
//
// The pure sim lives in game.ts; this component wires it to the runtime:
// createGameLoop steps the game at a fixed 1/60 s on the virtual clock
// (hz-invariant, DETERMINISM.md), the render callback flushes the Scene3D
// and refreshes the HUD signals, and the HUD (lap counter, standings,
// RaceMinimap) composes as ordinary flex children over the <Viewport3D>.
// On hosts without a 3D core the viewport is an empty box and the HUD —
// driven by the same deterministic sim — still renders.
//
// ONE FIELD PER SIGNAL. This used to be a single `hud` object signal, and a
// fresh object is never === the old one, so every 10 Hz refresh re-ran every
// Text line and every minimap dot whether or not its value had moved. On a
// real PSP that fan-out measured 12,973 µs/frame amortised — 78 ms per
// refresh, more than the sim and the scene flush put together. Scalars let
// Solid's identity check stop each update at the source; in steady state only
// the speed readout and the two moving map markers actually change, and the
// lap/status/standings lines go quiet for seconds at a time.

import { batch, createSignal } from "solid-js";
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
  const initial = game.hudState();

  const [lap, setLap] = createSignal(initial.lap);
  const [raceState, setRaceState] = createSignal(initial.raceState);
  const [gates, setGates] = createSignal(initial.checkpointsPassed);
  const [speed, setSpeed] = createSignal(initial.speed);
  const [standing1, setStanding1] = createSignal(initial.standings[0]);
  const [standing2, setStanding2] = createSignal(initial.standings[1]);
  const [nextCheckpointIndex, setNextCheckpointIndex] = createSignal(initial.nextCheckpointIndex);
  const [leaderId, setLeaderId] = createSignal(initial.leaderId);

  // Marker poses DO change every refresh, so there is nothing to gate them on;
  // what is worth saving is the garbage. These holders are written in place and
  // announced once with `poseTick` (equals:false — the value is the event),
  // which keeps the minimap's per-refresh allocation at zero on this side.
  const playerPosition = { ...initial.playerPosition };
  const playerForward = { ...initial.playerForward };
  const localVehicle = { position: playerPosition, bodyFrame: { forward: playerForward } };
  const rivalPosition = { ...initial.rivalPosition };
  const rivals = [{ id: RIVAL_ID, position: rivalPosition, color: "#5ac8fa" }];
  const progress = { nextCheckpointIndex: initial.nextCheckpointIndex };
  const [poseTick, bumpPose] = createSignal(0, { equals: false });

  type Vec = { x: number; y: number; z: number };
  const copyVec = (into: Vec, from: Vec): void => {
    into.x = from.x;
    into.y = from.y;
    into.z = from.z;
  };

  // One batch, so the refresh is a single reactive pass instead of one per
  // field (the writes that changed nothing cost a comparison and stop there).
  //
  // `markers` gates the map markers to HALF the text rate. MEASURED on a real
  // PSP: waking the two markers costs 4.0 ms/frame amortised (24 ms per
  // update) while the whole rest of the HUD costs 0.2 ms — rebuilding and
  // diffing a twelve-key style object per marker is simply expensive on this
  // interpreter, and that cost is the difference between holding 60 fps and
  // not. At 5 Hz a marker steps ~2 px on an 84 px map, which is not a
  // difference anyone can see; the lap counter and speed stay at 10 Hz.
  const refreshHud = (markers: boolean): void => {
    const s = game.hudState();
    copyVec(playerPosition, s.playerPosition);
    copyVec(playerForward, s.playerForward);
    copyVec(rivalPosition, s.rivalPosition);
    batch(() => {
      setLap(s.lap);
      setRaceState(s.raceState);
      setGates(s.checkpointsPassed);
      setSpeed(s.speed);
      setStanding1(s.standings[0]);
      setStanding2(s.standings[1]);
      setNextCheckpointIndex(s.nextCheckpointIndex);
      setLeaderId(s.leaderId);
      if (markers) bumpPose(0);
    });
  };

  let stepCount = 0;
  createGameLoop({
    step: (dt, input) => {
      game.step(dt, input);
      stepCount += 1;
    },
    render: () => {
      game.scene.flush();
      // HUD at 10 Hz, anchored to the VIRTUAL 0.1 s grid (sim steps, not
      // render frames) so every simulationHz refreshes the HUD at the same
      // virtual instants and the subsampling theorem keeps holding for the
      // HUD pixels too. Pure presentation: lap/speed/minimap don't need
      // 60 Hz, and on-device the refresh costs real JS time.
      if (stepCount % 6 === 0) refreshHud(stepCount % 12 === 0);
    },
  });

  const statusLine = () =>
    raceState() === "FINISHED" ? "RACE COMPLETE" : `GATES ${gates()} · × GAS · ▢ BRAKE`;

  // No bgColor on the viewport: on native hosts the 3D scene composites
  // UNDER the ui layer, so the viewport (and its ancestors) stay unpainted.
  return (
    <Viewport3D scene={game.scene} class="w-full h-full">
      <View class="w-full h-full flex-col justify-between px-3 py-2">
        {/* Top bar: lap + status left, standings right */}
        <View class="flex-row items-start justify-between">
          <View class="flex-col gap-1">
            <Text class="text-xl font-bold tracking-wide" style={{ textColor: INK }}>
              {`LAP ${lap()}/${LAP_COUNT}`}
            </Text>
            <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
              {statusLine()}
            </Text>
          </View>
          <View class="flex-col items-end gap-1">
            <Text class="text-xs font-bold tracking-wide" style={{ textColor: LIME }}>
              {`P1 ${standing1()}`}
            </Text>
            <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
              {`P2 ${standing2()}`}
            </Text>
          </View>
        </View>

        {/* Bottom bar: speed left, minimap right */}
        <View class="flex-row items-end justify-between">
          <Text class="text-sm font-bold tracking-wide" style={{ textColor: AMBER }}>
            {`${speed()} M/S`}
          </Text>
          {/* Each accessor names exactly the signal its consumer depends on:
              the checkpoint row re-projects only when `checkpoints` changes
              (never, here), the gate highlight only when the next gate does,
              and only the two marker accessors ride `poseTick`. */}
          <RaceMinimap
            planarBounds={TRACK_BOUNDS}
            width={84}
            height={84}
            padding={6}
            checkpoints={() => game.checkpoints}
            localProgress={() => {
              progress.nextCheckpointIndex = nextCheckpointIndex();
              return progress;
            }}
            localVehicle={() => {
              poseTick();
              return localVehicle;
            }}
            aiCars={() => {
              poseTick();
              return rivals;
            }}
            aiLeaderId={leaderId}
          />
        </View>
      </View>
    </Viewport3D>
  );
}
