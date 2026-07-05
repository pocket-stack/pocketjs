// site/assets/home.js — boots the homepage hero's LIVE demo: a prebuilt
// PocketJS bundle (the multi-screen launcher) rendered by the Rust core in
// WebAssembly. Bundled by site/build.ts (pulls in ../playground/host.js).
import { PocketHost } from "../playground/host.js";

const PG = "/pg/";
// The hero runs the animated gallery — L/R (or Q/E) pages between shader covers.
const SHOWCASE = "gallery-main";

function setupCodeTabs() {
  const tabs = [...document.querySelectorAll("[data-code-tab]")];
  if (tabs.length === 0) return;
  const panels = [...document.querySelectorAll("[data-code-panel]")];
  const select = (name) => {
    for (const tab of tabs) {
      const active = tab.dataset.codeTab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.codePanel !== name;
    }
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab.dataset.codeTab));
  }
}

async function boot() {
  setupCodeTabs();

  const canvas = document.getElementById("hero-canvas");
  if (!canvas) return;
  const loadEl = document.getElementById("hero-loading");

  // FPS + memory are drawn on the canvas by the host (see host-web/hud.js).
  const host = new PocketHost();
  await host.mount(canvas, {
    wasmUrl: PG + "pocketjs.wasm",
    onError: () => {},
  });

  const [js, pak] = await Promise.all([
    fetch(PG + "demo-bundles/" + SHOWCASE + ".js").then((r) => r.text()),
    fetch(PG + "demo-bundles/" + SHOWCASE + ".pak").then((r) => r.arrayBuffer()),
  ]);
  loadEl?.remove();
  host.runIIFE(js, pak);

  // Wire the device's on-screen buttons to the live WebAssembly canvas.
  for (const el of document.querySelectorAll(".screen-emu [data-btn]")) {
    const bit = parseInt(el.dataset.btn, 16);
    const set = (down) => (e) => {
      e.preventDefault();
      el.classList.toggle("is-down", down);
      host.press(bit, down);
    };
    el.addEventListener("mousedown", set(true));
    el.addEventListener("mouseup", set(false));
    el.addEventListener("mouseleave", set(false));
    el.addEventListener("touchstart", set(true), { passive: false });
    el.addEventListener("touchend", set(false));
    el.addEventListener("touchcancel", set(false));
  }
  canvas.addEventListener("click", () => canvas.focus());

  // Pause when scrolled out of view (save battery/CPU on a long landing page).
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) host._start();
        else host.stop();
      }
    },
    { threshold: 0.1 },
  );
  io.observe(canvas);
}

boot().catch((e) => {
  const loadEl = document.getElementById("hero-loading");
  if (loadEl) loadEl.textContent = "demo failed to load";
  console.error(e);
});
