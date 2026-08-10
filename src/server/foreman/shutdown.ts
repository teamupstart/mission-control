import { flushPendingSpend, pendingSpendReports } from "./client.ts";
import { killLiveLlmRuns } from "../llm/index.ts";

export interface ForemanShutdownClient {
  releaseLease(workerId: string): Promise<void>;
}

export interface ForemanShutdownProcess {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  exit(code: number): never;
}

const workerProcess: ForemanShutdownProcess = {
  on(signal, listener) {
    process.on(signal, listener);
  },
  exit(code) {
    process.exit(code);
  },
};

/**
 * Tear down on an ordinary exit signal. Two things must happen:
 *  - Cancel our reviewers. Print-mode children are detached, so they would survive us;
 *    SDK queries need their AbortControllers fired. A SIGKILL of this process still
 *    cannot run cleanup, but every ordinary path is covered.
 *  - Release the lease, so a standby takes over at once instead of waiting out the TTL.
 *
 * The process boundary is injectable so the signal behavior can be exercised without a
 * test killing its own runner. Cancellation itself always goes through the real registry.
 */
export function installForemanShutdown(
  client: ForemanShutdownClient,
  workerId: string,
  log: (message: string) => void,
  target: ForemanShutdownProcess = workerProcess,
): void {
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    target.on(signal, () => {
      if (closing) target.exit(1);
      closing = true;
      log("shutting down…");
      // Every runner and transport: print children need signals and SDK calls need aborts.
      killLiveLlmRuns();
      // One last attempt to deliver accounting for runs that already happened. Best-effort
      // rather than load-bearing now that the outbox is durable: anything this does not
      // manage to send stays on disk and the next worker picks it up. It still runs first,
      // because delivering now is better than delivering after the next restart.
      if (pendingSpendReports() > 0) log(`flushing ${pendingSpendReports()} spend report(s)…`);
      void flushPendingSpend()
        .catch(() => {})
        .then(() => client.releaseLease(workerId))
        .finally(() => target.exit(0));
    });
  }
}
