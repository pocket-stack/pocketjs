import { afterEach, describe, expect, test } from "bun:test";
import {
  __packTouch,
  __resetTouches,
  __setTouches,
  touches,
} from "../src/touch.ts";

afterEach(__resetTouches);

describe("touch frame snapshot", () => {
  test("decodes stable ids and logical coordinates", () => {
    __setTouches([
      __packTouch(7, 12, 34),
      __packTouch(3, 479, 271),
    ]);
    expect(touches()).toEqual([
      { id: 7, x: 12, y: 34 },
      { id: 3, x: 479, y: 271 },
    ]);
  });

  test("publishes an immutable per-frame snapshot and clears on release", () => {
    const hostValues = [__packTouch(1, 20, 40)];
    __setTouches(hostValues);
    const first = touches();
    hostValues[0] = __packTouch(1, 99, 99);
    expect(first).toEqual([{ id: 1, x: 20, y: 40 }]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);

    __setTouches(undefined);
    expect(touches()).toEqual([]);
  });

  test("caps a malformed host frame at the Vita maximum", () => {
    __setTouches(Array.from({ length: 12 }, (_, id) => __packTouch(id, id, id)));
    expect(touches()).toHaveLength(8);
  });
});
