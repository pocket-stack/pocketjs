// Pocket Desktop's visible application catalog comes from its System manifest.
// The native host receives separately resolved complete package plans; this
// module carries only System-owned presentation data.

import type { PocketSystemV1 } from "@pocketjs/framework/manifest";
import systemJson from "./pocket.system.json";

const system = systemJson as unknown as PocketSystemV1;
const installedPackages = new Set(system.installation.installedPackages);

export interface PocketAppSpec {
  /** Stable package id used by the native compositor surface registry. */
  package: string;
  /** Compact desktop caption/icon label. */
  title: string;
  /** The macos-app plan's logical viewport. */
  viewport: readonly [number, number];
}

export const POCKET_APPS: readonly PocketAppSpec[] = system.applications.catalog
  .filter((entry) => installedPackages.has(entry.package) && entry.presentation)
  .map((entry) => ({
    package: entry.package,
    title: entry.presentation!.title,
    viewport: entry.presentation!.viewport,
  }));

export const POCKET_ICON = "icons/pocket-app.svg";
export const POCKET_ICON_SMALL = "icons/pocket-app-16.svg";
