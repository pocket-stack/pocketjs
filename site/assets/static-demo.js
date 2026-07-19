// Pocket Static product-page demo: a slideshow of E2E captures from the
// BOARDROOM playthrough — one game, three consoles.
const root = document.querySelector("[data-static-demo]");
const canvas = document.getElementById("static-demo-canvas");

function loadImage(scene) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`missing ${scene.src}`));
    img.src = scene.src;
  });
}

if (root instanceof HTMLElement && canvas instanceof HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  const label = root.querySelector("[data-static-label]");
  const status = root.querySelector("[data-static-status]");
  const buttons = [...root.querySelectorAll("[data-static-input]")];
  const scenes = [
    { key: "boardroom", label: "the boardroom (GBA)", src: "/static/assets/boardroom.png" },
    { key: "vegas", label: "the call (GBA)", src: "/static/assets/vegas.png" },
    { key: "gameboy", label: "same cartridge (Game Boy)", src: "/static/assets/gameboy.png" },
    { key: "nes", label: "same cartridge (NES)", src: "/static/assets/nes.png" },
  ];

  const setStatus = (text, ready = true) => {
    if (!(status instanceof HTMLElement)) return;
    status.textContent = text;
    status.dataset.ready = ready ? "true" : "false";
  };

  try {
    const images = await Promise.all(scenes.map(loadImage));
    let index = 0;

    const draw = () => {
      if (!ctx) return;
      const scene = scenes[index];
      const image = images[index];
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#05070d";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
      const w = Math.floor(image.width * scale);
      const h = Math.floor(image.height * scale);
      ctx.drawImage(image, (canvas.width - w) >> 1, (canvas.height - h) >> 1, w, h);
      if (label instanceof HTMLElement) label.textContent = scene.label;
    };

    const step = (delta) => {
      index = (index + delta + scenes.length) % scenes.length;
      draw();
    };

    for (const button of buttons) {
      const dir = button.dataset.staticInput;
      button.addEventListener("click", () => step(dir === "up" || dir === "left" ? -1 : 1));
    }
    draw();
    setStatus("cartridge ready");
  } catch (error) {
    setStatus("captures unavailable", false);
  }
}
