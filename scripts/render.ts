#!/usr/bin/env bun
// scripts/render.ts — high-performance video rendering pipeline using PocketJS.
// Pipes raw framebuffers from WASM memory directly to an FFmpeg subprocess.

import { existsSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { cpus } from "node:os";
import { createWasmUi } from "../host-web/wasm-ops.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNTIME_DIST = join(ROOT, "dist/render-runtime/");
const WASM_PATH = join(ROOT, "host-web/pocketjs.wasm");

function ensureBuilt(path: string, cmd: string[]): void {
  if (existsSync(path)) return;
  console.log(`render: ${path.slice(ROOT.length)} missing — running: ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(path)) {
    console.error(`render: failed to produce ${path}`);
    process.exit(1);
  }
}

function buildApp(app: string, scale: number): void {
  rmSync(RUNTIME_DIST, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIST, { recursive: true });
  const output = RUNTIME_DIST + app + ".js";
  const cmd = [
    process.execPath,
    "scripts/build.ts",
    app,
    `--outdir=${RUNTIME_DIST}`,
    `--density=${scale}`
  ];
  console.log(`render: rebuilding ${app} with density=${scale}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(output)) {
    console.error(`render: failed to build app ${app}`);
    process.exit(1);
  }
}

function usage(msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    [
      "Usage:",
      "  bun scripts/render.ts -a <app> [options]",
      "",
      "Options:",
      "  -a, --app <name>       Name of the app/demo to render (required)",
      "  -o, --output <path>    Output MP4 file path (default: dist/render/<app>.mp4)",
      "  -d, --duration <secs>  Duration of video in seconds (default: 5.0)",
      "  -f, --fps <number>     Frame rate of output video (default: 60)",
      "  -s, --scale <1..10>    Integer scaling factor of logical size (default: 4)",
      "  -w, --width <pixels>   Logical width of layout viewport (default: 480)",
      "  --height <pixels>      Logical height of layout viewport (default: 272)",
      "  -c, --concurrency <n>  Number of parallel processes (default: 1)",
      "  --crf <number>         x264 quality factor (default: 18)",
      "  --preset <string>      x264 encoder preset (default: faster)",
      "  -h, --help             Show this help message",
    ].join("\n")
  );
  process.exit(1);
}

