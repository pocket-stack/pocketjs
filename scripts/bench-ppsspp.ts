// PPSSPP benchmark runner for engine comparison.
//
// Builds one bench EBOOT per app/engine, then runs PPSSPPHeadless repeatedly
// and reads PSP-side microsecond timing from ms0:/PocketJS-bench.jsonl.
//
// Example:
//   PSP_SDK=/path/to/mipsel-sony-psp bun scripts/bench-ppsspp.ts --engines=vue-vapor,vue,solid --samples=7

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

type Engine = "react" | "vue" | "vue-vapor" | "solid";

interface Spec {
  app: string;
  inputScript: string;
  capStart: number;
  capN: number;
}

interface BenchLine {
  app: string;
  engine: Engine;
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
  dcpak_bytes: number;
}

interface Sample extends BenchLine {
  sample: number;
  host_wall_ms: number;
}

const SPECS: Spec[] = [
  {
    app: "hero",
    inputScript: "0:0,58:0x40,62:0,76:0x2000,80:0",
    capStart: 48,
    capN: 48,
  },
  {
    app: "cards",
    inputScript: "0:0,20:0x20,24:0,28:0x20,32:0,44:0x2000,48:0",
    capStart: 16,
    capN: 80,
  },
  {
    app: "stats",
    inputScript: "0:0,84:0x20,88:0",
    capStart: 28,
    capN: 100,
  },
  {
    app: "library",
    inputScript: "0:0,8:0x20,12:0,16:0x20,20:0,32:0x2000,36:0",
    capStart: 4,
    capN: 120,
  },
  {
    app: "settings",
    inputScript:
      "0:0,4:0x40,8:0,10:0x2000,14:0,16:0x40,20:0,22:0x2000,26:0,28:0x40,32:0,34:0x2000,38:0,40:0x40,42:0,44:0x40,46:0,48:0x40,52:0,54:0x2000,58:0",
    capStart: 0,
    capN: 100,
  },
  {
    app: "notifications",
    inputScript: "0:0,10:0x40,14:0,16:0x40,20:0,24:0x2000,28:0",
    capStart: 0,
    capN: 65,
  },
  {
    app: "music",
    inputScript:
      "0:0,4:0x40,8:0,10:0x2000,14:0,30:0x40,34:0,36:0x40,40:0,42:0x2000,46:0,70:0x0200,74:0",
    capStart: 0,
    capN: 95,
  },
];

const pspUiDir = new URL("..", import.meta.url).pathname;
const argv = Bun.argv.slice(2);
let samples = 7;
let engines: Engine[] = ["vue", "solid"];
let apps = SPECS.map((s) => s.app);
let timeout = Number(process.env.BENCH_PPSSPP_TIMEOUT || 60);
let outDir = `${pspUiDir}dist/bench`;
let bootstrapIterations = 5000;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
  if (a.startsWith("--samples=") || a === "--samples") {
    samples = Number(value);
    if (a === "--samples") i++;
  } else if (a.startsWith("--engines=") || a === "--engines") {
    engines = value.split(",").map((e) => {
      if (e !== "react" && e !== "vue" && e !== "vue-vapor" && e !== "solid") {
        throw new Error(`unknown engine ${e}`);
      }
      return e;
    });
    if (a === "--engines") i++;
  } else if (a.startsWith("--apps=") || a === "--apps") {
    apps = value.split(",").filter(Boolean);
    if (a === "--apps") i++;
  } else if (a.startsWith("--timeout=") || a === "--timeout") {
    timeout = Number(value);
    if (a === "--timeout") i++;
  } else if (a.startsWith("--out-dir=") || a === "--out-dir") {
    outDir = value;
    if (a === "--out-dir") i++;
  } else if (a.startsWith("--bootstrap=") || a === "--bootstrap") {
    bootstrapIterations = Number(value);
    if (a === "--bootstrap") i++;
  } else {
    throw new Error(`unknown argument ${a}`);
  }
}

if (!Number.isFinite(samples) || samples < 2) throw new Error("--samples must be >= 2");
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
  "dcpak_bytes",
] as const;

const samplesOut: Sample[] = [];

for (const spec of selectedSpecs) {
  for (const engine of engines) {
    console.log(`\n## build ${spec.app} (${engine})`);
    await $`bun scripts/psp.ts ${spec.app} --engine=${engine} --bench`
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
      const run =
        await $`${headless} --graphics=software --timeout=${timeout} ${eboot}`.cwd("/tmp").nothrow().quiet();
      const host_wall_ms = performance.now() - t0;

      const produced = existsSync(dccap)
        ? readdirSync(dccap).filter((f) => /^f\d{4}\.raw$/.test(f)).length
        : 0;
      if (run.exitCode !== 0 && !existsSync(benchFile)) {
        throw new Error(`${spec.app}/${engine} sample ${sample}: PPSSPP failed\n${run.stdout}${run.stderr}`);
      }
      if (produced !== spec.capN) {
        throw new Error(`${spec.app}/${engine} sample ${sample}: produced ${produced}/${spec.capN} frames`);
      }
      if (!existsSync(benchFile)) {
        throw new Error(`${spec.app}/${engine} sample ${sample}: ${benchFile} missing`);
      }
      const lines = readFileSync(benchFile, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length !== 1) {
        throw new Error(`${spec.app}/${engine} sample ${sample}: expected 1 bench line, got ${lines.length}`);
      }
      const parsed = JSON.parse(lines[0]) as BenchLine;
      const row: Sample = { ...parsed, sample, host_wall_ms };
      samplesOut.push(row);
      writeFileSync(rawPath, `${JSON.stringify(row)}\n`, { flag: "a" });
      console.log(
        `${spec.app}/${engine} #${sample}: eval=${fmtMs(parsed.eval_us)} ` +
          `frame0=${fmtMs(parsed.boot_to_frame0_us)} work=${fmtUs(parsed.avg_work_us)} ` +
          `host=${host_wall_ms.toFixed(1)}ms`,
      );
    }
  }
}

