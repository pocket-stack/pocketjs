import { describe, expect, test } from "bun:test";
import { installHost, type HostOps } from "../framework/src/host.ts";
import {
  launchNativePlugin,
  launchPackage,
  restoreSessionState,
} from "../framework/src/launcher.ts";
import {
  library,
  playback,
  queue,
  ROCKBOX_PAGE_MAX,
  system,
} from "../framework/src/rockbox-services.ts";

type Call = { service: string; method: string; payload: unknown };

function mount(handler: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  const ops = {
    pocketrockCall(service: string, method: string, payload: string): string {
      const call = { service, method, payload: JSON.parse(payload) };
      calls.push(call);
      return JSON.stringify(handler(call));
    },
  } as unknown as HostOps;
  installHost({ ops, kind: "injected", target: "rockbox-ip6g", strict: true });
  return calls;
}

describe("PocketRock Host ABI 10 SDK", () => {
  test("routes playback, system and bounded list requests", () => {
    const calls = mount(({ service, method }) => {
      if (service === "playback" && method === "snapshot") {
        return { status: "paused", index: 2, title: "Track" };
      }
      if (service === "system") return { ok: true };
      return { items: [], offset: 0, total: 0 };
    });
    expect(playback.snapshot().status).toBe("paused");
    expect(system.setBacklight(false)).toBe(true);
    expect(library.page("artists", 7, ROCKBOX_PAGE_MAX).items).toEqual([]);
    expect(queue.page(2, 4).total).toBe(0);
    expect(calls).toContainEqual({
      service: "library",
      method: "page",
      payload: { kind: "artists", offset: 7, limit: 64 },
    });
    expect(() => library.page("tracks", 0, 65)).toThrow(/1\.\.64/);
  });

  test("exposes cold realm and native plugin lifecycle", () => {
    const calls = mount(({ method }) =>
      method === "restoreSessionState" ? { state: { page: "Music", index: 3 } } : { ok: true },
    );
    expect(launchPackage("dev.example.clock")).toBe(true);
    expect(launchNativePlugin("/.rockbox/rocks/games/chessbox.rock", "save.dat")).toBe(true);
    expect(restoreSessionState<{ page: string; index: number }>()).toEqual({
      page: "Music",
      index: 3,
    });
    expect(calls.map((call) => call.method)).toEqual([
      "launchPackage",
      "launchNativePlugin",
      "restoreSessionState",
    ]);
  });

  test("turns structured host errors and malformed replies into exceptions", () => {
    mount(() => ({ error: { code: "tagcache.busy", message: "database scanning" } }));
    expect(() => library.page("albums")).toThrow("PocketRock tagcache.busy: database scanning");

    const ops = { pocketrockCall: () => "not-json" } as unknown as HostOps;
    installHost({ ops, kind: "injected", target: "rockbox-ip6g", strict: true });
    expect(() => playback.snapshot()).toThrow(/malformed host response/);
  });
});
