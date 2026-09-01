// apps/pocket-shell/applets.tsx — what the windows hold. Every applet is
// self-contained on the console: pocketsh drives the window manager itself,
// the clock reads the RTC, notes is a scratch pad, keys is the chord table,
// stats reads the frame loop, about says what this is.
//
// An applet is given its content size and reads its own state object from
// the store (one per window, mutated in place, revalidated through `rev`).
// Text rows are absolutely positioned: on this host a Text that is a direct
// flex child of a short bar can paint nothing, so rows are offsets.

import { Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework";
import { keySheet } from "./chords.ts";
import { formatClock, formatDate, formatUptime } from "./shell.ts";
import type { AppId, ShellStore } from "./store.ts";

export interface AppletProps {
  id: number;
  app: AppId;
  store: ShellStore;
  /** Content size: the window minus border and header. */
  w: () => number;
  h: () => number;
}

/** 12 px JetBrains Mono is spec slot 16; its ~7.2 px advance snaps to a 7 px
 *  cell the way Pocket Term does it, so columns land on pixels. */
const MONO_SLOT = 16;
const LINE_H = 13;
const ROW_H = 13;
const PAD = 4;

let cellW = 7;
let measured = false;
function monoCell(): number {
  if (!measured) {
    measured = true;
    const advance = getOps().measureText("M", MONO_SLOT);
    if (advance > 0) cellW = Math.max(6, Math.round(advance));
  }
  return cellW;
}

/** Hard-wrap one logical line to `cols` cells. */
function wrap(line: string, cols: number, out: string[]): void {
  if (cols < 1) return;
  if (line.length === 0) {
    out.push("");
    return;
  }
  for (let i = 0; i < line.length; i += cols) out.push(line.slice(i, i + cols));
}

export function Applet(props: AppletProps) {
  switch (props.app) {
    case "term":
      return <Term {...props} />;
    case "clock":
      return <Clock {...props} />;
    case "notes":
      return <Notes {...props} />;
    case "keys":
      return <Keys {...props} />;
    case "stats":
      return <Stats {...props} />;
    case "about":
      return <About {...props} />;
  }
}

// ---- term ---------------------------------------------------------------------

function Term(props: AppletProps) {
  const cell = monoCell();
  const cols = () => Math.max(4, Math.floor((props.w() - PAD * 2) / cell));
  const rows = () => Math.max(1, Math.floor((props.h() - PAD) / LINE_H));
  const state = () => {
    props.store.rev();
    const s = props.store.stateOf(props.id);
    return s && s.kind === "term" ? s : null;
  };
  /** Wrapped scrollback, then the visible window of it above the prompt. */
  const view = () => {
    const s = state();
    if (!s) return { lines: [] as string[], input: "", promptRow: 0 };
    const wrapped: string[] = [];
    for (const line of s.lines) wrap(line, cols(), wrapped);
    const visible = rows() - 1; // the prompt keeps the last row
    const maxScroll = Math.max(0, wrapped.length - visible);
    const scroll = Math.min(s.scroll, maxScroll);
    const end = wrapped.length - scroll;
    const start = Math.max(0, end - visible);
    const lines = wrapped.slice(start, end);
    return { lines, input: s.input, promptRow: lines.length };
  };
  const inputShown = () => {
    const text = view().input;
    const room = cols() - 3;
    return text.length > room ? text.slice(text.length - room) : text;
  };
  return (
    <View debugName="Term" class="absolute inset-0 bg-[#1a1b26]">
      <Index each={view().lines}>
        {(line, i) => (
          <Text
            class="absolute left-[4] font-mono text-xs text-[#a9b1d6]"
            style={{ insetT: PAD + i * LINE_H }}
          >
            {line()}
          </Text>
        )}
      </Index>
      <Text
        class="absolute left-[4] font-mono text-xs text-[#9ece6a] font-bold"
        style={{ insetT: PAD + view().promptRow * LINE_H }}
      >
        {"❯"}
      </Text>
      <Text
        class="absolute font-mono text-xs text-[#c0caf5]"
        style={{ insetL: PAD + cell * 2, insetT: PAD + view().promptRow * LINE_H }}
      >
        {inputShown()}
      </Text>
      <View
        class="absolute w-[7] h-[13] bg-[#7aa2f7]"
        style={{
          insetL: PAD + cell * (2 + inputShown().length),
          insetT: PAD + view().promptRow * LINE_H,
        }}
      />
    </View>
  );
}

// ---- clock --------------------------------------------------------------------

function Clock(props: AppletProps) {
  const state = () => {
    props.store.rev();
    const s = props.store.stateOf(props.id);
    return s && s.kind === "clock" ? s : null;
  };
  const time = () => formatClock(props.store.now(), state()?.hour12 ?? false);
  const suffix = () => (state()?.hour12 ? (props.store.now().hour < 12 ? "am" : "pm") : "");
  const seconds = () => props.store.now().second;
  const big = () => props.w() >= 200 && props.h() >= 96;
  const mid = () => !big() && props.h() >= 56 && props.w() >= 110;
  return (
    <View debugName="Clock" class="absolute inset-0 items-center justify-center flex-col bg-[#1a1b26]">
      <Show when={big()}>
        <Text class="text-4xl text-[#c0caf5] font-bold">{time()}</Text>
      </Show>
      <Show when={mid()}>
        <Text class="text-2xl text-[#c0caf5] font-bold">{time()}</Text>
      </Show>
      <Show when={!big() && !mid()}>
        <Text class="text-base text-[#c0caf5] font-bold">{time()}</Text>
      </Show>
      <Show when={props.h() >= 56}>
        <Text class="text-xs text-[#7aa2f7]">
          {formatDate(props.store.now())}
          {suffix() ? ` ${suffix()}` : ""}
        </Text>
      </Show>
      <View class="absolute left-[8] right-[8] bottom-[6] h-[2] bg-[#292e42]">
        <View
          class="absolute left-0 top-0 h-[2] bg-[#bb9af7]"
          style={{ width: Math.max(0, props.w() - 16) * (seconds() / 60) }}
        />
      </View>
    </View>
  );
}

// ---- notes --------------------------------------------------------------------

function Notes(props: AppletProps) {
  const cell = monoCell();
  const cols = () => Math.max(4, Math.floor((props.w() - PAD * 2) / cell));
  const rows = () => Math.max(1, Math.floor((props.h() - PAD) / LINE_H));
  const state = () => {
    props.store.rev();
    const s = props.store.stateOf(props.id);
    return s && s.kind === "notes" ? s : null;
  };
  const view = () => {
    const s = state();
    const wrapped: string[] = [];
    for (const line of (s?.text ?? "").split("\n")) wrap(line, cols(), wrapped);
    if (wrapped.length === 0) wrapped.push("");
    // The cursor sits after the last line; a full last line starts a new one.
    if (wrapped[wrapped.length - 1].length >= cols()) wrapped.push("");
    const maxScroll = Math.max(0, wrapped.length - rows());
    const scroll = Math.min(s?.scroll ?? 0, maxScroll);
    const end = wrapped.length - scroll;
    const start = Math.max(0, end - rows());
    const lines = wrapped.slice(start, end);
    return { lines, cursorRow: lines.length - 1, cursorCol: lines[lines.length - 1].length, empty: !s?.text };
  };
  return (
    <View debugName="Notes" class="absolute inset-0 bg-[#1a1b26]">
      <Index each={view().lines}>
        {(line, i) => (
          <Text
            class="absolute left-[4] font-mono text-xs text-[#c0caf5]"
            style={{ insetT: PAD + i * LINE_H }}
          >
            {line()}
          </Text>
        )}
      </Index>
      <Show when={view().empty && props.h() >= 40}>
        <Text class="absolute left-[16] top-[20] text-xs text-[#414868]">SELECT opens the keyboard</Text>
      </Show>
      <View
        class="absolute w-[7] h-[13] bg-[#e0af68]"
        style={{ insetL: PAD + cell * view().cursorCol, insetT: PAD + view().cursorRow * LINE_H }}
      />
    </View>
  );
}

// ---- keys ---------------------------------------------------------------------

export interface SheetLine {
  kind: "title" | "row" | "gap";
  keys: string;
  what: string;
}

export function sheetLines(layout: "dwindle" | "scrolling"): SheetLine[] {
  const out: SheetLine[] = [];
  for (const group of keySheet(layout)) {
    out.push({ kind: "title", keys: group.title, what: "" });
    for (const row of group.rows) out.push({ kind: "row", keys: row.keys, what: row.what });
    out.push({ kind: "gap", keys: "", what: "" });
  }
  return out;
}

function Keys(props: AppletProps) {
  const rows = () => Math.max(1, Math.floor((props.h() - PAD) / ROW_H));
  const state = () => {
    props.store.rev();
    const s = props.store.stateOf(props.id);
    return s && s.kind === "keys" ? s : null;
  };
  const view = () => {
    const all = sheetLines(props.store.layoutKind());
    const maxScroll = Math.max(0, all.length - rows());
    const scroll = Math.min(state()?.scroll ?? 0, maxScroll);
    return all.slice(scroll, scroll + rows());
  };
  const keysW = () => (props.w() >= 200 ? 84 : 64);
  // A row is an offset, not a node. The 3DS spends its JS stack on JSX
  // NESTING DEPTH rather than node count (hosts/3ds/src/qjs.c
  // POCKETJS_JS_STACK_SIZE), and a wrapper View with a Show inside it put
  // this applet two levels past what mounting inside a window could afford —
  // opening one keys window overflowed the stack and the runtime rolled the
  // whole guest back. Each column is therefore its own flat pass of
  // absolutely-positioned Text, three levels deep in total.
  return (
    <View debugName="Keys" class="absolute inset-0 bg-[#1a1b26]">
      <Index each={view()}>
        {(line, i) =>
          line().kind === "gap" ? null : (
            <Text
              class={
                line().kind === "title"
                  ? "absolute left-[6] text-xs text-[#7aa2f7] font-bold"
                  : "absolute left-[6] text-xs text-[#c0caf5] font-bold"
              }
              style={{ insetT: PAD + i * ROW_H }}
            >
              {line().keys}
            </Text>
          )
        }
      </Index>
      <Index each={view()}>
        {(line, i) =>
          line().kind === "row" ? (
            <Text
              class="absolute text-xs text-[#a9b1d6]"
              style={{ insetT: PAD + i * ROW_H, insetL: 6 + keysW() }}
            >
              {line().what}
            </Text>
          ) : null
        }
      </Index>
    </View>
  );
}

// ---- stats --------------------------------------------------------------------

function Stats(props: AppletProps) {
  const store = props.store;
  const rows = () => {
    store.rev();
    const ops = getOps();
    return [
      ["fps", String(store.fps())],
      ["frame", String(store.frameCount())],
      ["uptime", formatUptime(store.uptimeSeconds())],
      ["windows", String(store.wm.windows.size)],
      ["workspace", `${store.active()} of 5 · ${store.layoutKind()}`],
      ["host", `${ops.__host ?? "3ds"} · abi ${ops.__hostAbi ?? "?"}`],
      ["wallpaper", store.wallpaper()],
      ["layer", store.layer()],
    ];
  };
  // Flat for the same reason as Keys: two passes of Text, no per-row wrapper.
  return (
    <View debugName="Stats" class="absolute inset-0 bg-[#1a1b26]">
      <Index each={rows()}>
        {(row, i) => (
          <Text class="absolute left-[6] text-xs text-[#565f89]" style={{ insetT: PAD + i * ROW_H }}>
            {row()[0]}
          </Text>
        )}
      </Index>
      <Index each={rows()}>
        {(row, i) => (
          <Text class="absolute left-[74] text-xs text-[#c0caf5]" style={{ insetT: PAD + i * ROW_H }}>
            {row()[1]}
          </Text>
        )}
      </Index>
    </View>
  );
}

// ---- about --------------------------------------------------------------------

function About(props: AppletProps) {
  const compact = () => props.h() < 80;
  return (
    <View debugName="About" class="absolute inset-0 bg-[#1a1b26]">
      <View class="absolute left-[8] top-[8] flex-row gap-[3]">
        <View class="w-[10] h-[10] bg-[#33ccff]" />
        <View class="w-[10] h-[10] bg-[#00ff99]" />
        <View class="w-[10] h-[10] bg-[#bb9af7]" />
      </View>
      <Text class="absolute left-[46] top-[4] text-lg text-[#c0caf5] font-bold">Pocket Shell</Text>
      <Show when={!compact()}>
        <Text class="absolute left-[8] top-[30] text-xs text-[#a9b1d6]">a tiling shell for the Nintendo 3DS</Text>
        <Text class="absolute left-[8] top-[46] text-xs text-[#565f89]">Omarchy's SUPER grammar on two shoulders</Text>
        <Text class="absolute left-[8] top-[59] text-xs text-[#565f89]">dwindle · scrolling · five workspaces</Text>
        <Text class="absolute left-[8] top-[72] text-xs text-[#565f89]">tokyo-night · wallpapers from Omarchy</Text>
        <Text class="absolute left-[8] top-[85] text-xs text-[#565f89]">PocketJS · Solid · QuickJS · citro3d</Text>
      </Show>
      <Show when={props.h() >= 112}>
        <Text class="absolute left-[8] bottom-[4] text-xs text-[#414868]">hold L and press SELECT for every key</Text>
      </Show>
    </View>
  );
}
