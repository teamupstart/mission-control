/**
 * How long a remembered pane reading survives its pane becoming unreadable.
 *
 * A counter, not a parser: nothing here knows what was on the screen or which agent
 * drew it. It lives outside `pane-mode.ts` for exactly that reason - that module is
 * Claude's footer and menu grammar, and this rule is about `tmux capture-pane`
 * failing, which happens identically whatever is running inside the pane.
 *
 * The rule has two ways to be wrong, in opposite directions: drop a live menu on one
 * flake, or keep drawing a dead one forever. Both are user-visible - the first takes
 * buttons away from under the human's cursor, the second offers rows against a screen
 * nobody can see, where every click is refused and the refusal is the only place it
 * shows.
 *
 * OWNERSHIP, and the thing to get right when a second caller arrives: the counter is
 * process-global, and `forgetPanesExcept` prunes it against ONE caller's idea of which
 * panes are live. Its only caller today is `annotatePaneState`, whose live set is
 * filtered to Claude sessions. A pane that strikes here but is absent from that set has
 * its count wiped on the next 1.5s sweep, so the tolerance quietly stops applying to it
 * and a single flaky capture drops its reading. Anything that calls `paneReadLost` /
 * `paneReadOk` must therefore also be represented in the set passed to
 * `forgetPanesExcept` - one union of every user's panes, not one caller's. The fix is at
 * the pruner's call site, never a harness filter in here: this module is deliberately
 * neutral about what is running inside the pane.
 */

/**
 * How many consecutive unreadable captures a remembered reading survives.
 *
 * Three, at the poller's 1.5s tick: long enough to ride out the flaky `tmux capture-pane`
 * this tolerance exists for (a loaded box timing out at `CAPTURE_TIMEOUT_MS` is the common
 * one), short enough that a pane which is really gone stops being drawn within seconds.
 */
const CAPTURE_MISS_TOLERANCE = 3;

/** Consecutive failed captures per pane token. Cleared the moment one succeeds. */
const captureMisses = new Map<string, number>();

/**
 * Record a failed capture of `key`, and say whether to stop believing what it last showed.
 *
 * Exported for its own test: it is otherwise reachable only through a real `tmux`
 * subprocess.
 */
export function paneReadLost(key: string): boolean {
  const missed = (captureMisses.get(key) ?? 0) + 1;
  if (missed < CAPTURE_MISS_TOLERANCE) {
    captureMisses.set(key, missed);
    return false;
  }
  // Given up: the count goes with the reading, so a pane that comes back is trusted from a
  // clean slate rather than one strike from being dropped again.
  captureMisses.delete(key);
  return true;
}

/** Record a successful capture of `key` - one good read forgives every miss before it. */
export function paneReadOk(key: string): void {
  captureMisses.delete(key);
}

/**
 * Drop the miss counts of every pane not in `live`, at the top of each sweep.
 *
 * A pane whose handle vanishes mid-run is never annotated again and so never reaches the
 * miss/ok calls that would clear it - its count sits in the map for the life of the
 * process. That leaks, but the reason it is a BUG is that the key is a pane token and
 * tmux reuses pane ids: after a restart a brand-new `%1` inherits the dead one's two
 * strikes and is one flaky capture away from having a dialog dropped out from under the
 * human on the first tick it ever showed one.
 *
 * `live` is every pane the COUNTER is used for, not every pane the caller cares about -
 * see the ownership note in the module header before adding a second user.
 */
export function forgetPanesExcept(live: Set<string>): void {
  for (const key of captureMisses.keys()) if (!live.has(key)) captureMisses.delete(key);
}

/** Whether a pane is currently carrying failed-capture strikes. For the counter's test. */
export function paneMissCount(key: string): number {
  return captureMisses.get(key) ?? 0;
}
