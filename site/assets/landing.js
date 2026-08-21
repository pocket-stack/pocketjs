// Homepage glue: the framework code tabs. Everything else is CSS.
for (const group of document.querySelectorAll("[data-subtabs]")) {
  const tabs = group.querySelectorAll(".subtab");
  tabs.forEach(t => t.addEventListener("click", () => {
    tabs.forEach(x => x.classList.remove("on"));
    group.querySelectorAll("pre").forEach(p => p.classList.remove("on"));
    t.classList.add("on");
    group.querySelector("#" + t.dataset.sub).classList.add("on");
  }));
}
