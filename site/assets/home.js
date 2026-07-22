// site/assets/home.js — homepage behaviors. The background remains a cheap
// baked demo wall; the live Pocket Stage below the CTA is code-split and boots
// only when it approaches the viewport.

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

function setupPocketStage() {
  const root = document.querySelector("[data-pocket-stage]");
  if (!root) return;
  let booted = false;
  const boot = async () => {
    if (booted) return;
    booted = true;
    try {
      const { mountPocketStage } = await import("/assets/pocket-stage-web.js");
      await mountPocketStage(root);
    } catch (error) {
      root.classList.add("has-error");
      const status = root.querySelector("[data-stage-status]");
      if (status) status.textContent = "Pocket Stage could not be loaded.";
      console.error("Pocket Stage module failed", error);
    }
  };
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      io.disconnect();
      void boot();
    },
    { rootMargin: "240px 0px", threshold: 0.01 },
  );
  io.observe(root);
}

setupCodeTabs();
setupDemoWall();
setupPocketStage();
