// PPSSPP benchmark runner for the current PocketJS PSP renderer.
//
// Builds one bench EBOOT per selected app, then runs PPSSPPHeadless and reads
// PSP-side timing/memory metrics from ms0:/PocketJS-bench.jsonl.
//
// Examples:
//   PSP_SDK=/path/to/mipsel-sony-psp bun tools/bench-ppsspp.ts --apps=stats --samples=5
//   PSP_SDK=/path/to/mipsel-sony-psp bun tools/bench-ppsspp.ts --apps=all --samples=3 --memory-scan

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

interface Spec {
  app: string;
  inputScript: string;
  capStart: number;
  capN: number;
}

interface BenchLine {
  app: string;
  frames: number;
  window_start: number;
  window_n: number;
  eval_us: number;
  boot_to_eval_begin_us: number;
  boot_to_frame0_us: number;
  avg_js_us: number;
  avg_jobs_us: number;
  avg_tick_us: number;
  avg_draw_us: number;
  avg_render_us: number;
  avg_work_us: number;
  max_work_us: number;
  bundle_bytes: number;
  pak_bytes: number;
  arena_capacity_bytes: number;
  arena_bump_bytes: number;
  arena_tail_free_bytes: number;
  arena_init_free_bytes: number;
  arena_configured_bytes: number;
}

interface Sample extends BenchLine {
  sample: number;
  host_wall_ms: number;
  arena_limit_bytes: number | null;
}

interface MemoryAttempt {
  arena_bytes: number;
  pass: boolean;
  avg_work_us?: number;
  arena_bump_bytes?: number;
  host_wall_ms?: number;
  error?: string;
}

interface MemoryScanApp {
  uncapped_arena_bump_bytes: number;
  min_pass_arena_bytes: number;
  safety_margin_bytes: number;
  safe_arena_bytes: number;
  safe_sample: Sample;
  attempts: MemoryAttempt[];
}

const KiB = 1024;
const MiB = 1024 * KiB;
const FRAME_BUDGET_US = 16_667;

const SPECS: Spec[] = [
  { app: "hero", inputScript: "0:0,58:0x40,62:0,76:0x2000,80:0", capStart: 48, capN: 48 },
  { app: "cards", inputScript: "0:0,20:0x20,24:0,28:0x20,32:0,44:0x2000,48:0", capStart: 16, capN: 80 },
  { app: "stats", inputScript: "0:0,84:0x20,88:0", capStart: 28, capN: 100 },
  { app: "library", inputScript: "0:0,8:0x20,12:0,16:0x20,20:0,32:0x2000,36:0", capStart: 4, capN: 120 },
  {
    app: "settings",
    inputScript:
      "0:0,4:0x40,8:0,10:0x2000,14:0,16:0x40,20:0,22:0x2000,26:0,28:0x40,32:0,34:0x2000,38:0,40:0x40,42:0,44:0x40,46:0,48:0x40,52:0,54:0x2000,58:0",
    capStart: 0,
    capN: 100,
  },
  { app: "notifications", inputScript: "0:0,10:0x40,14:0,16:0x40,20:0,24:0x2000,28:0", capStart: 0, capN: 65 },
  {
    app: "music",
    inputScript: "0:0,4:0x40,8:0,10:0x2000,14:0,30:0x40,34:0,36:0x40,40:0,42:0x2000,46:0,70:0x0200,74:0",
    capStart: 0,
    capN: 95,
  },
];

