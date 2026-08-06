import { afterEach, describe, expect, test } from "bun:test";
import {
  __packPointer,
  __resetPointer,
  __setPointer,
  pointer,
} from "../framework/src/pointer.ts";

afterEach(__resetPointer);

describe("pointer frame snapshot", () => {
  test("decodes logical coordinates and the button state", () => {
    __setPointer(__packPointer(12, 34, false));
    expect(pointer()).toEqual({ x: 12, y: 34, down: false });

    __setPointer(__packPointer(479, 271, true));
    expect(pointer()).toEqual({ x: 479, y: 271, down: true });
  });

  test("carries coordinates past the touch channel's 9-bit range", () => {
    __setPointer(__packPointer(1023, 1000, true));
    expect(pointer()).toEqual({ x: 1023, y: 1000, down: true });
  });

  test("publishes an immutable per-frame snapshot", () => {
    __setPointer(__packPointer(20, 40, true));
    const first = pointer();
    expect(Object.isFrozen(first)).toBe(true);
    __setPointer(__packPointer(99, 99, false));
    expect(first).toEqual({ x: 20, y: 40, down: true });
  });

  test("a host with no pointer this frame reports null, not an origin", () => {
    __setPointer(__packPointer(5, 6, true));
    __setPointer(undefined);
    // Null is distinguishable from (0,0): the cursor holds its last position
    // instead of snapping to a corner when the pointer leaves the window.
    expect(pointer()).toBeNull();
  });

  test("hosts that never pass a pointer see none", () => {
    expect(pointer()).toBeNull();
  });
});
