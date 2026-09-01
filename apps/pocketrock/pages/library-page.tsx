import { For, Show, createMemo } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { LibraryKind } from "@pocketjs/framework/rockbox";

/**
 * Pure PocketRock library presentation.  Navigation and kinetic scrolling stay
 * in the shell: callers supply the current selection and pixel offset, so this
 * surface can render either a 64-item service page or the four root kinds.
 */
export type LibraryPageState = "ready" | "scanning" | "loading" | "empty" | "error";
export type LibraryPageView = "categories" | "results";

export interface LibraryCategory {
  kind: LibraryKind;
  /** Optional service count. An omitted count deliberately reads as a browse action. */
  count?: number;
  subtitle?: string;
}

export interface LibraryResult {
  id?: number | string;
  title: string;
  subtitle?: string;
  /** e.g. track count for an album, or duration for a track. */
  count?: number | string;
  countLabel?: string;
}

export interface LibraryPageProps {
  /** `categories` is the Artists / Albums / Tracks / Playlists root. */
  view?: LibraryPageView;
  kind?: LibraryKind;
  title?: string;
  subtitle?: string;
  back?: boolean;
  state?: LibraryPageState;
  error?: string;
  categories?: readonly LibraryCategory[];
  items?: readonly LibraryResult[];
  /** Index into the supplied visible page, not the entire tagcache. */
  selected?: number;
  /** Pixel scroll offset for the supplied page; owned by the parent scroller. */
  offset?: number;
  /** Total matching library entries, used in the compact header counter. */
  total?: number;
  /** Absolute offset of this service page, useful for "65–128 of 418". */
  pageOffset?: number;
}

const ROW_HEIGHT = 30;
const LIST_HEIGHT = 204;
const WINDOW_ROWS = Math.ceil(LIST_HEIGHT / ROW_HEIGHT) + 2;

const DEFAULT_CATEGORIES: readonly LibraryCategory[] = [
  { kind: "artists", subtitle: "Browse by artist" },
  { kind: "albums", subtitle: "Browse by album" },
  { kind: "tracks", subtitle: "All tracks" },
  { kind: "playlists", subtitle: "Saved playlists" },
];