const pspUiDir = new URL("..", import.meta.url).pathname;
const argv = Bun.argv.slice(2);
let samples = 5;
let apps = ["stats"];
let timeout = Number(process.env.BENCH_PPSSPP_TIMEOUT || 60);
let outDir = `${pspUiDir}dist/bench`;
let dumpFrames = false;
let memoryScan = false;
let memoryStepBytes = 256 * KiB;
let memorySafetyBytes = 512 * KiB;
let memorySafetyPercent = 20;
let memoryMaxBytes = 32 * MiB;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
  if (a.startsWith("--samples=") || a === "--samples") {
    samples = Number(value);
    if (a === "--samples") i++;
  } else if (a.startsWith("--apps=") || a === "--apps") {
    apps = value.split(",").filter(Boolean);
    if (a === "--apps") i++;
  } else if (a.startsWith("--timeout=") || a === "--timeout") {
    timeout = Number(value);
    if (a === "--timeout") i++;
  } else if (a.startsWith("--out-dir=") || a === "--out-dir") {
    outDir = value;
    if (a === "--out-dir") i++;
  } else if (a === "--dump-frames") {
    dumpFrames = true;
  } else if (a === "--memory-scan") {
    memoryScan = true;
  } else if (a.startsWith("--memory-step-kib=") || a === "--memory-step-kib") {
    memoryStepBytes = Number(value) * KiB;
    if (a === "--memory-step-kib") i++;
  } else if (a.startsWith("--memory-safety-kib=") || a === "--memory-safety-kib") {
    memorySafetyBytes = Number(value) * KiB;
    if (a === "--memory-safety-kib") i++;
  } else if (a.startsWith("--memory-safety-percent=") || a === "--memory-safety-percent") {
    memorySafetyPercent = Number(value);
    if (a === "--memory-safety-percent") i++;
  } else if (a.startsWith("--memory-max-kib=") || a === "--memory-max-kib") {
    memoryMaxBytes = Number(value) * KiB;
    if (a === "--memory-max-kib") i++;
  } else if (a === "--list-apps") {
    console.log(SPECS.map((s) => s.app).join("\n"));
    process.exit(0);
  } else {
    throw new Error(`unknown argument ${a}`);
  }
}

if (!Number.isFinite(samples) || samples < 1) throw new Error("--samples must be >= 1");
if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be > 0");
if (!Number.isFinite(memoryStepBytes) || memoryStepBytes < 16 * KiB) throw new Error("--memory-step-kib must be >= 16");
if (!Number.isFinite(memorySafetyBytes) || memorySafetyBytes < 0) throw new Error("--memory-safety-kib must be >= 0");
if (!Number.isFinite(memorySafetyPercent) || memorySafetyPercent < 0) throw new Error("--memory-safety-percent must be >= 0");
if (!Number.isFinite(memoryMaxBytes) || memoryMaxBytes < memoryStepBytes) throw new Error("--memory-max-kib must be >= --memory-step-kib");

const selectedSpecs = apps.includes("all")
  ? SPECS
  : apps.map((app) => {
      const spec = SPECS.find((s) => s.app === app);
      if (!spec) throw new Error(`unknown app ${app}`);
      return spec;
    });

const headless = process.env.PPSSPP_HEADLESS || `${homedir()}/ppsspp-src/build/PPSSPPHeadless`;
if (!existsSync(headless)) throw new Error(`PPSSPPHeadless not found at ${headless}`);

const dccap = `${homedir()}/.ppsspp/dc_cap`;
const benchFile = `${homedir()}/.ppsspp/PocketJS-bench.jsonl`;
const eboot = `${pspUiDir}hosts/psp/target/mipsel-sony-psp/debug/EBOOT.PBP`;

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const rawPath = `${outDir}/ppsspp-bench-${stamp}.raw.jsonl`;
const summaryPath = `${outDir}/ppsspp-bench-${stamp}.json`;
const mdPath = `${outDir}/ppsspp-bench-${stamp}.md`;

const METRICS = [
  "eval_us",
  "boot_to_frame0_us",
  "avg_js_us",
  "avg_jobs_us",
  "avg_tick_us",
  "avg_draw_us",
  "avg_render_us",
  "avg_work_us",
  "max_work_us",
  "host_wall_ms",
  "bundle_bytes",
  "pak_bytes",
  "arena_capacity_bytes",
  "arena_bump_bytes",
  "arena_tail_free_bytes",
  "arena_init_free_bytes",
  "arena_configured_bytes",
] as const;

type Metric = (typeof METRICS)[number];

const samplesOut: Sample[] = [];
const memoryScans = new Map<string, MemoryScanApp>();

for (const spec of selectedSpecs) {
  console.log(`\n## build ${spec.app}`);
  await buildBenchEboot(spec, null);

  for (let sample = 1; sample <= samples; sample++) {
    const row = await runBenchSample(spec, sample, null);
    samplesOut.push(row);
    writeRaw({ kind: "sample", ...row });
    console.log(
      `${row.app} #${sample}: eval=${fmtMs(row.eval_us)} frame0=${fmtMs(row.boot_to_frame0_us)} ` +
        `work=${fmtUs(row.avg_work_us)} render=${fmtUs(row.avg_render_us)} arena=${fmtBytes(row.arena_bump_bytes)}`,
    );
  }
}

