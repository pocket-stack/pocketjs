import { For, Show, createMemo } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

/** The four runtime buckets exposed by PocketRock's launcher registry. */
export type AppsPageCategory = "all" | "pocket" | "apps" | "games" | "demos";

export type AppsPageSource = "builtin" | "third-party";

/**
 * Display data for one launcher entry.  The page deliberately does not call
 * appTable(): Shell owns the host boundary and can pass either a live table
 * or a deterministic preview fixture into this component.
 */
export interface AppsPageEntry {
  title?: string;
  id?: string;
  kind?: "pocket" | "rockbox";
  path?: string;
  category?: Exclude<AppsPageCategory, "all">;
  source?: AppsPageSource;
  builtIn?: boolean;
  /** Explicit package validation result from the host/loader. */
  valid?: boolean;
  /** Optional short loader error, shown on the entry and in the footer. */
  error?: string;
}

export interface AppsPageProps {
  apps: readonly AppsPageEntry[];
  category?: AppsPageCategory;
  /** Selected/offset are indices in the currently filtered `apps` list. */
  selected?: number;
  offset?: number;
  /** false means the launcher ABI did not return an app table. */
  appTableAvailable?: boolean;
  notice?: string;
  /** Category strip is also driven by the shell's button/focus layer. */
  onCategoryChange?: (category: AppsPageCategory) => void;
  onSelect?: (entry: AppsPageEntry, index: number) => void;
  onLaunch?: (entry: AppsPageEntry, index: number) => void;
}

const ROW_HEIGHT = 30;
const LIST_HEIGHT = 150;
const VISIBLE_ROWS = LIST_HEIGHT / ROW_HEIGHT;

const CATEGORY_LABEL: Record<AppsPageCategory, string> = {
  all: "ALL",
  pocket: "POCKET",
  apps: "APPS",
  games: "GAMES",
  demos: "DEMOS",
};

const CATEGORY_ORDER: readonly AppsPageCategory[] = [
  "all",
  "pocket",
  "apps",
  "games",
  "demos",
];

function inferCategory(entry: AppsPageEntry): Exclude<AppsPageCategory, "all"> {
  if (entry.category) return entry.category;
  if (entry.kind !== "rockbox") return "pocket";

  const path = (entry.path ?? "").toLowerCase();
  if (path.includes("/games/") || path.includes("\\games\\")) return "games";
  if (path.includes("/demos/") || path.includes("\\demos\\")) return "demos";
  return "apps";
}

function isBadPackage(entry: AppsPageEntry): boolean {
  if (entry.valid === false) return true;
  // A PocketJS entry needs its manifest id; a Rockbox entry needs the .rock
  // path. Keep malformed host rows visible so users can diagnose the table.
  return entry.kind === "rockbox" ? !entry.path : !entry.id;
}

function packageRef(entry: AppsPageEntry): string {
  return entry.kind === "rockbox"
    ? entry.path ?? "path missing"
    : entry.id ?? "package id missing";
}

function sourceLabel(entry: AppsPageEntry): string {
  if (entry.builtIn === true || entry.source === "builtin") return "BUILT-IN";
  if (entry.builtIn === false || entry.source === "third-party") return "3RD-PARTY";
  return "SOURCE ?";
}

function kindLabel(entry: AppsPageEntry): string {
  return entry.kind === "rockbox" ? "R" : "P";
}

function kindDescription(entry: AppsPageEntry): string {
  return entry.kind === "rockbox" ? CATEGORY_LABEL[inferCategory(entry)] : "POCKETJS";
}

function categoryDescription(category: AppsPageCategory): string {
  if (category === "all") return "PocketJS + Rockbox entries";
  if (category === "pocket") return "PocketJS packages";
  return `Rockbox ${CATEGORY_LABEL[category].toLowerCase()}`;
}

function AppRow(props: {
  entry: AppsPageEntry;
  selected: boolean;
  onSelect?: () => void;
  onLaunch?: () => void;
}) {
  const bad = () => isBadPackage(props.entry);

  return (
    <View
      focusable={props.onSelect !== undefined || props.onLaunch !== undefined}
      onPress={() => {
        props.onSelect?.();
        props.onLaunch?.();
      }}
      class={props.selected ? "relative w-[320] h-[30] flex-row bg-[#2378d4]" : "relative w-[320] h-[30] flex-row bg-[#f5f6f8]"}
    >
      <View class={props.selected ? "w-[27] h-[30] items-center justify-center bg-[#195ea9]" : "w-[27] h-[30] items-center justify-center bg-[#e2e7ee]"}>
        <Text class={props.selected ? "text-xs text-white font-bold" : bad() ? "text-xs text-[#b13d36] font-bold" : "text-xs text-[#3b5877] font-bold"}>
          {bad() ? "!" : kindLabel(props.entry)}
        </Text>
      </View>
      <View class="flex-1 h-[30] flex-col justify-center pl-[8] pr-[5] overflow-hidden">
        <Text class={props.selected ? "text-xs text-white font-bold" : "text-xs text-[#17202a] font-bold"}>
          {props.entry.title?.trim() || "Untitled package"}
        </Text>
        <Text class={props.selected ? "text-[10px] text-[#d8e8fb]" : "text-[10px] text-[#657181]"}>
          {bad() ? props.entry.error || "PACKAGE DATA INVALID" : packageRef(props.entry)}
        </Text>
      </View>
      <View class="w-[73] h-[30] flex-col items-end justify-center pr-[7] overflow-hidden">
        <Text class={props.selected ? "text-[10px] text-white font-bold" : bad() ? "text-[10px] text-[#b13d36] font-bold" : "text-[10px] text-[#3c526c] font-bold"}>
          {bad() ? "BAD PACKAGE" : sourceLabel(props.entry)}
        </Text>
        <Text class={props.selected ? "text-[10px] text-[#d8e8fb]" : "text-[10px] text-[#7a8795]"}>
          {kindDescription(props.entry)}
        </Text>
      </View>
      <Show when={!props.selected}>
        <View class="absolute left-[27] right-0 bottom-0 h-[1] bg-[#d5d9df]" />
      </Show>
    </View>
  );
}