async function main() {
  const args = Bun.argv.slice(2);
  let app: string | undefined;
  let output: string | undefined;
  let duration = 5.0;
  let fps = 60;
  let scale = 4;
  let widthParam = 480;
  let heightParam = 272;
  let crf = 18;
  let preset = "faster";
  let concurrency = 1;
  let chunkStart: number | undefined;
  let chunkEnd: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-a" || a === "--app") {
      app = args[++i];
    } else if (a === "-o" || a === "--output") {
      output = args[++i];
    } else if (a === "-d" || a === "--duration") {
      duration = Number(args[++i]);
    } else if (a === "-f" || a === "--fps") {
      fps = Number(args[++i]);
    } else if (a === "-s" || a === "--scale") {
      scale = Number(args[++i]);
    } else if (a === "-w" || a === "--width") {
      widthParam = Number(args[++i]);
    } else if (a === "--height") {
      heightParam = Number(args[++i]);
    } else if (a === "-c" || a === "--concurrency") {
      concurrency = Number(args[++i]);
    } else if (a === "--crf") {
      crf = Number(args[++i]);
    } else if (a === "--preset") {
      preset = args[++i];
    } else if (a === "--chunk-start") {
      chunkStart = Number(args[++i]);
    } else if (a === "--chunk-end") {
      chunkEnd = Number(args[++i]);
    } else if (a === "-h" || a === "--help") {
      usage();
    } else {
      usage(`Unknown argument: ${a}`);
    }
  }

  if (!app) {
    usage("App name is required (-a or --app)");
  }

  if (!Number.isInteger(scale) || scale < 1 || scale > 10) {
    usage("Scale must be an integer between 1 and 10");
  }

  if (isNaN(widthParam) || widthParam <= 0 || widthParam > 32000) {
    usage("Width must be a positive integer <= 32000");
  }

  if (isNaN(heightParam) || heightParam <= 0 || heightParam > 32000) {
    usage("Height must be a positive integer <= 32000");
  }

  if (isNaN(duration) || duration <= 0) {
    usage("Duration must be a positive number");
  }

  if (!Number.isInteger(fps) || fps <= 0) {
    usage("FPS must be a positive integer");
  }

  if (isNaN(crf) || crf < 0 || crf > 51) {
    usage("CRF must be a number between 0 and 51");
  }

  const isWorker = chunkStart !== undefined && chunkEnd !== undefined;
  const baseApp = app.replace(/\\/g, "/").split("/").pop()!.replace(/\.tsx?$/, "");
  if (!output) {
    const renderDir = join(ROOT, "dist/render/");
    mkdirSync(renderDir, { recursive: true });
    output = join(renderDir, `${baseApp}.mp4`);
  }

  const totalFrames = Math.round(duration * fps);

  // 1. Parent Process orchestrates parallel chunks if concurrency > 1
  if (!isWorker && concurrency > 1 && totalFrames >= concurrency) {
    console.log(`render: orchestrating parallel render with concurrency ${concurrency} across ${totalFrames} frames...`);
    const start = performance.now();

    // Build the app bundle once in parent so workers can share it
    ensureBuilt(WASM_PATH, [process.execPath, "scripts/wasm.ts"]);
    buildApp(app, scale);

    const chunkTasks: { start: number; end: number; output: string }[] = [];
    const framesPerChunk = Math.ceil(totalFrames / concurrency);
    for (let i = 0; i < concurrency; i++) {
      const cStart = i * framesPerChunk;
      const cEnd = Math.min(totalFrames, (i + 1) * framesPerChunk);
      if (cStart >= totalFrames) break;
      chunkTasks.push({
        start: cStart,
        end: cEnd,
        output: join(dirname(output), `${baseApp}-chunk-${i}.mp4`)
      });
    }

    const workerProgress = new Array(chunkTasks.length).fill(0);

    const printProgress = () => {
      const totalRendered = workerProgress.reduce((a, b) => a + b, 0);
      const pct = (totalRendered / totalFrames) * 100;
      const barLen = 20;
      const filled = Math.round((pct / 100) * barLen);
      const empty = barLen - filled;
      process.stdout.write(
        `\rrender: [${"█".repeat(filled)}${"░".repeat(empty)}] ${pct.toFixed(1)}% (${totalRendered}/${totalFrames} frames)`
      );
    };

    async function readStdout(index: number, stream: ReadableStream<Uint8Array>) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("progress:")) {
            const frames = Number(line.slice(9).trim());
            workerProgress[index] = frames;
            printProgress();
          }
        }
      }
    }

    // Spawn workers
    const workers = chunkTasks.map((task, index) => {
      const child = Bun.spawn([
        process.execPath,
        "scripts/render.ts",
        "-a", app,
        "-o", task.output,
        "-d", String(duration),
        "-f", String(fps),
        "-s", String(scale),
        "-w", String(widthParam),
        "--height", String(heightParam),
        "--crf", String(crf),
        "--preset", preset,
        "--chunk-start", String(task.start),
        "--chunk-end", String(task.end)
      ], {
        stdout: "pipe",
        stderr: "ignore"
      });

      readStdout(index, child.stdout);
      return child;
    });

    const exitCodes = await Promise.all(workers.map(w => w.exited));
    process.stdout.write("\n");
    for (let i = 0; i < exitCodes.length; i++) {
      if (exitCodes[i] !== 0) {
        throw new Error(`Worker rendering chunk ${i} (${chunkTasks[i].start}-${chunkTasks[i].end}) failed with exit code ${exitCodes[i]}`);
      }
    }

    // Stitch chunks using FFmpeg concat demuxer
    console.log(`render: stitching ${chunkTasks.length} chunks into ${output}...`);
    const concatListPath = join(dirname(output), `${baseApp}-concat.txt`);
    const concatLines = chunkTasks.map(t => `file '${t.output.replace(/\\/g, "/")}'`).join("\n") + "\n";
    writeFileSync(concatListPath, concatLines, "utf8");

    const stitch = Bun.spawn([
      "ffmpeg",
      "-y",
      "-safe", "0",
      "-f", "concat",
      "-i", concatListPath,
      "-c", "copy",
      output
    ], {
      stdout: "ignore",
      stderr: "inherit"
    });

    const stitchCode = await stitch.exited;
    // Clean up temporary chunks and concat list
    unlinkSync(concatListPath);
    for (const t of chunkTasks) {
      if (existsSync(t.output)) {
        unlinkSync(t.output);
      }
    }

    if (stitchCode !== 0) {
      throw new Error(`FFmpeg concat stitching failed with exit code ${stitchCode}`);
    }

    const timeTaken = (performance.now() - start) / 1000;
    console.log(`render: complete! Created ${output} in ${timeTaken.toFixed(2)}s (${(totalFrames / timeTaken).toFixed(1)} FPS)`);
    return;
  }

  // 2. Build the app bundle at the correct density (skipped in worker processes since parent built it)
  if (!isWorker) {
    ensureBuilt(WASM_PATH, [process.execPath, "scripts/wasm.ts"]);
    buildApp(app, scale);
  }

  // 3. Load WASM and boot the app
  if (!isWorker) {
    console.log(`render: loading WASM and booting ${app}...`);
  }
  const wasm = await createWasmUi(await Bun.file(WASM_PATH).arrayBuffer());
  wasm.init(scale, widthParam, heightParam);

  const g = globalThis as Record<string, any>;
  g.ui = wasm.ops;
  wasm.ops.__viewport = { w: widthParam, h: heightParam };
  const pakPath = join(RUNTIME_DIST, `${baseApp}.pak`);
  g.__pak = existsSync(pakPath) ? await Bun.file(pakPath).arrayBuffer() : undefined;
  g.__pocketApp = baseApp;

  const jsPath = join(RUNTIME_DIST, `${baseApp}.js`);
  const src = await Bun.file(jsPath).text();
  (0, eval)(src);

  const frameFn = g.frame as (buttons: number) => void;
  if (typeof frameFn !== "function") {
    throw new Error("Entry bundle did not expose globalThis.frame function");
  }

  // 4. Compute dimensions and crop arguments
  const width = widthParam * scale;
  const height = heightParam * scale;
  const isDefault480 = widthParam === 480 && heightParam === 272;
  const targetW = isDefault480 ? 480 * scale : width;
  const targetH = isDefault480 ? 270 * scale : height;
  const cropY = scale;
  const cropFilter = isDefault480
    ? `crop=${targetW}:${targetH}:0:${cropY}`
    : `scale=trunc(iw/2)*2:trunc(ih/2)*2`;

  if (!isWorker) {
    console.log(`render: spawning FFmpeg to output ${output}`);
    console.log(`render: input size ${width}x${height} -> output size ${targetW}x${targetH} (cropped)`);
  }

  const ffmpeg = Bun.spawn([
    "ffmpeg",
    "-y",
    "-threads", isWorker ? "1" : "0",
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", `${width}x${height}`,
    "-r", String(fps),
    "-i", "-", // read from stdin
    "-vf", cropFilter,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", preset,
    "-crf", String(crf),
    output
  ], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore"
  });

  const startFrame = chunkStart ?? 0;
  const endFrame = chunkEnd ?? totalFrames;
  const framesToWrite = endFrame - startFrame;

  if (!isWorker) {
    console.log(`render: generating ${totalFrames} frames @ ${fps} FPS...`);
  }

  const start = performance.now();
  for (let f = 0; f < endFrame; f++) {
    frameFn(0);
    wasm.tick();
    if (f >= startFrame) {
      const frameBuffer = wasm.renderScaled(scale);
      ffmpeg.stdin.write(frameBuffer);
      if ((f - startFrame) % 4 === 0) {
        await ffmpeg.stdin.flush();
      }

      // Update progress
      if (isWorker) {
        if ((f - startFrame) % 10 === 0 || f === endFrame - 1) {
          console.log(`progress:${f - startFrame + 1}`);
        }
      } else {
        if (f % 10 === 0 || f === endFrame - 1) {
          const pct = ((f + 1) / totalFrames) * 100;
          const barLen = 20;
          const filled = Math.round((pct / 100) * barLen);
          const empty = barLen - filled;
          process.stdout.write(
            `\rrender: [${"█".repeat(filled)}${"░".repeat(empty)}] ${pct.toFixed(1)}% (${f + 1}/${totalFrames} frames)`
          );
        }
      }
    }
  }
  await ffmpeg.stdin.flush();

  ffmpeg.stdin.end();
  const exitCode = await ffmpeg.exited;
  if (exitCode !== 0) {
    throw new Error(`FFmpeg exited with code ${exitCode}`);
  }

  if (!isWorker) {
    process.stdout.write("\n");
    const timeTaken = (performance.now() - start) / 1000;
    console.log(`render: complete! Created ${output} in ${timeTaken.toFixed(2)}s (${(totalFrames / timeTaken).toFixed(1)} FPS)`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(`render error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
