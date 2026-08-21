// apps/desk98/pocket-apps.ts — the fixed PocketJS demo catalog exposed by
// PocketJS 98. tools/macos.ts imports the same list to build every bundle the
// single-process desktop host may open; app.tsx uses it for icons and windows.

export interface PocketAppSpec {
  /** apps/<dir>/pocket.json */
  dir: string;
  /** Built bundle/pak stem and host realm key. */
  output: string;
  /** Compact desktop caption/icon label. */
  title: string;
  /** The macos-app plan's logical viewport. */
  viewport: readonly [number, number];
}

/** The small, hardware-neutral demos that form the PocketJS showcase. Device
 *  ports, editors, launchers and 3D products keep their own hosts/workflows. */
export const POCKET_APPS: readonly PocketAppSpec[] = [
  { dir: "hero", output: "hero-main", title: "Hero", viewport: [640, 360] },
  {
    dir: "settings",
    output: "settings-main",
    title: "Settings",
    viewport: [480, 272],
  },
  {
    dir: "motions",
    output: "motions-main",
    title: "Motions",
    viewport: [480, 272],
  },
  { dir: "cards", output: "cards-main", title: "Cards", viewport: [480, 272] },
  {
    dir: "chrome",
    output: "chrome-main",
    title: "Chrome",
    viewport: [480, 272],
  },
  {
    dir: "cursor",
    output: "cursor-main",
    title: "Cursor",
    viewport: [480, 272],
  },
  {
    dir: "gallery",
    output: "gallery-main",
    title: "Gallery",
    viewport: [480, 272],
  },
  {
    dir: "library",
    output: "library-main",
    title: "Library",
    viewport: [480, 272],
  },
  { dir: "music", output: "music-main", title: "Music", viewport: [480, 272] },
  {
    dir: "notifications",
    output: "notifications-main",
    title: "Notifications",
    viewport: [480, 272],
  },
  { dir: "stats", output: "stats-main", title: "Stats", viewport: [480, 272] },
] as const;

/** Name registered in the desk shell's native texture table. The GPUI host
 *  treats its texture handle as a portal and paints the matching realm there. */
export function pocketPortalSource(output: string): string {
  return `pocket-app/${output}`;
}

export const POCKET_ICON = "icons/pocket-app.svg";
export const POCKET_ICON_SMALL = "icons/pocket-app-16.svg";
