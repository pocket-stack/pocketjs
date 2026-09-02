// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/handlers.ts — the shape every surface implements. One
// recogniser covers the screen (app.tsx); each contact is routed at its down
// edge to the surface under it and every later callback for that contact
// follows the same route, so a sheet cannot steal a finger that began on
// the stage and a finger that began on the sheet cannot leak through it.

import type { GestureContact } from "@pocketjs/framework/gesture";

export type GestureHandlers = {
  [K in "onDown" | "onMove" | "onTap" | "onLongPress" | "onPanStart" | "onPanMove" | "onUp" | "onCancel"]?: (
    c: GestureContact,
  ) => void;
};
