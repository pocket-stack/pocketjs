import { createSignal, createMemo, createComputed, createRoot } from 'reactivity';
createRoot(dispose => {
  const [chooseLeft, setChooseLeft] = createSignal(true);
  const [left, setLeft] = createSignal(1);
  const [right, setRight] = createSignal(10);
  const selected = createMemo(() => chooseLeft() ? left() : right());
  createComputed(() => { print(selected()); });
  setLeft(2); setRight(20); setChooseLeft(false); setLeft(3);
  dispose();
});
