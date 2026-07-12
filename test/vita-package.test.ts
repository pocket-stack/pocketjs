import { describe, expect, test } from "bun:test";
import { vitaTitleId } from "../src/manifest/vita-package.ts";

describe("PS Vita package identity", () => {
  test("deterministically encodes a Pocket application id", () => {
    const first = vitaTitleId("dev.pocket-stack.demo.hero");
    expect(first).toBe(vitaTitleId("dev.pocket-stack.demo.hero"));
    expect(first).toMatch(/^[A-Z][A-Z0-9]{8}$/);
  });

  test("gives different applications different title ids", () => {
    expect(vitaTitleId("dev.pocket-stack.demo.hero"))
      .not.toBe(vitaTitleId("dev.pocket-stack.demo.gallery"));
  });
});
