import type { createOffloadClient } from "./offload.ts";
import type { ResourceLoad } from "./resource-cache.ts";
import type { ResourceCollectionOptions, createResourceRuntime } from "./resource-view.ts";
import type { TextureResource, MeshResource } from "./resource.ts";
import { getOps } from "./host.ts";

/** An opt-in adapter for reproducible read capabilities. Already-serialized
 * payloads retain offload's wire bound. Mutating methods must use offload directly. */
export function offloadResource<I>(
  client: Pick<ReturnType<typeof createOffloadClient>, "request" | "cancel"> & { connected?(): boolean },
  method: string,
  payload: (input: I) => string,
): ResourceLoad<I, string> {
  return (input, complete) => {
    if (client.connected?.() === false) return false;
    const id = client.request(method, payload(input), (result) => complete(result));
    return id ? { cancel: () => client.cancel(id) } : false;
  };
}

/** Remote images share the same demand, retry, fallback and eviction lifecycle
 * as data. Native staging is released on every path; decoded textures are
 * owned by the collection. Configure one image materialization per frame. */
export function createOffloadImageCollection<I>(
  runtime: ReturnType<typeof createResourceRuntime>,
  client: Pick<ReturnType<typeof createOffloadClient>, "requestImage" | "cancel" | "uploadImage" | "releaseImage"> & { connected?(): boolean },
  options: Omit<
    ResourceCollectionOptions<I, string, TextureResource>,
    "load" | "materialize" | "dispose" | "releaseResponse" | "maxResponseBytes" | "cost" | "maxCost"
  > & {
    method: string;
    payload(input: I): string;
    /** Maximum rendition envelope. Reserves staging and old + new GPU values. */
    width: number;
    height: number;
  },
) {
  for (const n of [options.width, options.height])
    if (!Number.isInteger(n) || n < 16 || n > 256 || n & (n - 1))
      throw new Error("Invalid image collection dimensions");
  // Native staging (2), old + new core/GPU copies (2 * (2 + 4)),
  // and the 3DS renderer's temporary tiled upload buffer (4), plus ticket data.
  const cost = options.width * options.height * 18 + 512;
  return runtime.createCollection<I, string, TextureResource>({
    ...options,
    maxResponseBytes: 512,
    cost: () => cost,
    maxCost: options.maxEntries * cost,
    load: (input, complete) => {
      if (client.connected?.() === false) return false;
      const id = client.requestImage(options.method, options.payload(input), complete);
      return id ? { cancel: () => client.cancel(id) } : false;
    },
    materialize(raw) {
      const ticket = JSON.parse(raw);
      if (ticket.width > options.width || ticket.height > options.height)
        throw new Error("Image exceeds collection envelope");
      return client.uploadImage(raw);
    },
    releaseResponse: (raw) => client.releaseImage(raw),
    dispose: (value) => getOps().freeTexture?.(value.handle),
  });
}

/** Prepared geometry has the image lifecycle, but never consumes texture slots.
 * One completion per frame covers the bounded native validation/copy. */
export function createOffloadMeshCollection<I>(
  runtime: ReturnType<typeof createResourceRuntime>,
  client: Pick<ReturnType<typeof createOffloadClient>, "requestMesh" | "cancel" | "uploadMesh" | "releaseMesh"> & { connected?(): boolean },
  options: Omit<
    ResourceCollectionOptions<I, string, MeshResource>,
    "load" | "materialize" | "dispose" | "releaseResponse" | "maxResponseBytes" | "cost" | "maxCost"
  > & {
    method: string;
    payload(input: I): string;
  },
) {
  // Staging plus old/new native records and 3DS retained VBOs. Replaced VBOs
  // remain alive until the previous GPU frame retires.
  const cost = 131088 + 2 * (4096 * 4 + 2048 * 12 + 2048 * 3 * 32 + 512);
  return runtime.createCollection<I, string, MeshResource>({
    ...options,
    maxResponseBytes: 512,
    cost: () => cost,
    maxCost: options.maxEntries * cost,
    load: (input, complete) => {
      if (client.connected?.() === false) return false;
      const id = client.requestMesh(options.method, options.payload(input), complete);
      return id ? { cancel: () => client.cancel(id) } : false;
    },
    materialize: (raw) => client.uploadMesh(raw),
    releaseResponse: (raw) => client.releaseMesh(raw),
    dispose: (value) => getOps().freeMesh?.(value.handle),
  });
}
