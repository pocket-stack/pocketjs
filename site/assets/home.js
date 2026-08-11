// site/assets/home.js — homepage behaviors. The hero is a machine collage on
// a fixed canvas that cover-scales to the viewport, its screens cropped live
// out of the baked demo wall. Tab groups (framework tabs on the code card,
// target chips on the selector) are static HTML — JS only toggles state.

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

setupTabs("code-tab", "code-panel");
setupCodeCardName();
setupTabs("tgt-tab", "tgt-panel");
setupHeroCollage();
