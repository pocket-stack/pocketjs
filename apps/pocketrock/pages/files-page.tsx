import { For, Show, createMemo } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

/** The browser-facing kind; callers do not need to turn files into UI labels. */
export type FileBrowserKind = "directory" | "music" | "playlist" | "file";

export interface FileBrowserEntry {
  /** Stable path or id. The component never parses this value. */
  id: string;
  name: string;
  kind: FileBrowserKind;
  /** e.g. "12.4 MiB". Displayed at the right edge when supplied. */
  size?: string;
  /** e.g. artist, track count, file type, or modified date. */
  subtitle?: string;
}

export type FileBrowserUsbState = "normal" | "readonly" | "busy";

export interface FilesPageProps {
  /** Defaults to Files. */
  title?: string;
  /** Absolute path or breadcrumb segments, such as ["Music", "Albums"]. */
  path?: string | readonly string[];
  entries?: readonly FileBrowserEntry[];
  /** Includes a synthetic `..` row whenever the path is not the volume root. */
  showParent?: boolean;
  /** Selected row in the displayed rows, including the optional parent row. */
  selected?: number;
  /** Pixel list offset. Keeping this external makes the page work with the shell scroller. */
  offset?: number;
  /** A recoverable directory-read failure replaces the list with an error state. */
  error?: string;
  /** USB does not hide the browser: it communicates whether writes are safe. */
  usbState?: FileBrowserUsbState;
}

const SCREEN_W = 320;
const ROW_H = 32;
const LIST_TOP = 56;
const LIST_H = 184;
const WINDOW_ROWS = Math.ceil(LIST_H / ROW_H) + 2;
const PARENT: FileBrowserEntry = { id: "..", name: "..", kind: "directory", subtitle: "Up one folder" };

function breadcrumb(path: FilesPageProps["path"]): string {
  if (typeof path !== "string") return path?.length ? `/${path.join("/")}` : "/";
  if (!path || path === "/") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function canGoUp(path: string): boolean {
  return path !== "/";
}

function typeMark(kind: FileBrowserKind): string {
  switch (kind) {
    case "directory": return "DIR";
    case "music": return "MUS";
    case "playlist": return "PL";
    default: return "FILE";
  }
}

function typeColor(kind: FileBrowserKind): string {
  switch (kind) {
    case "directory": return "#627f9e";
    case "music": return "#6e8498";
    case "playlist": return "#83758f";
    default: return "#8a929c";
  }
}

function UsbNotice(props: { state: FileBrowserUsbState }) {
  const copy = () => props.state === "busy"
    ? "USB: device busy"
    : "USB: read-only";
  return (
    <Show when={props.state !== "normal"}>
      <View class="absolute right-[6] top-[7] h-[17] px-[5] flex-row items-center rounded-[3] bg-[#d8dee6] border border-[#a9b4c1]">
        <Text class="text-[10] text-[#4c5d70] font-bold">{copy()}</Text>
      </View>
    </Show>
  );
}

function FileRow(props: { entry: FileBrowserEntry }) {
  const compactMeta = () => props.entry.size ?? props.entry.subtitle ?? "";
  return (
    <View class="relative w-[320] h-[32] flex-row items-center pl-[9] pr-[8]">
      <Text
        class="w-[29] text-[10] font-bold"
        style={{ textColor: typeColor(props.entry.kind) }}
      >
        {typeMark(props.entry.kind)}
      </Text>
      <View class="h-[32] flex-1 flex-col justify-center pr-[5]">
        <Text class="text-sm text-[#18202a] font-bold">{props.entry.name}</Text>
        <Show when={props.entry.subtitle}>
          <Text class="text-[10] text-[#758190]">{props.entry.subtitle}</Text>
        </Show>
      </View>
      <Show when={compactMeta()}>
        <Text class="absolute right-[8] top-[10] text-[10] text-[#687484]">{compactMeta()}</Text>
      </Show>
    </View>
  );
}

function BrowserMessage(props: { title: string; detail: string }) {
  return (
    <View class="absolute left-0 top-[56] w-[320] h-[184] flex-col items-center justify-center px-[22] bg-[#f5f6f8]">
      <Text class="text-sm text-[#364250] font-bold">{props.title}</Text>
      <Text class="mt-[4] text-xs text-[#778392]">{props.detail}</Text>
    </View>
  );
}

/**
 * Compact 320x240 file-browser surface. Navigation and filesystem operations
 * deliberately remain in the host shell; this component only renders the
 * latest props snapshot, so USB state changes cannot leave stale local data.
 */
export default function FilesPage(props: FilesPageProps) {
  const path = createMemo(() => breadcrumb(props.path));
  const rows = createMemo<readonly FileBrowserEntry[]>(() => {
    const entries = props.entries ?? [];
    return (props.showParent ?? true) && canGoUp(path()) ? [PARENT, ...entries] : entries;
  });
  const selected = createMemo(() => Math.max(0, Math.min(rows().length - 1, props.selected ?? 0)));
  const offset = () => Math.max(0, props.offset ?? 0);
  const first = createMemo(() => Math.max(
    0,
    Math.min(Math.max(0, rows().length - WINDOW_ROWS), Math.floor(offset() / ROW_H) - 1),
  ));
  const visible = createMemo(() => rows().slice(first(), first() + WINDOW_ROWS));
  const translateY = createMemo(() => first() * ROW_H - offset());
  const selectionY = createMemo(() => selected() * ROW_H - offset());
  const usb = () => props.usbState ?? "normal";

  return (
    <View class="absolute left-0 top-0 w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
        <Text class="text-base text-white font-bold">{props.title ?? "Files"}</Text>
        <UsbNotice state={usb()} />
        <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
      </View>

      <View class="absolute left-0 top-[36] w-[320] h-[20] flex-row items-center px-[9] bg-[#e5e9ee]">
        <Text class="text-[10] text-[#526274] font-bold">{path()}</Text>
        <Text class="absolute right-[8] top-[4] text-[10] text-[#7d8996]">{rows().length} items</Text>
        <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#c5cdd7]" />
      </View>

      <Show when={!props.error && rows().length > 0}>
        <View class="absolute left-0 top-[56] w-[320] h-[184] overflow-hidden">
          <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
            <For each={visible()}>{(_, index) => {
              const rowIndex = () => first() + index();
              return (
                <View class="relative w-[320] h-[32]">
                  <Show when={rowIndex() + 1 < rows().length && rowIndex() !== selected() && rowIndex() + 1 !== selected()}>
                    <View class="absolute left-[9] right-0 bottom-0 h-[1] bg-[#d5d9df]" />
                  </Show>
                </View>
              );
            }}</For>
          </View>
          <View class="absolute left-0 top-0 w-[320] h-[32] bg-[#2378d4]" style={{ translateY: selectionY() }} />
          <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
            <For each={visible()}>{(entry) => <FileRow entry={entry} />}</For>
          </View>
        </View>
      </Show>

      <Show when={!props.error && rows().length === 0}>
        <BrowserMessage title="This folder is empty" detail="No files or folders to show" />
      </Show>
      <Show when={!!props.error}>
        <BrowserMessage title="Unable to read this folder" detail={props.error!} />
      </Show>
    </View>
  );
}
