// apps/note/pocket.config.ts — app-local animation theme (build.ts prefers
// this over the repo root config).
//
// The caret is a browser-style square wave: 500 ms on, 500 ms off, sharp
// edges — not the soft animate-pulse sine. The long constant segments keep
// the DrawList byte-stable between edges, so every demand-rendering host
// paints ~2 frames per second while the caret rests instead of 60
// (docs/BACKENDS.md governor discipline). The 49.99% twin keyframe bakes to
// the same fixed-dt frame as 50%, making the transition a hard step.
import { definePocketConfig } from "@pocketjs/framework/config";

export default definePocketConfig({
  theme: {
    keyframes: {
      caret: {
        "0%,49.99%": { opacity: 1 },
        "50%,100%": { opacity: 0 },
      },
    },
    animation: {
      caret: "caret 1s linear infinite",
    },
  },
});