if (memoryScan) {
  for (const spec of selectedSpecs) {
    const uncappedRows = samplesOut.filter((r) => isAppRow(r, spec.app));
    const uncapped = uncappedRows.reduce((best, row) => (row.arena_bump_bytes > best.arena_bump_bytes ? row : best), uncappedRows[0]);
    if (!uncapped) throw new Error(`no uncapped sample for ${spec.app}`);
    const scan = await scanMemoryForApp(spec, uncapped);
    memoryScans.set(spec.app, scan);
  }
}

const memoryScanReport = memoryScan ? renderMemoryScanReport(memoryScans) : undefined;
const report = {
  generated: new Date().toISOString(),
  samples,
  ppsspp_revision: await textOrUnknown($`git -C ${homedir()}/ppsspp-src rev-parse --short HEAD`.quiet()),
  git_revision: await textOrUnknown($`git rev-parse --short HEAD`.cwd(pspUiDir).quiet()),
  frame_budget_us: FRAME_BUDGET_US,
  apps: Object.fromEntries(selectedSpecs.map((spec) => [spec.app, summarizeApp(samplesOut, spec.app)])),
  memory_scan: memoryScanReport,
};
writeFileSync(summaryPath, JSON.stringify(report, null, 2));
writeFileSync(mdPath, renderMarkdown(report));

console.log(`\nraw samples: ${rawPath}`);
console.log(`summary:     ${summaryPath}`);
console.log(`report:      ${mdPath}`);
if (memoryScanReport) {
  console.log(`suite safe arena: ${fmtBytes(memoryScanReport.suite.safe_arena_bytes)}`);
}

async function buildBenchEboot(spec: Spec, arenaBytes: number | null): Promise<void> {
  await $`bun tools/psp.ts ${spec.app} --bench`
    .cwd(pspUiDir)
    .env({
      ...process.env,
      POCKETJS_CAPTURE_INPUT: spec.inputScript,
      POCKETJS_CAP_START: String(spec.capStart),
      POCKETJS_CAP_N: String(spec.capN),
      POCKETJS_ARENA_BYTES: arenaBytes == null ? "" : String(arenaBytes),
      POCKETJS_BENCH_DUMP_FRAMES: dumpFrames ? "1" : "",
    })
    .quiet();
}

async function runBenchSample(spec: Spec, sample: number, arenaBytes: number | null): Promise<Sample> {
  rmSync(dccap, { recursive: true, force: true });
  rmSync(benchFile, { force: true });
  const t0 = performance.now();
  const run = await $`${headless} --graphics=software --timeout=${timeout} ${eboot}`.cwd("/tmp").nothrow().quiet();
  const host_wall_ms = performance.now() - t0;

  if (dumpFrames) {
    const produced = existsSync(dccap)
      ? readdirSync(dccap).filter((f) => /^f\d{4}\.raw$/.test(f)).length
      : 0;
    if (produced !== spec.capN) {
      throw new Error(`${spec.app} sample ${sample}: produced ${produced}/${spec.capN} frames`);
    }
  }
  if (run.exitCode !== 0 && !existsSync(benchFile)) {
    throw new Error(`${spec.app} sample ${sample}: PPSSPP failed\n${run.stdout}${run.stderr}`);
  }
  if (!existsSync(benchFile)) {
    throw new Error(`${spec.app} sample ${sample}: ${benchFile} missing`);
  }
  const lines = readFileSync(benchFile, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`${spec.app} sample ${sample}: expected 1 bench line, got ${lines.length}`);
  }
  const parsed = JSON.parse(lines[0]) as BenchLine;
  if (parsed.frames !== spec.capN || parsed.window_n !== spec.capN) {
    throw new Error(`${spec.app} sample ${sample}: bench window mismatch (${parsed.frames}/${parsed.window_n}, expected ${spec.capN})`);
  }
  return { ...parsed, sample, host_wall_ms, arena_limit_bytes: arenaBytes };
}

