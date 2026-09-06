import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || 'test';
if (!['test', 'bench', 'example'].includes(mode)) throw Error('Expected test, bench, or example');
const runner = process.env.REACTIVITY_RUNNER || resolve(base, 'build/reactivity-runner');
const dir = mkdtempSync(resolve(tmpdir(), 'reactivity-'));
const expected = new Map();
const scenarios = mode === 'bench' ? ['untracked', 'fanout', 'equality', 'chain', 'branch', 'expensive'] : ['test'];
const repeats = mode === 'bench' ? 3 : 1;
try {
  for (const scenario of scenarios) {
    for (let repeat = 0; repeat < repeats; ++repeat) {
      // Rotate execution order; every sample gets a fresh QuickJS process.
      const variants = ['solid', 'reference', 'native'];
      for (let index = 0; index < variants.length; ++index) {
        const variant = variants[(index + repeat) % variants.length];
        const target = variant === 'solid' ? resolve(base, 'node_modules/solid-js/dist/solid.js')
          : resolve(base, variant === 'native' ? 'bindings/quickjs/index.js' : 'benchmarks/reference.js');
        const outfile = resolve(dir, `${variant}.js`);
        const entry = mode === 'test' ? 'tests/semantics.js' : mode === 'bench' ? 'benchmarks/workloads.js' : 'examples/branch.js';
        await build({ entryPoints: [resolve(base, entry)], bundle: true, format: 'iife', platform: 'neutral',
          outfile, alias: { reactivity: target },
          define: { VARIANT: JSON.stringify(variant), CASE: JSON.stringify(scenario) } });
        const result = spawnSync(runner, [outfile], { encoding: 'utf8', timeout: 120000 });
        if (result.status !== 0) throw Error(`${variant}: ${result.error || result.stderr}`);
        if (mode === 'bench') {
          const row = JSON.parse(result.stdout);
          const behavior = JSON.stringify([row.computations, row.observations, row.checksum]);
          if (expected.has(scenario) && expected.get(scenario) !== behavior)
            throw Error(`Behavior mismatch: ${scenario}/${variant}`);
          expected.set(scenario, behavior);
          process.stdout.write(`${JSON.stringify({ repeat, ...row })}\n`);
        } else {
          if (mode === 'test') {
            if (expected.has('test') && expected.get('test') !== result.stdout)
              throw Error(`Test trace mismatch: ${variant}`);
            expected.set('test', result.stdout);
          }
          process.stdout.write(`${variant}: ${result.stdout}`);
        }
      }
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
