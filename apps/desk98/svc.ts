// apps/desk98/svc.ts — the desk companion protocol over the spec svc channel
// (HostOps svcOpen/svcPoll/svcSend), the note dialect's input lines extended
// for a desktop compositor. hosts/macos speaks it when the plan's companion
// list names "desk".
//
// host → guest lines (superset of apps/note/svc.ts):
//   {t:"hello", w, h, epoch}   viewport at boot + wall-clock ms (taskbar clock)
//   {t:"resize", w, h}         live window resize
//   {t:"ch", s}                typed characters
//   {t:"key", k, sh, alt, ctl} named key + modifiers (adds F1..F12)
//   {t:"key", k, cmd:true}     ⌘ chord — k is the raw lowercase key ("w",
//                              "m", "`", "c", …); ⌘Q/⌘V stay host-side
//   {t:"paste", text}          system clipboard (⌘V or a paste-req reply)
//   {t:"ime", s, c}            IME preedit + caret char index (null clears)
//   {t:"mouse", x, y, d, sh}   primary-button pointer stream
//   {t:"mouse", x, y, d, b:2}  right-button press/release (desk-only lines)
//   {t:"scroll", dy}           wheel delta in logical px
//
// guest → host intents:
//   {t:"quit"}                 Shut Down
//   {t:"copy", text}           put text on the system clipboard
//   {t:"paste-req"}            ask for the clipboard (host answers {t:"paste"})
//   {t:"caret", x, y, h}       caret rect — docks the IME candidate window
//   {t:"cursor", k}            pointer shape: default|text|pointer|move|
//                              grabbing|ew|ns|nwse|nesw

import { getOps } from "@pocketjs/framework";

export interface HostEvent {
  t: "hello" | "resize" | "ch" | "key" | "mouse" | "scroll" | "paste" | "ime";
  w?: number;
  h?: number;
  epoch?: number;
  s?: string;
  k?: string;
  x?: number;
  y?: number;
  /** Button state for "mouse" lines (the b-button's state, primary if no b). */
  d?: boolean;
  /** Mouse button: undefined/1 = primary, 2 = right. */
  b?: number;
  sh?: boolean;
  alt?: boolean;
  ctl?: boolean;
  /** ⌘ held — k is then the raw lowercase key name ("w", "m", "`", …). */
  cmd?: boolean;
  dy?: number;
  text?: string;
  /** IME preedit caret (char index into s), null when composition ends. */
  c?: number | null;
}

export type CursorKind =
  | "default"
  | "text"
  | "pointer"
  | "move"
  | "grabbing"
  | "ew"
  | "ns"
  | "nwse"
  | "nesw";

export interface Svc {
  /** Drain and parse this frame's host lines (call once per frame). */
  poll(): HostEvent[];
  send(
    line:
      | { t: "quit" }
      | { t: "copy"; text: string }
      | { t: "paste-req" }
      | { t: "caret"; x: number; y: number; h: number }
      | { t: "cursor"; k: CursorKind },
  ): void;
}

/** Probe the channel; null = standalone (sim, goldens — static desktop). */
export function connectSvc(): Svc | null {
  const ops = getOps();
  if (!ops.svcOpen || !ops.svcPoll || !ops.svcSend || !ops.svcOpen("desk")) return null;
  const poll = ops.svcPoll.bind(ops);
  const send = ops.svcSend.bind(ops);
  return {
    poll() {
      const batch = poll();
      if (!batch) return [];
      const events: HostEvent[] = [];
      for (const line of batch.split("\n")) {
        if (line === "") continue;
        try {
          events.push(JSON.parse(line) as HostEvent);
        } catch {
          // A malformed line is a host bug; skip it rather than wedge.
        }
      }
      return events;
    },
    send(line) {
      send(JSON.stringify(line));
    },
  };
}
