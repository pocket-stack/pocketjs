// apps/music — app-local Pocket config: baked equalizer timelines.
//
// The four bars sample h(f) = 6 + 20*|sin(0.15f + 1.7i)| — the exact curve
// the JS equalizer used to compute per frame — at 8 points per |sin| period
// (pi/0.15 ~= 21 frames ~= 350ms), with each bar's phase baked into its own
// keyframes. The whole choreography replays every 350ms via `loop`, so the
// host animates the bars forever with zero per-frame JS.

import { definePocketConfig } from "@pocketjs/framework/config";

const EQ_MS = "350ms";

export default definePocketConfig({
  theme: {
    keyframes: {
      "eq-bar-0": { from: { height: 6.0 }, "12.5%": { height: 13.7 }, "25%": { height: 20.1 }, "37.5%": { height: 24.5 }, "50%": { height: 26.0 }, "62.5%": { height: 24.5 }, "75%": { height: 20.1 }, "87.5%": { height: 13.7 }, to: { height: 6.0 } },
      "eq-bar-1": { from: { height: 25.8 }, "12.5%": { height: 23.3 }, "25%": { height: 18.2 }, "37.5%": { height: 11.2 }, "50%": { height: 8.6 }, "62.5%": { height: 16.0 }, "75%": { height: 21.8 }, "87.5%": { height: 25.3 }, to: { height: 25.8 } },
      "eq-bar-2": { from: { height: 11.1 }, "12.5%": { height: 18.1 }, "25%": { height: 23.3 }, "37.5%": { height: 25.8 }, "50%": { height: 25.3 }, "62.5%": { height: 21.9 }, "75%": { height: 16.1 }, "87.5%": { height: 8.7 }, to: { height: 11.1 } },
      "eq-bar-3": { from: { height: 24.5 }, "12.5%": { height: 20.2 }, "25%": { height: 13.7 }, "37.5%": { height: 6.1 }, "50%": { height: 13.6 }, "62.5%": { height: 20.1 }, "75%": { height: 24.4 }, "87.5%": { height: 26.0 }, to: { height: 24.5 } },
    },
    animation: {
      "eq0": { value: "eq-bar-0 350ms linear both", loop: EQ_MS },
      "eq1": { value: "eq-bar-1 350ms linear both", loop: EQ_MS },
      "eq2": { value: "eq-bar-2 350ms linear both", loop: EQ_MS },
      "eq3": { value: "eq-bar-3 350ms linear both", loop: EQ_MS },
    },
  },
});
