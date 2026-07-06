// demos/motions — app-local Pocket config.
//
// Every keyframe below is ported 1:1 from yui540's motion studies
// https://yui540.com/motions/53, /56 and /30 (durations, delays, easings and
// keyframe percentages match the extracted @emotion CSS; geometry is rebaked
// from the original percent/calc values into absolute px for a 320x190 stage,
// which is what the bake-ability rules require).
//
// Each `animation` entry carries the scene's whole-choreography `loop` — the
// PocketJS extension that replays the full comma list (delays included) every
// N ms, replacing the original page's remount-driven replay.

import { definePocketConfig } from "@pocketjs/framework/config";

// The two cubic-beziers yui540 uses beyond the CSS named easings.
const SNAP = "cubic-bezier(0.77, 0.02, 0.25, 0.97)"; // motion/30 signature ease
const FLING = "cubic-bezier(0.04, 0.91, 0.51, 0.97)"; // slide-in card fling

export default definePocketConfig({
  framework: "solid",
  theme: {
    keyframes: {
      // ---- shared ----------------------------------------------------------
      "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
      "fade-out": { from: { opacity: 1 }, to: { opacity: 0 } },

      // ---- motions/56 · app launch (アプリ起動) ------------------------------
      // box 56px at (132,54) -> full 320x190 stage and back.
      "m56-applaunch-in": {
        from: { top: 54, left: 132, width: 56 },
        to: { top: 0, left: 0, width: 320 },
      },
      "m56-applaunch-grow": {
        from: { height: 56 },
        to: { height: 190 },
      },
      "m56-applaunch-back": {
        from: { top: 0, left: 0, width: 320, height: 190 },
        "50%": { top: 58, left: 135, width: 50, height: 50 },
        "75%": { top: 53, left: 131, width: 58, height: 58 },
        to: { top: 54, left: 132, width: 56, height: 56 },
      },
      "m56-applaunch-press": {
        "from,to": { scale: 1 },
        "50%": { scale: 0.85 },
      },

      // ---- motions/56 · layout switch (レイアウト切り替え) --------------------
      // 200x130 window at (60,23): left/right panes shrink apart, right pane
      // splits into two cards, then a 3-row layout takes over.
      "m56-layout-left": {
        from: { width: 102 },
        "60%": { width: 87 },
        to: { width: 92 },
      },
      "m56-layout-left-close": { from: { width: 92 }, to: { width: 102 } },
      "m56-layout-right": {
        from: { left: 98, width: 102 },
        "60%": { left: 110, width: 90 },
        to: { left: 106, width: 94 },
      },
      "m56-layout-right-close": {
        from: { left: 106, width: 94 },
        to: { left: 98, width: 102 },
      },
      "m56-layout-half-top": {
        from: { height: 66, borderRadius: 0 },
        "60%": { height: 54, borderRadius: 16 },
        to: { height: 58, borderRadius: 16 },
      },
      "m56-layout-half-top-close": {
        from: { height: 58, borderRadius: 16 },
        to: { height: 66, borderRadius: 0 },
      },
      "m56-layout-half-bottom": {
        from: { top: 64, height: 66, borderRadius: 0 },
        "60%": { top: 76, height: 54, borderRadius: 16 },
        to: { top: 72, height: 58, borderRadius: 16 },
      },
      "m56-layout-half-bottom-close": {
        from: { top: 72, height: 58, borderRadius: 16 },
        to: { top: 64, height: 66, borderRadius: 0 },
      },
      "m56-layout-row-top": {
        from: { height: 44, borderRadius: 0 },
        "60%": { height: 34, borderRadius: 16 },
        to: { height: 36, borderRadius: 16 },
      },
      "m56-layout-row-top-close": {
        from: { height: 36, borderRadius: 16 },
        to: { height: 44, borderRadius: 0 },
      },
      "m56-layout-row-mid": {
        from: { top: 43, height: 44, borderRadius: 0 },
        "60%": { top: 48, height: 34, borderRadius: 16 },
        to: { top: 47, height: 36, borderRadius: 16 },
      },
      "m56-layout-row-mid-close": {
        from: { top: 47, height: 36, borderRadius: 16 },
        to: { top: 43, height: 44, borderRadius: 0 },
      },
      "m56-layout-row-bottom": {
        from: { top: 86, height: 44, borderRadius: 0 },
        "60%": { top: 96, height: 34, borderRadius: 16 },
        to: { top: 94, height: 36, borderRadius: 16 },
      },
      "m56-layout-row-bottom-close": {
        from: { top: 94, height: 36, borderRadius: 16 },
        to: { top: 86, height: 44, borderRadius: 0 },
      },

      // ---- motions/56 · shutter (シャッター) ---------------------------------
      "m56-shutter-open": {
        from: { height: 8 },
        "60%": { height: 30 },
        to: { height: 28 },
      },
      "m56-shutter-close": {
        from: { height: 28 },
        "60%": { height: 6 },
        to: { height: 8 },
      },

      // ---- motions/56 · card fan (カード) ------------------------------------
      "m56-fan-l2": { from: { rotate: 0 }, "60%": { rotate: -55 }, to: { rotate: -50 } },
      "m56-fan-l1": { from: { rotate: 0 }, "60%": { rotate: -27.5 }, to: { rotate: -25 } },
      "m56-fan-r1": { from: { rotate: 0 }, "60%": { rotate: 27.5 }, to: { rotate: 25 } },
      "m56-fan-r2": { from: { rotate: 0 }, "60%": { rotate: 55 }, to: { rotate: 50 } },
      "m56-fan-l2-close": { from: { rotate: -50 }, to: { rotate: 0 } },
      "m56-fan-l1-close": { from: { rotate: -25 }, to: { rotate: 0 } },
      "m56-fan-r1-close": { from: { rotate: 25 }, to: { rotate: 0 } },
      "m56-fan-r2-close": { from: { rotate: 50 }, to: { rotate: 0 } },
      "m56-fan-pulse": { "from,to": { scale: 1 }, "60%": { scale: 1.06 } },

      // ---- motions/56 · heave-ho (よいしょよいしょ) ---------------------------
      // 60x50 pill squashes into a 120x30 slab, then hops 60px right — twice.
      "m56-heave-1": {
        from: { width: 60, height: 50, top: 0, translateX: 0, backgroundColor: "#bbb" },
        "50%": { width: 120, height: 30, top: 20, translateX: 0, backgroundColor: "#ccc" },
        to: { width: 60, height: 50, top: 0, translateX: 60, backgroundColor: "#bbb" },
      },
      "m56-heave-2": {
        from: { width: 60, height: 50, top: 0, translateX: 60, backgroundColor: "#bbb" },
        "50%": { width: 120, height: 30, top: 20, translateX: 60, backgroundColor: "#ccc" },
        to: { width: 60, height: 50, top: 0, translateX: 120, backgroundColor: "#bbb" },
      },

      // ---- motions/56 · focus ring (フォーカス) -------------------------------
      // Ring hops B -> C -> A, stretches across all three, then snaps back.
      "m56-focus-hop-right": { from: { left: 0 }, to: { left: 90 } },
      "m56-focus-hop-left": { from: { left: 90 }, to: { left: -90 } },
      "m56-focus-stretch": {
        from: { left: -90, width: 60 },
        to: { left: -90, width: 240 },
      },
      "m56-focus-snap": {
        from: { left: -90, width: 240 },
        to: { left: 0, width: 60 },
      },
      "m56-focus-pulse": { "from,to": { inset: -10 }, "50%": { inset: -6 } },

      // ---- motions/53 · menu (メニュー) ---------------------------------------
      // 64px pill expands to 237px revealing three items; dots morph into an X.
      "m53-menu-open": { from: { width: 64 }, "60%": { width: 243 }, to: { width: 237 } },
      "m53-menu-close": { from: { width: 237 }, "60%": { width: 58 }, to: { width: 64 } },
      "m53-menu-x-left": {
        from: { left: 12, rotate: 0 },
        "40%": { left: 28, rotate: 45 },
        to: { left: 28, rotate: 45 },
      },
      "m53-menu-x-right": {
        from: { left: 44, rotate: 0 },
        "40%": { left: 28, rotate: -45 },
        to: { left: 28, rotate: -45 },
      },
      // bar growth + recolor shared by both X arms (top pins the center).
      "m53-menu-x-grow": {
        from: { top: 28, height: 8, backgroundColor: "#777" },
        "40%": { top: 28, height: 8 },
        "50%": { backgroundColor: "#ccc" },
        "70%": { top: 13, height: 38 },
        to: { top: 14, height: 35, backgroundColor: "#ccc" },
      },
      "m53-menu-x-left-out": {
        from: { left: 28, rotate: 45 },
        "50%": { left: 28, rotate: 45 },
        to: { left: 12, rotate: 0 },
      },
      "m53-menu-x-right-out": {
        from: { left: 28, rotate: -45 },
        "50%": { left: 28, rotate: -45 },
        to: { left: 44, rotate: 0 },
      },
      "m53-menu-x-shrink": {
        from: { top: 14, height: 35, backgroundColor: "#ccc" },
        "50%": { top: 28, height: 8, backgroundColor: "#777" },
        to: { top: 28, height: 8, backgroundColor: "#777" },
      },
      "m53-menu-item-in": {
        from: { translateY: 64 },
        "50%": { translateY: -3 },
        "75%": { translateY: 2 },
        to: { translateY: 0 },
      },
      "m53-menu-item-out": { from: { translateY: 0 }, to: { translateY: 77 } },

      // ---- motions/53 · d-pad (十字キー) --------------------------------------
      // Key caps stretch away from the center and snap back (135% -> 93% -> 100%).
      "m53-dpad-up": {
        "from,to": { top: 38, height: 40 },
        "50%": { top: 24, height: 54 },
        "75%": { top: 41, height: 37 },
      },
      "m53-dpad-down": {
        "from,to": { top: 90, height: 40 },
        "50%": { height: 54 },
        "75%": { height: 37 },
      },
      "m53-dpad-right": {
        "from,to": { left: 166, width: 40 },
        "50%": { width: 54 },
        "75%": { width: 37 },
      },
      "m53-dpad-left": {
        "from,to": { left: 114, width: 40 },
        "50%": { left: 100, width: 54 },
        "75%": { left: 117, width: 37 },
      },

      // ---- motions/53 · share (共有) ------------------------------------------
      // Buttons inflate 68 -> 110 -> 106 keeping the bottom-center anchored.
      "m53-share-grow-a": {
        from: { left: 72, top: 62, width: 68, height: 68 },
        "50%": { left: 51, top: 20, width: 110, height: 110 },
        "75%": { left: 54, top: 26, width: 104, height: 104 },
        to: { left: 53, top: 24, width: 106, height: 106 },
      },
      "m53-share-shrink-a": {
        from: { left: 53, top: 24, width: 106, height: 106 },
        "50%": { left: 74, top: 66, width: 64, height: 64 },
        "75%": { left: 71, top: 60, width: 70, height: 70 },
        to: { left: 72, top: 62, width: 68, height: 68 },
      },
      "m53-share-grow-b": {
        from: { left: 180, top: 62, width: 68, height: 68 },
        "50%": { left: 159, top: 20, width: 110, height: 110 },
        "75%": { left: 162, top: 26, width: 104, height: 104 },
        to: { left: 161, top: 24, width: 106, height: 106 },
      },
      "m53-share-shrink-b": {
        from: { left: 161, top: 24, width: 106, height: 106 },
        "50%": { left: 182, top: 66, width: 64, height: 64 },
        "75%": { left: 179, top: 60, width: 70, height: 70 },
        to: { left: 180, top: 62, width: 68, height: 68 },
      },
      "m53-share-label-in": {
        from: { translateY: 30, opacity: 0 },
        "60%": { translateY: -2, opacity: 1 },
        to: { translateY: 0, opacity: 1 },
      },
      "m53-share-label-out": {
        from: { translateY: 0, opacity: 1 },
        to: { translateY: 30, opacity: 0 },
      },

      // ---- motions/53 · hover button (ホバー) ----------------------------------
      "m53-hover-lift": { from: { translateY: 0 }, to: { translateY: -2 } },
      "m53-hover-drop": { from: { translateY: -2 }, to: { translateY: 0 } },
      "m53-hover-arrow-in": {
        from: { width: 0 },
        "50%": { width: 48 },
        "75%": { width: 45 },
        to: { width: 46 },
      },
      "m53-hover-arrow-out": {
        from: { width: 46 },
        "50%": { width: 0 },
        "75%": { width: 3 },
        to: { width: 0 },
      },

      // ---- motions/53 · reload (リロード) --------------------------------------
      "m53-reload-spin": { from: { rotate: 45 }, to: { rotate: 220 } },
      "m53-reload-dot": {
        "from,to": { opacity: 0 },
        "30%,70%": { opacity: 1 },
      },

      // ---- motions/53 · keypad (キーパッド) -------------------------------------
      // Center-preserving squish inside a 60x60 wrapper.
      "m53-key-squish": {
        "from,to": { left: 0, top: 0, width: 60, height: 60, borderRadius: 16 },
        "50%": { left: -12, top: 3, width: 84, height: 54, borderRadius: 30 },
        "75%": { left: 3, top: 1, width: 54, height: 59, borderRadius: 16 },
      },
      "m53-key-digit": {
        "from,to": { translateY: 0 },
        "50%": { translateY: 3 },
        "75%": { translateY: -1 },
      },

      // ---- motions/30 · circular reveal (app launch) ---------------------------
      // A white splash grows from (80%, 80%) of the card; content pops after.
      "m30-reveal": { from: { scale: 1 }, to: { scale: 17 } },
      "m30-pop": {
        from: { scale: 0.2, opacity: 0 },
        to: { scale: 1, opacity: 1 },
      },

      // ---- motions/30 · staggered grid ------------------------------------------
      "m30-cell": {
        from: { opacity: 0, scale: 0.3 },
        to: { opacity: 1, scale: 1 },
      },
      "m30-slide-down": { from: { translateY: -29 }, to: { translateY: 0 } },
      "m30-slide-up": { from: { translateY: 25 }, to: { translateY: 0 } },

      // ---- motions/30 · expand panel ---------------------------------------------
      "m30-expand-w": {
        from: { left: 160, width: 0 },
        "50%": { left: 55, width: 210 },
        to: { left: 60, width: 200 },
      },
      "m30-expand-h": {
        from: { top: 68, height: 28 },
        "50%": { top: 14, height: 135 },
        to: { top: 19, height: 125 },
      },

      // ---- motions/30 · modal ------------------------------------------------------
      "m30-modal-pop": {
        from: { scale: 0.5, opacity: 0 },
        "50%": { scale: 1.04, opacity: 1 },
        to: { scale: 1, opacity: 1 },
      },
      "m30-jelly": {
        from: { scale: 0.7, opacity: 0 },
        "40%": { scale: 1.2, opacity: 1 },
        "60%": { scale: 1, opacity: 1 },
        "80%": { scale: 1.05, opacity: 1 },
        to: { scale: 1, opacity: 1 },
      },
      "m30-line": { from: { translateX: 26 }, to: { translateX: -26 } },

      // ---- motions/30 · comment pops -------------------------------------------------
      "m30-comment": {
        from: { scale: 0.4, opacity: 0 },
        "50%": { scale: 1.15, opacity: 1 },
        to: { scale: 1, opacity: 1 },
      },

      // ---- motions/30 · slide-in stack -------------------------------------------------
      "m30-slidein": {
        from: { translateY: 130, scale: 1.25, rotate: 20 },
        to: { translateY: 0, scale: 1, rotate: 0 },
      },
      "m30-zoom-in": {
        from: { scale: 1.4, opacity: 0 },
        "50%": { scale: 0.94, opacity: 1 },
        to: { scale: 1, opacity: 1 },
      },
    },

    animation: {
      // ---- motions/56 -----------------------------------------------------------
      "m56-applaunch-box": {
        value:
          "m56-applaunch-in 0.2s ease-in-out 0.2s both, " +
          "m56-applaunch-grow 0.4s ease-in-out 0.3s forwards, " +
          "m56-applaunch-back 0.6s ease-in-out 1.4s forwards",
        loop: "2600ms",
      },
      "m56-applaunch-press": {
        value: "m56-applaunch-press 0.3s ease-in-out both",
        loop: "2600ms",
      },
      "m56-layout-p1": {
        value: "fade-out 0.05s ease-in-out 2.2s forwards",
        loop: "3900ms",
      },
      "m56-layout-left": {
        value:
          "m56-layout-left 0.5s ease-in-out 0.2s both, " +
          "m56-layout-left-close 0.25s ease-in-out 1.8s forwards",
        loop: "3900ms",
      },
      "m56-layout-right": {
        value:
          "m56-layout-right 0.5s ease-in-out 0.2s both, " +
          "m56-layout-right-close 0.25s ease-in-out 1.8s forwards",
        loop: "3900ms",
      },
      "m56-layout-half-top": {
        value:
          "m56-layout-half-top 0.5s ease-in-out 0.8s both, " +
          "m56-layout-half-top-close 0.25s ease-in-out 1.6s forwards",
        loop: "3900ms",
      },
      "m56-layout-half-bottom": {
        value:
          "m56-layout-half-bottom 0.5s ease-in-out 0.8s both, " +
          "m56-layout-half-bottom-close 0.25s ease-in-out 1.6s forwards",
        loop: "3900ms",
      },
      "m56-layout-p2": {
        value: "fade-in 0.05s ease-in-out 2.1s both",
        loop: "3900ms",
      },
      "m56-layout-row-top": {
        value:
          "m56-layout-row-top 0.5s ease-in-out 2.2s both, " +
          "m56-layout-row-top-close 0.25s ease-in-out 3.2s forwards",
        loop: "3900ms",
      },
      "m56-layout-row-mid": {
        value:
          "m56-layout-row-mid 0.5s ease-in-out 2.25s both, " +
          "m56-layout-row-mid-close 0.25s ease-in-out 3.2s forwards",
        loop: "3900ms",
      },
      "m56-layout-row-bottom": {
        value:
          "m56-layout-row-bottom 0.5s ease-in-out 2.3s both, " +
          "m56-layout-row-bottom-close 0.25s ease-in-out 3.2s forwards",
        loop: "3900ms",
      },
      "m56-shutter-1": {
        value:
          "m56-shutter-open 0.5s ease-in-out 0.2s both, " +
          "m56-shutter-close 0.5s ease-in-out 1.3s forwards",
        loop: "2600ms",
      },
      "m56-shutter-2": {
        value:
          "m56-shutter-open 0.5s ease-in-out 0.25s both, " +
          "m56-shutter-close 0.5s ease-in-out 1.35s forwards",
        loop: "2600ms",
      },
      "m56-shutter-3": {
        value:
          "m56-shutter-open 0.5s ease-in-out 0.3s both, " +
          "m56-shutter-close 0.5s ease-in-out 1.4s forwards",
        loop: "2600ms",
      },
      "m56-shutter-4": {
        value:
          "m56-shutter-open 0.5s ease-in-out 0.35s both, " +
          "m56-shutter-close 0.5s ease-in-out 1.45s forwards",
        loop: "2600ms",
      },
      "m56-fan-l2": {
        value:
          "m56-fan-l2 0.6s ease-in-out 0.1s both, " +
          "m56-fan-l2-close 0.3s ease-in-out 1.1s forwards",
        loop: "2400ms",
      },
      "m56-fan-l1": {
        value:
          "m56-fan-l1 0.6s ease-in-out 0.2s both, " +
          "m56-fan-l1-close 0.3s ease-in-out 1.2s forwards",
        loop: "2400ms",
      },
      "m56-fan-r1": {
        value:
          "m56-fan-r1 0.6s ease-in-out 0.2s both, " +
          "m56-fan-r1-close 0.3s ease-in-out 1.2s forwards",
        loop: "2400ms",
      },
      "m56-fan-r2": {
        value:
          "m56-fan-r2 0.6s ease-in-out 0.1s both, " +
          "m56-fan-r2-close 0.3s ease-in-out 1.1s forwards",
        loop: "2400ms",
      },
      "m56-fan-pulse": {
        value:
          "m56-fan-pulse 0.6s ease-in-out both, " +
          "m56-fan-pulse 0.6s ease-in-out 1s forwards",
        loop: "2400ms",
      },
      "m56-heave": {
        value:
          "m56-heave-1 1.5s ease-in-out both, " +
          "m56-heave-2 1.5s ease-in-out 1.7s forwards",
        loop: "3600ms",
      },
      "m56-focus-ring": {
        value:
          "m56-focus-hop-right 0.2s ease-in-out 0.2s both, " +
          "m56-focus-hop-left 0.2s ease-in-out 1.2s forwards, " +
          "m56-focus-stretch 0.2s ease-in-out 2.2s forwards, " +
          "m56-focus-snap 0.2s ease-in-out 3.2s forwards",
        loop: "4400ms",
      },
      "m56-focus-pulse": {
        value:
          "m56-focus-pulse 0.3s ease-in-out 0.4s both, " +
          "m56-focus-pulse 0.3s ease-in-out 1.4s forwards, " +
          "m56-focus-pulse 0.3s ease-in-out 2.4s forwards, " +
          "m56-focus-pulse 0.3s ease-in-out 3.4s forwards",
        loop: "4400ms",
      },

      // ---- motions/53 -----------------------------------------------------------
      "m53-menu-pill": {
        value:
          "m53-menu-open 0.6s ease-in-out 0.2s both, " +
          "m53-menu-close 0.6s ease-in-out 1.2s forwards",
        loop: "2400ms",
      },
      "m53-menu-x-left": {
        value:
          "m53-menu-x-left 0.6s ease-in-out 0.2s both, " +
          "m53-menu-x-grow 0.6s ease-in-out 0.2s both, " +
          "m53-menu-x-left-out 0.35s ease-in-out 1.2s forwards, " +
          "m53-menu-x-shrink 0.35s ease-in-out 1.2s forwards",
        loop: "2400ms",
      },
      "m53-menu-x-right": {
        value:
          "m53-menu-x-right 0.6s ease-in-out 0.2s both, " +
          "m53-menu-x-grow 0.6s ease-in-out 0.2s both, " +
          "m53-menu-x-right-out 0.35s ease-in-out 1.2s forwards, " +
          "m53-menu-x-shrink 0.35s ease-in-out 1.2s forwards",
        loop: "2400ms",
      },
      "m53-menu-item-1": {
        value:
          "m53-menu-item-in 0.6s ease-in-out 0.25s both, " +
          "m53-menu-item-out 0.25s ease-in-out 1.3s forwards",
        loop: "2400ms",
      },
      "m53-menu-item-2": {
        value:
          "m53-menu-item-in 0.6s ease-in-out 0.3s both, " +
          "m53-menu-item-out 0.25s ease-in-out 1.25s forwards",
        loop: "2400ms",
      },
      "m53-menu-item-3": {
        value:
          "m53-menu-item-in 0.6s ease-in-out 0.35s both, " +
          "m53-menu-item-out 0.25s ease-in-out 1.2s forwards",
        loop: "2400ms",
      },
      "m53-dpad-up": { value: "m53-dpad-up 0.55s ease-in-out 0.2s both", loop: "2600ms" },
      "m53-dpad-right": { value: "m53-dpad-right 0.55s ease-in-out 0.7s both", loop: "2600ms" },
      "m53-dpad-down": { value: "m53-dpad-down 0.55s ease-in-out 1.2s both", loop: "2600ms" },
      "m53-dpad-left": { value: "m53-dpad-left 0.55s ease-in-out 1.7s both", loop: "2600ms" },
      "m53-share-a": {
        value:
          "m53-share-grow-a 0.6s ease-in-out 0.2s both, " +
          "m53-share-shrink-a 0.5s ease-in-out 1.4s forwards",
        loop: "4000ms",
      },
      "m53-share-b": {
        value:
          "m53-share-grow-b 0.6s ease-in-out 2s both, " +
          "m53-share-shrink-b 0.5s ease-in-out 3s forwards",
        loop: "4000ms",
      },
      "m53-share-label-a": {
        value:
          "m53-share-label-in 0.4s ease-in-out 0.2s both, " +
          "m53-share-label-out 0.3s ease-in-out 1.2s forwards",
        loop: "4000ms",
      },
      "m53-share-label-b": {
        value:
          "m53-share-label-in 0.4s ease-in-out 2s both, " +
          "m53-share-label-out 0.3s ease-in-out 3s forwards",
        loop: "4000ms",
      },
      "m53-hover-btn": {
        value:
          "m53-hover-lift 0.3s ease-in-out 0.2s both, " +
          "m53-hover-drop 0.3s ease-in-out 1.4s forwards",
        loop: "2400ms",
      },
      "m53-hover-arrow": {
        value:
          "m53-hover-arrow-in 0.5s ease-in-out 0.2s both, " +
          "m53-hover-arrow-out 0.5s ease-in-out 1.4s forwards",
        loop: "2400ms",
      },
      "m53-reload-spin-a": { value: "m53-reload-spin 1.2s ease-in 0.2s both", loop: "3200ms" },
      "m53-reload-spin-b": { value: "m53-reload-spin 1.2s ease-in 1.4s both", loop: "3200ms" },
      ...Object.fromEntries(
        [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [
          `m53-reload-dot-a${i}`,
          { value: `m53-reload-dot 1s ease-in-out ${(0.2 + i * 0.07).toFixed(2)}s both`, loop: "3200ms" },
        ]),
      ),
      ...Object.fromEntries(
        [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [
          `m53-reload-dot-b${i}`,
          { value: `m53-reload-dot 1s ease-in-out ${(1.4 + i * 0.07).toFixed(2)}s both`, loop: "3200ms" },
        ]),
      ),
      "m53-key-1": { value: "m53-key-squish 0.6s ease-in-out 0.2s both", loop: "2400ms" },
      "m53-key-2": { value: "m53-key-squish 0.6s ease-in-out 0.8s both", loop: "2400ms" },
      "m53-key-3": { value: "m53-key-squish 0.6s ease-in-out 1.4s both", loop: "2400ms" },
      "m53-key-digit-1": { value: "m53-key-digit 0.6s ease-in-out 0.2s both", loop: "2400ms" },
      "m53-key-digit-2": { value: "m53-key-digit 0.6s ease-in-out 0.8s both", loop: "2400ms" },
      "m53-key-digit-3": { value: "m53-key-digit 0.6s ease-in-out 1.4s both", loop: "2400ms" },

      // ---- motions/30 -----------------------------------------------------------
      "m30-reveal": { value: `m30-reveal 1s ${SNAP} 0.2s both`, loop: "2600ms" },
      "m30-reveal-logo": { value: `m30-pop 0.5s ${SNAP} 0.7s both`, loop: "2600ms" },
      "m30-reveal-btn": { value: `m30-pop 0.5s ${SNAP} 0.9s both`, loop: "2600ms" },
      "m30-cell-a": { value: `m30-cell 0.6s ${SNAP} both`, loop: "3000ms" },
      "m30-cell-b": { value: `m30-cell 0.6s ${SNAP} 0.18s both`, loop: "3000ms" },
      "m30-cell-c": { value: `m30-cell 0.6s ${SNAP} 0.36s both`, loop: "3000ms" },
      "m30-grid-header": { value: `m30-slide-down 0.7s ${SNAP} 0.9s both`, loop: "3000ms" },
      "m30-grid-button": { value: `m30-slide-up 0.7s ${SNAP} 0.9s both`, loop: "3000ms" },
      "m30-grid-text": { value: "fade-in 0.3s linear 1.2s both", loop: "3000ms" },
      "m30-expand": {
        value:
          "m30-expand-w 0.6s ease-in-out 0.2s both, " +
          "m30-expand-h 0.7s ease-in-out 0.8s both",
        loop: "3000ms",
      },
      "m30-expand-body": { value: "fade-in 0.3s linear 1.4s both", loop: "3000ms" },
      "m30-modal": { value: "m30-modal-pop 0.45s ease-in-out 0.2s both", loop: "2800ms" },
      "m30-modal-btn": { value: "m30-jelly 0.8s ease-in-out 0.5s both", loop: "2800ms" },
      "m30-line-1": {
        value: "m30-line 0.8s cubic-bezier(0.76, 0, 0.25, 0.97) 0.35s both",
        loop: "2800ms",
      },
      "m30-line-2": {
        value: "m30-line 0.8s cubic-bezier(0.76, 0, 0.25, 0.97) 0.5s both",
        loop: "2800ms",
      },
      "m30-comment-1": { value: "m30-comment 0.45s ease-in-out 0.2s both", loop: "2600ms" },
      "m30-comment-2": { value: "m30-comment 0.45s ease-in-out 0.45s both", loop: "2600ms" },
      "m30-bubble": { value: "m30-comment 0.45s ease-in-out 0.7s both", loop: "2600ms" },
      "m30-slidein-back": {
        value: `m30-slidein 0.9s ${FLING} 0.2s both, fade-in 0.6s ease-out 0.2s both`,
        loop: "3000ms",
      },
      "m30-slidein-front": {
        value: `m30-slidein 0.9s ${FLING} 0.5s both, fade-in 0.6s ease-out 0.5s both`,
        loop: "3000ms",
      },
      "m30-slidein-btn": { value: "m30-zoom-in 0.8s ease-in-out 1.1s both", loop: "3000ms" },
    },
  },
});
