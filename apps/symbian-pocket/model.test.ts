import { describe, expect, test } from "bun:test";

import {
  APP_CATALOG,
  KEYPAD,
  appendKey,
  calculate,
  moveGrid,
  moveSnake,
  nextLanguage,
  shouldPersistWifi,
  type SnakeState,
} from "./model.ts";

describe("Symbian Pocket model", () => {
  test("ships the agreed complete application catalog", () => {
    expect(APP_CATALOG.map((app) => app.id)).toEqual([
      "contacts",
      "messages",
      "calendar",
      "alarms",
      "notes",
      "calculator",
      "files",
      "gallery",
      "music",
      "snake",
      "connectivity",
      "sensors",
      "hardware",
      "settings",
    ]);
  });

  test("wraps the S60 icon grid in both axes", () => {
    expect(moveGrid(0, "left", 14, 3)).toBe(2);
    expect(moveGrid(2, "right", 14, 3)).toBe(0);
    expect(moveGrid(1, "up", 14, 3)).toBe(13);
    expect(moveGrid(12, "down", 14, 3)).toBe(0);
  });

  test("uses bounded multi-tap style text entry", () => {
    expect(KEYPAD[0]).toBe("1234567890");
    expect(appendKey("abc", "d", 4)).toBe("abcd");
    expect(appendKey("abcd", "e", 4)).toBe("abcd");
  });

  test("calculator accepts the supported grammar and rejects other input", () => {
    expect(calculate("12+3*4")).toBe("24");
    expect(calculate("(9-3)/2")).toBe("3");
    expect(calculate("globalThis")).toBe("ERR");
    expect(calculate("1/0")).toBe("ERR");
  });

  test("wifi is persisted only after connection and an explicit yes", () => {
    expect(shouldPersistWifi(true, true)).toBe(true);
    expect(shouldPersistWifi(true, false)).toBe(false);
    expect(shouldPersistWifi(false, true)).toBe(false);
  });

  test("toggles between Chinese and English", () => {
    expect(nextLanguage("zh")).toBe("en");
    expect(nextLanguage("en")).toBe("zh");
  });

  test("snake advances, eats, grows and wraps deterministically", () => {
    const initial: SnakeState = {
      body: [{ x: 19, y: 3 }, { x: 18, y: 3 }],
      direction: "right",
      food: { x: 0, y: 3 },
      score: 0,
      alive: true,
    };
    const next = moveSnake(initial, 20, 10);
    expect(next.body).toEqual([
      { x: 0, y: 3 },
      { x: 19, y: 3 },
      { x: 18, y: 3 },
    ]);
    expect(next.score).toBe(1);
    expect(next.food).not.toEqual({ x: 0, y: 3 });
  });
});