/**
 * Compact, 320x240 application-center surface.  It intentionally renders no
 * controls of its own: the parent maps Click Wheel / SELECT to `selected`,
 * `offset`, `onSelect`, and `onLaunch`, which keeps this screen reusable for
 * the Pocket Apps and Rockbox Apps shell routes.
 */
export default function AppsPage(props: AppsPageProps) {
  const category = () => props.category ?? "all";
  const allApps = createMemo(() => props.apps ?? []);
  const filtered = createMemo(() => {
    const active = category();
    return active === "all"
      ? [...allApps()]
      : allApps().filter((entry) => inferCategory(entry) === active);
  });
  const offset = createMemo(() => Math.max(0, props.offset ?? 0));
  const first = createMemo(() => Math.max(0, Math.floor(offset() / ROW_HEIGHT)));
  const visible = createMemo(() => filtered().slice(first(), first() + VISIBLE_ROWS));
  const selected = createMemo(() => Math.min(
    Math.max(0, filtered().length - 1),
    Math.max(0, props.selected ?? 0),
  ));
  const hasTable = () => props.appTableAvailable !== false;
  const footerNotice = createMemo(() => {
    if (props.notice) return props.notice;
    const bad = filtered().find((entry) => isBadPackage(entry));
    return bad?.error || (bad ? "SELECT shows package diagnostics" : "SELECT launch  •  MENU back");
  });

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View class="absolute left-0 top-0 w-[320] h-[34] flex-row items-center justify-between px-[10] bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
        <Text class="text-base text-white font-bold">APPLICATIONS</Text>
        <Text class="text-xs text-[#e2e9f2]">{filtered().length} FOUND</Text>
        <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
      </View>

      <View class="absolute left-0 top-[34] w-[320] h-[24] flex-row bg-[#dfe5ed] border-b border-[#b6c1cf]">
        <For each={CATEGORY_ORDER}>{(item) =>
          <View
            focusable={props.onCategoryChange !== undefined}
            onPress={() => props.onCategoryChange?.(item)}
            class={category() === item ? "flex-1 h-[24] items-center justify-center bg-[#2378d4]" : "flex-1 h-[24] items-center justify-center"}
          >
            <Text class={category() === item ? "text-[10px] text-white font-bold" : "text-[10px] text-[#526276] font-bold"}>
              {CATEGORY_LABEL[item]}
            </Text>
          </View>
        }</For>
      </View>

      <View class="absolute left-0 top-[58] w-[320] h-[150] bg-[#f5f6f8] overflow-hidden">
        <Show when={hasTable()} fallback={
          <View class="w-[320] h-[150] items-center justify-center px-[20]">
            <Text class="text-sm text-[#263447] font-bold">APP LIST UNAVAILABLE</Text>
            <Text class="mt-[4] text-xs text-[#6d7887]">Launcher ABI did not return a table</Text>
          </View>
        }>
          <Show when={filtered().length > 0} fallback={
            <View class="w-[320] h-[150] items-center justify-center px-[20]">
              <Text class="text-sm text-[#263447] font-bold">NO APPLICATIONS</Text>
              <Text class="mt-[4] text-xs text-[#6d7887] text-center">{categoryDescription(category())}</Text>
            </View>
          }>
            <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: first() * ROW_HEIGHT - offset() }}>
              <For each={visible()}>{(entry, index) => {
                const absoluteIndex = () => first() + index();
                return (
                  <AppRow
                    entry={entry}
                    selected={absoluteIndex() === selected()}
                    onSelect={() => props.onSelect?.(entry, absoluteIndex())}
                    onLaunch={() => props.onLaunch?.(entry, absoluteIndex())}
                  />
                );
              }}</For>
            </View>
          </Show>
        </Show>
      </View>

      <View class="absolute left-0 bottom-0 w-[320] h-[32] flex-row items-center justify-between px-[9] bg-[#e3e7ed] border-t border-[#c3cbd6]">
        <Text class="w-[238] text-[10px] text-[#647183] overflow-hidden">{footerNotice()}</Text>
        <Text class="text-[10px] text-[#53657b] font-bold">{filtered().length > 0 ? `${selected() + 1}/${filtered().length}` : "—"}</Text>
      </View>
    </View>
  );
}

export { AppRow, categoryDescription, inferCategory, isBadPackage };
