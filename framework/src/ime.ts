import { IME, validImeKeys, type ImeSnapshot } from "../../contracts/spec/ime.ts";
import { offload } from "./offload.ts";
export { IME };
export type { ImeSnapshot };
type Channel = Pick<ReturnType<typeof offload>, "request" | "cancel" | "session">;
export type ImeState = ImeSnapshot & { pending: boolean; connected: boolean; error: string };
const empty = (): ImeSnapshot => ({ preedit: "", commit: "", candidates: [], page: 0, last: true, caret: 0 });

/** One editor owns one bounded transcript. A reconnect recomputes the current
 * transcript, and revision checks fence callbacks from a closed or edited field. */
export function createIme(options: {
  io?: Channel;
  changed(state: ImeState): void;
  commit(text: string): void;
}) {
  const io = options.io ?? offload();
  let keys: number[] = [], revision = 0, request = 0, requestRevision = -1;
  let session = 0, applied = "", dirty = false, snapshot = empty(), error = "";
  let retry = 0;
  const notify = () => options.changed({ ...snapshot, pending: dirty || request > 0,
    connected: io.session() > 0, error });
  const api = {
    composing: () => keys.length > 0,
    state: () => ({ ...snapshot, pending: dirty || request > 0, connected: io.session() > 0, error }),
    key(key: number) {
      if (!validImeKeys([key])) return false;
      if (keys.length >= IME.keys) { error = "Composition limit reached"; notify(); return false; }
      keys.push(key); revision++; dirty = true; error = "";
      // Old candidate labels are never selectable against a newer transcript.
      snapshot = { ...snapshot, candidates: [] };
      notify(); return true;
    },
    select(index: number) {
      if (dirty || request || index < 0 || index >= snapshot.candidates.length) return false;
      return api.key(IME.select + index);
    },
    reset() {
      if (request) io.cancel(request);
      request = 0; revision++; keys = []; applied = ""; dirty = false; snapshot = empty(); error = ""; notify();
    },
    /** Called by the editor once per frame, after the realm offload pump. */
    step() {
      const current = io.session();
      if (current !== session) {
        session = current;
        if (request) io.cancel(request);
        request = 0; dirty = keys.length > 0; retry = 0; notify();
      }
      if (retry > 0) { retry--; return; }
      if (!dirty || request || current <= 0) return;
      const version = revision; requestRevision = version;
      request = io.request("ime.compose", JSON.stringify(keys), result => {
        if (requestRevision !== version) return;
        request = 0;
        if (revision !== version) return;
        if (!result.ok) { error = result.error; retry = 60; notify(); return; }
        try {
          const next = JSON.parse(result.value) as ImeSnapshot;
          if (typeof next.preedit !== "string" || next.preedit.length > 256 ||
              typeof next.commit !== "string" || next.commit.length > 512 ||
              !next.commit.startsWith(applied) || !Array.isArray(next.candidates) ||
              next.candidates.length > IME.candidates || next.candidates.some(c => typeof c !== "string" || c.length > 128) ||
              !Number.isSafeInteger(next.page) || next.page < 0 || !Number.isInteger(next.caret) ||
              next.caret < 0 || next.caret > next.preedit.length || typeof next.last !== "boolean") throw new Error("Invalid IME snapshot");
          const suffix = next.commit.slice(applied.length);
          applied = next.commit; snapshot = next; dirty = false; error = "";
          if (suffix) options.commit(suffix);
          if (!next.preedit) { keys = []; applied = ""; snapshot = empty(); }
        } catch { error = "Invalid IME reply"; retry = 60; }
        notify();
      });
    },
    dispose() { api.reset(); },
  };
  return api;
}
