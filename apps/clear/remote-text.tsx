import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { getOps } from "@pocketjs/framework/host";
import { offload, uploadCoverage } from "@pocketjs/framework/offload";
import { shallowRef, onScopeDispose } from "vue";

export const hasCompanion = () => !!(globalThis as { offload?: unknown }).offload;

/** A fixed tile grid per label. Baked ASCII stays local; the companion rasterizes
 * Unicode into bounded coverage records. Old textures live until replacement. */
export function remoteText(text: () => string, width: number, size: 16 | 20, color: () => string = () => "#ffffff", bold = false) {
  const remote = shallowRef(false), ready = shallowRef(false);
  const rows = Math.ceil(size * 2 / 16);
  const tiles = Array.from({ length: hasCompanion() ? Math.ceil(width / 160) * rows : 0 }, (_, i) => {
    const column = Math.floor(i / rows), row = i % rows;
    const w = Math.ceil(Math.min(160, width - column * 160) * 2 / 4) * 4;
    return { column, row, width: w, envelope: 2 ** Math.ceil(Math.log2(w)) };
  });
  const nodes: (NodeMirror | null)[] = tiles.map(() => null);
  let value = "", version = 0, request = 0, row = 0, retry = 0;
  let textures: number[] = [], next: number[] = [];
  let pending: { mask: string; version: number; row: number } | undefined;
  const io = hasCompanion() ? offload() : undefined;
  const free = (handles: number[]) => handles.forEach(h => getOps().freeTexture?.(h));
  onFrame(() => {
    const wanted = text();
    const needs = !!io && /[^\x20-\x7e]/.test(wanted);
    remote.value = needs;
    if (wanted !== value) {
      value = wanted; version++; ready.value = false; row = 0; retry = 0; pending = undefined;
      free(next); next = [];
      if (!needs) { free(textures); textures = []; }
    }
    if (!needs || ready.value || !io) return;
    if (pending) {
      const handle = uploadCoverage(pending.mask, tiles[row].width, 16, 0xffffffff);
      if (handle && handle > 0) {
        next.push(handle); row++; pending = undefined;
        if (row === tiles.length) {
          for (let i = 0; i < tiles.length; i++) if (nodes[i]) getOps().setImage(nodes[i]!.id, next[i]);
          free(textures); textures = next; next = []; ready.value = true;
        }
      }
      return;
    }
    if (retry) { retry--; return; }
    if (request || !io.connected()) return;
    const revision = version, part = row;
    request = io.request("text.tile", JSON.stringify({ text: value.slice(0, 256), width: tiles[row].width, size: size * 2, row: tiles[row].row, column: tiles[row].column, bold }), result => {
      request = 0;
      if (version !== revision) return;
      if (result.ok && result.value.length === Math.ceil(tiles[part].width * 4 / 3) * 4) pending = { mask: result.value, version: revision, row: part };
      else retry = 60;
    });
  });
  onScopeDispose(() => { if (request) io?.cancel(request); free(textures); free(next); });
  return (
    <View class="relative overflow-hidden" style={{ width, height: size + 4 }}>
      <Text class={bold ? "text-xl font-bold" : "text-base"} style={{ textColor: color(), opacity: remote.value ? 0 : 1 }}>{text()}</Text>
      <Text class="absolute left-0 top-0 text-base text-white" style={{ opacity: remote.value && !ready.value ? 1 : 0 }}>...</Text>
      {tiles.map((tile, i) => <Image nodeRef={n => { nodes[i] = n ?? null; }} class="absolute"
        style={{ insetL: tile.column * 160, insetT: tile.row * 8, width: tile.envelope / 2, height: 8, opacity: remote.value && ready.value ? (color() === "#666666" ? 0.4 : 1) : 0 }} />)}
    </View>
  );
}
