import type { VoiceDashboardSnapshot } from "./api.ts";

interface ClockSample {
  daemon: string;
  order: number;
  lower: number;
  upper: number;
}

/** Bounds on daemon time minus the browser's monotonic time. The daemon takes its
 * snapshot between the start of a request and the receipt of its response. */
export class VoiceDashboardClock {
  private sample?: ClockSample;

  constructor(private readonly refresh: (signal: AbortSignal) => Promise<VoiceDashboardSnapshot | null>) {}

  observe(snapshot: VoiceDashboardSnapshot, sentAt: number): void {
    if (!Number.isFinite(snapshot.serverTime)) return;
    const daemon = snapshot.providerRevision.split(":")[0]!;
    let lower = snapshot.serverTime - performance.now();
    let upper = snapshot.serverTime + 1 - sentAt;
    const prior = this.sample;
    if (prior?.daemon === daemon) {
      if (snapshot.snapshotOrder <= prior.order) return;
      if (lower <= prior.upper && prior.lower <= upper) {
        lower = Math.max(lower, prior.lower);
        upper = Math.min(upper, prior.upper);
      }
    }
    this.sample = { daemon, order: snapshot.snapshotOrder, lower, upper };
  }

  async deadline(ms: number, signal: AbortSignal): Promise<number> {
    const start = performance.now();
    if (this.sample && this.sample.upper - this.sample.lower > ms / 4) {
      // A slow first read can consume much of the edit's budget. Take a fresh sample
      // within that same budget; keep the earlier bound if only the response is slow.
      const read = await this.refresh(signal);
      if (read && read.providerRevision.split(":")[0] === this.sample.daemon) this.observe(read, start);
    }
    // The lower bound does not grant extra time to a delayed credential or provider write.
    const serverStart = this.sample ? start + this.sample.lower : Date.now();
    return Math.floor(serverStart) + ms;
  }
}
