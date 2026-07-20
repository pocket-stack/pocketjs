// site/assets/home.js — homepage behaviors. The hero background is the baked
// demo wall (site/bake-demo-wall.ts): every demo and satellite-app recording
// tiled into one muted loop, so there is no live emulator to boot here — the
// interactive shell lives in /playground/ now.

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

// Pause the wall when it can't be seen (scrolled away) or shouldn't move
// (prefers-reduced-motion — the CSS also hides it there).
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

setupCodeTabs();
setupDemoWall();
