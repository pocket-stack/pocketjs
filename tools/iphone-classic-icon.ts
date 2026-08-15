import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));

/** The installed iPhone 2G artwork is the single source for legacy iPhone icons. */
export const IPHONE_CLASSIC_ICON_SOURCE = resolve(REPOSITORY, "hosts/iphone2g/Icon.png");

function integerScale(source: Canvas, scale: number): Canvas {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error("pocket iphone artwork: scale must be a positive integer");
  }
  const sourceData = source.getContext("2d").getImageData(0, 0, source.width, source.height).data;
  const output = createCanvas(source.width * scale, source.height * scale);
  const image = output.getContext("2d").createImageData(output.width, output.height);
  for (let y = 0; y < output.height; y += 1) {
    const sourceY = Math.floor(y / scale);
    for (let x = 0; x < output.width; x += 1) {
      const sourceX = Math.floor(x / scale);
      const sourceIndex = (sourceY * source.width + sourceX) * 4;
      const targetIndex = (y * output.width + x) * 4;
      image.data[targetIndex] = sourceData[sourceIndex];
      image.data[targetIndex + 1] = sourceData[sourceIndex + 1];
      image.data[targetIndex + 2] = sourceData[sourceIndex + 2];
      image.data[targetIndex + 3] = sourceData[sourceIndex + 3];
    }
  }
  output.getContext("2d").putImageData(image, 0, 0);
  return output;
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
  const image = await loadImage(readFileSync(IPHONE_CLASSIC_ICON_SOURCE));
  const source = createCanvas(image.width, image.height);
  source.getContext("2d").drawImage(image, 0, 0);

  const icon = resolve(outputDirectory, "Icon.png");
  const retinaIcon = resolve(outputDirectory, "Icon@2x.png");
  cpSync(IPHONE_CLASSIC_ICON_SOURCE, icon);
  writeFileSync(retinaIcon, integerScale(source, 2).toBuffer("image/png"));

  const launchIcon = integerScale(source, 4);
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