function titleCase(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Keep Rockbox's single-line native text drawing inside its fixed 320px grid. */
function clipText(value: string | undefined, limit: number): string {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}…` : value;
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function Header(props: {
  title: string;
  subtitle?: string;
  total?: number;
  back: boolean;
}) {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[36] bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
      <Show when={props.back}>
        <View class="absolute left-[5] top-[6] h-[24] px-[7] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
          <Text class="text-xs text-white font-bold">MENU: Back</Text>
        </View>
      </Show>
      <View
        class="absolute right-[58] top-[3] h-[18] overflow-hidden"
        style={{ left: props.back ? 79 : 10 }}
      >
        <Text class="text-sm text-white font-bold">{clipText(props.title, props.back ? 23 : 33)}</Text>
      </View>
      <Show when={props.subtitle}>
        <View
          class="absolute right-[58] top-[19] h-[14] overflow-hidden"
          style={{ left: props.back ? 79 : 10 }}
        >
          <Text class="text-xs text-[#e3e9f1]">{clipText(props.subtitle, props.back ? 31 : 43)}</Text>
        </View>
      </Show>
      <Show when={props.total !== undefined}>
        <View class="absolute right-[7] top-[7] h-[21] min-w-[42] px-[6] flex-row items-center justify-center rounded-[10] bg-[#526681] border border-[#40516a]">
          <Text class="text-xs text-white font-bold">{props.total}</Text>
        </View>
      </Show>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

function CategoryRow(props: { item: LibraryCategory }) {
  const title = () => titleCase(props.item.kind);
  const count = () => props.item.count === undefined
    ? "Browse"
    : plural(props.item.count, title().slice(0, -1).toLowerCase());
  return (
    <View class="relative w-[320] h-[30] flex-col justify-center pl-[12] pr-[8]">
      <Text class="absolute left-[12] top-[3] w-[186] h-[15] text-sm text-[#18202a] font-bold">
        {title()}
      </Text>
      <Text class="absolute left-[12] top-[17] w-[190] h-[12] text-xs text-[#687484]">
        {clipText(props.item.subtitle, 30)}
      </Text>
      <Text class="absolute right-[9] top-[9] w-[99] h-[14] text-xs text-[#687484]">
        {clipText(count(), 16)}
      </Text>
    </View>
  );
}

function ResultRow(props: { item: LibraryResult; kind: LibraryKind }) {
  const trail = () => props.item.subtitle || (props.kind === "tracks" ? "Unknown artist" : "");
  const count = () => {
    if (props.item.count === undefined) return "";
    if (typeof props.item.count === "string") return props.item.count;
    return props.item.countLabel ? plural(props.item.count, props.item.countLabel) : String(props.item.count);
  };
  return (
    <View class="relative w-[320] h-[30] flex-col justify-center pl-[12] pr-[8]">
      <Text class="absolute left-[12] top-[3] w-[206] h-[15] text-sm text-[#18202a] font-bold">
        {clipText(props.item.title || "Untitled", 31)}
      </Text>
      <Text class="absolute left-[12] top-[17] w-[211] h-[12] text-xs text-[#687484]">
        {clipText(trail(), 35)}
      </Text>
      <Show when={count()}>
        <Text class="absolute right-[9] top-[9] w-[82] h-[14] text-xs text-[#687484]">
          {clipText(count(), 13)}
        </Text>
      </Show>
    </View>
  );
}

function StatusPanel(props: { state: Exclude<LibraryPageState, "ready" | "scanning">; error?: string }) {
  const isLoading = () => props.state === "loading";
  const isEmpty = () => props.state === "empty";
  const heading = () => isLoading() ? "Reading music database" : isEmpty() ? "No music found" : "Library unavailable";
  const detail = () => isLoading()
    ? "Please wait…"
    : isEmpty()
      ? "Add music, then update the database"
      : clipText(props.error || "The tagcache could not be read", 45);
  return (
    <View class="absolute left-0 top-[36] w-[320] h-[204] flex-col items-center justify-center bg-[#f5f6f8]">
      <Show when={isLoading()}>
        <View class="w-[56] h-[5] rounded-[3] bg-[#c4ccd7] overflow-hidden">
          <View class="w-[30] h-[5] rounded-[3] bg-[#2378d4]" />
        </View>
      </Show>
      <Text class="mt-[10] text-sm text-[#283442] font-bold">{heading()}</Text>
      <Text class="mt-[3] text-xs text-[#687484]">{detail()}</Text>
    </View>
  );
}

/**
 * A 320×240 library view. It intentionally has no input handlers or scroller;
 * use `selected` and `offset` from the owning PocketRock navigation shell.
 */
export default function LibraryPage(props: LibraryPageProps) {
  const view = () => props.view ?? "categories";
  const state = () => props.state ?? "ready";
  const kind = () => props.kind ?? "artists";
  const selected = () => Math.max(0, props.selected ?? 0);
  const offset = () => Math.max(0, props.offset ?? 0);
  const categories = () => props.categories ?? DEFAULT_CATEGORIES;
  const rows = createMemo(() => view() === "categories" ? categories() : (props.items ?? []));
  const title = () => props.title ?? (view() === "categories" ? "Music" : titleCase(kind()));
  const subtitle = () => {
    if (props.subtitle !== undefined) return props.subtitle;
    if (view() === "categories") return "Library";
    const count = props.items?.length ?? 0;
    if (count === 0) return undefined;
    const firstItem = (props.pageOffset ?? 0) + 1;
    const lastItem = (props.pageOffset ?? 0) + count;
    return props.total === undefined ? `${firstItem}–${lastItem}` : `${firstItem}–${lastItem} of ${props.total}`;
  };
  const first = createMemo(() => Math.max(
    0,
    Math.min(Math.max(0, rows().length - WINDOW_ROWS), Math.floor(offset() / ROW_HEIGHT) - 1),
  ));
  const visible = createMemo(() => rows().slice(first(), first() + WINDOW_ROWS));
  const translateY = createMemo(() => first() * ROW_HEIGHT - offset());
  const selectionIndex = createMemo(() => Math.min(selected(), Math.max(0, rows().length - 1)));
  const selectionY = createMemo(() => selectionIndex() * ROW_HEIGHT - offset());
  const resultTotal = () => props.total ?? (view() === "categories" ? undefined : props.items?.length);
  const hasRows = () => rows().length > 0;
  const displayState = () => state() === "ready" && !hasRows() ? "empty" : state();

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <Show when={displayState() === "ready" || displayState() === "scanning"} fallback={
        <StatusPanel state={displayState() as Exclude<LibraryPageState, "ready" | "scanning">} error={props.error} />
      }>
        <View class="absolute left-0 top-[36] w-[320] h-[204] bg-[#f5f6f8] overflow-hidden">
          <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
            <For each={visible()}>{(_, index) => {
              const rowIndex = () => first() + index();
              return (
                <View class="relative w-[320] h-[30]">
                  <Show when={rowIndex() + 1 < rows().length && rowIndex() !== selectionIndex() && rowIndex() + 1 !== selectionIndex()}>
                    <View class="absolute left-[12] right-0 bottom-0 h-[1] bg-[#d5d9df]" />
                  </Show>
                </View>
              );
            }}</For>
          </View>
          <Show when={hasRows()}>
            <View class="absolute left-0 top-0 w-[320] h-[30] bg-[#2378d4]" style={{ translateY: selectionY() }} />
          </Show>
          <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
            <For each={visible()}>{(item) =>
              <Show when={view() === "categories"} fallback={<ResultRow item={item as LibraryResult} kind={kind()} />}>
                <CategoryRow item={item as LibraryCategory} />
              </Show>
            }</For>
          </View>
          <Show when={displayState() === "scanning"}>
            <View class="absolute left-0 bottom-0 w-[320] h-[18] flex-row items-center pl-[11] bg-[#e5ebf3] border-t border-[#bdc8d6]">
              <View class="w-[5] h-[5] rounded-[3] bg-[#2378d4]" />
              <Text class="ml-[5] text-xs text-[#4d6078] font-bold">UPDATING MUSIC DATABASE</Text>
              <Show when={props.total !== undefined}>
                <Text class="absolute right-[9] top-[3] text-xs text-[#687484]">{props.total} found</Text>
              </Show>
            </View>
          </Show>
        </View>
      </Show>
      <Header title={title()} subtitle={subtitle()} total={resultTotal()} back={props.back ?? false} />
    </View>
  );
}
