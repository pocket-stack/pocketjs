import { createCanvas, loadImage } from "@napi-rs/canvas";

/** Rasterize vector artwork once, then average exact sample areas. */
export async function rasterizeIconSvg(svg: string, width: number, height = width) {
  const scale = 4;
  const sized = svg.replace(/(<svg\b[^>]*\bwidth=")[^"]+("[^>]*\bheight=")[^"]+"/, `$1${width * scale}$2${height * scale}"`);
  if (sized === svg) throw new Error("Icon SVG must declare width and height");
  const image = await loadImage(Buffer.from(sized));
  if (image.width !== width * scale || image.height !== height * scale) throw new Error("Unexpected icon raster dimensions");
  const big = createCanvas(width * scale, height * scale);
  big.getContext("2d").drawImage(image, 0, 0);
  const pixels = big.getContext("2d").getImageData(0, 0, big.width, big.height).data;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const result = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) sum += pixels[((y * scale + yy) * big.width + x * scale + xx) * 4 + c];
      result.data[(y * width + x) * 4 + c] = Math.round(sum / (scale * scale));
    }
    if (result.data[(y * width + x) * 4 + 3] !== 255) throw new Error("Icon artwork must be opaque");
  }
  ctx.putImageData(result, 0, 0);
  return canvas;
}
