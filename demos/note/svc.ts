// demos/note/svc.ts — the widget host protocol over the spec svc channel
// (ops 30..32, HostOps svcOpen/svcPoll/svcSend).
//
// The desktop widget host is the app's companion process: it forwards the
// real keyboard, mouse and window into the guest as JSON lines, and the
// guest sends intents (save, quit) back. One poll per frame, per the
// HostOps contract. Hosts without the channel (goldens, host-sim, PSP)
// feature-detect to null and the app runs standalone on its sample doc —
// an unmodified-app base case, per RUNTIMES.md rule 5.
//
// host → guest lines:
//   {t:"hello", w, h}          logical viewport at boot
//   {t:"resize", w, h}         live window resize (relayout follows)
//   {t:"load", text}           document content from the host's file
//   {t:"ch", s}                typed characters (batched, layout applied)
//   {t:"key", k}               named key: Backspace Delete Enter Tab Left
//                              Right Up Down Home End PageUp PageDown Escape
//   {t:"mouse", x, y, d}       pointer moved / pressed / released — d is
//                              the primary-button state, and a line is sent
//                              on every press/release even without movement
//   {t:"scroll", dy}           wheel delta in logical px
//
// guest → host lines:
//   {t:"save", text}           persist the document (debounced by the app)
//   {t:"quit"}                 close the widget
//   {t:"menu", open}           the ••• menu is up — the host stops claiming
//                              header drags so backdrop clicks can close it

import { getOps } from "@pocketjs/framework";

export interface HostEvent {
  t: "hello" | "resize" | "load" | "ch" | "key" | "mouse" | "scroll";
  w?: number;
  h?: number;
  text?: string;
  s?: string;
  k?: string;
  x?: number;
  y?: number;
  /** Primary mouse button held ("mouse" events). */
  d?: boolean;
  dy?: number;
}

export interface Svc {
  /** Drain and parse this frame's host lines (call once per frame). */
  poll(): HostEvent[];
  send(line: { t: "save"; text: string } | { t: "quit" } | { t: "menu"; open: boolean }): void;
}

/** Probe the channel; null = standalone (no widget host on the other end). */
export function connectSvc(): Svc | null {
  const ops = getOps();
  if (!ops.svcOpen || !ops.svcPoll || !ops.svcSend || !ops.svcOpen("note")) return null;
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
