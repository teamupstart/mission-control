// "Only the newest read may land."
//
// A poller that fires on a timer does not wait for its previous request, so two reads are
// routinely in flight at once - and nothing makes them resolve in the order they were
// issued. The failure that produces is specific and looks like data loss: a slow response
// settles after a newer one and overwrites it with an older snapshot, so something the
// server has already recorded disappears from the screen until the next poll happens to
// succeed.
//
// This is the guard, extracted rather than left as a `useRef` counter inside the hook so
// it can actually be tested: the dashboard's test setup is `renderToStaticMarkup` with no
// jsdom (see the house rules), which means effects never run and a hook's ordering
// behaviour is unreachable from a test. A four-line pure object is.

/** Hands out read tokens and says which one is still the newest. */
export interface Sequencer {
  /**
   * Claim the next token, retiring every token handed out before it.
   *
   * Call this when a read STARTS, not when it finishes - the point is to order reads by
   * when they were issued. A writer calls it too, to retire reads that began before the
   * write and would otherwise repaint its result away.
   */
  begin(): number;
  /** Whether `token` is still the newest one claimed - i.e. may this result be applied? */
  isCurrent(token: number): boolean;
}

export function createSequencer(): Sequencer {
  let seq = 0;
  return {
    begin: () => ++seq,
    isCurrent: (token: number) => token === seq,
  };
}
