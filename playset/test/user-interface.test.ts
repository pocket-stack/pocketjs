// playset/test/user-interface.test.ts — GameBlocks user-interface ports:
// UiStateModel (+ createUiSignal), NotificationQueue/ExpiringMessageFeed on a
// manual Clock, MinimapProjector2D + heading-relative projection anchors,
// StorageSettingsStore, and the Solid components (HudValue/HudBar, FlightHud,
// HeadingRelativeRadar, RaceMinimap) mounted against a mock host the way
// test/renderer.test.ts does.
//
// Run: bun test --conditions=browser playset/test/user-interface.test.ts
// (without the flag Bun resolves solid-js to its SSR build and reactive
// updates silently no-op — same rule as test/renderer.test.ts).

import { beforeEach, describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) {
  throw new Error(
    "solid-js resolved to its SSR build (dist/server.js) — reactive updates " +
      "would silently no-op. Run: bun test --conditions=browser",
  );
}

import { installHost, type Host, type HostOps } from "../../src/host.ts";
import {
  render,
  resetRendererState,
  setStyleResolver,
  type NodeMirror,
} from "../../src/renderer.ts";
import { registerStyles, resetStyles, resolveStyle } from "../../src/styles.ts";
import { NODE_TYPE, PROP, ROOT_ID } from "../../spec/spec.ts";

import { UiStateModel, createUiSignal } from "../modules/user-interface/ui-state-model.ts";
import {
  ExpiringMessageFeed,
  NotificationQueue,
} from "../modules/user-interface/notification-queue.ts";
import {
  MinimapProjector2D,
  projectRelativePlanar,
} from "../modules/user-interface/minimap-projector-2d.ts";
import {
  JsonSettingsStore,
  MemoryStorageBackend,
  readBoolean,
  readInteger,
  readJsonStorageItem,
  resolveStorage,
  writeStorageItem,
} from "../modules/user-interface/storage-settings-store.ts";
import { HudBar, HudValue, hudBarRatio } from "../modules/user-interface/hud-binder.ts";
import {
  FlightHud,
  cardinalForCompassHeadingDegrees,
  computeFlightHudReadouts,
  padNumber,
  type FlightHudState,
} from "../modules/user-interface/flight-hud.ts";
import {
  HeadingRelativeRadar,
  HeadingRelativeRadarProjection,
  parseVec3Reading,
  type RadarContact,
} from "../modules/user-interface/heading-relative-radar.ts";
import { RaceMinimap, type AiCar } from "../modules/user-interface/race-minimap.ts";
import { Clock } from "../modules/math/time-utils.ts";
import type { VecLike } from "../modules/math/world-basis.ts";

// ---------------------------------------------------------------------------
// Mock host (the renderer.test.ts harness pattern)
// ---------------------------------------------------------------------------

type Call = [string, ...unknown[]];

interface MockHost extends Host {
  calls: Call[];
  of(...names: string[]): Call[];
  clear(): void;
}

function makeMockHost(): MockHost {
  const calls: Call[] = [];
  let nextId = ROOT_ID + 1;
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ops: HostOps = {
    createNode(type: number): number {
      const id = nextId++;
      calls.push(["createNode", type, id]);
      return id;
    },
    destroyNode: rec("destroyNode"),
    insertBefore: rec("insertBefore"),
    removeChild: rec("removeChild"),
    setStyle: rec("setStyle"),
    setProp: rec("setProp"),
    setText: rec("setText"),
    replaceText: rec("replaceText"),
    uploadTexture: () => 900,
    setImage: rec("setImage"),
    setSprite: rec("setSprite"),
    animate: () => 1,
    cancelAnim: rec("cancelAnim"),
    setFocus: rec("setFocus"),
    loadStyles: rec("loadStyles"),
    loadFontAtlas: rec("loadFontAtlas"),
    measureText: () => 0,
  };
  return {
    ops,
    kind: "injected",
    target: "injected",
    strict: true,
    calls,
    of(...names: string[]) {
      return calls.filter((c) => names.includes(c[0] as string));
    },
    clear() {
      calls.length = 0;
    },
  };
}