async function scanMemoryForApp(spec: Spec, uncapped: Sample): Promise<MemoryScanApp> {
  console.log(`\n## memory scan ${spec.app} (uncapped high-water ${fmtBytes(uncapped.arena_bump_bytes)})`);
  const attempts: MemoryAttempt[] = [];
  let candidate = alignUp(Math.max(memoryStepBytes, uncapped.arena_bump_bytes), memoryStepBytes);
  let pass: Sample | null = null;

  while (candidate <= memoryMaxBytes) {
    const result = await probeMemory(spec, candidate, attempts);
    if (result) {
      pass = result;
      break;
    }
    candidate += memoryStepBytes;
  }
  if (!pass) {
    throw new Error(`${spec.app}: no passing arena <= ${fmtBytes(memoryMaxBytes)}`);
  }

  let minPass = candidate;
  let minPassSample = pass;
  let below = candidate - memoryStepBytes;
  while (below >= memoryStepBytes) {
    if (below < uncapped.arena_bump_bytes) {
      const attempt: MemoryAttempt = {
        arena_bytes: below,
        pass: false,
        error: `below uncapped high-water ${fmtBytes(uncapped.arena_bump_bytes)}`,
      };
      attempts.push(attempt);
      writeRaw({ kind: "memory-attempt", app: spec.app, inferred: true, ...attempt });
      break;
    }
    const result = await probeMemory(spec, below, attempts);
    if (!result) break;
    minPass = below;
    minPassSample = result;
    below -= memoryStepBytes;
  }

  const safetyMargin = Math.max(memorySafetyBytes, Math.ceil((minPass * memorySafetyPercent) / 100));
  const safeArena = alignUp(minPass + safetyMargin, memoryStepBytes);
  let safeSample = minPassSample;
  if (safeArena !== minPass) {
    const result = await probeMemory(spec, safeArena, attempts);
    if (!result) throw new Error(`${spec.app}: safe arena ${fmtBytes(safeArena)} failed after min pass ${fmtBytes(minPass)}`);
    safeSample = result;
  }

  console.log(
    `${spec.app}: min=${fmtBytes(minPass)} safe=${fmtBytes(safeArena)} ` +
      `(margin ${fmtBytes(safetyMargin)}, high-water ${fmtBytes(uncapped.arena_bump_bytes)})`,
  );

  return {
    uncapped_arena_bump_bytes: uncapped.arena_bump_bytes,
    min_pass_arena_bytes: minPass,
    safety_margin_bytes: safetyMargin,
    safe_arena_bytes: safeArena,
    safe_sample: safeSample,
    attempts,
  };
}

async function probeMemory(spec: Spec, arenaBytes: number, attempts: MemoryAttempt[]): Promise<Sample | null> {
  console.log(`# probe ${spec.app} arena=${fmtBytes(arenaBytes)}`);
  try {
    await buildBenchEboot(spec, arenaBytes);
    const sample = await runBenchSample(spec, 1, arenaBytes);
    const attempt: MemoryAttempt = {
      arena_bytes: arenaBytes,
      pass: true,
      avg_work_us: sample.avg_work_us,
      arena_bump_bytes: sample.arena_bump_bytes,
      host_wall_ms: sample.host_wall_ms,
    };
    attempts.push(attempt);
    writeRaw({ kind: "memory-attempt", app: spec.app, ...attempt });
    return sample;
  } catch (error) {
    const attempt: MemoryAttempt = {
      arena_bytes: arenaBytes,
      pass: false,
      error: error instanceof Error ? firstLine(error.message) : String(error),
    };
    attempts.push(attempt);
    writeRaw({ kind: "memory-attempt", app: spec.app, ...attempt });
    console.log(`# fail ${spec.app} arena=${fmtBytes(arenaBytes)}: ${attempt.error}`);
    return null;
  }
}

function renderMemoryScanReport(scans: Map<string, MemoryScanApp>) {
  const appsReport = Object.fromEntries(scans.entries());
  const minPass = Math.max(...[...scans.values()].map((s) => s.min_pass_arena_bytes));
  const safeArena = Math.max(...[...scans.values()].map((s) => s.safe_arena_bytes));
  return {
    step_bytes: memoryStepBytes,
    safety_floor_bytes: memorySafetyBytes,
    safety_percent: memorySafetyPercent,
    apps: appsReport,
    suite: {
      min_pass_arena_bytes: minPass,
      safe_arena_bytes: safeArena,
    },
  };
}