const report = buildReport(samplesOut, engines, selectedSpecs.map((s) => s.app), bootstrapIterations);
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

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

function tCrit95(n: number): number {
  const table: Record<number, number> = {
    2: 12.706,
    3: 4.303,
    4: 3.182,
    5: 2.776,
    6: 2.571,
    7: 2.447,
    8: 2.365,
    9: 2.306,
    10: 2.262,
    11: 2.228,
    12: 2.201,
    13: 2.179,
    14: 2.16,
    15: 2.145,
    16: 2.131,
    17: 2.12,
    18: 2.11,
    19: 2.101,
    20: 2.093,
    21: 2.086,
    22: 2.08,
    23: 2.074,
    24: 2.069,
    25: 2.064,
    26: 2.06,
    27: 2.056,
    28: 2.052,
    29: 2.048,
    30: 2.045,
  };
  if (n <= 30) return table[n] ?? table[30];
  return 1.96;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = mean(values);
  const s = sd(values);
  const half = tCrit95(values.length) * s / Math.sqrt(values.length);
  return {
    n: values.length,
    mean: m,
    sd: s,
    ci95_low: m - half,
    ci95_high: m + half,
    min: sorted[0],
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
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

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function bootstrapRatio(a: number[], b: number[], iterations: number, seed: number) {
  const rand = rng(seed);
  const ratios: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sumA = 0;
    let sumB = 0;
    for (let j = 0; j < a.length; j++) sumA += a[Math.floor(rand() * a.length)];
    for (let j = 0; j < b.length; j++) sumB += b[Math.floor(rand() * b.length)];
    ratios.push((sumA / a.length) / (sumB / b.length));
  }
  ratios.sort((x, y) => x - y);
  return {
    mean_ratio: mean(a) / mean(b),
    ci95_low: quantile(ratios, 0.025),
    ci95_high: quantile(ratios, 0.975),
  };
}

function buildReport(rows: Sample[], reportEngines: Engine[], reportApps: string[], iterations: number) {
  const groups: Record<string, Record<string, Record<string, ReturnType<typeof summarize>>>> = {};
  for (const app of reportApps) {
    groups[app] = {};
    for (const engine of reportEngines) {
      const subset = rows.filter((r) => r.app.startsWith(`${app}-main`) && r.engine === engine);
      groups[app][engine] = {};
      for (const metric of METRICS) {
        groups[app][engine][metric] = summarize(subset.map((r) => r[metric]));
      }
    }
  }

  const comparisonRatios: Record<string, Record<string, Record<string, ReturnType<typeof bootstrapRatio>>>> = {};
  const comparisonPairs: [Engine, Engine][] = [];
  if (reportEngines.includes("solid")) {
    for (const engine of reportEngines) {
      if (engine !== "solid") comparisonPairs.push([engine, "solid"]);
    }
  }
  if (reportEngines.includes("vue-vapor") && reportEngines.includes("vue")) {
    comparisonPairs.push(["vue-vapor", "vue"]);
  }

  for (const [numerator, denominator] of comparisonPairs) {
    const key = ratioKey(numerator, denominator);
    comparisonRatios[key] = {};
    for (const app of reportApps) {
      comparisonRatios[key][app] = {};
      const left = rows.filter((r) => r.app.startsWith(`${app}-main`) && r.engine === numerator);
      const right = rows.filter((r) => r.app.startsWith(`${app}-main`) && r.engine === denominator);
      for (const metric of METRICS) {
        comparisonRatios[key][app][metric] = bootstrapRatio(
          left.map((r) => r[metric]),
          right.map((r) => r[metric]),
          iterations,
          hashString(`${key}:${app}:${metric}`),
        );
      }
    }
  }

  const ratios: Record<string, Record<string, ReturnType<typeof bootstrapRatio>>> = {};
  if (reportEngines.includes("vue") && reportEngines.includes("solid")) {
    for (const app of reportApps) {
      ratios[app] = {};
      const vue = rows.filter((r) => r.app.startsWith(`${app}-main`) && r.engine === "vue");
      const solid = rows.filter((r) => r.app.startsWith(`${app}-main`) && r.engine === "solid");
      for (const metric of METRICS) {
        ratios[app][metric] = bootstrapRatio(
          vue.map((r) => r[metric]),
          solid.map((r) => r[metric]),
          iterations,
          hashString(`${app}:${metric}`),
        );
      }
    }
  }

  return {
    generated_at: new Date().toISOString(),
    psp_ui_dir: pspUiDir,
    ppsspp_headless: headless,
    ppsspp_commit: readCommand(`git -C ${homedir()}/ppsspp-src rev-parse HEAD`),
    git_head: readCommand("git rev-parse HEAD"),
    git_dirty: readCommand("git status --short").length > 0,
    samples_per_group: samples,
    engines: reportEngines,
    apps: reportApps,
    metrics: METRICS,
    raw_samples: rows,
    groups,
    vue_over_solid_ratios: ratios,
    comparison_ratios: comparisonRatios,
  };
}

function ratioKey(numerator: Engine, denominator: Engine): string {
  return `${numerator}_over_${denominator}`;
}

function ratioTitle(key: string): string {
  return key.replace("_over_", "/").replaceAll("-", " ");
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function readCommand(cmd: string): string {
  const proc = Bun.spawnSync(["zsh", "-lc", cmd], { cwd: pspUiDir });
  if (proc.exitCode !== 0) return "";
  return new TextDecoder().decode(proc.stdout).trim();
}

function renderMarkdown(report: ReturnType<typeof buildReport>): string {
  const lines: string[] = [];
  lines.push("# PPSSPP Engine Bench");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Samples per app/engine: ${report.samples_per_group}`);
  lines.push(`PPSSPP: ${report.ppsspp_commit.slice(0, 12)}`);
  lines.push(`Git: ${report.git_head.slice(0, 12)}${report.git_dirty ? " (dirty)" : ""}`);
  lines.push("");
  lines.push("Lower is better for all timing metrics. Values are mean with t-based 95% CI.");
  lines.push("");
  for (const key of Object.keys(report.comparison_ratios)) {
    lines.push(`## Rollup: ${ratioTitle(key)}`);
    lines.push("");
    lines.push(`| metric | ${ratioTitle(key)} ratio, geometric mean across apps |`);
    lines.push("|---|---:|");
    for (const metric of ["eval_us", "boot_to_frame0_us", "avg_work_us", "host_wall_ms", "bundle_bytes"] as const) {
      const ratios = report.apps
        .map((app) => report.comparison_ratios[key]?.[app]?.[metric]?.mean_ratio)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
      if (ratios.length > 0) {
        lines.push(`| ${metric} | ${geomean(ratios).toFixed(3)}x |`);
      }
    }
    lines.push("");
  }

  for (const metric of ["eval_us", "boot_to_frame0_us", "avg_work_us", "avg_js_us", "avg_jobs_us", "host_wall_ms", "bundle_bytes"] as const) {
    lines.push(`## ${metric}`);
    lines.push("");
    const comparisonKeys = Object.keys(report.comparison_ratios);
    lines.push(
      `| app | ${report.engines.join(" | ")}${
        comparisonKeys.length > 0 ? ` | ${comparisonKeys.map((key) => `${ratioTitle(key)} ratio`).join(" | ")}` : ""
      } |`,
    );
    lines.push(
      `|---|${report.engines.map(() => "---:|").join("")}${
        comparisonKeys.length > 0 ? comparisonKeys.map(() => "---:|").join("") : ""
      }`,
    );
    for (const app of report.apps) {
      const engineCells = report.engines.map((engine) => {
        const summary = report.groups[app]?.[engine]?.[metric];
        return summary ? formatSummary(metric, summary) : "n/a";
      });
      const ratioCells = comparisonKeys.map((key) => {
        const ratio = report.comparison_ratios[key]?.[app]?.[metric];
        const denominator = key.slice(key.indexOf("_over_") + "_over_".length) as Engine;
        const denominatorSummary = report.groups[app]?.[denominator]?.[metric];
        if (!ratio || !denominatorSummary) return "n/a";
        if (denominatorSummary.mean < 10 && metric !== "bundle_bytes") return "n/a (denominator near zero)";
        return `${ratio.mean_ratio.toFixed(3)} (${ratio.ci95_low.toFixed(3)}..${ratio.ci95_high.toFixed(3)})`;
      });
      lines.push(`| ${app} | ${[...engineCells, ...ratioCells].join(" | ")} |`);
    }
    lines.push("");
  }
  lines.push(`Raw samples: ${rawPath}`);
  lines.push(`JSON summary: ${summaryPath}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function geomean(values: number[]): number {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

function formatSummary(metric: string, value: ReturnType<typeof summarize>): string {
  if (metric.endsWith("_bytes")) return `${Math.round(value.mean)} B`;
  if (metric === "host_wall_ms") {
    return `${value.mean.toFixed(1)} ms [${value.ci95_low.toFixed(1)}, ${value.ci95_high.toFixed(1)}]`;
  }
  return `${(value.mean / 1000).toFixed(2)} ms [${(value.ci95_low / 1000).toFixed(2)}, ${(value.ci95_high / 1000).toFixed(2)}]`;
}
