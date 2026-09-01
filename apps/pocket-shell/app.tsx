// apps/pocket-shell/app.tsx — Pocket Shell: a tiling window shell for the
// Nintendo 3DS, entirely on the console. The top screen is the stage —
// Omarchy's tokyo-night wallpaper under dwindle- or scrolling-tiled windows —
// and the touch screen is the deck, where the shoulders' chord map, the
// workspace strip, a live minimap and the dock live. See README.md for the
// interaction design and store.ts for how input becomes actions.

import { AuxiliarySurface } from "@pocketjs/framework/components";
import { Deck } from "./deck.tsx";
import { Stage } from "./stage.tsx";
import { createShellStore } from "./store.ts";

export default function PocketShell() {
  const store = createShellStore();
  // Debug handle for the headless sim test (tests/pocket-shell-sim.test.ts),
  // which has no touch screen to open windows from.
  (globalThis as { __pocketShell?: unknown }).__pocketShell = store;
  return (
    <>
      <Stage store={store} />
      <AuxiliarySurface>
        <Deck store={store} />
      </AuxiliarySurface>
    </>
  );
}
