// site/assets/home.js — homepage behaviors. The hero is a machine collage on
// a fixed canvas that cover-scales to the viewport, its screens cropped live
// out of the baked demo wall. The machine matrix below auto-rotates until the
// visitor takes over. Tab groups (framework tabs on the code card, target
// chips on the selector, machine chips on the matrix) are static HTML — JS
// only toggles state.

function setupTabs(tabAttr, panelAttr) {
  const tabs = [...document.querySelectorAll(`[data-${tabAttr}]`)];
  if (tabs.length === 0) return;
  const panels = [...document.querySelectorAll(`[data-${panelAttr}]`)];
  const key = tabAttr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const panelKey = panelAttr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const select = (name) => {
    for (const tab of tabs) {
      const active = tab.dataset[key] === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset[panelKey] !== name;
    }
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab.dataset[key]));
  }
}

function setupCodeCardName() {
  const nameEl = document.getElementById("lp-codecard-name");
  if (!nameEl) return;
  const names = {
    solid: "Counter.tsx",
    vue: "Counter.vue",
    octane: "Counter.tsrx",
  };
  const tabs = [...document.querySelectorAll("[data-code-tab]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const key = tab.dataset.codeTab;
      if (key && names[key]) nameEl.textContent = names[key];
    });
  }
}

// The hero collage: a fixed 1440x820 canvas cover-scaled to fill the hero, so
// narrow screens crop the collage's sides instead of stacking the devices.
// The screen videos pause off screen and under prefers-reduced-motion.
function setupHeroCollage() {
  const hero = document.querySelector(".lp-hero");
  const canvas = document.querySelector("[data-collage]");
  if (!hero || !canvas) return;
  const fit = () => {
    const s = Math.max(hero.clientWidth / 1440, hero.clientHeight / 820);
    canvas.style.transform = `translate(-50%, -50%) scale(${s})`;
  };
  addEventListener("resize", fit);
  fit();

  const videos = [...canvas.querySelectorAll("video")];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let visible = true;
  const apply = () => {
    for (const video of videos) {
      if (reduced.matches || !visible) video.pause();
      else video.play().catch(() => {});
    }
  };
  reduced.addEventListener?.("change", apply);
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) visible = e.isIntersecting;
      apply();
    },
    { threshold: 0.05 },
  );
  io.observe(hero);
  apply();
}

// Carousel spine for the machine matrix: chip tabs plus a rotation that
// advances every `period` ms. Rotation pauses while the widget is hovered,
// focused, or off screen, and stops for good on any manual pick — the
// countdown sweep on the active chip only runs while `is-auto` is set.
// `show(panel, active)` applies the widget's visibility scheme.
function setupRotator(root, tabAttr, panelAttr, period, show) {
  if (!root) return;
  const tabs = [...root.querySelectorAll(`[data-${tabAttr}]`)];
  const panels = [...root.querySelectorAll(`[data-${panelAttr}]`)];
  if (tabs.length === 0) return;
  const key = tabAttr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const panelKey = panelAttr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const rail = tabs[0].parentElement;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let index = 0;
  let timer = 0;
  let visible = false;
  let engaged = false; // hover or focus within
  let manual = false; // a real pick parks the carousel

  const select = (name) => {
    index = Math.max(0, tabs.findIndex((tab) => tab.dataset[key] === name));
    for (const tab of tabs) {
      const active = tab.dataset[key] === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
    for (const panel of panels) {
      show(panel, panel.dataset[panelKey] === name);
    }
    const active = tabs[index];
    if (rail && active && rail.scrollWidth > rail.clientWidth) {
      rail.scrollTo({ left: Math.max(0, active.offsetLeft - 24), behavior: "smooth" });
    }
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = 0;
    root.classList.remove("is-auto");
  };
  const start = () => {
    if (timer || manual || engaged || !visible || reduced.matches) return;
    // Re-arm the sweep animation even when the active chip didn't change.
    root.classList.remove("is-auto");
    void root.offsetWidth;
    root.classList.add("is-auto");
    timer = setInterval(() => {
      select(tabs[(index + 1) % tabs.length].dataset[key]);
    }, period);
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      manual = true;
      stop();
      select(tab.dataset[key]);
    });
  }
  root.addEventListener("mouseenter", () => { engaged = true; stop(); });
  root.addEventListener("mouseleave", () => { engaged = false; start(); });
  root.addEventListener("focusin", () => { engaged = true; stop(); });
  root.addEventListener("focusout", (event) => {
    if (root.contains(event.relatedTarget)) return;
    engaged = false;
    start();
  });
  reduced.addEventListener?.("change", () => (reduced.matches ? stop() : start()));
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) visible = e.isIntersecting;
      if (visible) start();
      else stop();
    },
    { threshold: 0.25 },
  );
  io.observe(root);

  // Normalize the static markup once (aria on the non-active panels).
  const initial = tabs.find((tab) => tab.classList.contains("is-active")) ?? tabs[0];
  select(initial.dataset[key]);
}

// The machine matrix: plain hidden-attribute panels, like the other tab groups.
function setupMachineMatrix() {
  const root = document.querySelector("[data-mx]");
  if (!root) return;
  const PERIOD = 6000;
  root.style.setProperty("--mx-period", `${PERIOD}ms`);
  setupRotator(root, "mx-tab", "mx-panel", PERIOD, (panel, active) => {
    panel.hidden = !active;
  });
}

setupTabs("code-tab", "code-panel");
setupCodeCardName();
setupTabs("tgt-tab", "tgt-panel");
setupHeroCollage();
setupMachineMatrix();
