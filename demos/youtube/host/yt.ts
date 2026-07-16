// demos/youtube/host/yt.ts — the yt-dlp adapter (search + stream resolve).
//
// The Mac owns every network protocol the PSP cannot speak: TLS, YouTube's
// player API, adaptive formats. This module keeps that boundary to two
// calls: search() (flat ytsearch, one JSON line per hit) and resolve() (one
// direct progressive-mp4 URL ffmpeg can pull twice — video and audio ride
// separate -re pipelines).
//
// The runner is injectable so tests exercise the parsing without a network
// (memory: never .sh — Bun.spawn only).

export interface SearchItem {
  videoId: string;
  title: string;
  channel: string;
  durationS: number;
  views: number;
}

export interface ResolvedStream {
  videoId: string;
  title: string;
  channel: string;
  durationS: number;
  /** Direct progressive URL (video+audio muxed) for ffmpeg. */
  url: string;
  thumbnail: string;
}

export type Runner = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export const spawnRunner: Runner = async (args) => {
  const proc = Bun.spawn(["yt-dlp", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, stdout, stderr };
};

/** Best-effort field pluck from one yt-dlp JSON line. */
function toItem(j: Record<string, unknown>): SearchItem | null {
  const videoId = typeof j.id === "string" ? j.id : "";
  const title = typeof j.title === "string" ? j.title : "";
  if (!videoId || !title) return null;
  return {
    videoId,
    title,
    channel:
      (typeof j.channel === "string" && j.channel) ||
      (typeof j.uploader === "string" && j.uploader) ||
      "",
    durationS: typeof j.duration === "number" ? Math.round(j.duration) : 0,
    views: typeof j.view_count === "number" ? j.view_count : 0,
  };
}

export async function search(q: string, n = 12, run: Runner = spawnRunner): Promise<SearchItem[]> {
  const res = await run([
    "--dump-json",
    "--flat-playlist",
    "--no-warnings",
    `ytsearch${n}:${q}`,
  ]);
  if (!res.ok) throw new Error(`yt-dlp search failed: ${res.stderr.trim().slice(0, 300)}`);
  const items: SearchItem[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = toItem(JSON.parse(line) as Record<string, unknown>);
      if (item) items.push(item);
    } catch {
      // yt-dlp sometimes interleaves notices; skip non-JSON lines.
    }
  }
  return items;
}

/** Resolve one video to a progressive URL the ffmpeg pipelines can pull.
 *  Format 18 (360p mp4, muxed) is the classic progressive itag; the
 *  fallbacks keep odd uploads working at PSP-appropriate sizes. */
export async function resolve(videoId: string, run: Runner = spawnRunner): Promise<ResolvedStream> {
  const res = await run([
    "--dump-json",
    "--no-playlist",
    "--no-warnings",
    "-f",
    "18/best[height<=480][vcodec^=avc][acodec!=none]/best[height<=480]",
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  if (!res.ok) throw new Error(`yt-dlp resolve failed: ${res.stderr.trim().slice(0, 300)}`);
  const j = JSON.parse(res.stdout) as Record<string, unknown>;
  const url = typeof j.url === "string" ? j.url : "";
  if (!url) throw new Error("yt-dlp resolve: no direct url in output");
  return {
    videoId,
    title: typeof j.title === "string" ? j.title : videoId,
    channel:
      (typeof j.channel === "string" && j.channel) ||
      (typeof j.uploader === "string" && j.uploader) ||
      "",
    durationS: typeof j.duration === "number" ? Math.round(j.duration) : 0,
    url,
    thumbnail: typeof j.thumbnail === "string" ? j.thumbnail : "",
  };
}

/** mqdefault is 320x180 — plenty for a 116x64 card slot, tiny to fetch. */
export const thumbnailUrl = (videoId: string): string =>
  `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
