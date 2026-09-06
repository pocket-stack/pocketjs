// Algorithm control: the same states, edge vectors, queue and owner cleanup as core/reactivity.c.
const nodes = [], queue = [];
let owner = null, listener = null, flushing = false;
function node(kind, value, fn) {
  const n = { kind, value, fn, owner: kind === 0 || kind === 3 ? null : owner,
    state: kind === 1 || kind === 2 ? 2 : 0, running: false, disposed: false,
    sources: [], observers: [], owned: [] };
  nodes.push(n);
  if (n.owner) n.owner.owned.push(n);
  return n;
}
function detach(n) {
  for (const source of n.sources) {
    const i = source.observers.indexOf(n);
    source.observers[i] = source.observers[source.observers.length - 1];
    source.observers.pop();
  }
  n.sources.length = 0;
}
function children(n) { for (const c of n.owned) dispose(c); n.owned.length = 0; }
function dispose(n) {
  if (n.disposed) return;
  n.disposed = true; n.state = 0; children(n); detach(n); n.fn = null;
  n.sources = []; n.owned = [];
}
function mark(n, state) {
  if (n.disposed) return;
  const old = n.state;
  n.state = Math.max(old, state);
  if (old) return;
  queue.push(n);
  for (const o of n.observers) mark(o, 1);
}
function changed(n) { for (const o of n.observers) mark(o, 2); }
function valid(v, optional = false) {
  if (typeof v !== 'number' && typeof v !== 'boolean' && !(optional && v === undefined))
    throw new TypeError('Solid API subset accepts only numbers/booleans');
  return v;
}
function update(n) {
  if (n.disposed || !n.state) return;
  if (n.running) throw new Error('cycle');
  n.running = true;
  try {
    for (const s of n.sources) update(s);
    if (n.state === 2) {
      children(n); detach(n);
      const oldOwner = owner, oldListener = listener;
      owner = listener = n;
      let value;
      try { value = valid(n.fn(n.value), n.kind === 2); }
      finally { owner = oldOwner; listener = oldListener; }
      if (value !== n.value) { n.value = value; changed(n); }
    }
    n.state = 0;
  } finally { n.running = false; }
}
function read(n) {
  update(n);
  if (listener && !listener.disposed && !n.disposed && !listener.sources.includes(n)) {
    listener.sources.push(n); n.observers.push(listener);
  }
  return n.value;
}
export function createSignal(value) {
  if (arguments.length > 1) throw new TypeError('options outside subset');
  const n = node(0, valid(value));
  return [() => read(n), value => {
    if (typeof value === 'function') {
      const old = listener; listener = null;
      try { value = value(n.value); } finally { listener = old; }
    }
    valid(value);
    if (listener || flushing) throw new TypeError('reentrant write');
    if (n.value === value) return value;
    n.value = value; changed(n); flushing = true;
    try { for (let i = 0; i < queue.length; ++i) update(queue[i]); }
    finally { for (const q of queue) q.state = 0; queue.length = 0; flushing = false; }
    return value;
  }];
}
function computation(kind, fn, value) {
  if (typeof fn !== 'function') throw new TypeError('callback required');
  const n = node(kind, valid(value, true), fn);
  try { update(n); } catch (error) { dispose(n); throw error; }
  return kind === 1 ? () => read(n) : undefined;
}
export function createMemo(fn, value) {
  if (arguments.length > 2) throw new TypeError('options outside subset');
  return computation(1, fn, value);
}
export function createComputed(fn, value) {
  if (arguments.length > 2) throw new TypeError('options outside subset');
  return computation(2, fn, value);
}
export function createRoot(fn) {
  if (arguments.length > 1 || typeof fn !== 'function') throw new TypeError('callback required; options outside subset');
  const n = node(3), oldOwner = owner, oldListener = listener;
  owner = n; listener = null;
  try {
    const result = fn(() => dispose(n));
    if (result instanceof Promise) throw new TypeError('async roots are outside the subset');
    return result;
  }
  catch (error) { dispose(n); throw error; }
  finally { owner = oldOwner; listener = oldListener; }
}
