import { envVar } from "@shared/harness-runtime.mjs";

export interface CompactionResult { contextTokens: number; contextWindow: number | null }

/**
 * How long one maintenance compaction may run before it is declared stalled.
 *
 * A fixed deadline, deliberately not one that progress extends: during a network outage the
 * CLI keeps emitting retry frames for a request that will never land, and a deadline that
 * every frame pushed back would never fire in exactly the case it exists for. Ten minutes is
 * far longer than a healthy compaction of the largest window takes.
 */
export function compactionStallMs(raw = envVar("RESIDENT_COMPACTION_STALL_MS")): number {
  const ms = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isInteger(ms) && ms > 0 ? ms : 600_000;
}

/** A compaction that failed. `retryable` is false when the session may still be mid-turn. */
export class CompactionError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}

/**
 * One maintenance operation, bounded and completed only by the driver's own event stream.
 *
 * A stalled operation is interrupted, not abandoned: rejecting the caller while the driver's
 * `/compact` turn stays open would leave the session working forever and every later wake
 * refused behind it.
 */
export class CompactionCompletion {
  private pending: { resolve: (result: CompactionResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private observed: CompactionResult | null = null;
  constructor(private readonly stallMs = compactionStallMs()) {}
  begin(interrupt: () => Promise<void>): Promise<CompactionResult> {
    if (this.pending) throw new Error("Compaction is already running.");
    this.observed = null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => void this.stall(interrupt), this.stallMs);
      timer.unref();
      this.pending = { resolve, reject, timer };
    });
  }
  observe(contextTokens: number | null, contextWindow: number | null): void {
    if (this.pending && contextTokens !== null && Number.isFinite(contextTokens) && contextTokens >= 0) {
      this.observed = { contextTokens, contextWindow };
    }
  }
  finish(): void {
    if (!this.pending) return;
    if (!this.observed) { this.fail("Compaction ended without a measured context boundary."); return; }
    const { resolve, timer } = this.pending;
    this.pending = null; clearTimeout(timer); resolve(this.observed);
  }
  fail(message: string, retryable = true): void {
    if (!this.pending) return;
    const { reject, timer } = this.pending;
    this.pending = null; clearTimeout(timer); reject(new CompactionError(message, retryable));
  }
  private async stall(interrupt: () => Promise<void>): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    // Detach first, so the interrupted turn's own `result` cannot settle this operation as
    // "ended without a boundary" and hide that it stalled.
    this.pending = null;
    const [count, unit] = this.stallMs >= 60_000 ? [Math.round(this.stallMs / 60_000), "minute"] : [Math.max(1, Math.round(this.stallMs / 1000)), "second"];
    const stalled = `Compaction made no progress for ${count} ${unit}${count === 1 ? "" : "s"}`;
    let bound: NodeJS.Timeout | undefined;
    try {
      // The interrupt is a request to the same CLI that stopped answering. Bound it too.
      await Promise.race([interrupt(), new Promise<never>((_, reject) => {
        bound = setTimeout(() => reject(new Error("the interrupt was not acknowledged")), 30_000);
        bound.unref();
      })]);
      pending.reject(new CompactionError(`${stalled} and was interrupted.`));
    } catch (error) {
      pending.reject(new CompactionError(`${stalled} and could not be interrupted: ${error instanceof Error ? error.message : String(error)}`, false));
    } finally { clearTimeout(bound); }
  }
}
