// Rate-limits how often Foreman runs a full (expensive `claude -p`) evaluation of
// the SAME session. The worker's marker idempotency check already skips an UNCHANGED
// waiting episode for free; this adds a wall-clock floor so a session whose marker
// *flaps* - e.g. a terminal surface keyed on a moving `lastActivity` timestamp -
// can't spawn a fresh review on every loop. A session seen for the first time is due
// immediately, so genuinely new work is never delayed; only re-evaluations inside the
// window are held off until it elapses.

/**
 * Per-session minimum interval between full evaluations. In-memory and per-session:
 * a worker restart simply forgets the timestamps (worst case, one session is
 * re-evaluated slightly early after a restart), which is why this lives in the worker
 * loop rather than the persisted note - it governs the worker's own cadence, not the
 * session's handled state. The map is pruned of expired entries on each successful
 * claim, so it stays bounded to sessions seen within the last window. The clock is
 * injectable so tests need no real time. Pure logic - no I/O.
 */
export class EvaluationDebounce {
  private readonly lastEval = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Attempt to claim an evaluation slot for this session. Returns true - and records
   * the current time - when the session is due: it was never evaluated, or its last
   * evaluation was at least `intervalMs` ago. Returns false (record nothing) when a
   * prior evaluation is still inside the window, so the caller skips it for now and a
   * later loop picks it up once the window elapses. The window is measured from the
   * last *successful* claim, so a burst of flapping markers stays rate-limited.
   */
  claim(sessionId: string): boolean {
    const at = this.now();
    const last = this.lastEval.get(sessionId);
    if (last !== undefined && at - last < this.intervalMs) return false;
    this.prune(at);
    this.lastEval.set(sessionId, at);
    return true;
  }

  /** Sessions currently tracked; bounded to those seen within the last window. For metrics/tests. */
  get size(): number {
    return this.lastEval.size;
  }

  /** Drop entries whose window has fully elapsed so the map can't grow unbounded. */
  private prune(at: number): void {
    for (const [id, t] of this.lastEval) {
      if (at - t >= this.intervalMs) this.lastEval.delete(id);
    }
  }
}
