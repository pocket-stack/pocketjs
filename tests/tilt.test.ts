import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TILT_CENTER } from "../contracts/spec/spec.ts";
import { jsxPlugin, type PocketFramework } from "../framework/compiler/jsx-plugin.ts";
import type { HostOps } from "../framework/src/host.ts";
import { tiltRaw, tiltX, tiltY } from "../framework/src/input-api.ts";
import { __resetTilt, __setTilt } from "../framework/src/tilt.ts";
import { resetFrameHooks as resetSolidFrameHooks } from "../framework/src/frame.ts";
import { resetFrameHooks as resetVueFrameHooks } from "../framework/src/frame-vue-vapor.ts";
import { resetFrameHooks as resetOctaneFrameHooks } from "../framework/src/frame-octane.tsx";

describe("input.tilt", () => {
  test("decodes the packed calibrated screen-plane axes", () => {
    __setTilt(0xff80);
    expect([tiltX(), tiltY(), tiltRaw()]).toEqual([1, 0, 0xff80]);

    __setTilt(0x80ff);
    expect([tiltX(), tiltY(), tiltRaw()]).toEqual([0, 1, 0x80ff]);

    __setTilt(0x0080);
    expect([tiltX(), tiltY(), tiltRaw()]).toEqual([-1, 0, 0x0080]);

    __setTilt(0x8000);
    expect([tiltX(), tiltY(), tiltRaw()]).toEqual([0, -1, 0x8000]);
  });

  test("masks host samples to u16 and centers an omitted sample", () => {
    __setTilt(0x123456);
    expect(tiltRaw()).toBe(0x3456);
    __setTilt(undefined);
    expect([tiltX(), tiltY(), tiltRaw()]).toEqual([0, 0, TILT_CENTER]);
  });

  test("all framework lifecycle resets restore the center fallback", () => {
    for (const reset of [resetSolidFrameHooks, resetVueFrameHooks, resetOctaneFrameHooks]) {
      __setTilt(0xff00);
      reset();
      expect([tiltX(), tiltY(), tiltRaw()]).toEqual([0, 0, TILT_CENTER]);
    }
    __resetTilt();
  });
});

interface TiltProbeGlobals {
  ui?: HostOps;
  frame?: (
    buttons: number,
    analog?: number,
    touches?: readonly number[],
    hits?: readonly number[],
    tilt?: number,
  ) => void;
  __pocketTiltSamples?: [number, number, number][];
  __disposePocketTiltProbe?: () => void;
}

function tiltProbeHost(): HostOps {
  let nextId = 2;
  const noop = () => {};
  return {
    createNode: () => nextId++,
    destroyNode: noop,
    insertBefore: noop,
    removeChild: noop,
    setStyle: noop,
    setProp: noop,
    setText: noop,
    replaceText: noop,
    uploadTexture: () => 1,
    setImage: noop,
    setSprite: noop,
    animate: () => 1,
    cancelAnim: noop,
    setFocus: noop,
    measureText: () => 0,
  };
}

async function bundleTiltProbe(framework: PocketFramework): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pocketjs-${framework}-tilt-`));
  const entry = join(directory, "main.tsx");
  const runtime = `@pocketjs/framework/${framework}`;
  const frameHook = framework === "octane" ? "useFrame" : "onFrame";
  const component = framework === "octane"
    ? `function Probe() {
        useFrame(() => globalThis.__pocketTiltSamples.push([tiltX(), tiltY(), tiltRaw()]));
        return <View />;
      }
      globalThis.__disposePocketTiltProbe = render(Probe, { ops: globalThis.ui, styles: {} });`
    : `globalThis.__disposePocketTiltProbe = render(() => {
        onFrame(() => globalThis.__pocketTiltSamples.push([tiltX(), tiltY(), tiltRaw()]));
        return <View />;
      }, { ops: globalThis.ui, styles: {} });`;
  try {
    await Bun.write(entry, `
      import { render } from "${runtime}";
      import { View } from "${runtime}/components";
      import { ${frameHook} } from "${runtime}/lifecycle";
      import { tiltRaw, tiltX, tiltY } from "${runtime}/input";

      globalThis.__pocketTiltSamples = [];
      ${component}
    `);
    const result = await Bun.build({
      entrypoints: [entry],
      format: "iife",
      target: "browser",
      conditions: ["browser"],
      define: {
        "process.env.NODE_ENV": '"production"',
        __POCKET_TARGET__: '"tilt-test"',
        __POCKET_HOST_ABI__: "1",
        __POCKET_FEATURES__: JSON.stringify({ "input.tilt": true }),
        __POCKET_PIXEL_RATIO__: "1",
      },
      plugins: [jsxPlugin(framework, { entry })],
    });
    expect(result.success).toBe(true);
    return await result.outputs[0]!.text();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe.each(["solid", "vue-vapor", "octane"] as const)(
  "%s tilt frame integration",
  (framework) => {
    test("latches argument five before app hooks and centers omission", async () => {
      const globals = globalThis as typeof globalThis & TiltProbeGlobals;
      globals.ui = tiltProbeHost();
      try {
        (0, eval)(await bundleTiltProbe(framework));
        // Octane registers effects after its initial render commit.
        await Promise.resolve();
        globals.frame!(0, undefined, undefined, undefined, 0xff80);
        globals.frame!(0, undefined, undefined, undefined, 0x8000);
        globals.frame!(0);
        expect(globals.__pocketTiltSamples).toEqual([
          [1, 0, 0xff80],
          [0, -1, 0x8000],
          [0, 0, TILT_CENTER],
        ]);
      } finally {
        globals.__disposePocketTiltProbe?.();
        delete globals.__disposePocketTiltProbe;
        delete globals.__pocketTiltSamples;
        delete globals.ui;
        delete globals.frame;
      }
    });
  },
);
