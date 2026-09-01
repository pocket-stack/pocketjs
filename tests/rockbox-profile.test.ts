import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROCKBOX_IPOD_CLASSIC_HOST_ABI,
  ROCKBOX_IPOD_CLASSIC_TARGET_ID,
  resolveRockboxBuildPlan,
} from "../tools/rockbox-profile.ts";
import { parseClassLiteral } from "../framework/compiler/tailwind.ts";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "hosts/rockbox/demo.pocket.json"), "utf8"),
);
const nativeHost = readFileSync(join(root, "hosts/rockbox/main.c"), "utf8");
const runtimePort = readFileSync(
  join(root, "hosts/rockbox/runtime_port.c"),
  "utf8",
);
const demoMain = readFileSync(
  join(root, "hosts/rockbox/demo/main.tsx"),
  "utf8",
);
const inputPage = readFileSync(
  join(root, "hosts/rockbox/demo/input-test-page.tsx"),
  "utf8",
);
const contactsPage = readFileSync(
  join(root, "hosts/rockbox/demo/contacts-page.tsx"),
  "utf8",
);

describe("Rockbox iPod classic development profile", () => {
  test("resolves the embedded 320x240 demo", () => {
    const plan = resolveRockboxBuildPlan(manifest);
    expect(plan.target).toEqual({
      id: ROCKBOX_IPOD_CLASSIC_TARGET_ID,
      hostAbi: ROCKBOX_IPOD_CLASSIC_HOST_ABI,
    });
    expect(plan.viewport.logical).toEqual([320, 240]);
    expect(plan.features["input.buttons"]).toBe(true);
    expect(plan.features["text.glyphs.baked"]).toBe(true);
  });

  test("rejects a non-native logical viewport", () => {
    const changed = structuredClone(manifest);
    changed.app.viewport.fixed.logical = [176, 132];
    expect(() => resolveRockboxBuildPlan(changed)).toThrow();
  });

  test("reserves a 16 MiB runtime stack before the QuickJS heap", () => {
    expect(nativeHost).toContain("rb->audio_stop();");
    expect(nativeHost).toContain("rb->plugin_get_audio_buffer(&audio_size)");
    expect(nativeHost).toContain(
      "#define POCKETJS_RUNTIME_STACK_SIZE (16u * 1024u * 1024u)",
    );
    expect(nativeHost).toContain("heap = audio_buffer + POCKETJS_RUNTIME_STACK_SIZE");
    expect(nativeHost).toContain("rb->create_thread(");
    expect(nativeHost).toContain("POCKETJS_RUNTIME_STACK_SIZE,");
    expect(runtimePort).toContain(
      "#define POCKET_RUNTIME_JS_STACK_SIZE (8 * 1024 * 1024)",
    );
  });

  test("renders native RGB565 and presents only the damaged LCD region", () => {
    expect(nativeHost).toContain("pocket_runtime_render_rgb565(");
    expect(nativeHost).toContain("pocket_runtime_damage_bounds(damage)");
    expect(nativeHost).toContain("rb->lcd_bitmap_part(");
    expect(nativeHost).toContain("rb->lcd_update_rect(");
    expect(nativeHost).not.toContain("rockbox_bgra_to_rgb565(");
    expect(nativeHost).not.toContain("rb->lcd_update();");
  });

  test("ships three hardware-switchable acceptance pages", () => {
    expect(demoMain).toContain("const PAGE_COUNT = 3");
    expect(demoMain).toContain("buttons & BTN.CIRCLE");
    expect(demoMain).toContain("pressed & BTN.LEFT");
    expect(demoMain).toContain("pressed & BTN.RIGHT");
    expect(demoMain).toContain("<StandardPage />");
    expect(demoMain).toContain("<InputTestPage />");
    expect(demoMain).toContain("<ContactsPage />");
  });

  test("covers every iPod input and virtualizes 10,000 contacts", () => {
    for (const button of [
      "BTN.TRIANGLE",
      "BTN.LEFT",
      "BTN.CIRCLE",
      "BTN.RIGHT",
      "BTN.START",
      "BTN.UP",
      "BTN.DOWN",
    ]) {
      expect(inputPage).toContain(button);
    }
    expect(contactsPage).toContain("const CONTACT_COUNT = 10_000");
    expect(contactsPage).toContain("const CONTACT_WINDOW_ROWS = Math.ceil(");
    expect(contactsPage).toContain("<RecycledContactList");
    expect(contactsPage).toContain("<For each={CONTACT_ROW_SLOTS}>");
    expect(contactsPage).toContain("firstIndex() * CONTACT_ROW_HEIGHT");
    expect(contactsPage).not.toContain("<VirtualList");
    expect(contactsPage).toContain("contactScrollTarget(");
    expect(contactsPage).toContain("listScroller.springTo(target");
    expect(contactsPage).toContain("contactSelectionY(");
    expect(contactsPage).toContain("contactVisibleIndex(");
    expect(contactsPage).toContain("wheelTargetIndex");
    expect(contactsPage).toContain("style={{ translateY: props.selectionY() }}");
    const separatorLayer = contactsPage.indexOf("<ContactSeparator />");
    const selectionLayer = contactsPage.indexOf('bg-[#2378d4]');
    const textLayer = contactsPage.indexOf("<ContactRow index=");
    expect(separatorLayer).toBeGreaterThan(-1);
    expect(separatorLayer).toBeLessThan(selectionLayer);
    expect(selectionLayer).toBeLessThan(textLayer);
    expect(contactsPage).not.toContain("selected().given");
    expect(contactsPage).not.toContain("selected().surname");
    expect(contactsPage).not.toContain("selected().ordinal");
    expect(contactsPage).toContain("acceleratedWheelDelta(-1)");
    expect(contactsPage).toContain("acceleratedWheelDelta(1)");
    expect(contactsPage).toContain("wheelMultiplier(wheelBurst)");
    expect(contactsPage).toContain("settleReleasedSelection()");
    expect(contactsPage).toContain("wheelIdleFrames === 1");
    expect(contactsPage).toContain("listScroller.stop()");
    expect(contactsPage).toContain("setDetailIndex(destinationIndex())");
    expect(contactsPage).toContain('class="relative w-[320] h-[204] overflow-hidden"');
    expect(contactsPage).toContain('w-[62] h-[18] text-sm');
    expect(contactsPage).toContain('w-[174] h-[18] text-sm');
    expect(contactsPage).toContain('w-[50] h-[15] text-xs');
    expect(contactsPage).toContain('top-[36] w-[320] h-[204]');
    expect(contactsPage).toContain('{ dur: 110, easing: "out" }');
    expect(contactsPage).toContain('animate(detailPanel, "translateX", 0');
    expect(contactsPage).toContain('animate(detailPanel, "translateX", 320');
    expect(demoMain).not.toContain("PAGE_LABELS");
    expect(demoMain).not.toContain("SELECT + LEFT / RIGHT");
  });

  test("compiles the fixed 320x36 contacts navigation bar", () => {
    const navigationClass = contactsPage.match(
      /function NavigationBar[\s\S]*?<View class="([^"]+)"/,
    )?.[1];
    expect(navigationClass).toBeDefined();
    expect(parseClassLiteral(navigationClass!)).not.toBeNull();
    expect(navigationClass).toContain("w-[320] h-[36]");
    expect(contactsPage).toContain(
      'left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]',
    );
  });
});
