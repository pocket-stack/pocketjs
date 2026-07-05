// scripts/video-encode.ts <input> [out-basename]
//
// Produce the "most PSP-suited" video for the native <Video> component from any
// source clip, using ffmpeg. Emits TWO artifacts:
//
//   dist/video/<name>.h264   H.264 Annex-B elementary stream — the input to the
//                            PSMF muxer (step 2 below); the PSP Media Engine's
//                            AVC decoder consumes this framing.
//   host-web/<name>.mp4      web-preview encode the browser dev host plays for
//                            the <Video> web fallback (served at /<name>.mp4).
//
// Encode profile (research-grounded — see DESIGN.md "Video"): 480×272 (both
// multiples of 16 = the ME AVC max, no padding), H.264 Main + CABAC, Level 3.0,
// 30 fps, NO B-frames (one AU == one displayable frame, PTS=DTS), closed 1 s
// GOP (clean loop/seek joins), ~1.5 Mbps CBR (comfortably within PSPLink).
//
// STEP 2 (mux to host0:/<name>.pmf) is NOT done here — ffmpeg has no PSMF/game
// `.pmf` muxer (its `-f psp` makes an XMB MP4, not a game PMF). Use a PSMF muxer
// (UMDGen / MakePMF-class tooling) or the byte layout in DESIGN.md "Video". The
// resulting <name>.pmf goes in the usbhostfs_pc host dir so it resolves as
// host0:/<name>.pmf over PSPLink.
//
// Requires ffmpeg with libx264 on PATH.

import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";

const [input, outArg] = Bun.argv.slice(2);
if (!input) {
  console.error("usage: bun scripts/video-encode.ts <input.mov> [out-basename]");
  process.exit(1);
}
if (!existsSync(input)) {
  console.error(`video-encode: input not found: ${input}`);
  process.exit(1);
}
if (!Bun.which("ffmpeg")) {
  console.error("video-encode: ffmpeg not found on PATH (brew install ffmpeg)");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname; // PocketJS/
const name = (outArg ?? "clip").replace(/\.[^.]+$/, "");
const outDir = `${root}dist/video`;
mkdirSync(outDir, { recursive: true });

// scale to fit inside 480×272 preserving aspect, then pad to exactly 480×272.
const VF =
  "scale=480:272:force_original_aspect_ratio=decrease," +
  "pad=480:272:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p";
// PSP Media Engine profile: Main + CABAC, L3.0, no B-frames, closed 1 s GOP.
const X264 =
  "cabac=1:ref=1:bframes=0:keyint=30:min-keyint=30:scenecut=0:aud=1:nal-hrd=cbr";

const h264 = `${outDir}/${name}.h264`;
const mp4 = `${root}host-web/${name}.mp4`;

console.log(`video-encode: ${input} -> ${name}.h264 (+ web ${name}.mp4)`);

// 1) H.264 Annex-B elementary stream for the PSMF muxer / Media Engine.
await $`ffmpeg -y -i ${input} -vf ${VF} \
  -c:v libx264 -profile:v main -level:v 3.0 -x264-params ${X264} \
  -b:v 1500k -maxrate 1500k -bufsize 1500k -an -f h264 ${h264}`;

// 2) Web-preview mp4 for the browser dev host (<Video> web fallback).
await $`ffmpeg -y -i ${input} -vf ${VF} \
  -c:v libx264 -profile:v main -level:v 3.0 -pix_fmt yuv420p \
  -b:v 1500k -movflags +faststart -an ${mp4}`;

console.log(`  elementary stream: ${h264}`);
console.log(`  web preview:       ${mp4}  (served at /${name}.mp4)`);
console.log("");
console.log("Next: mux the .h264 to a PSMF `.pmf` (see DESIGN.md \"Video\") and place");
console.log(`it in the usbhostfs_pc host dir so it resolves as host0:/${name}.pmf.`);
