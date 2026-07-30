// Render a PPSSPP bench summary (tools/bench-ppsspp.ts --frameworks=... JSON)
// into a self-contained SVG matrix chart: grouped per-app bars for the
// headline metrics plus the geomean-vs-baseline table. Deterministic output —
// byte-stable for a given summary file.
//
//   bun tools/bench-chart.ts dist/bench/ppsspp-bench-<stamp>.json docs/bench/out.svg

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface Summary {
  generated: string;
  samples: number;
  frameworks: string[];
  ppsspp_revision: string;
  git_revision: string;
  apps: Record<string, Record<string, Record<string, { mean: number }>>>;
  comparison?: {
    baseline: string;
    geomean: Record<string, Record<string, { ratio: number; ci95?: [number, number] }>>;
  };
}

const [summaryPath, outPath] = process.argv.slice(2);
if (!summaryPath || !outPath) {
  console.error("usage: bun tools/bench-chart.ts <summary.json> <out.svg>");
  process.exit(2);
}
const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Summary;

const FW_COLORS: Record<string, string> = {
  solid: "#2c4f7c",
  "vue-vapor": "#42b883",
  octane: "#e8590c",
};
const FW_LABELS: Record<string, string> = {
  solid: "Solid",
  "vue-vapor": "Vue Vapor",
  octane: "Octane",
};

const PANELS: { metric: string; title: string; unit: (v: number) => string }[] = [
  { metric: "avg_work_us", title: "Average frame work (lower is better)", unit: (v) => `${(v / 1000).toFixed(1)}ms` },
  { metric: "boot_to_frame0_us", title: "Boot to first frame (lower is better)", unit: (v) => `${(v / 1000000).toFixed(2)}s` },
  { metric: "bundle_bytes", title: "Bundle size (lower is better)", unit: (v) => `${(v / 1024).toFixed(0)}KiB` },
];

const apps = Object.keys(summary.apps);
const fws = summary.frameworks;

const M = { l: 56, r: 16, t: 44, b: 34 };
const BAR_W = 26;
const GROUP_GAP = 30;
const groupW = fws.length * BAR_W + GROUP_GAP;
const plotW = apps.length * groupW;
const plotH = 150;
const panelW = M.l + plotW + M.r;
const panelH = M.t + plotH + M.b;
const headerH = 96;
const width = panelW;
const height = headerH + PANELS.length * panelH + 16;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const svg: string[] = [];
svg.push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`,
  `<rect width="${width}" height="${height}" fill="#0b1220"/>`,
  `<text x="16" y="26" fill="#e2e8f0" font-size="15" font-weight="bold">PocketJS on PPSSPP — ${fws.map((f) => FW_LABELS[f] ?? f).join(" vs ")}</text>`,
  `<text x="16" y="44" fill="#94a3b8" font-size="10">${esc(summary.generated)} · ${summary.samples} samples/app · PPSSPP ${esc(summary.ppsspp_revision)} · pocketjs ${esc(summary.git_revision)} · software renderer</text>`,
);

// Legend + geomean strip
let lx = 16;
for (const fw of fws) {
  svg.push(
    `<rect x="${lx}" y="56" width="10" height="10" fill="${FW_COLORS[fw] ?? "#888"}"/>`,
    `<text x="${lx + 14}" y="65" fill="#e2e8f0" font-size="10">${FW_LABELS[fw] ?? fw}</text>`,
  );
  lx += 110;
}
if (summary.comparison) {
  const { baseline, geomean } = summary.comparison;
  const parts: string[] = [];
  for (const [fw, metrics] of Object.entries(geomean)) {
    const work = metrics.avg_work_us?.ratio;
    const boot = metrics.boot_to_frame0_us?.ratio;
    const size = metrics.bundle_bytes?.ratio;
    parts.push(
      `${FW_LABELS[fw] ?? fw}/${FW_LABELS[baseline] ?? baseline}: work ${work?.toFixed(2)}x · boot ${boot?.toFixed(2)}x · size ${size?.toFixed(2)}x`,
    );
  }
  svg.push(`<text x="16" y="84" fill="#cbd5e1" font-size="10">geomean — ${esc(parts.join("   |   "))}</text>`);
}

PANELS.forEach((panel, pi) => {
  const oy = headerH + pi * panelH;
  const max = Math.max(
    ...apps.flatMap((app) => fws.map((fw) => summary.apps[app][fw]?.[panel.metric]?.mean ?? 0)),
  );
  const scale = max > 0 ? plotH / (max * 1.12) : 0;
  svg.push(`<text x="16" y="${oy + 18}" fill="#e2e8f0" font-size="12" font-weight="bold">${esc(panel.title)}</text>`);
  // gridlines (quarters)
  for (let g = 0; g <= 4; g++) {
    const gy = oy + M.t + plotH - (plotH * g) / 4;
    const gv = (max * 1.12 * g) / 4;
    svg.push(
      `<line x1="${M.l}" y1="${gy}" x2="${M.l + plotW}" y2="${gy}" stroke="#1e293b" stroke-width="1"/>`,
      `<text x="${M.l - 6}" y="${gy + 3}" fill="#64748b" font-size="8" text-anchor="end">${panel.unit(gv)}</text>`,
    );
  }
  apps.forEach((app, ai) => {
    const gx = M.l + ai * groupW + GROUP_GAP / 2;
    fws.forEach((fw, fi) => {
      const v = summary.apps[app][fw]?.[panel.metric]?.mean ?? 0;
      const h = v * scale;
      const x = gx + fi * BAR_W;
      const y = oy + M.t + plotH - h;
      svg.push(`<rect x="${x}" y="${y}" width="${BAR_W - 3}" height="${h}" fill="${FW_COLORS[fw] ?? "#888"}"/>`);
      svg.push(
        `<text x="${x + (BAR_W - 3) / 2}" y="${y - 3}" fill="#94a3b8" font-size="7" text-anchor="middle">${panel.unit(v)}</text>`,
      );
    });
    svg.push(
      `<text x="${gx + (fws.length * BAR_W) / 2}" y="${oy + M.t + plotH + 14}" fill="#cbd5e1" font-size="9" text-anchor="middle">${esc(app)}</text>`,
    );
  });
});
svg.push(`</svg>`);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, svg.join("\n") + "\n");
console.log(`wrote ${outPath} (${apps.length} apps x ${fws.length} frameworks)`);