let host: MockHost;
let root: NodeMirror;

beforeEach(() => {
  host = makeMockHost();
  installHost(host);
  resetRendererState();
  resetStyles();
  // FlightHud's Texts carry font classes (native hosts render no text without
  // a compiled style); in a real app the build compiles these — the mock host
  // just needs the literals resolvable.
  registerStyles({ "text-xs": 101, "text-sm": 102, "text-sm font-bold": 103 });
  setStyleResolver(resolveStyle);
  root = { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] };
});

function walk(node: NodeMirror, visit: (n: NodeMirror) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** Text of every text run in the subtree, in document order. */
function collectTexts(node: NodeMirror): string[] {
  const texts: string[] = [];
  walk(node, (n) => {
    if (n.text !== undefined) texts.push(n.text);
  });
  return texts;
}

function countViews(node: NodeMirror): number {
  let count = 0;
  walk(node, (n) => {
    if (n.type === NODE_TYPE.view && n.id !== ROOT_ID) count++;
  });
  return count;
}

/**
 * Mount a component the way renderer.test.ts drives babel-universal output —
 * the component's SolidJSX.Element return is runtime-identical to NodeMirror.
 */
function mount(code: () => unknown): () => void {
  return render(code as () => NodeMirror, root);
}

/** Last setProp value per node id for one prop. */
function lastPropByNode(prop: number): Map<number, number> {
  const map = new Map<number, number>();
  for (const call of host.of("setProp")) {
    if (call[2] === prop) map.set(call[1] as number, call[3] as number);
  }
  return map;
}

// ---------------------------------------------------------------------------
// UiStateModel
// ---------------------------------------------------------------------------

describe("UiStateModel", () => {
  test("getState snapshots are stable clones", () => {
    const model = new UiStateModel({ hp: 10, mp: 4 });
    const before = model.getState();
    model.patch({ hp: 5 });
    expect(before.hp).toBe(10); // old snapshot untouched

    const snapshot = model.getState();
    (snapshot as Record<string, unknown>).hp = 999; // mutating a snapshot…
    expect(model.getState().hp).toBe(5); // …never reaches the model
  });

  test("subscribe fire rules: equality gate, changedKeys, emitInitial, unsubscribe", () => {
    const model = new UiStateModel<Record<string, unknown>>({ hp: 10 });
    const calls: Array<[Record<string, unknown>, string[]]> = [];
    const unsubscribe = model.subscribe((state, keys) => calls.push([state, keys]));

    expect(calls.length).toBe(0); // no initial emit by default
    expect(model.patch({ hp: 10 })).toEqual([]); // equal value → no emit
    expect(calls.length).toBe(0);

    expect(model.patch({ hp: 7, mp: 3 })).toEqual(["hp", "mp"]);
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toEqual({ hp: 7, mp: 3 });
    expect(calls[0][1]).toEqual(["hp", "mp"]);

    expect(unsubscribe()).toBe(true);
    model.patch({ hp: 1 });
    expect(calls.length).toBe(1);

    const initial: string[][] = [];
    model.subscribe((_s, keys) => initial.push(keys), true);
    expect(initial).toEqual([["hp", "mp"]]); // emitInitial reports all keys

    expect(() =>
      model.subscribe(null as unknown as (s: Record<string, unknown>, k: string[]) => void),
    ).toThrow(/listener must be a function/);
  });

  test("replace diffs across the union of keys (removals count)", () => {
    const model = new UiStateModel<Record<string, unknown>>({ a: 1, b: 2 });
    expect(model.replace({ a: 1, b: 2 })).toEqual([]);
    expect(model.replace({ b: 2, c: 3 })).toEqual(["a", "c"]);
    expect(model.getState()).toEqual({ b: 2, c: 3 });
  });

  test("createUiSignal tracks patches and unsubscribes on dispose", () => {
    const model = new UiStateModel({ score: 1 });
    createRoot((dispose) => {
      const state = createUiSignal(model);
      expect(state().score).toBe(1);
      model.patch({ score: 2 });
      expect(state().score).toBe(2);
      expect(model.listeners.size).toBe(1);
      dispose();
    });
    expect(model.listeners.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NotificationQueue / ExpiringMessageFeed (manual Clock)
// ---------------------------------------------------------------------------

describe("NotificationQueue", () => {
  test("enqueue → visible cap → expiry order under a manual clock", () => {
    const clock = new Clock({ manual: true, nowMs: 0 });
    const queue = new NotificationQueue(2, 1000, "n-", clock);
    const emitted: number[] = [];
    queue.subscribe((visible) => emitted.push(visible.length));

    const first = queue.add("first");
    expect(first.id).toBe("n-1");
    expect(first.expiresAt).toBe(1000);
    queue.add("second");
    queue.add("third");

    expect(queue.getVisible().map((i) => i.id)).toEqual(["n-1", "n-2"]);
    expect(queue.getPending().map((i) => i.id)).toEqual(["n-3"]);

    queue.tick(999); // t=999: nothing expires yet
    expect(queue.getVisible().map((i) => i.id)).toEqual(["n-1", "n-2"]);

    queue.tick(2); // t=1001: first two expire, third promotes
    expect(queue.getVisible().map((i) => i.id)).toEqual(["n-3"]);
    expect(queue.getVisible()[0].shownAt).toBe(1001);
    expect(queue.getVisible()[0].expiresAt).toBe(2001);

    queue.tick(1000); // t=2001: expiresAt > now fails on equality
    expect(queue.getVisible()).toEqual([]);
    expect(emitted).toEqual([1, 2, 2, 2, 1, 0]);
  });

  test("sticky items never expire; remove() promotes pending", () => {
    const clock = new Clock({ manual: true, nowMs: 0 });
    const queue = new NotificationQueue(1, 100, null, clock);
    const sticky = queue.add("stay", "warn", 100, true);
    expect(sticky.id).toBe(1); // numeric ids without a prefix
    queue.add("later");

    queue.tick(100000);
    expect(queue.getVisible().map((i) => i.id)).toEqual([1]);
    expect(queue.getVisible()[0].expiresAt).toBe(0);

    expect(queue.remove(1)).toBe(true);
    expect(queue.getVisible().map((i) => i.id)).toEqual([2]);
    expect(queue.getVisible()[0].shownAt).toBe(100000);
    expect(queue.remove("nope")).toBe(false);
  });

  test("determinism golden: same script → identical state on fresh instances", () => {
    const run = (): string => {
      const clock = new Clock({ manual: true, nowMs: 0 });
      const queue = new NotificationQueue(2, 500, "g-", clock);
      queue.add("a");
      queue.tick(100);
      queue.add("b", "warn", 250);
      queue.add("c", "info", 100, false, { squad: 3 });
      queue.tick(300);
      queue.remove("g-2");
      queue.tick(250);
      return JSON.stringify({ visible: queue.getVisible(), pending: queue.getPending() });
    };
    const first = run();
    expect(run()).toBe(first);
    expect(first.length).toBeGreaterThan(2); // non-trivial state
  });

  test("ExpiringMessageFeed: newest-first, capped, expires by absolute time", () => {
    const clock = new Clock({ manual: true, nowMs: 0 });
    const feed = new ExpiringMessageFeed(3000, 2, "m-", clock);
    const snapshots: number[] = [];
    feed.subscribe((messages) => snapshots.push(messages.length));
    expect(snapshots).toEqual([0]); // subscribe emits immediately

    feed.push("a"); // atMs 0 → expires 3000
    feed.push("b", "info", 1000); // expires 4000
    feed.push("c", "info", 2000); // expires 5000, cap drops "a"
    expect(feed.snapshot().map((m) => m.text)).toEqual(["c", "b"]);

    expect(feed.tick(4500).map((m) => m.messageId)).toEqual(["m-3"]);
    feed.clear();
    expect(feed.snapshot()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MinimapProjector2D
// ---------------------------------------------------------------------------

describe("MinimapProjector2D", () => {
  const bounds = { minRight: -100, maxRight: 100, minForward: -100, maxForward: 100 };

  test("projectPlanar anchors: center / right edge / top edge / clamped", () => {
    const projector = new MinimapProjector2D({ planarBounds: { ...bounds } });
    expect(projector.projectPlanar(0, 0)).toEqual({ x: 100, y: 100 });
    expect(projector.projectPlanar(100, 0)).toEqual({ x: 200, y: 100 });
    expect(projector.projectPlanar(0, 100)).toEqual({ x: 100, y: 0 }); // +forward → top
    expect(projector.projectPlanar(-250, 0)).toEqual({ x: 0, y: 100 }); // clamped
  });

  test("padding shrinks the drawable area; inverts flip axes", () => {
    const projector = new MinimapProjector2D({ planarBounds: { ...bounds }, padding: 10 });
    expect(projector.projectPlanar(0, 0)).toEqual({ x: 100, y: 100 });
    expect(projector.projectPlanar(100, 100)).toEqual({ x: 190, y: 10 });

    projector.setViewport(200, 200, 0).setInvert(true, true);
    expect(projector.projectPlanar(100, 100)).toEqual({ x: 0, y: 200 });
  });

  test("project uses the default basis (right=+x, forward=−z)", () => {
    const projector = new MinimapProjector2D({ planarBounds: { ...bounds } });
    expect(projector.project({ x: 50, y: 3, z: -50 })).toEqual({ x: 150, y: 50 });
    expect(projector.projectPath([{ x: 0, y: 0, z: 0 }])).toEqual([{ x: 100, y: 100 }]);
  });

  test("projectYaw: world forward → 0, +x → +90°, +z → 180°", () => {
    const projector = new MinimapProjector2D({ planarBounds: { ...bounds } });
    expect(projector.projectYaw({ x: 0, y: 0, z: -1 })).toBeCloseTo(0, 12);
    expect(projector.projectYaw({ x: 1, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2, 12);
    expect(projector.projectYaw({ x: -1, y: 0, z: 0 })).toBeCloseTo(-Math.PI / 2, 12);
    expect(Math.abs(projector.projectYaw({ x: 0, y: 0, z: 1 }))).toBeCloseTo(Math.PI, 12);
  });

  test("bounds helpers: center/size and ortho frustum", () => {
    const projector = new MinimapProjector2D({ planarBounds: { ...bounds } });
    projector.setPlanarBoundsFromCenterSize(10, 20, 40, 60);
    expect(projector.planarBounds).toEqual({
      minRight: -10,
      maxRight: 30,
      minForward: -10,
      maxForward: 50,
    });
    expect(projector.getOrthoFrustumFromBounds()).toEqual({
      left: -10,
      right: 30,
      top: 50,
      bottom: -10,
    });
  });

  test("projectRelativePlanar: forward maps down (or up when flipped)", () => {
    expect(projectRelativePlanar(0, 1, 0, 0, 1, 2, 2, "down")).toEqual({ x: 1, y: 2 });
    expect(projectRelativePlanar(0, 1, 0, 0, 1, 2, 2, "up")).toEqual({ x: 1, y: 0 });
    expect(projectRelativePlanar(1, 0, 0, 0, 1, 2, 2)).toEqual({ x: 2, y: 1 });
  });
});

// ---------------------------------------------------------------------------
// Heading-relative projection (radar math)
// ---------------------------------------------------------------------------

describe("HeadingRelativeRadarProjection", () => {
  // width 250 / height 200 / range 20 → radius 89, origin (36, 11), center (125, 100)
  const geometry = { width: 250, height: 200, range: 20 };

  test("scope geometry matches the original's radius rule", () => {
    const projection = new HeadingRelativeRadarProjection(geometry);
    expect(projection.radarRadius).toBe(89);
    expect(projection.radarOriginX).toBe(36);
    expect(projection.radarOriginY).toBe(11);
    expect(projection.projectRelativePoint(0, 0)).toEqual({ x: 125, y: 100 });
  });

  test("anchors: dead ahead → top of scope, right → right edge", () => {
    const projection = new HeadingRelativeRadarProjection(geometry);
    const origin = { x: 0, y: 0, z: 0 };

    // facing world forward (−z), yaw 0
    const ahead = projection.projectContact({ x: 0, y: 0, z: -20 }, origin, 0);
    expect(ahead.x).toBeCloseTo(125, 10);
    expect(ahead.y).toBeCloseTo(11, 10); // top of scope

    const halfAhead = projection.projectContact({ x: 0, y: 0, z: -10 }, origin, 0);
    expect(halfAhead.y).toBeCloseTo(55.5, 10); // halfway up

    const right = projection.projectContact({ x: 20, y: 0, z: 0 }, origin, 0);
    expect(right.x).toBeCloseTo(214, 10); // right edge
    expect(right.y).toBeCloseTo(100, 10);
  });

  test("contacts beyond range clamp to the scope edge", () => {
    const projection = new HeadingRelativeRadarProjection(geometry);
    const far = projection.projectContact({ x: 0, y: 0, z: -40 }, { x: 0, y: 0, z: 0 }, 0);
    expect(far.x).toBeCloseTo(125, 10);
    expect(far.y).toBeCloseTo(11, 10);
  });

  test("player heading rotates the frame: facing +x puts a +x contact dead ahead", () => {
    const projection = new HeadingRelativeRadarProjection(geometry);
    const yaw = projection.yawFromForward({ x: 1, y: 0, z: 0 });
    expect(yaw).toBeCloseTo(-Math.PI / 2, 12);

    const ahead = projection.projectContact({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, yaw);
    expect(ahead.x).toBeCloseTo(125, 10);
    expect(ahead.y).toBeCloseTo(55.5, 10);
  });

  test("parseVec3Reading rejects missing and non-finite readings", () => {
    expect(parseVec3Reading(null)).toBeNull();
    expect(parseVec3Reading({ x: 1, y: 2 } as VecLike)).toBeNull(); // z undefined → NaN
    expect(parseVec3Reading({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
  });
});

// ---------------------------------------------------------------------------
// StorageSettingsStore
// ---------------------------------------------------------------------------

describe("StorageSettingsStore", () => {
  test("JsonSettingsStore round-trips through the memory backend", () => {
    const backend = new MemoryStorageBackend();
    const store = new JsonSettingsStore(backend, "race.settings", { volume: 5, invertY: false });
    store.update({ volume: 7 });
    store.save();

    const reloaded = new JsonSettingsStore(backend, "race.settings", {
      volume: 5,
      invertY: false,
    });
    expect(reloaded.load()).toEqual({ volume: 7, invertY: false });
    expect(reloaded.defaults).toEqual({ volume: 5, invertY: false }); // defaults untouched
  });

  test("resolveStorage(null) falls back to the shared memory backend", () => {
    const writer = new JsonSettingsStore(null, "ui.shared-key", { theme: "dark" });
    writer.update({ theme: "light" }).theme;
    writer.save();
    const reader = new JsonSettingsStore(null, "ui.shared-key", { theme: "dark" });
    expect(reader.load().theme).toBe("light");
    expect(resolveStorage(null)).toBe(resolveStorage(null));
  });

  test("raw readers: booleans, integers, corrupt JSON fall back", () => {
    const backend = new MemoryStorageBackend();
    expect(readBoolean("true")).toBe(true);
    expect(readBoolean("0", true)).toBe(false);
    expect(readBoolean("on")).toBe(true);
    expect(readBoolean("junk", true)).toBe(true);
    expect(readBoolean(null, true)).toBe(true);
    expect(readInteger("42", 7)).toBe(42);
    expect(readInteger("nope", 7)).toBe(7);

    backend.setItem("bad", "{not json");
    expect(readJsonStorageItem(backend, "bad", { ok: 1 })).toEqual({ ok: 1 });
    expect(writeStorageItem(backend, "", "x")).toBe(false); // falsy key
    expect(writeStorageItem(null, "k", "x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Components — mounted via the renderer harness
// ---------------------------------------------------------------------------

describe("HudValue / HudBar", () => {
  test("HudValue binds a Text to an accessor and updates in place", () => {
    const [ammo, setAmmo] = createSignal(12);
    const dispose = mount(() => HudValue({ value: () => `AMMO ${ammo()}` }));

    expect(collectTexts(root)).toEqual(["AMMO 12"]);
    host.clear();

    setAmmo(3);
    expect(collectTexts(root)).toEqual(["AMMO 3"]);
    expect(host.of("replaceText").length).toBe(1);
    expect(host.of("createNode")).toEqual([]); // in-place update, no new nodes

    dispose();
  });

  test("HudBar fill width tracks a 0..1 accessor over the px track", () => {
    const [ratio, setRatio] = createSignal(0.25);
    const dispose = mount(() => HudBar({ ratio, width: 100, height: 6 }));

    const widths = lastPropByNode(PROP.width);
    const fillId = [...widths.entries()].find(([, w]) => w === 25)?.[0];
    expect(fillId).toBeDefined();

    setRatio(0.5);
    expect(lastPropByNode(PROP.width).get(fillId as number)).toBe(50);
    setRatio(4); // clamped
    expect(lastPropByNode(PROP.width).get(fillId as number)).toBe(100);

    expect(hudBarRatio(50, 200)).toBe(0.25);
    expect(hudBarRatio(50, 0)).toBe(0); // non-positive max ⇒ 0, verbatim

    dispose();
  });
});

describe("FlightHud", () => {
  const baseState: Partial<FlightHudState> = {
    regionName: "Canyon Run",
    speed: 42,
    altitude: 1234,
    agl: 57,
    waveLabel: "WAVE 2",
    waveDetail: "3 LEFT",
    compassHeadingDegrees: 275.4,
    timeText: "01:23.4",
    scoreText: "score 120",
    throttle: 0.75,
    pitchDegrees: 12.3,
    rollDegrees: -8,
    weaponLabel: "CANNON",
    lockStatus: "RADAR",
    gunHeat: 0.5,
    pullUpWarning: true,
  };

  test("computeFlightHudReadouts matches the original formatting", () => {
    const readouts = computeFlightHudReadouts(baseState);
    expect(readouts.compassHeading).toBe("275");
    expect(readouts.cardinal).toBe("W");
    expect(readouts.speed).toBe("042");
    expect(readouts.altitude).toBe("1234");
    expect(readouts.agl).toBe("057");
    expect(readouts.throttle).toBe("075%");
    expect(readouts.attitude).toBe("+12.3 / -8.0");
    expect(readouts.wave).toBe("WAVE 2 3 LEFT");
    expect(readouts.lock).toBe("LOCK RADAR  HEAT 50%");
    expect(readouts.translatePitch).toBeCloseTo(12.3, 10);
    expect(readouts.safeRoll).toBe(-8);
    expect(readouts.pullUpWarning).toBe(true);

    // defaults are the original's renderDashboard defaults
    const idle = computeFlightHudReadouts();
    expect(idle.region).toBe("Hold Pattern");
    expect(idle.wave).toBe("FREE");
    expect(idle.weapon).toBe("--");
    expect(idle.lock).toBe("LOCK NONE  HEAT 0%");

    // pitch wraps past 180 to a negative tape translation
    expect(computeFlightHudReadouts({ pitchDegrees: 350 }).translatePitch).toBeCloseTo(-10, 10);
    expect(padNumber(-42.6, 3)).toBe("043");
    expect(cardinalForCompassHeadingDegrees(350)).toBe("N");
  });

  test("mounts the cockpit and updates readouts + tape transform reactively", () => {
    const [state, setState] = createSignal<Partial<FlightHudState>>(baseState);
    const dispose = mount(() => FlightHud({ state }));

    const texts = collectTexts(root);
    for (const expected of [
      "HDG",
      "275",
      "W",
      "042",
      "075%",
      "+12.3 / -8.0",
      "1234",
      "057",
      "CANNON",
      "Canyon Run",
      "WAVE 2 3 LEFT",
      "LOCK RADAR  HEAT 50%",
      "score 120",
      "01:23.4",
      "PULL UP",
    ]) {
      expect(texts).toContain(expected);
    }

    // pitch tape: 12 normal lines (210 wide) + 1 zero line (330 wide)
    const widths = [...lastPropByNode(PROP.width).values()];
    expect(widths.filter((w) => w === 210).length).toBe(12);
    expect(widths.filter((w) => w === 330).length).toBe(1);

    // tape transform: rotate(−roll), translateY(pitch·7)
    const rotates = lastPropByNode(PROP.rotate);
    expect(rotates.size).toBe(1);
    const [tapeId, tapeRotate] = [...rotates.entries()][0];
    expect(tapeRotate).toBe(8);
    expect(lastPropByNode(PROP.translateY).get(tapeId)).toBeCloseTo(86.1, 10);

    // throttle meter fill: 0.75 × 116px track
    expect([...lastPropByNode(PROP.width).values()]).toContain(87);

    setState({ ...baseState, speed: 128, rollDegrees: 4, pullUpWarning: false });
    const updated = collectTexts(root);
    expect(updated).toContain("128");
    expect(updated).not.toContain("042");
    expect(updated).not.toContain("PULL UP");
    expect(lastPropByNode(PROP.rotate).get(tapeId)).toBe(-4);

    dispose();
  });

  test("accepts a UiStateModel and tracks patches", () => {
    const model = new UiStateModel<Partial<FlightHudState>>({ speed: 10 });
    const dispose = mount(() => FlightHud({ state: model }));

    expect(collectTexts(root)).toContain("010");
    model.patch({ speed: 999 });
    expect(collectTexts(root)).toContain("999");
    expect(model.listeners.size).toBe(1);

    dispose();
    expect(model.listeners.size).toBe(0); // createUiSignal cleaned up

    // horizon toggle: display switches on the tape node
    const dispose2 = mount(
      () => FlightHud({ state: () => ({}), showHorizonLines: () => false }));
    const displays = [...lastPropByNode(PROP.display).values()];
    expect(displays).toContain(1); // Display.None
    dispose2();
  });
});

describe("HeadingRelativeRadar", () => {
  const player = { x: 0, y: 0, z: 0 };
  const contactsAt = (positions: VecLike[]): RadarContact[] =>
    positions.map((position) => ({ position }));

  test("projects contacts into dot Views; Index keeps nodes across updates", () => {
    const [contacts, setContacts] = createSignal<RadarContact[]>(
      contactsAt([
        { x: 0, y: 0, z: -20 }, // dead ahead → top of scope
        { x: 20, y: 0, z: 0 }, // hard right → right edge
      ]),
    );
    const dispose = mount(
      () =>
        HeadingRelativeRadar({
          playerPosition: () => player,
          playerForward: () => ({ x: 0, y: 0, z: -1 }),
          contacts,
        }));

    // root + 2 crosshair axes + ring + 2 contact dots + player marker
    expect(countViews(root)).toBe(7);

    // contact dots are the radius-4.2 nodes (default size), centered on the point
    const radii = lastPropByNode(PROP.radius);
    const dotIds = [...radii.entries()].filter(([, r]) => r === 4.2).map(([id]) => id);
    expect(dotIds.length).toBe(2);
    const tx = lastPropByNode(PROP.translateX);
    const ty = lastPropByNode(PROP.translateY);
    expect(tx.get(dotIds[0])).toBeCloseTo(120.8, 6); // 125 − 4.2
    expect(ty.get(dotIds[0])).toBeCloseTo(6.8, 6); // 11 − 4.2 (top)
    expect(tx.get(dotIds[1])).toBeCloseTo(209.8, 6); // 214 − 4.2 (right)
    expect(ty.get(dotIds[1])).toBeCloseTo(95.8, 6);

    // player marker present (radius 5.6)
    expect([...radii.values()]).toContain(5.6);

    // move the second contact behind the player: SAME node, new transform
    setContacts(contactsAt([{ x: 0, y: 0, z: -20 }, { x: 0, y: 0, z: 20 }]));
    expect(countViews(root)).toBe(7);
    expect(lastPropByNode(PROP.translateX).get(dotIds[1])).toBeCloseTo(120.8, 6);
    expect(lastPropByNode(PROP.translateY).get(dotIds[1])).toBeCloseTo(184.8, 6); // 189 − 4.2

    dispose();
  });

  test("invalid player reading renders the empty scope (no dots, no marker)", () => {
    const dispose = mount(
      () =>
        HeadingRelativeRadar({
          playerPosition: () => null,
          contacts: () => contactsAt([{ x: 1, y: 0, z: 1 }]),
        }));
    expect(countViews(root)).toBe(4); // root + axes + ring only
    dispose();
  });
});

describe("RaceMinimap", () => {
  const planarBounds = { minRight: 0, maxRight: 100, minForward: 0, maxForward: 100 };

  test("checkpoints, competitors, leader ring, and local marker project to dots", () => {
    const [checkpoints, setCheckpoints] = createSignal<VecLike[]>([
      { x: 0, y: 0, z: 0 }, // bottom-left corner
      { x: 100, y: 0, z: -100 }, // top-right corner
    ]);
    const [leader, setLeader] = createSignal<unknown>("a");
    const aiCars: AiCar[] = [{ id: "a", position: { x: 50, y: 0, z: -50 }, color: 0xff0000 }];

    const dispose = mount(
      () =>
        RaceMinimap({
          planarBounds,
          checkpoints,
          localProgress: () => ({ nextCheckpointIndex: 1 }),
          aiCars: () => aiCars,
          aiLeaderId: leader,
          localVehicle: () => ({
            position: { x: 50, y: 0, z: 0 },
            bodyFrame: { forward: { x: 1, y: 0, z: 0 } },
          }),
        }));

    // root + 2 checkpoints + ai dot + leader ring + local marker
    expect(countViews(root)).toBe(6);

    const radii = lastPropByNode(PROP.radius);
    const tx = lastPropByNode(PROP.translateX);
    const ty = lastPropByNode(PROP.translateY);
    const byRadius = (r: number): number[] =>
      [...radii.entries()].filter(([, v]) => v === r).map(([id]) => id);

    // plain checkpoint at (0, 200), radius 2.1
    const [plainId] = byRadius(2.1);
    expect(tx.get(plainId)).toBeCloseTo(-2.1, 6);
    expect(ty.get(plainId)).toBeCloseTo(197.9, 6);

    // NEXT checkpoint at (200, 0) grows to radius 3.4
    const [nextId] = byRadius(3.4);
    expect(tx.get(nextId)).toBeCloseTo(196.6, 6);
    expect(ty.get(nextId)).toBeCloseTo(-3.4, 6);

    // ai car at map center (100, 100): dot 2.8 + leader ring 4.8
    const [carId] = byRadius(2.8);
    expect(tx.get(carId)).toBeCloseTo(97.2, 6);
    expect(ty.get(carId)).toBeCloseTo(97.2, 6);
    expect(byRadius(4.8).length).toBe(1);

    // local vehicle at (100, 200), facing +x → +90° on the map
    const [localId] = byRadius(4.5);
    expect(tx.get(localId)).toBeCloseTo(95.5, 6);
    expect(ty.get(localId)).toBeCloseTo(195.5, 6);
    expect(lastPropByNode(PROP.rotate).get(localId)).toBeCloseTo(90, 10);

    // leadership change removes the ring; new checkpoint adds a row
    setLeader("b");
    expect(countViews(root)).toBe(5);
    setCheckpoints([...checkpoints(), { x: 50, y: 0, z: -100 }]);
    expect(countViews(root)).toBe(6);
    expect(byRadius(2.1).length + byRadius(3.4).length).toBeGreaterThanOrEqual(2);

    dispose();
  });
});
