import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));

/** The installed iPhone 2G artwork is the single source for legacy iPhone icons. */
export const IPHONE_CLASSIC_ICON_SOURCE = resolve(REPOSITORY, "hosts/iphone2g/Icon.png");
export const IPHONE_CLASSIC_RETINA_SOURCE = resolve(REPOSITORY, "hosts/iphone4s/Icon.svg");
export const IPHONE_CLASSIC_ICON_FILE = "PocketClassic-v3.png";
export const IPHONE_CLASSIC_RETINA_ICON_FILE = "PocketClassic-v3@2x.png";

const ICON_SUPERSAMPLE = 8;

function exactAreaDownsample(source: Canvas, targetWidth: number, targetHeight: number): Canvas {
  const sourcePixels = source.getContext("2d").getImageData(0, 0, source.width, source.height).data;
  const output = createCanvas(targetWidth, targetHeight);
  const outputPixels = output.getContext("2d").createImageData(targetWidth, targetHeight);
  const samplesPerPixel = ICON_SUPERSAMPLE * ICON_SUPERSAMPLE;
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sampleY = 0; sampleY < ICON_SUPERSAMPLE; sampleY += 1) {
        for (let sampleX = 0; sampleX < ICON_SUPERSAMPLE; sampleX += 1) {
          const sourceIndex = (
            ((y * ICON_SUPERSAMPLE + sampleY) * source.width) +
            (x * ICON_SUPERSAMPLE + sampleX)
          ) * 4;
          totals[0] += sourcePixels[sourceIndex];
          totals[1] += sourcePixels[sourceIndex + 1];
          totals[2] += sourcePixels[sourceIndex + 2];
          totals[3] += sourcePixels[sourceIndex + 3];
        }
      }
      const targetIndex = (y * targetWidth + x) * 4;
      outputPixels.data[targetIndex] = Math.round(totals[0] / samplesPerPixel);
      outputPixels.data[targetIndex + 1] = Math.round(totals[1] / samplesPerPixel);
      outputPixels.data[targetIndex + 2] = Math.round(totals[2] / samplesPerPixel);
      outputPixels.data[targetIndex + 3] = Math.round(totals[3] / samplesPerPixel);
    }
  }
  output.getContext("2d").putImageData(outputPixels, 0, 0);
  return output;
}

async function rasterizeRetinaArtwork(width: number, height: number): Promise<Canvas> {
  const svg = readFileSync(IPHONE_CLASSIC_RETINA_SOURCE, "utf8");
  const rasterWidth = width * ICON_SUPERSAMPLE;
  const rasterHeight = height * ICON_SUPERSAMPLE;
  const sized = svg.replace(
    'width="590" height="600"',
    `width="${rasterWidth}" height="${rasterHeight}"`,
  );
  if (sized === svg) throw new Error("pocket iphone artwork: SVG canvas declaration changed");
  const image = await loadImage(Buffer.from(sized));
  if (image.width !== rasterWidth || image.height !== rasterHeight) {
    throw new Error(
      `pocket iphone artwork: SVG rasterized at ${image.width}x${image.height}, expected ${rasterWidth}x${rasterHeight}`,
    );
  }
  const supersampled = createCanvas(rasterWidth, rasterHeight);
  supersampled.getContext("2d").drawImage(image, 0, 0);
  return exactAreaDownsample(supersampled, width, height);
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
  cpSync(IPHONE_CLASSIC_ICON_SOURCE, icon);
  writeFileSync(retinaIcon, (await rasterizeRetinaArtwork(118, 120)).toBuffer("image/png"));

  const launchIcon = await rasterizeRetinaArtwork(236, 240);
  const written = [icon, retinaIcon];
  for (const [name, height] of [["Default@2x.png", 960], ["Default-568h@2x.png", 1136]] as const) {
    const target = resolve(outputDirectory, name);
    const canvas = createCanvas(640, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#020617";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      launchIcon,
      Math.floor((canvas.width - launchIcon.width) / 2),
      Math.floor((canvas.height - launchIcon.height) / 2),
    );
    assertOpaque(canvas);
    writeFileSync(target, canvas.toBuffer("image/png"));
    written.push(target);
  }
  return written;
}
