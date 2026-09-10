import { createCanvas, loadImage } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";

export const FOLD_RADII = [0, 2, 4, 8, 12, 20, 30, 40] as const;
export const FOLD_TEXTURE = { width: 512, height: 1024, padding: 64 } as const;

/** Disk convolution baked outside the display loop. Row prefix sums evaluate
 * a filled disk without sparse-tap rings or 8-bit additive-blend rounding.
 * Samples outside the screenshot contribute black. */
export async function bakeFoldSnapshot(png: string, output: string): Promise<void> {
  const image = await loadImage(png);
  if (image.width * 3 !== image.height * 2 || image.width < 320 || image.width > 1280) {
    throw new Error(`Pocket Fold needs a portrait 2:3 screenshot, got ${image.width}x${image.height}`);
  }
  const source = createCanvas(320, 480);
  const sourceCtx = source.getContext("2d");
  sourceCtx.drawImage(image, 0, 0, 320, 480);
  const pixels = sourceCtx.getImageData(0, 0, 320, 480).data;
  let light = 0;
  for (let i = 0; i < pixels.length; i += 4) light += pixels[i] + pixels[i + 1] + pixels[i + 2];
  if (light / (320 * 480 * 3) < 1) throw new Error("Display capture is black; unlock the iPod and leave SpringBoard visible, then capture again.");
  const { width, height, padding } = FOLD_TEXTURE;
  const stride = (width + 1) * 3;
  const prefix = new Uint32Array(height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= padding && x < padding + 320 && y >= padding && y < padding + 480;
      const source = ((y - padding) * 320 + x - padding) * 4;
      for (let channel = 0; channel < 3; channel++) {
        prefix[y * stride + (x + 1) * 3 + channel] = prefix[y * stride + x * 3 + channel] +
          (inside ? pixels[source + channel] : 0);
      }
    }
  }
  const chunks: Buffer[] = [Buffer.from("PFOLD001")];
  for (const radius of FOLD_RADII) {
    const output = Buffer.alloc(width * height * 4);
    for (let i = 3; i < output.length; i += 4) output[i] = 255;
    const rows: { dy: number; dx: number }[] = [];
    let area = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const dx = Math.floor(Math.sqrt(radius * radius - dy * dy));
      rows.push({ dy, dx }); area += dx * 2 + 1;
    }
    for (let y = padding - radius; y < padding + 480 + radius; y++) {
      for (let x = padding - radius; x < padding + 320 + radius; x++) {
        let r = 0, g = 0, b = 0;
        for (const row of rows) {
          const left = (y + row.dy) * stride + Math.max(0, x - row.dx) * 3;
          const right = (y + row.dy) * stride + Math.min(width, x + row.dx + 1) * 3;
          // Padding exceeds every blur radius; source rows outside the atlas
          // have no contribution. They remain part of the kernel's area.
          if (y + row.dy < 0 || y + row.dy >= height) continue;
          r += prefix[right] - prefix[left];
          g += prefix[right + 1] - prefix[left + 1];
          b += prefix[right + 2] - prefix[left + 2];
        }
        const index = (y * width + x) * 4;
        output[index] = Math.round(r / area);
        output[index + 1] = Math.round(g / area);
        output[index + 2] = Math.round(b / area);
      }
    }
    chunks.push(output);
  }
  writeFileSync(output, Buffer.concat(chunks));
}
