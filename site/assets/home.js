// site/assets/home.js — homepage behaviors. The background remains a cheap
// baked demo wall; the machine matrix below the CTA auto-rotates through the
// machines until the visitor takes over. Tab groups (framework tabs on the
// code card, target chips on the selector, machine chips on the matrix) are
// static HTML — JS only toggles state.

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

// Pause the wall when it can't be seen (scrolled away) or shouldn't move
// (prefers-reduced-motion — the CSS also hides it there).
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

function setupDemoWall() {
  const video = document.querySelector(".lp-hero__wall-video");
  if (!video) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let visible = true;
  const apply = () => {
    if (reduced.matches || !visible) video.pause();
    else video.play().catch(() => {});
  };
  reduced.addEventListener?.("change", apply);
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) visible = e.isIntersecting;
      apply();
    },
    { threshold: 0.05 },
  );
  io.observe(video);
}

// The machine matrix: chip tabs like the other groups, plus a rotation that
// advances every MX_PERIOD ms. Rotation pauses while the matrix is hovered,
// focused, or off screen, and stops for good on any manual pick — the sweep
// on the active chip only runs while `is-auto` is set.
function setupMachineMatrix() {
  const root = document.querySelector("[data-mx]");
  if (!root) return;
  const chips = root.querySelector(".lp-mx__chips");
  const tabs = [...root.querySelectorAll("[data-mx-tab]")];
  const panels = [...root.querySelectorAll("[data-mx-panel]")];
  if (tabs.length === 0) return;

  const MX_PERIOD = 6000;
  root.style.setProperty("--mx-period", `${MX_PERIOD}ms`);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let index = 0;
  let timer = 0;
  let visible = false;
  let engaged = false; // hover or focus within
  let manual = false; // a real pick parks the carousel

  const select = (name) => {
    index = Math.max(0, tabs.findIndex((tab) => tab.dataset.mxTab === name));
    for (const tab of tabs) {
      const active = tab.dataset.mxTab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.mxPanel !== name;
    }
    const active = tabs[index];
    if (chips && active && chips.scrollWidth > chips.clientWidth) {
      chips.scrollTo({ left: Math.max(0, active.offsetLeft - 24), behavior: "smooth" });
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
      select(tabs[(index + 1) % tabs.length].dataset.mxTab);
    }, MX_PERIOD);
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      manual = true;
      stop();
      select(tab.dataset.mxTab);
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
}

setupTabs("code-tab", "code-panel");
setupCodeCardName();
setupTabs("tgt-tab", "tgt-panel");
setupDemoWall();
setupMachineMatrix();
