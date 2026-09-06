import { flush } from "solid-js";
import { expect, test } from "bun:test";
import { createRoot, createSignal, onCleanup, runWithOwner, type Element as SolidElement } from "solid-js";
import { createResourceSlot, pending, ready, failed, type ResourceState } from "../framework/src/resource-state.ts";
import { ResourceBoundary } from "../framework/src/resource.ts";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js"))
  throw new Error("Resource UI tests require --conditions=browser");

test("resource tickets fence stale, duplicate and disposed completions", () => {
  let changes = 0;
  const slot = createResourceSlot<number>(() => changes++);
  const old = slot.begin(), current = slot.begin();
  expect(slot.resolve(old, 1)).toBe(false);
  expect(slot.resolve(current, 2)).toBe(true);
  expect(slot.reject(current, "late failure")).toBe(false);
  expect(slot.state()).toEqual(ready(2));
  const next = slot.begin();
  expect(slot.reject(next, "offline")).toBe(true);
  expect(slot.state()).toEqual(failed("offline"));
  slot.dispose();
  expect(slot.resolve(next, 3)).toBe(false);
  expect(slot.begin()).toBe(0);
  expect(changes).toBe(5);
});

test("boundary lazily reveals content, updates ready values and disposes only its subtree", () => {
  createRoot(dispose => {
    const [state, setState] = createSignal<ResourceState<number>>(pending());
    const [label, setLabel] = createSignal("skeleton");
    let mounts = 0, cleanups = 0;
    const output = ResourceBoundary({
      state,
      fallback: label,
      errorFallback: error => `error:${error}`,
      children: value => { mounts++; onCleanup(() => cleanups++); return (() => `value:${value()}`) as unknown as SolidElement; },
    });
    const read = () => { let value: unknown = output; while (typeof value === "function") value = value(); return value; };
    runWithOwner(null, () => {
    expect(read()).toBe("skeleton"); expect(mounts).toBe(0);
    setLabel("waiting"); flush(); expect(read()).toBe("waiting");
    setLabel("skeleton"); flush();
    setState(ready(7)); flush(); expect(read()).toBe("value:7");
    setState(ready(8)); flush(); expect(read()).toBe("value:8"); expect(mounts).toBe(1);
    setState(pending()); flush(); expect(read()).toBe("skeleton"); expect(cleanups).toBe(1);
    setState(failed("offline")); flush(); expect(read()).toBe("error:offline");
    setState(ready(9)); flush(); expect(read()).toBe("value:9");
    dispose(); expect(cleanups).toBe(2);
    });
  });
});
