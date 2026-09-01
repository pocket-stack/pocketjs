// Effect driver over the ui.svc* host-service channel: commands go out as
// JSON lines (svcSend), results and host-initiated events come back through
// the per-frame poll pump (svcPoll). Protocol:
//   guest -> host  {t:"cmd", id, kind, payload}
//   host -> guest  {t:"result", id, result} | {t:"event", ...anything}

import { getOps } from "@pocketjs/framework";
import { installEffectDriver } from "@pocketjs/framework/effects";

type SvcOps = {
  svcSend?: (line: string) => void;
  svcPoll?: () => string | null;
};

const pendingDeliver = new Map<number, (result: unknown) => void>();

export function installSvcEffectDriver(): void {
  installEffectDriver((cmd, deliver) => {
    const ops = getOps() as SvcOps;
    if (typeof ops.svcSend !== "function") {
      return; // host without a service channel: commands drop, app stays pure
    }
    pendingDeliver.set(cmd.id, deliver);
    ops.svcSend(JSON.stringify({ t: "cmd", id: cmd.id, kind: cmd.kind, payload: cmd.payload }));
  });
}

/** Run once per frame: matches results to pending effects, forwards events. */
export function pumpHostLines(onEvent: (event: Record<string, unknown>) => void): void {
  const ops = getOps() as SvcOps;
  if (typeof ops.svcPoll !== "function") {
    return;
  }
  const batch = ops.svcPoll();
  if (!batch) {
    return;
  }
  for (const line of batch.split("\n")) {
    if (!line) {
      continue;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = message["id"];
    if (message["t"] === "result" && typeof id === "number" && pendingDeliver.has(id)) {
      const deliver = pendingDeliver.get(id)!;
      pendingDeliver.delete(id);
      deliver(message["result"]);
    } else {
      onEvent(message);
    }
  }
}
