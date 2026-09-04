// hosts/sim/companion.ts — a guest and a companion in one process, no
// sockets. The pair gives the guest the svc trio (svcOpen/svcPoll/svcSend)
// and gives a companion host a session, with one deliberate property of the
// real transport kept: what the companion sends during frame N is visible
// to svcPoll only after tick() — a reply is never read on the frame that
// asked for it. Tests step tick() between frames; a sim-hosted app mounts
// the ops as `ui.svc*` and talks to a real host object.

import { SVC_POLL_BUF } from "../../contracts/spec/spec.ts";
import { utf8Length } from "../../contracts/spec/companion.ts";
import type { CompanionHost, CompanionSession } from "../../tools/companion-host.ts";

export interface SimCompanionOps {
  svcOpen(app: string): boolean;
  svcPoll(): string | undefined;
  svcSend(line: string): void;
}

export interface SimCompanionPair {
  readonly ops: SimCompanionOps;
  readonly host: CompanionHost;
  /** The live session, once the guest has opened the matching app. */
  session(): CompanionSession | null;
  /** Bring the transport up (default) or down; down closes the session and
   *  drops anything in flight, like a lost cable. */
  connect(): void;
  disconnect(): void;
  /** Make the companion's queued lines visible to the next svcPoll. */
  tick(): void;
  /** Lines the guest sent, in order, for assertions. */
  sent(): readonly string[];
  /** Bytes returned by svcPoll so far, for budget assertions. */
  polledBytes(): number;
}

export function createSimCompanionPair(host: CompanionHost): SimCompanionPair {
  let connected = true;
  let session: CompanionSession | null = null;
  const staged: string[] = [];
  const inbox: string[] = [];
  const sent: string[] = [];
  let polled = 0;

  const drop = (): void => {
    if (session) session.close();
    session = null;
    staged.length = 0;
    inbox.length = 0;
  };

  const ops: SimCompanionOps = {
    svcOpen(app) {
      if (!connected || app !== host.app) return false;
      if (!session || session.closed) {
        session = host.attach({ label: "sim", send: (line) => staged.push(line) });
      }
      return true;
    },
    svcPoll() {
      if (inbox.length === 0) return undefined;
      // Whole lines only, up to SVC_POLL_BUF bytes — the 3DS rule.
      let bytes = 0;
      let count = 0;
      while (count < inbox.length) {
        const next = utf8Length(inbox[count]!) + 1;
        if (count > 0 && bytes + next > SVC_POLL_BUF) break;
        bytes += next;
        count += 1;
      }
      const batch = inbox.splice(0, count).join("\n") + "\n";
      polled += bytes;
      return batch;
    },
    svcSend(line) {
      if (!connected || !session) return;
      sent.push(line);
      session.receive(line);
    },
  };

  return {
    ops,
    host,
    session: () => session,
    connect() {
      connected = true;
    },
    disconnect() {
      connected = false;
      drop();
    },
    tick() {
      if (staged.length === 0) return;
      inbox.push(...staged);
      staged.length = 0;
    },
    sent: () => sent,
    polledBytes: () => polled,
  };
}
