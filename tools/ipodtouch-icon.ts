import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
export const IPODTOUCH_ICON_SOURCE = resolve(REPOSITORY, "hosts/ipodtouch/Icon.svg");

export const IPODTOUCH_ICON_OUTPUTS = {
  "Icon.png": 57,
  "Icon@2x.png": 114,
  "Icon-60@2x.png": 120,
  "Icon-60@3x.png": 180,
} as const;

const ICON_SUPERSAMPLE = 8;

async function iconImage() {
  return loadImage(readFileSync(IPODTOUCH_ICON_SOURCE));
}

function opaquePng(
  image: Awaited<ReturnType<typeof iconImage>>,
  width: number,
  height: number,
  draw: (context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>) => void,
): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#020304";
  context.fillRect(0, 0, width, height);
  draw(context);
  const corners = context.getImageData(0, 0, width, height).data;
  for (let index = 3; index < corners.length; index += 4) {
    if (corners[index] !== 255) {
      throw new Error("pocket ipodtouch: baked iOS artwork must be fully opaque");
    }
  }
  return canvas.toBuffer("image/png");
}

function drawSupersampledIcon(
  context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  image: Awaited<ReturnType<typeof iconImage>>,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const source = createCanvas(width * ICON_SUPERSAMPLE, height * ICON_SUPERSAMPLE);
  const sourceContext = source.getContext("2d");
  sourceContext.fillStyle = "#020304";
  sourceContext.fillRect(0, 0, source.width, source.height);
  sourceContext.drawImage(image, 0, 0, source.width, source.height);

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, x, y, width, height);
}

export async function bakeIPodTouchArtwork(outputDirectory: string): Promise<string[]> {
  const image = await iconImage();
  mkdirSync(outputDirectory, { recursive: true });
  const written: string[] = [];

  for (const [name, size] of Object.entries(IPODTOUCH_ICON_OUTPUTS)) {
    const target = resolve(outputDirectory, name);
    writeFileSync(target, opaquePng(image, size, size, (context) => {
      drawSupersampledIcon(context, image, 0, 0, size, size);
    }));
    written.push(target);
  }

  for (const [name, height] of [["Default@2x.png", 960], ["Default-568h@2x.png", 1136]] as const) {
    const width = 640;
    const iconSize = 224;
    const target = resolve(outputDirectory, name);
    writeFileSync(target, opaquePng(image, width, height, (context) => {
      context.fillStyle = "#020617";
      context.fillRect(0, 0, width, height);
      drawSupersampledIcon(
        context,
        image,
        (width - iconSize) / 2,
        (height - iconSize) / 2,
        iconSize,
        iconSize,
      );
    }));
    written.push(target);
  }

  return written;
}

async function main(): Promise<void> {
  const outputFlag = Bun.argv.find((arg) => arg.startsWith("--outdir="));
  const outputDirectory = resolve(outputFlag?.slice("--outdir=".length) ?? "dist/ipodtouch/artwork");
  const written = await bakeIPodTouchArtwork(outputDirectory);
  for (const path of written) console.log(`baked ${basename(path)}`);
}

if (import.meta.main) {
  await main();
}
