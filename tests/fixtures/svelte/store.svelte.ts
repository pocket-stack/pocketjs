// Shared reactive fixture state: the test mutates it, then flushes.
export const state = $state({
  label: "hi",
  on: false,
  items: [
    { id: "a", n: "A" },
    { id: "b", n: "B" },
    { id: "c", n: "C" },
  ] as { id: string; n: string }[],
  presses: 0,
});
