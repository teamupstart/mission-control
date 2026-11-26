/** Synchronize a fixture with an observed event without introducing a clock delay. */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
