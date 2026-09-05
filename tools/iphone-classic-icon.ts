import { rasterizeIconSvg } from "./icon-raster.ts";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));

/** Precomposed classic iOS icons carry their own transparent corner mask. */
export const IPHONE_CLASSIC_ICON_SOURCE = resolve(REPOSITORY, "hosts/iphone2g/Icon.png");
export const IPHONE_CLASSIC_RETINA_SOURCE = resolve(REPOSITORY, "hosts/iphone4s/Icon.svg");
export const IPHONE_CLASSIC_ICON_FILE = "PocketClassic-v6.png";
export const IPHONE_CLASSIC_RETINA_ICON_FILE = "PocketClassic-v6@2x.png";

async function rasterizeRetinaArtwork(width: number, height: number): Promise<Canvas> {
  return rasterizeIconSvg(readFileSync(IPHONE_CLASSIC_RETINA_SOURCE, "utf8"), width, height, false);
}

function assertOpaque(canvas: Canvas): void {
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 255) {
      throw new Error("pocket iphone artwork: launch image must be opaque");
    }
  }
}

export async function bakeClassicIPhoneArtwork(outputDirectory: string): Promise<string[]> {
  mkdirSync(outputDirectory, { recursive: true });
  const icon = resolve(outputDirectory, IPHONE_CLASSIC_ICON_FILE);
  const retinaIcon = resolve(outputDirectory, IPHONE_CLASSIC_RETINA_ICON_FILE);
  writeFileSync(icon, (await rasterizeRetinaArtwork(57, 57)).toBuffer("image/png"));
  writeFileSync(retinaIcon, (await rasterizeRetinaArtwork(114, 114)).toBuffer("image/png"));

  const launchIcon = await rasterizeRetinaArtwork(228, 228);
  const written = [icon, retinaIcon];
  for (const [name, height] of [["Default@2x.png", 960], ["Default-568h@2x.png", 1136]] as const) {
    const target = resolve(outputDirectory, name);
    const canvas = createCanvas(640, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#020617";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const x = Math.floor((canvas.width - launchIcon.width) / 2);
    const y = Math.floor((canvas.height - launchIcon.height) / 2);
    context.save();
    context.beginPath();
    context.roundRect(x, y, launchIcon.width, launchIcon.height, 44);
    context.clip();
    context.drawImage(
      launchIcon,
      x,
      y,
    );
    context.restore();
    assertOpaque(canvas);
    writeFileSync(target, canvas.toBuffer("image/png"));
    written.push(target);
  }
  return written;
}
