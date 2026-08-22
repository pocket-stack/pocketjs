// Pocket Desktop's visible application catalog comes from the Environment
// specification. RuntimeSupervisor receives the separately resolved, complete
// package plans; this module carries only environment-owned presentation data.

import type { PocketEnvironmentV1 } from "../../contracts/spec/pocket-environment.ts";
import environmentJson from "./pocket.environment.json";

const environment = environmentJson as unknown as PocketEnvironmentV1;

export interface PocketAppSpec {
  /** Stable package id used by the native compositor surface registry. */
  package: string;
  /** Compact desktop caption/icon label. */
  title: string;
  /** The macos-app plan's logical viewport. */
  viewport: readonly [number, number];
}

export const POCKET_APPS: readonly PocketAppSpec[] =
  environment.applications.packages
    .filter((entry) => entry.installation !== "available" && entry.presentation)
    .map((entry) => ({
      package: entry.package,
      title: entry.presentation!.title,
      viewport: entry.presentation!.viewport,
    }));

export const POCKET_ICON = "icons/pocket-app.svg";
export const POCKET_ICON_SMALL = "icons/pocket-app-16.svg";
