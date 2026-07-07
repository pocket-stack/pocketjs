// saga/pixellab/client.ts — thin typed client for the PixelLab API
// (https://api.pixellab.ai/v1). Bearer key comes from the repo-root .env
// (PIXELLAB_API_KEY). Endpoints used: generate-image-pixflux (up to 400x400),
// with retry/backoff; responses carry base64 PNGs.

const API = "https://api.pixellab.ai/v1";

let cachedKey: string | null = null;

export function apiKey(): string {
  if (cachedKey) return cachedKey;
  const envPath = new URL("../../.env", import.meta.url).pathname;
  const text = require("node:fs").readFileSync(envPath, "utf8") as string;
  const m = text.match(/^PIXELLAB_API_KEY=(.+)$/m);
  if (!m) throw new Error("PIXELLAB_API_KEY not found in repo .env");
  cachedKey = m[1].trim();
  return cachedKey;
}

export interface PixfluxOpts {
  description: string;
  width: number;
  height: number;
  negative?: string;
  noBackground?: boolean;
  outline?: "single color black outline" | "single color outline" | "selective outline" | "lineless";
  shading?: "flat shading" | "basic shading" | "medium shading" | "detailed shading" | "highly detailed shading";
  detail?: "low detail" | "medium detail" | "highly detailed";
  view?: "side" | "low top-down" | "high top-down";
  direction?: string;
  textGuidance?: number;
  seed?: number;
  /** force palette: PNG bytes whose colors constrain the output */
  colorImage?: Uint8Array;
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as Record<string, unknown>;
    lastErr = `${res.status} ${await res.text()}`;
    if (res.status === 422 || res.status === 401) break; // no point retrying
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`pixellab ${path}: ${lastErr}`);
}

export async function pixflux(opts: PixfluxOpts): Promise<Uint8Array> {
  const body: Record<string, unknown> = {
    description: opts.description,
    image_size: { width: opts.width, height: opts.height },
    no_background: opts.noBackground ?? false,
    text_guidance_scale: opts.textGuidance ?? 8,
  };
  if (opts.negative) body.negative_description = opts.negative;
  if (opts.outline) body.outline = opts.outline;
  if (opts.shading) body.shading = opts.shading;
  if (opts.detail) body.detail = opts.detail;
  if (opts.view) body.view = opts.view;
  if (opts.direction) body.direction = opts.direction;
  if (opts.seed !== undefined) body.seed = opts.seed;
  if (opts.colorImage) body.color_image = { type: "base64", base64: Buffer.from(opts.colorImage).toString("base64") };
  const res = await post("/generate-image-pixflux", body);
  const img = res.image as { base64: string } | undefined;
  if (!img?.base64) throw new Error("pixellab: no image in response");
  return new Uint8Array(Buffer.from(img.base64, "base64"));
}

export async function balance(): Promise<string> {
  const res = await fetch(API + "/balance", { headers: { Authorization: `Bearer ${apiKey()}` } });
  return await res.text();
}