function writeRaw(value: unknown): void {
  writeFileSync(rawPath, `${JSON.stringify(value)}\n`, { flag: "a" });
}

function isAppRow(row: Sample, app: string): boolean {
  return row.app === `${app}-main` || row.app === app;
}

function firstLine(text: string): string {
  return text.split("\n").find(Boolean)?.slice(0, 240) ?? "unknown error";
}

function alignUp(n: number, step: number): number {
  return Math.ceil(n / step) * step;
}

function fmtUs(us: number): string {
  return `${Math.round(us)}us`;
}

function fmtMs(us: number): string {
  return `${(us / 1000).toFixed(1)}ms`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(bytes % MiB === 0 ? 0 : 2)} MiB`;
  if (bytes >= KiB) return `${(bytes / KiB).toFixed(bytes % KiB === 0 ? 0 : 1)} KiB`;
  return `${bytes} B`;
}

async function textOrUnknown(cmd: ReturnType<typeof $>): Promise<string> {
  const out = await cmd.nothrow().text();
  return out.trim() || "unknown";
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = mean(values);
  return {
    n: values.length,
    mean: m,
    sd: sd(values),
    min: sorted[0],
    median: quantile(sorted, 0.5),
    max: sorted[sorted.length - 1],
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const t = pos - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function summarizeApp(rows: Sample[], app: string): Record<Metric, ReturnType<typeof summarize>> {
  const subset = rows.filter((r) => isAppRow(r, app));
  return Object.fromEntries(METRICS.map((metric) => [metric, summarize(subset.map((r) => r[metric]))])) as Record<
    Metric,
    ReturnType<typeof summarize>
  >;
}

function formatMetric(metric: Metric, value: number): string {
  if (metric === "host_wall_ms") return `${value.toFixed(1)}ms`;
  if (metric.endsWith("_bytes")) return fmtBytes(value);
  return fmtUs(value);
}

function renderMarkdown(report: {
  generated: string;
  samples: number;
  ppsspp_revision: string;
  git_revision: string;
  frame_budget_us: number;
  apps: Record<string, Record<Metric, ReturnType<typeof summarize>>>;
  memory_scan?: ReturnType<typeof renderMemoryScanReport>;
}) {
  const lines = [
    "# PocketJS PPSSPP Benchmark",
    "",
    `Generated: ${report.generated}`,
    `Samples per app: ${report.samples}`,
    `PPSSPP revision: ${report.ppsspp_revision}`,
    `Git revision: ${report.git_revision}`,
    `Frame budget: ${fmtUs(report.frame_budget_us)}`,
    "",
  ];
  for (const [app, metrics] of Object.entries(report.apps)) {
    lines.push(`## ${app}`, "");
    lines.push("| metric | mean | sd | min | median | max |");
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const metric of METRICS) {
      const s = metrics[metric];
      lines.push(
        `| ${metric} | ${formatMetric(metric, s.mean)} | ${formatMetric(metric, s.sd)} | ${formatMetric(metric, s.min)} | ${formatMetric(metric, s.median)} | ${formatMetric(metric, s.max)} |`,
      );
    }
    lines.push("");
  }

  if (report.memory_scan) {
    lines.push("## Memory Scan", "");
    lines.push(`Step: ${fmtBytes(report.memory_scan.step_bytes)}`);
    lines.push(
      `Safety margin: max(${fmtBytes(report.memory_scan.safety_floor_bytes)}, ${report.memory_scan.safety_percent}% of min passing arena)`,
    );
    lines.push("");
    lines.push("| app | uncapped high-water | min passing arena | safety margin | safe arena | attempts |");
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const [app, scan] of Object.entries(report.memory_scan.apps)) {
      lines.push(
        `| ${app} | ${fmtBytes(scan.uncapped_arena_bump_bytes)} | ${fmtBytes(scan.min_pass_arena_bytes)} | ${fmtBytes(scan.safety_margin_bytes)} | ${fmtBytes(scan.safe_arena_bytes)} | ${scan.attempts.length} |`,
      );
    }
    lines.push("");
    lines.push(`Suite min passing arena: ${fmtBytes(report.memory_scan.suite.min_pass_arena_bytes)}`);
    lines.push(`Suite safe arena: ${fmtBytes(report.memory_scan.suite.safe_arena_bytes)}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
