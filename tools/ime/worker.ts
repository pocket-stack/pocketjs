import { dispatchOffload } from "../offload-provider.ts";
import { validImeKeys } from "../../contracts/spec/ime.ts";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
declare const self: Worker;
let enginePort = 0, engineToken = "";
async function compose(payload: string) {
  if (!validImeKeys(JSON.parse(payload))) throw new Error("Invalid IME transcript");
  const response = await fetch(`http://127.0.0.1:${enginePort}/compose`, {
    method: "POST", headers: { authorization: engineToken }, body: payload, signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error("IME engine unavailable");
  return response.text();
}
const canvas = createCanvas(320, 48), context = canvas.getContext("2d");
function textTile(payload: string) {
  const { text, width, size, row, bold, column = 0 } = JSON.parse(payload);
  if (typeof text !== "string" || text.length > 256 || !Number.isInteger(width) || width < 4 || width > 320 || width % 4 ||
    ![16, 20, 32, 40].includes(size) || ![0, 1, 2].includes(row) || ![0, 1].includes(column) || typeof bold !== "boolean") throw new Error("Invalid text tile");
  context.clearRect(0, 0, 320, 48);
  context.font = `${bold ? "bold " : ""}${size}px "Pocket CJK"`;
  context.fillStyle = "white"; context.textBaseline = "top";
  context.fillText(text, -column * 320, 0);
  const pixels = context.getImageData(0, row * 16, width, 16).data;
  const mask = Buffer.alloc(width * 4);
  for (let i = 0; i < width * 16; i++) mask[i >> 2] |= Math.round(pixels[i * 4 + 3] / 85) << ((i & 3) * 2);
  return mask.toString("base64");
}
// One serial capability queue owns this worker's canvas. The supervisor owns
// Rime; per-connection workers hold its authenticated loopback address.
let pending = Promise.resolve();
self.onmessage = event => {
  if (event.data.init) { if (!GlobalFonts.registerFromPath(event.data.init.font, "Pocket CJK")) throw new Error("CJK font unavailable"); enginePort = event.data.init.enginePort; engineToken = event.data.init.engineToken; return; }
  pending = pending.then(async () => self.postMessage(await dispatchOffload({ "ime.compose": compose, "text.tile": textTile }, event.data)));
};
