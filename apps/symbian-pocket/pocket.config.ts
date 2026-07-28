import { definePocketConfig } from "@pocketjs/framework/config";

export default definePocketConfig({
  framework: "solid",
  theme: {
    keyframes: {
      "s60-screen-in": {
        from: { transform: "translateX(12px)", opacity: 0 },
        to: { transform: "translateX(0px)", opacity: 1 },
      },
      "s60-menu-in": {
        from: { transform: "translateY(8px) scale(0.96)", opacity: 0 },
        to: { transform: "translateY(0px) scale(1)", opacity: 1 },
      },
      "s60-cursor": {
        from: { transform: "scale(0.96)", opacity: 0.72 },
        to: { transform: "scale(1)", opacity: 1 },
      },
      "s60-scan": {
        from: { transform: "translateX(-150px)" },
        to: { transform: "translateX(150px)" },
      },
    },
    animation: {
      "s60-screen-in": { value: "s60-screen-in 0.2s ease-out both" },
      "s60-menu-in": { value: "s60-menu-in 0.18s ease-out both" },
      // Replays when selection changes without forcing a permanent full-screen
      // redraw loop on the ESP32 RGB565 renderer.
      "s60-cursor": { value: "s60-cursor 0.18s ease-out both" },
      "s60-scan": { value: "s60-scan 1.4s linear infinite both" },
    },
  },
});
