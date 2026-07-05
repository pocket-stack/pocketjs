const root = document.querySelector("[data-aot-demo]");
const canvas = document.getElementById("aot-demo-canvas");

if (root instanceof HTMLElement && canvas instanceof HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  const label = root.querySelector("[data-aot-label]");
  const status = root.querySelector("[data-aot-status]");
  const buttons = [...root.querySelectorAll("[data-aot-input]")];
  const scenes = [
    { key: "town", label: "town map", src: "/aot/assets/town.png" },
    { key: "dialogue", label: "dialogue", src: "/aot/assets/dialogue.png" },
    { key: "choice", label: "choice menu", src: "/aot/assets/choice.png" },
    { key: "route", label: "route warp", src: "/aot/assets/route.png" },
  ];
  const images = await Promise.all(scenes.map(loadImage));
  let index = 0;

  const setStatus = (text, ready = true) => {
    if (!(status instanceof HTMLElement)) return;
    status.textContent = text;
    status.dataset.ready = ready ? "true" : "false";
  };

  const draw = () => {
    if (!ctx) return;
    const scene = scenes[index];
    const image = images[index];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, 0.16)";
    for (let y = 1; y < canvas.height; y += 3) {
      ctx.fillRect(0, y, canvas.width, 1);
    }
    ctx.fillStyle = "rgba(7, 12, 8, 0.72)";
    ctx.fillRect(6, 6, 72, 13);
    ctx.fillStyle = "#cfff9c";
    ctx.font = "7px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.fillText(scene.label.toUpperCase(), 10, 15);
    if (label instanceof HTMLElement) label.textContent = scene.label;
    setStatus(scene.key);
  };

  const activate = (input) => {
    const button = buttons.find((node) => node instanceof HTMLElement && node.dataset.aotInput === input);
    if (!(button instanceof HTMLElement)) return;
    button.classList.add("is-active");
    window.setTimeout(() => button.classList.remove("is-active"), 140);
  };

  const go = (next, input) => {
    index = (next + scenes.length) % scenes.length;
    activate(input);
    draw();
  };

  const inputs = {
    a: () => go(index + 1, "a"),
    b: () => go(index - 1, "b"),
    up: () => go(index - 1, "up"),
    down: () => go(index + 1, "down"),
    left: () => go(0, "left"),
    right: () => go(3, "right"),
  };

  for (const button of buttons) {
    if (!(button instanceof HTMLElement)) continue;
    button.addEventListener("click", () => inputs[button.dataset.aotInput]?.());
  }

  window.addEventListener("keydown", (event) => {
    const input = keyToInput(event.key);
    if (!input) return;
    event.preventDefault();
    inputs[input]?.();
  });

  draw();
} else if (root instanceof HTMLElement) {
  const status = root.querySelector("[data-aot-status]");
  if (status instanceof HTMLElement) status.textContent = "canvas unavailable";
}

function keyToInput(key) {
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "Enter" || key.toLowerCase() === "a") return "a";
  if (key === "Escape" || key.toLowerCase() === "b") return "b";
  return null;
}

function loadImage(scene) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`AOT demo asset failed: ${scene.src}`));
    image.src = scene.src;
  });
}
