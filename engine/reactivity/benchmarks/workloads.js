import { createSignal, createMemo, createComputed, createRoot } from 'reactivity';
const width = 128, iterations = 2000, warmup = 100;
const baseline = metrics();
createRoot(dispose => {
  const [source, set] = createSignal(0), [choose, toggle] = createSignal(true);
  const [other, setOther] = createSignal(100);
  let computations = 0, observations = 0, checksum = 0;
  let update;
  if (CASE === 'untracked') {
    update = i => { for (let j = 0; j < 128; ++j) checksum += source(); set(i); };
  } else if (CASE === 'fanout' || CASE === 'equality') {
    for (let j = 0; j < width; ++j) {
      const m = createMemo(() => { computations++; return CASE === 'equality' ? source() % 2 : source() + j; });
      createComputed(() => { checksum += m(); observations++; });
    }
    update = i => set(CASE === 'equality' ? i * 2 : i);
  } else if (CASE === 'chain') {
    let last = source;
    for (let j = 0; j < width; ++j) {
      const prev = last;
      last = createMemo(() => { computations++; return prev() + 1; });
    }
    createComputed(() => { checksum += last(); observations++; }); update = set;
  } else if (CASE === 'branch') {
    const selected = createMemo(() => { computations++; return choose() ? source() : other(); });
    createComputed(() => { checksum += selected(); observations++; });
    update = i => { set(i); setOther(i + 100); toggle(i % 2 === 0); };
  } else if (CASE === 'expensive') {
    const m = createMemo(() => {
      computations++; let result = source();
      for (let j = 0; j < 2000; ++j) result = (result * 13 + j) % 100003;
      return result;
    });
    createComputed(() => { checksum += m(); observations++; }); update = set;
  } else throw Error('unknown workload');
  for (let i = 1; i <= warmup; ++i) update(i);
  computations = observations = checksum = 0;
  const before = metrics(), samples = [];
  for (let i = 1; i <= iterations; ++i) {
    const start = clockMs(); update(i + warmup); samples.push(clockMs() - start);
  }
  const after = metrics();
  samples.sort((a,b) => a-b);
  const result = { case: CASE, variant: VARIANT, iterations, width, computations, observations, checksum,
    medianUs: samples[Math.floor(iterations / 2)] * 1000,
    p95Us: samples[Math.floor(iterations * 0.95)] * 1000,
    jsToNative: after.jsToNative - before.jsToNative,
    nativeToJs: after.nativeToJs - before.nativeToJs,
    baseline, before, after };
  dispose(); result.disposed = metrics();
  print(JSON.stringify(result));
});
