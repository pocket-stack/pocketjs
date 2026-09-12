// Nintendo 3DS additions to the generic Pocket Runtime client: PICA200
// surface decoding and the top/bottom PNG composition its screenshots need.
// Everything protocol-level is re-exported from pocket-runtime-client.ts.
import type { PocketRuntimeScreenshotBegin } from "../contracts/spec/pocket-runtime-wire.ts";
import type { PocketRuntimeScreenshot } from "./pocket-runtime-client.ts";
import { encodePNG } from "./png.ts";

export * from "./pocket-runtime-client.ts";

/** PICA target RGB8 is B,G,R in rotated column-major screen order. */
export function decodePocketRuntimeSurface(
  bytes: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  if (bytes.length !== width * height * 3) {
    throw new Error("Pocket Runtime surface has the wrong RGB8 byte count");
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (x * height + (height - 1 - y)) * 3;
      const destination = (y * width + x) * 4;
      rgba[destination] = bytes[source + 2];
      rgba[destination + 1] = bytes[source + 1];
      rgba[destination + 2] = bytes[source];
      rgba[destination + 3] = 255;
    }
  }
  return rgba;
}

/** Top screen over bottom screen, each centered, as one PNG. */
export function combinePocketRuntimeScreens(
  metadata: PocketRuntimeScreenshotBegin,
  top: Uint8Array,
  auxiliary: Uint8Array,
): Buffer {
  const width = Math.max(metadata.topWidth, metadata.auxiliaryWidth);
  const height = metadata.topHeight + metadata.auxiliaryHeight;
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
  const copy = (surface: Uint8Array, sourceWidth: number, sourceHeight: number, x: number, y: number) => {
    for (let row = 0; row < sourceHeight; row++) {
      const sourceAt = row * sourceWidth * 4;
      const destinationAt = ((y + row) * width + x) * 4;
      rgba.set(surface.subarray(sourceAt, sourceAt + sourceWidth * 4), destinationAt);
    }
  };
  copy(
    decodePocketRuntimeSurface(top, metadata.topWidth, metadata.topHeight),
    metadata.topWidth,
    metadata.topHeight,
    Math.floor((width - metadata.topWidth) / 2),
    0,
  );
  copy(
    decodePocketRuntimeSurface(
      auxiliary,
      metadata.auxiliaryWidth,
      metadata.auxiliaryHeight,
    ),
    metadata.auxiliaryWidth,
    metadata.auxiliaryHeight,
    Math.floor((width - metadata.auxiliaryWidth) / 2),
    metadata.topHeight,
  );
  return encodePNG(Buffer.from(rgba), width, height);
}

/** The PNG of one streamed 3DS screenshot. */
export function render3dsScreenshotPng(screenshot: PocketRuntimeScreenshot): Buffer {
  return combinePocketRuntimeScreens(screenshot.metadata, screenshot.top, screenshot.auxiliary);
}
