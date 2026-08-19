// apps/desk98/pocket.config.ts — the Notepad caret reuses the note app's
// square-wave blink: 500 ms on, 500 ms off, hard edges. Long constant
// segments keep the DrawList byte-stable between edges so the demand-
// rendering host paints ~2 frames a second while the caret rests
// (docs/BACKENDS.md governor discipline).
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
