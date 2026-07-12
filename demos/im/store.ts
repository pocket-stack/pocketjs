// demos/im/store.ts — the client-side data layer (the "satchel" seat).
//
// Everything stateful about the IM app that is not pixels lives here:
// conversations, message lists, send states, unread counts, typing flags,
// per-conversation drafts. The sync engine is the classic IM loop —
// bootstrap once, then keep exactly one long-poll in flight and apply
// whatever it returns. All network I/O goes through the effect shell, so a
// host (sim, tape replay) can take the whole thing over without touching
// this file. Swapping the mock for a real data layer means re-implementing
// createTalkStore() against the same interface — the UI does not change.
//
// Every delivery applies its writes inside batch(): the UI (row layout,
// scroll rebase, stick-to-bottom) must see one consistent world per
// delivery, not one per signal — a history page and its hasMore flip, or a
// burst of poll events, land as a single update.

import { batch, createSignal, type Accessor } from "solid-js";
import { runEffect } from "@pocketjs/framework/effects";
import { virtualNow } from "@pocketjs/framework/clock";
import type {
  BootPayload,
  HistoryPayload,
  HistoryReq,
  PollPayload,
  Push,
  SendAck,
  SendReq,
} from "./backend.ts";
import {
  contactById,
  stampNow,
  type Contact,
  type SendState,
  type UiMsg,
  type WireMsg,
} from "./data.ts";

const READ: () => SendState = () => "read";

function toUi(w: WireMsg): UiMsg {
  return { ...w, out: w.from === "me", state: READ };
}

export interface Convo {
  contact: Contact;
  msgs: Accessor<UiMsg[]>;
  unread: Accessor<number>;
  /** Group member currently typing (contact name in 1:1 chats), or null. */
  typing: Accessor<string | null>;
  draft: Accessor<string>;
  setDraft: (s: string) => void;
  hasMore: Accessor<boolean>;
  loading: Accessor<boolean>;
}

interface ConvoInternal extends Convo {
  setMsgs: (m: UiMsg[]) => void;
  setUnread: (n: number) => void;
  /** Typing windows overlap when replies queue up — refcounted, not a slot. */
  applyTyping: (from: string, on: boolean) => void;
  setHasMore: (b: boolean) => void;
  setLoading: (b: boolean) => void;
  pagesLoaded: number;
}

export interface TalkStore {
  phase: Accessor<"connecting" | "ready">;
  convos: Accessor<Convo[]>;
  /** Open conversation id — null on the list screen. Opening marks it read. */
  active: Accessor<string | null>;
  setActive: (id: string | null) => void;
  send: (convo: Convo, text: string) => void;
  loadOlder: (convo: Convo) => void;
}

export function createTalkStore(): TalkStore {
  const [phase, setPhase] = createSignal<"connecting" | "ready">("connecting");
  const [convos, setConvos] = createSignal<ConvoInternal[]>([]);
  const [active, setActiveRaw] = createSignal<string | null>(null);
  const stateSetters = new Map<string, (s: SendState) => void>();
  let sendSeq = 0;

  const byId = (id: string): ConvoInternal | undefined =>
    convos().find((c) => c.contact.id === id);

  const applyPush = (p: Push): void => {
    const c = byId(p.convo);
    if (!c) return;
    if (p.t === "message") {
      c.setMsgs([...c.msgs(), toUi(p.msg)]);
      if (active() !== c.contact.id) c.setUnread(c.unread() + 1);
    } else if (p.t === "typing") {
      c.applyTyping(p.from, p.on);
    } else {
      const set = stateSetters.get(p.id);
      if (set) {
        set(p.state);
        // Terminal receipt: "read", or "delivered" from a contact who will
        // never read — drop the setter so sends don't accumulate forever.
        if (p.state === "read" || !c.contact.online) stateSetters.delete(p.id);
      }
    }
  };

  // The sync loop: exactly one poll in flight, re-issued from its own
  // delivery. Deliveries apply at frame boundaries (src/effects.ts); the
  // batch makes a multi-event drain (reply + receipt + ambient in one tick)
  // a single UI update.
  const poll = (): void => {
    runEffect<PollPayload>("im/poll", null, (res) => {
      batch(() => {
        for (const ev of res.events) applyPush(ev);
      });
      poll();
    });
  };

  runEffect<BootPayload>("im/bootstrap", null, (boot) => {
    setConvos(
      boot.convos.map((b) => {
        const [msgs, setMsgs] = createSignal<UiMsg[]>(b.messages.map(toUi));
        const [unread, setUnread] = createSignal(b.unread);
        const [typing, setTyping] = createSignal<string | null>(null);
        const [draft, setDraft] = createSignal("");
        const [hasMore, setHasMore] = createSignal(b.hasMore);
        const [loading, setLoading] = createSignal(false);
        let typingCount = 0;
        const applyTyping = (from: string, on: boolean): void => {
          typingCount = Math.max(0, typingCount + (on ? 1 : -1));
          setTyping(typingCount > 0 ? from : null);
        };
        return {
          contact: contactById(b.id),
          msgs, setMsgs,
          unread, setUnread,
          typing, applyTyping,
          draft, setDraft,
          hasMore, setHasMore,
          loading, setLoading,
          pagesLoaded: 1,
        };
      }),
    );
    setPhase("ready");
    poll();
  });

  const send = (convo: Convo, text: string): void => {
    const c = convo as ConvoInternal;
    const [state, setState] = createSignal<SendState>("sending");
    const msg: UiMsg = {
      id: `me-${++sendSeq}`,
      from: "me",
      text,
      ...stampNow(virtualNow()),
      out: true,
      state,
    };
    stateSetters.set(msg.id, setState);
    c.setMsgs([...c.msgs(), msg]);
    const req: SendReq = { convo: c.contact.id, id: msg.id, text };
    runEffect<SendAck>("im/send", req, () => {
      // Receipts may already have arrived in the same drain — never regress.
      if (state() === "sending") setState("sent");
    });
  };

  const loadOlder = (convo: Convo): void => {
    const c = convo as ConvoInternal;
    if (c.loading() || !c.hasMore()) return;
    c.setLoading(true);
    const req: HistoryReq = { convo: c.contact.id, page: c.pagesLoaded };
    runEffect<HistoryPayload>("im/history", req, (res) => {
      // One batch, one layout: the prepend and the hasMore flip (which adds
      // the beginning-of-conversation chip) must land in the SAME update, or
      // the thread's scroll rebase misses the chip's height and the content
      // the user is reading jumps.
      batch(() => {
        c.pagesLoaded++;
        c.setHasMore(res.hasMore);
        c.setMsgs([...res.messages.map(toUi), ...c.msgs()]);
        c.setLoading(false);
      });
    });
  };

  const setActive = (id: string | null): void => {
    setActiveRaw(id);
    if (id) byId(id)?.setUnread(0);
  };

  return { phase, convos, active, setActive, send, loadOlder };
}
