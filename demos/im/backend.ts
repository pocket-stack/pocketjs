// demos/im/backend.ts — Pocket Talk's "network": a virtual-time fake IM server.
//
// Same effect-shell pattern as demos/cafe/backend.ts (DETERMINISM.md), grown
// one IM-shaped notch: on top of plain request -> response effects
// (bootstrap, history pages, send acks) the server also PUSHES — replies,
// delivery/read receipts, typing signals, ambient traffic in other
// conversations. A delivery can only answer one command, so pushes ride a
// long-poll: the app keeps one "im/poll" in flight, the server answers it
// every half virtual second with whatever events have come due, and the app
// immediately re-polls. That is real IM sync-loop shape — swap the `after`
// for a fetch against a real endpoint and the app code does not change.
//
// The session state here (send counts, scheduled pushes) is deterministic:
// it advances only on commands and on the virtual clock, never on wall time.

import { after, virtualNow } from "@pocketjs/framework/clock";
import { installEffectDriver } from "@pocketjs/framework/effects";
import {
  AMBIENT,
  CONTACTS,
  contactById,
  historyPage,
  maxPage,
  stampNow,
  type WireMsg,
} from "./data.ts";

export type Push =
  | { t: "message"; convo: string; msg: WireMsg }
  | { t: "typing"; convo: string; from: string; on: boolean }
  | { t: "receipt"; convo: string; id: string; state: "delivered" | "read" };

export interface BootPayload {
  convos: { id: string; unread: number; hasMore: boolean; messages: WireMsg[] }[];
}

export interface HistoryReq {
  convo: string;
  page: number;
}

export interface HistoryPayload {
  page: number;
  hasMore: boolean;
  messages: WireMsg[];
}

export interface SendReq {
  convo: string;
  /** Client-assigned message id — receipts reference it. */
  id: string;
  text: string;
}

export interface SendAck {
  id: string;
}

export interface PollPayload {
  events: Push[];
}

/** How long a contact "types" before a reply of this length lands. */
function typingSeconds(text: string): number {
  return Math.min(3.5, 0.5 * Math.ceil((0.8 + text.length * 0.03) / 0.5));
}

export function installTalkBackend(): void {
  // Scheduled pushes, sorted by due time. Ambient traffic is generated from
  // a cycling pointer instead of being queued ahead, so an arbitrarily long
  // session never grows this array.
  let queue: { at: number; push: Push }[] = [];
  let sendCounts: Record<string, number> = {};
  let ambIdx = 0;
  let ambNextAt = AMBIENT[0].gap;
  let srvSeq = 0;

  const schedule = (at: number, push: Push): void => {
    let i = queue.length;
    while (i > 0 && queue[i - 1].at > at) i--;
    queue.splice(i, 0, { at, push });
  };

  const ambientPush = (at: number): Push => {
    const ev = AMBIENT[ambIdx % AMBIENT.length];
    ambIdx++;
    ambNextAt = at + AMBIENT[ambIdx % AMBIENT.length].gap;
    return {
      t: "message",
      convo: ev.convo,
      msg: { id: `srv-${++srvSeq}`, from: ev.from, text: ev.text, ...stampNow(at) },
    };
  };

  const drainUpTo = (now: number): Push[] => {
    const due: { at: number; push: Push }[] = [];
    while (ambNextAt <= now) due.push({ at: ambNextAt, push: ambientPush(ambNextAt) });
    while (queue.length > 0 && queue[0].at <= now) due.push(queue.shift()!);
    due.sort((a, b) => a.at - b.at);
    return due.map((d) => d.push);
  };

  /** The server-side choreography a send sets in motion. */
  const receiveMessage = (req: SendReq): void => {
    const c = contactById(req.convo);
    const t0 = virtualNow();
    schedule(t0 + 1.0, { t: "receipt", convo: c.id, id: req.id, state: "delivered" });
    if (!c.online) return; // offline contacts never read — the ✓✓ stays gray
    schedule(t0 + 2.0, { t: "receipt", convo: c.id, id: req.id, state: "read" });
    const n = sendCounts[c.id] ?? 0;
    sendCounts[c.id] = n + 1;
    const reply = c.replies[n % c.replies.length];
    const from = reply.from || c.name;
    const typeS = typingSeconds(reply.text);
    schedule(t0 + 2.5, { t: "typing", convo: c.id, from, on: true });
    schedule(t0 + 2.5 + typeS, { t: "typing", convo: c.id, from, on: false });
    schedule(t0 + 2.5 + typeS, {
      t: "message",
      convo: c.id,
      msg: { id: `srv-${++srvSeq}`, from, text: reply.text, ...stampNow(t0 + 2.5 + typeS) },
    });
  };

  installEffectDriver((cmd, deliver) => {
    // Server latency in VIRTUAL seconds (0.5 s grid — exact at every hz).
    const lat = cmd.kind === "im/history" ? 1.0 : 0.5;
    if (cmd.kind === "im/bootstrap") {
      // Fresh mount, fresh session (also keeps hot reload sane): a
      // re-bootstrap must replay like a cold boot, so the reply-script
      // cursors and server message ids reset along with the push queue.
      queue = [];
      sendCounts = {};
      srvSeq = 0;
      ambIdx = 0;
      ambNextAt = virtualNow() + AMBIENT[0].gap;
      after(lat, () =>
        deliver({
          convos: CONTACTS.map((c) => ({
            id: c.id,
            unread: c.unreadSeed,
            hasMore: maxPage(c) > 0,
            messages: historyPage(c, 0),
          })),
        } satisfies BootPayload),
      );
    } else if (cmd.kind === "im/history") {
      const req = cmd.payload as HistoryReq;
      const c = contactById(req.convo);
      after(lat, () =>
        deliver({
          page: req.page,
          hasMore: req.page < maxPage(c),
          messages: historyPage(c, req.page),
        } satisfies HistoryPayload),
      );
    } else if (cmd.kind === "im/send") {
      const req = cmd.payload as SendReq;
      receiveMessage(req);
      after(lat, () => deliver({ id: req.id } satisfies SendAck));
    } else if (cmd.kind === "im/poll") {
      after(lat, () => deliver({ events: drainUpTo(virtualNow()) } satisfies PollPayload));
    } else {
      throw new Error(`pocket talk backend: unknown effect kind "${cmd.kind}"`);
    }
  });
}
