import { MEDIA, validMediaSource, validMediaKey, type MediaOps, type MediaSource, type MediaStatus, type LocalMediaSource, type MediaCaption, type MediaLibraryOps, type MediaLibraryEntry, type MediaDownloadStatus } from "../../contracts/spec/media.ts";
export { MEDIA };
export type { MediaSource, MediaStatus, MediaPhase, LocalMediaSource, MediaCaption, MediaLibraryEntry, MediaDownloadStatus } from "../../contracts/spec/media.ts";

/** One native playback plane per realm. Surface placement is an ordinary
 * Image binding, independent of the number of displays and input devices. */
export function mediaPlayer(ops = (globalThis as unknown as { media?: MediaOps }).media) {
  if (!ops) throw new Error("Host does not implement media.playback");
  return {
    open(source: MediaSource | LocalMediaSource): boolean {
      if ("file" in source) {
        const position = source.positionMs ?? 0;
        if (!validMediaKey(source.file) || !Number.isFinite(position) || position < 0 || position > 86400000) throw new Error("Invalid local media source");
        return ops.openLocal?.(source.file, Math.round(position)) ?? false;
      }
      if (!validMediaSource(source)) throw new Error("Invalid companion media source");
      return ops.open(source.host, source.port, source.token);
    },
    close: () => ops.close(),
    pause: (value: boolean) => ops.paused(value),
    volume: (value: number) => ops.volume(Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0),
    texture: () => ops.texture(),
    status: (): MediaStatus => JSON.parse(ops.status()),
    caption: (): MediaCaption | Record<string, never> | null => { const value = ops.caption?.(); return value ? JSON.parse(value) : null; },
  };
}

/** SD library operations are bounded handoffs to a storage worker. Keys name
 * entries in the host's app-specific media directory, never arbitrary paths. */
export function mediaLibrary(ops = (globalThis as unknown as { media?: MediaLibraryOps }).media) {
  if (!ops) throw new Error("Host does not implement a media library");
  return {
    download(source: MediaSource, key: string) {
      if (!validMediaSource(source) || !validMediaKey(key)) throw new Error("Invalid media download");
      return ops.download(source.host, source.port, source.token, key);
    },
    cancel: () => ops.cancelDownload(),
    status: (): MediaDownloadStatus => JSON.parse(ops.downloadStatus()),
    refresh: () => ops.refreshLibrary(),
    entries: (): MediaLibraryEntry[] | null => { const value = ops.library(); return value ? JSON.parse(value) : null; },
    remove(key: string) { if (!validMediaKey(key)) throw new Error("Invalid media key"); return ops.removeDownload(key); },
  };
}

/** Local seek preview shared by touch surfaces, cursors and directional input.
 * A drag issues one remote seek on release. Cancellation issues none. */
export function createMediaScrubber(seek: (seconds: number) => void) {
  let active = false, preview = 0;
  const position = (fraction: number, duration: number) =>
    Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * Math.max(0, duration);
  return {
    active: () => active,
    preview: () => preview,
    begin(fraction: number, duration: number) { active = true; preview = position(fraction, duration); },
    move(fraction: number, duration: number) { if (active) preview = position(fraction, duration); },
    commit() { if (!active) return; active = false; seek(preview); },
    cancel() { active = false; },
  };
}
