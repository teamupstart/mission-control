export interface CompactionResult { contextTokens: number; contextWindow: number | null }
/** One maintenance operation, bounded and completed only by the driver's own event stream. */
export class CompactionCompletion {
  private pending: { resolve: (result: CompactionResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private observed: CompactionResult | null = null;
  begin(): Promise<CompactionResult> {
    if (this.pending) throw new Error("Compaction is already running.");
    this.observed = null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("Compaction completion was not confirmed."), 60_000);
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
  fail(message: string): void {
    if (!this.pending) return;
    const { reject, timer } = this.pending;
    this.pending = null; clearTimeout(timer); reject(new Error(message));
  }
}
