import { $ } from "bun";
import { expect, test } from "bun:test";

const ROOT = new URL("..", import.meta.url).pathname;
const COMMAND = [
  "cargo",
  "run",
  "--manifest-path",
  "engine/core/Cargo.toml",
  "--example",
  "membench",
  "--quiet",
];

const REQUIRED_FIELDS = [
  "peak_requested_bytes",
  "final_requested_bytes",
  "allocation_count",
  "total_allocated_bytes",
  "avg_layout_us",
  "max_layout_us",
  "nodes",
  "structural_relayouts",
  "text_mode",
  "texture_mode",
  "drawlist_checksum",
] as const;

const TIMING_FIELDS = new Set(["avg_layout_us", "max_layout_us"]);
type Receipt = Record<(typeof REQUIRED_FIELDS)[number], string>;

function parseReceipt(output: string): Receipt {
  const receipt = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        expect(separator).toBeGreaterThan(0);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  ) as Partial<Receipt>;

  for (const field of REQUIRED_FIELDS) {
    expect(receipt[field]).toBeDefined();
    expect(receipt[field]).not.toBe("");
  }

  for (const field of REQUIRED_FIELDS) {
    if (TIMING_FIELDS.has(field)) continue;
    if (field === "text_mode" || field === "texture_mode") {
      expect(receipt[field]).toBe("atlas");
    } else if (field === "drawlist_checksum") {
      expect(receipt[field]).toMatch(/^[0-9a-f]{16}$/);
    } else {
      expect(receipt[field]).toMatch(/^\d+$/);
      expect(Number(receipt[field])).toBeGreaterThanOrEqual(0);
    }
  }

  for (const field of TIMING_FIELDS) {
    expect(receipt[field]).toMatch(/^\d+$/);
    expect(Number(receipt[field])).toBeGreaterThanOrEqual(0);
  }

  return receipt as Receipt;
}

function canonicalReceipt(receipt: Receipt): Partial<Receipt> {
  return Object.fromEntries(
    REQUIRED_FIELDS.filter((field) => !TIMING_FIELDS.has(field)).map((field) => [
      field,
      receipt[field],
    ]),
  );
}

test(
  "core memory receipt is complete, stable, and matches its baseline",
  { timeout: 30_000 },
  async () => {
    const run = () =>
      $`${COMMAND[0]} ${COMMAND.slice(1)}`.cwd(ROOT).quiet().text();
    const first = parseReceipt(await run());
    const second = parseReceipt(await run());

    expect(canonicalReceipt(first)).toEqual(canonicalReceipt(second));

    const baseline = (await Bun.file(
      new URL("../engine/core/examples/membench_baseline.json", import.meta.url),
    ).json()) as { receipt: Receipt };
    expect(canonicalReceipt(first)).toEqual(canonicalReceipt(baseline.receipt));
  },
);
