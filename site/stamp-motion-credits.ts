// Add the persistent (yui540) badge to every committed Motion Lab GIF.
//
//   bun site/stamp-motion-credits.ts
//   bun site/stamp-motion-credits.ts --check

import { ensureMotionCredits } from "./motion-credit.ts";

const result = ensureMotionCredits({ checkOnly: Bun.argv.includes("--check") });
if (result.stamped.length > 0) {
  console.log(`motion credits: stamped ${result.stamped.length} asset(s)`);
} else {
  console.log(`motion credits: verified ${result.checked} asset(s)`);
}
