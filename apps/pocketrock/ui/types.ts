import type { JSX } from "solid-js";
import type { ViewProps } from "@pocketjs/framework/components";

/** Palette roles intentionally kept small for the 320x240 PocketRock shell. */
export type PocketRockTone = "neutral" | "accent" | "success" | "warning" | "danger";

/** Shared 320x240 page frame. Content begins directly below the 36px chrome. */
export interface PocketRockPageProps {
  title: string;
  back?: boolean;
  backLabel?: string;
  children?: JSX.Element;
  notice?: JSX.Element;
}

/** Fixed-height list row whose separator, selection, and text are separate layers. */
export interface PocketRockListRowProps extends Omit<ViewProps, "children" | "class"> {
  title: JSX.Element;
  subtitle?: JSX.Element;
  detail?: JSX.Element;
  selected?: boolean;
  divider?: boolean;
  tone?: PocketRockTone;
}

export interface PocketRockInfoCardProps {
  title: JSX.Element;
  detail?: JSX.Element;
  children?: JSX.Element;
  tone?: PocketRockTone;
}

export interface PocketRockSliderProps {
  label: JSX.Element;
  value: number;
  valueLabel?: JSX.Element;
  selected?: boolean;
}

export interface PocketRockStatusBadgeProps {
  label: JSX.Element;
  tone?: PocketRockTone;
}

export interface PocketRockEmptyStateProps {
  title: JSX.Element;
  detail?: JSX.Element;
  action?: JSX.Element;
}
