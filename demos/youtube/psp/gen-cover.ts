// demos/youtube/psp/gen-cover.ts — bake Pocket YouTube's XMB cover art.
//
// Pocket app-family cover convention (see demos/im/psp/gen-cover.ts):
// ICON0 is the brand mark from geometry — the red play tile + wordmark on
// the app's surface palette. PIC1 is a designed still of the product idea:
// the player HUD over a letterboxed frame, USB cable glyph in the corner
// (this app's whole premise: no WiFi, one cable).
//
//   bun demos/youtube/psp/gen-cover.ts     (rewrites icon0.png + pic1.png)

import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";

const ROOT = new URL("../../../", import.meta.url).pathname;
const OUT = new URL("./", import.meta.url).pathname;

GlobalFonts.registerFromPath(ROOT + "assets/fonts/Inter-Bold.ttf", "Inter");

const BG = "#0b0f14";
const PANEL = "#141c26";
const INK = "#e8f0f2";
const DIM = "#8fa3ad";
const RED = "#ff4757";

function roundRect(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function playTile(g: SKRSContext2D, x: number, y: number, w: number, h: number): void {
  roundRect(g, x, y, w, h, h * 0.28);
  g.fillStyle = RED;
  g.fill();
  const cx = x + w / 2;
  const cy = y + h / 2;
  const s = h * 0.3;
  g.beginPath();
  g.moveTo(cx - s * 0.55, cy - s);
  g.lineTo(cx + s * 1.05, cy);
  g.lineTo(cx - s * 0.55, cy + s);
  g.closePath();
  g.fillStyle = "#ffffff";
  g.fill();
}

// ---------------------------------------------------------------------------
// ICON0 — 144×80 XMB tile
// ---------------------------------------------------------------------------
{
  const W = 144;
  const H = 80;
  const c = createCanvas(W, H);
  const g = c.getContext("2d");

  roundRect(g, 0.5, 0.5, W - 1, H - 1, 10);
  g.fillStyle = BG;
  g.fill();
  g.strokeStyle = "#232e3c";
  g.lineWidth = 1;
  g.stroke();

  playTile(g, 22, 20, 42, 28);

  g.fillStyle = INK;
  g.font = "bold 15px Inter";
  g.fillText("POCKET", 72, 33);
  g.fillStyle = RED;
  g.fillText("TUBE", 72, 49);

  g.fillStyle = DIM;
  g.font = "bold 7px Inter";
  g.fillText("USB · NO WIFI · POCKETJS", 22, 64);

  Bun.write(OUT + "icon0.png", c.toBuffer("image/png"));
  console.log("icon0.png 144x80 written");
}

// ---------------------------------------------------------------------------
// PIC1 — 480×272 XMB background: the player HUD over a letterboxed frame
// ---------------------------------------------------------------------------
{
  const W = 480;
  const H = 272;
  const c = createCanvas(W, H);
  const g = c.getContext("2d");

  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);

  // The "video": an abstract sunset gradient, letterboxed.
  const vy = 36;
  const vh = 200;
  const grad = g.createLinearGradient(0, vy, 0, vy + vh);
  grad.addColorStop(0, "#2b1a3a");
  grad.addColorStop(0.55, "#7a2f4a");
  grad.addColorStop(1, "#e0684a");
  g.fillStyle = grad;
  g.fillRect(0, vy, W, vh);
  // Sun disc + scanline shimmer.
  g.beginPath();
  g.arc(340, vy + 96, 44, 0, Math.PI * 2);
  g.fillStyle = "#ffd27a";
  g.fill();
  g.fillStyle = "rgba(11,15,20,0.22)";
  for (let y = vy; y < vy + vh; y += 4) g.fillRect(0, y, W, 1);

  // Big translucent play mark, centered.
  g.fillStyle = "rgba(11,15,20,0.45)";
  g.beginPath();
  g.arc(200, vy + 100, 40, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(186, vy + 78);
  g.lineTo(226, vy + 100);
  g.lineTo(186, vy + 122);
  g.closePath();
  g.fillStyle = INK;
  g.fill();

  // Top HUD: brand + title line.
  g.fillStyle = "rgba(11,15,20,0.78)";
  g.fillRect(0, 0, W, vy);
  playTile(g, 14, 9, 30, 19);
  g.fillStyle = INK;
  g.font = "bold 14px Inter";
  g.fillText("POCKET YOUTUBE", 54, 23);
  g.fillStyle = DIM;
  g.font = "bold 9px Inter";
  g.fillText("USB · PSPLINK", 388, 22);

  // Bottom HUD: progress + chords, the player screen's real furniture.
  const by = vy + vh;
  g.fillStyle = "rgba(11,15,20,0.82)";
  g.fillRect(0, by, W, H - by);
  roundRect(g, 16, by + 10, W - 32, 4, 2);
  g.fillStyle = PANEL;
  g.fill();
  roundRect(g, 16, by + 10, (W - 32) * 0.42, 4, 2);
  g.fillStyle = RED;
  g.fill();
  g.fillStyle = INK;
  g.font = "bold 9px Inter";
  g.fillText("5:12 / 12:34", 16, by + 28);
  g.fillStyle = DIM;
  g.fillText("○ PAUSE · ◁▷ ±10s · × BACK", 300, by + 28);

  Bun.write(OUT + "pic1.png", c.toBuffer("image/png"));
  console.log("pic1.png 480x272 written");
}
