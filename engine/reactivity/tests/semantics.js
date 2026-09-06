import { createSignal, createMemo, createComputed, createRoot } from 'reactivity';
const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(JSON.stringify({actual:a, expected:b})); };
let tests = 0;
function test(fn) { fn(); tests++; }
test(() => createRoot(dispose => {
  const [choose, setChoose] = createSignal(true), [left, setLeft] = createSignal(1), [right, setRight] = createSignal(10);
  let runs = 0; const values = [];
  const selected = createMemo(() => { runs++; return choose() ? left() : right(); });
  createComputed(() => { values.push(selected()); });
  eq(runs, 1); setLeft(2); setRight(20); setChoose(false); setLeft(3);
  eq(values, [1, 2, 20]); eq(runs, 3);
  dispose(); dispose(); setRight(30); eq(values, [1, 2, 20]);
}));
test(() => createRoot(dispose => {
  const [v, set] = createSignal(0); let runs = 0; const values = [];
  const parity = createMemo(() => { runs++; return v() % 2; });
  createComputed(() => { values.push(parity()); });
  set(2); set(2); eq(set(x => x + 1), 3);
  eq(runs, 3); eq(values, [0, 1]); dispose();
}));
test(() => createRoot(dispose => {
  const [v, set] = createSignal(1); const trace = [];
  const a = createMemo(() => v() * 2), b = createMemo(() => v() * 3);
  const sum = createMemo(() => a() + b());
  createComputed(() => { trace.push([sum(), v(), a(), b()]); });
  set(2); set(3); eq(trace, [[5,1,2,3], [10,2,4,6], [15,3,6,9]]); dispose();
}));
test(() => createRoot(dispose => {
  const [v, set] = createSignal(1); let count = 0;
  createComputed(() => { v(); v(); v(); count++; });
  set(2); eq(count, 2); dispose();
}));
test(() => createRoot(dispose => {
  const [v, set] = createSignal(1), [other, setOther] = createSignal(0);
  let children = 0;
  createComputed(() => { v(); createComputed(() => { other(); children++; }); });
  set(2); setOther(1); eq(children, 3); dispose(); setOther(2); eq(children, 3);
}));
test(() => {
  let stop, childStop, set, calls = 0;
  createRoot(dispose => {
    stop = dispose; const [v, write] = createSignal(0); set = write;
    createRoot(disposeChild => { childStop = disposeChild; createComputed(() => { v(); calls++; }); });
  });
  stop(); set(1); eq(calls, 2); childStop(); set(2); eq(calls, 2);
});
test(() => createRoot(dispose => {
  const [v, set] = createSignal(1), values = [];
  const sum = createMemo(previous => previous + v(), 10);
  createComputed(() => { values.push(sum()); }); set(2); eq(values, [11,13]); dispose();
}));
test(() => createRoot(dispose => {
  const [v, set] = createSignal(0); let calls = 0;
  createComputed(() => { v(); calls++; });
  set(-0); set(NaN); set(NaN); set(false); set(0); eq(calls, 5); dispose();
}));
test(() => createRoot(dispose => {
  const [v, set] = createSignal(0); let calls = 0;
  createComputed(() => { if (v() === 1) dispose(); calls++; });
  set(1); set(2); eq(calls, 2);
}));
test(() => {
  const marker = new Error('callback failure'); let caught;
  try { createRoot(dispose => { createMemo(() => { throw marker; }); dispose(); }); }
  catch (error) { caught = error; }
  eq(caught === marker, true);
  createRoot(dispose => {
    const [v, set] = createSignal(0); let observed;
    createComputed(() => { observed = v(); }); set(1); eq(observed, 1); dispose();
  });
});
test(() => createRoot(dispose => {
  const [v, set] = createSignal(0); let newer;
  const selected = createMemo(() => v() === 0 ? 0 : newer());
  newer = createMemo(() => v() + 10);
  const values = []; createComputed(() => { values.push(selected()); });
  set(1); set(2); eq(values, [0,11,12]); dispose();
}));
let differential;
test(() => createRoot(dispose => {
  let seed = 1234567;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * n); };
  const signals = Array.from({length: 6}, () => createSignal(0));
  const reads = signals.map(pair => pair[0]);
  const counts = Array(24).fill(0), observed = Array(8).fill(0), observerCounts = Array(8).fill(0);
  for (let i = 0; i < 24; ++i) {
    const a = reads[random(reads.length)], b = reads[random(reads.length)];
    const choose = signals[random(6)][0];
    reads.push(createMemo(() => { counts[i]++; return (choose() % 2 ? a() : b()) % 7; }));
  }
  for (let i = 0; i < 8; ++i) {
    const read = reads[reads.length - 1 - i];
    createComputed(() => { observed[i] = read(); observerCounts[i]++; });
  }
  let checksum = 0;
  for (let i = 0; i < 500; ++i) {
    signals[random(6)][1](random(30));
    for (const value of observed) checksum = (Math.imul(checksum, 31) + value) | 0;
  }
  differential = {counts, observerCounts, observed, checksum}; dispose();
}));
if (VARIANT !== 'solid') {
  const rejects = fn => { let threw = false; try { fn(); } catch (error) { threw = error instanceof TypeError; } eq(threw, true); };
  rejects(() => createSignal({}));
  rejects(() => createSignal(0, {equals: false}));
  rejects(() => createRoot(async () => {}));
  rejects(() => createMemo(() => Promise.resolve(1)));
  rejects(() => createRoot(dispose => {
    const [v, set] = createSignal(0);
    createComputed(() => { set(v() + 1); }); dispose();
  }));
}
print(JSON.stringify({ tests, status: 'passed', differential }));
