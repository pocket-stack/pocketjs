import { beforeEach, describe, expect, mock, test } from "bun:test";
import { BTN } from "../contracts/spec/spec.ts";

// Components are normally bundled with framework/compiler/jsx-plugin.ts, which aliases
// `vue` to the Vapor runtime. This focused unit test only needs enough of that
// runtime to execute ActionHandler's setup and lifecycle registration.
mock.module("vue", () => ({
  computed<T>(read: () => T) {
    return { get value() { return read(); } };
  },
  createVaporApp() {
    return { mount() {}, unmount() {} };
  },
  defineVaporComponent(setup: unknown) {
    return setup;
  },
  insert() {},
  onScopeDispose() {},
  remove() {},
  shallowRef<T>(value: T) {
    return { value };
  },
  watchEffect(run: () => void) {
    run();
    return () => {};
  },
}));

const { ActionHandler } = await import("../framework/src/components-vue-vapor.ts");
const { resetFrameHooks, runFrameHooks } = await import("../framework/src/frame-vue-vapor.ts");

describe("Vue Vapor ActionHandler", () => {
  beforeEach(() => resetFrameHooks());

  test("forwards latched so a held opener must release before firing", () => {
    let presses = 0;
    const setup = ActionHandler as unknown as (
      props: Record<string, never>,
      context: { attrs: Record<string, unknown>; slots: { default: () => unknown } },
    ) => unknown;

    setup({}, {
      attrs: {
        button: BTN.SELECT,
        latched: true,
        onPress: () => presses++,
      },
      // A non-null block avoids constructing a native comment node; this test
      // is only about the lifecycle options passed by the component wrapper.
      slots: { default: () => ({ testBlock: true }) },
    });

    runFrameHooks(BTN.SELECT);
    expect(presses).toBe(0);
    runFrameHooks(0);
    runFrameHooks(BTN.SELECT);
    expect(presses).toBe(1);
  });
});
