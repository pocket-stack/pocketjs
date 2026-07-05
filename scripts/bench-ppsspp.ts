// PPSSPP benchmark runner for the current PocketJS renderer.
//
// Builds one bench EBOOT per selected app, then runs PPSSPPHeadless repeatedly
// and reads PSP-side microsecond timing from ms0:/PocketJS-bench.jsonl.
//
// Example:
//   PSP_SDK=/path/to/mipsel-sony-psp bun scripts/bench-ppsspp.ts --apps=stats --samples=5

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
}

interface Sample extends BenchLine {
  sample: number;
  host_wall_ms: number;
}

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
  } else {
    throw new Error(`unknown argument ${a}`);
  }
}

if (!Number.isFinite(samples) || samples < 1) throw new Error("--samples must be >= 1");
if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be > 0");

const selectedSpecs = apps.map((app) => {
  const spec = SPECS.find((s) => s.app === app);
  if (!spec) throw new Error(`unknown app ${app}`);
  return spec;
});

const headless = process.env.PPSSPP_HEADLESS || `${homedir()}/ppsspp-src/build/PPSSPPHeadless`;
if (!existsSync(headless)) throw new Error(`PPSSPPHeadless not found at ${headless}`);

const dccap = `${homedir()}/.ppsspp/dc_cap`;
const benchFile = `${homedir()}/.ppsspp/PocketJS-bench.jsonl`;
const eboot = `${pspUiDir}native/target/mipsel-sony-psp/debug/EBOOT.PBP`;

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
] as const;

const samplesOut: Sample[] = [];

for (const spec of selectedSpecs) {
  console.log(`\n## build ${spec.app}`);
  await $`bun scripts/psp.ts ${spec.app} --bench`
    .cwd(pspUiDir)
    .env({
      ...process.env,
      POCKETJS_CAPTURE_INPUT: spec.inputScript,
      POCKETJS_CAP_START: String(spec.capStart),
      POCKETJS_CAP_N: String(spec.capN),
    })
    .quiet();

  for (let sample = 1; sample <= samples; sample++) {
    rmSync(dccap, { recursive: true, force: true });
    rmSync(benchFile, { force: true });
    const t0 = performance.now();
    const run = await $`${headless} --graphics=software --timeout=${timeout} ${eboot}`.cwd("/tmp").nothrow().quiet();
    const host_wall_ms = performance.now() - t0;

    const produced = existsSync(dccap)
      ? readdirSync(dccap).filter((f) => /^f\d{4}\.raw$/.test(f)).length
      : 0;
    if (run.exitCode !== 0 && !existsSync(benchFile)) {
      throw new Error(`${spec.app} sample ${sample}: PPSSPP failed\n${run.stdout}${run.stderr}`);
    }
    if (produced !== spec.capN) {
      throw new Error(`${spec.app} sample ${sample}: produced ${produced}/${spec.capN} frames`);
    }
    if (!existsSync(benchFile)) {
      throw new Error(`${spec.app} sample ${sample}: ${benchFile} missing`);
    }
    const lines = readFileSync(benchFile, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length !== 1) {
      throw new Error(`${spec.app} sample ${sample}: expected 1 bench line, got ${lines.length}`);
    }
    const parsed = JSON.parse(lines[0]) as BenchLine;
    const row: Sample = { ...parsed, sample, host_wall_ms };
    samplesOut.push(row);
    writeFileSync(rawPath, `${JSON.stringify(row)}\n`, { flag: "a" });
    console.log(
      `${parsed.app} #${sample}: eval=${fmtMs(parsed.eval_us)} frame0=${fmtMs(parsed.boot_to_frame0_us)} ` +
        `render=${fmtUs(parsed.avg_render_us)} work=${fmtUs(parsed.avg_work_us)} host=${host_wall_ms.toFixed(1)}ms`,
    );
  }
}

const report = {
  generated: new Date().toISOString(),
  samples,
  ppsspp_revision: await textOrUnknown($`git -C ${homedir()}/ppsspp-src rev-parse --short HEAD`.quiet()),
  git_revision: await textOrUnknown($`git rev-parse --short HEAD`.cwd(pspUiDir).quiet()),
  apps: Object.fromEntries(selectedSpecs.map((spec) => [spec.app, summarizeApp(samplesOut, spec.app)])),
};
writeFileSync(summaryPath, JSON.stringify(report, null, 2));
writeFileSync(mdPath, renderMarkdown(report));

console.log(`\nraw samples: ${rawPath}`);
console.log(`summary:     ${summaryPath}`);
console.log(`report:      ${mdPath}`);

function fmtUs(us: number): string {
  return `${Math.round(us)}us`;
}

function fmtMs(us: number): string {
  return `${(us / 1000).toFixed(1)}ms`;
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

function summarizeApp(rows: Sample[], app: string) {
  const subset = rows.filter((r) => r.app === `${app}-main` || r.app === app);
  return Object.fromEntries(METRICS.map((metric) => [metric, summarize(subset.map((r) => r[metric]))]));
}

function renderMarkdown(report: {
  generated: string;
  samples: number;
  ppsspp_revision: string;
  git_revision: string;
  apps: Record<string, Record<(typeof METRICS)[number], ReturnType<typeof summarize>>>;
}) {
  const lines = [
    "# PocketJS PPSSPP Benchmark",
    "",
    `Generated: ${report.generated}`,
    `Samples per app: ${report.samples}`,
    `PPSSPP revision: ${report.ppsspp_revision}`,
    `Git revision: ${report.git_revision}`,
    "",
  ];
  for (const [app, metrics] of Object.entries(report.apps)) {
    lines.push(`## ${app}`, "");
    lines.push("| metric | mean | sd | min | median | max |");
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const metric of METRICS) {
      const s = metrics[metric];
      const formatter = metric === "host_wall_ms" ? (v: number) => `${v.toFixed(1)}ms` : fmtUs;
      lines.push(
        `| ${metric} | ${formatter(s.mean)} | ${formatter(s.sd)} | ${formatter(s.min)} | ${formatter(s.median)} | ${formatter(s.max)} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
