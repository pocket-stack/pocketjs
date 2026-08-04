// tools/test.ts — the test suite, as data. `bun run test` runs every stage
// in order and fails fast; the package.json one-liner it replaces had grown
// to nineteen &&-chained segments nobody could read or partially re-run.
//
//   bun tools/test.ts                 # the full suite (what CI runs)
//   bun tools/test.ts --stage=sim     # only stages whose name contains "sim"
//   bun tools/test.ts --list          # print the stage table and exit
//
// Stage anatomy: `prep` commands build the artifacts a stage needs (stdout
// captured, replayed only on failure); `script` runs a self-reporting bun
// script as-is (tests/contract.ts prints its own ok-lines); `tests` run as
// ONE `bun test` invocation, with `browser: true` adding
// `--conditions=browser` (stages that eval wasm-host bundles). On failure
// the exact repro command is printed before exiting 1.

interface Stage {
  readonly name: string;
  /** Artifact builds this stage needs: quiet unless they fail. */
  readonly prep?: readonly (readonly string[])[];
  /** A self-reporting bun script, run loud (instead of / before `tests`). */
  readonly script?: readonly string[];
  /** Test files for one `bun test` invocation. */
  readonly tests?: readonly string[];
  /** Run `tests` under --conditions=browser (wasm-host module resolution). */
  readonly browser?: boolean;
}

const SUITE: readonly Stage[] = [
  {
    name: "compiler smoke",
    prep: [["bun", "tools/build.ts", "hero"]],
  },
  {
    name: "contracts drift guard",
    script: ["bun", "tests/contract.ts"],
  },
  {
    name: "unit",
    tests: [
      "tests/release-check.test.ts",
      "tests/release-notes.test.ts",
      "tests/platform-contracts.test.ts",
      "tests/pocket-package.test.ts",
      "tests/widget-args.test.ts",
      "tests/ipod-nano.test.ts",
      "tests/note.test.ts",
      "tests/site-stage.test.ts",
      "tests/host-build-inputs.test.ts",
      "tests/platform-runtime.test.ts",
      "tests/app-check.test.ts",
      "tests/vue-sfc.test.ts",
      "tests/font-bake.test.ts",
      "tests/touch.test.ts",
      "tests/gesture.test.ts",
      "tests/kinetics.test.ts",
      "tests/osk-controller.test.ts",
      "tests/audio.test.ts",
      "tests/vita-package.test.ts",
      "tests/psp-toolchain.test.ts",
      "tests/symbian-data.test.ts",
      "tests/symbian-toolchain.test.ts",
      "tests/symbian-device.test.ts",
      "tests/symbian-runtime.test.ts",
      "tests/cli.test.ts",
      "tests/npm-package.test.ts",
      "tests/video-outro.test.ts",
      "tests/osk-layout.test.ts",
    ],
  },
  {
    name: "unit (wasm host)",
    browser: true,
    tests: [
      "tests/tailwind.test.ts",
      "tests/renderer.test.ts",
      "tests/virtual-list.test.ts",
      "tests/touch-activation.test.ts",
      "tests/portal-hit.test.ts",
      "tests/cursor.test.ts",
      "tests/action-handler-vue-vapor.test.ts",
      "tests/vue-vapor-dom.test.ts",
      "tests/vue-vapor-pak.test.ts",
      "tests/svg-bake.test.ts",
      "tests/devtools.test.ts",
      "tests/hot.test.ts",
      "tests/clock.test.ts",
      "tests/tiles.test.ts",
    ],
  },
  {
    name: "vue-sfc journeys",
    prep: [
      ["bun", "tools/build.ts", "hero-vue-sfc-main", "--framework=vue-vapor"],
      ["bun", "tools/build.ts", "vue-sfc-lab-main", "--framework=vue-vapor"],
    ],
    browser: true,
    tests: ["tests/vue-sfc-lab.test.ts"],
  },
  {
    name: "octane smoke",
    prep: [["bun", "tools/build.ts", "hero-main", "--framework=octane"]],
    browser: true,
    tests: ["tests/octane-smoke.test.ts"],
  },
  {
    name: "cafe sim (determinism)",
    prep: [["bun", "tools/build.ts", "cafe-main"]],
    browser: true,
    tests: ["tests/sim.test.ts"],
  },
  {
    name: "deepzoom sim",
    prep: [["bun", "tools/build.ts", "zoomlab-main"]],
    browser: true,
    tests: ["tests/deepzoom-sim.test.ts"],
  },
  {
    name: "im sim",
    prep: [["bun", "tools/build.ts", "im-main"]],
    browser: true,
    tests: ["tests/im-sim.test.ts"],
  },
  {
    name: "audio sim",
    prep: [["bun", "tools/build.ts", "music-main"]],
    browser: true,
    tests: ["tests/audio-sim.test.ts"],
  },
  {
    name: "launcher sim",
    prep: [["bun", "tools/launcher.ts", "covers"]],
    browser: true,
    tests: ["tests/launcher-sim.test.ts"],
  },
];

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const stageFilter = args.find((a) => a.startsWith("--stage="))?.slice("--stage=".length);
const selected = SUITE.filter((s) => !stageFilter || s.name.includes(stageFilter));

if (args.includes("--list")) {
  for (const s of SUITE) {
    const what = [
      s.prep ? `${s.prep.length} build(s)` : "",
      s.script ? s.script.join(" ") : "",
      s.tests ? `${s.tests.length} test file(s)${s.browser ? " [browser]" : ""}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    console.log(`  ${s.name.padEnd(24)} ${what}`);
  }
  process.exit(0);
}
if (stageFilter && selected.length === 0) {
  console.error(`test: no stage matches "${stageFilter}" (see --list)`);
  process.exit(1);
}

const ROOT = new URL("..", import.meta.url).pathname;

function fail(stage: string, cmd: readonly string[], captured?: string): never {
  if (captured) process.stderr.write(captured);
  console.error(`\ntest: FAIL in stage "${stage}"`);
  console.error(`      repro: ${cmd.join(" ")}`);
  process.exit(1);
}

const t0 = Date.now();
for (const stage of selected) {
  const started = Date.now();
  console.log(`\n== ${stage.name} ==`);
  for (const cmd of stage.prep ?? []) {
    const p = Bun.spawnSync(cmd as string[], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) {
      fail(stage.name, cmd, p.stdout.toString() + p.stderr.toString());
    }
  }
  if (stage.script) {
    const p = Bun.spawnSync(stage.script as string[], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (p.exitCode !== 0) fail(stage.name, stage.script);
  }
  if (stage.tests) {
    const cmd = [
      "bun",
      "test",
      ...(stage.browser ? ["--conditions=browser"] : []),
      ...stage.tests,
    ];
    const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) fail(stage.name, cmd);
  }
  console.log(`   ${stage.name}: ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
console.log(
  `\ntest: ${selected.length}/${SUITE.length} stage(s) green in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
