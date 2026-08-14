import type { LlmRunnerId } from "@shared/llm.ts";
import type { ForemanPlannerHealth } from "@shared/types.ts";

export interface PlannerIdentity {
  runner: LlmRunnerId;
  model: string;
}

export interface PlannerCircuitOptions {
  failureCap: number;
  retryMs: number;
  storeBackoffMs: number;
  storeBackoffMaxMs: number;
}

const SAFE_ERROR_MAX = 400;

function safeError(reason: unknown): string {
  const line = String(reason).replace(/\s+/g, " ").trim();
  return (line || "unknown planner failure").slice(0, SAFE_ERROR_MAX);
}

/**
 * The worker's one process-local circuit for dependency planning and plan storage.
 *
 * It owns no task or database state. `decideBacklogTick` remains the scheduler and the
 * daemon remains the plan store; this only answers whether that machine may ask for a plan
 * or must use its existing serial safety arm.
 */
export class BacklogPlannerCircuit {
  private identity: PlannerIdentity | null = null;
  private plannerFailures = 0;
  private plannerRetryAt = 0;
  private storeFailures = 0;
  private storeRetryAtValue = 0;
  private degraded = false;
  private probePending = false;
  private lastErrorValue: string | null = null;

  constructor(private readonly options: PlannerCircuitOptions) {}

  /**
   * Apply the effective provider/model pair. A real change retires every strike earned by
   * the old pair and forces a fresh plan read even when the stored plan still covers the
   * backlog. The first observation merely initializes the circuit.
   */
  setIdentity(next: PlannerIdentity): "initial" | "changed" | "same" {
    if (!this.identity) {
      this.identity = next;
      return "initial";
    }
    if (this.identity.runner === next.runner && this.identity.model === next.model) return "same";
    this.identity = next;
    this.reset();
    this.probePending = true;
    return "changed";
  }

  /** Let the operator spend exactly one immediate probe without removing the fallback. */
  requestProbe(): void {
    this.probePending = true;
    this.plannerRetryAt = 0;
    this.storeRetryAtValue = 0;
  }

  /** Rearm one automatic probe after the cooldown. */
  rearm(now: number): boolean {
    if (!this.degraded || this.probePending || now < this.nextRetryAt(now)) return false;
    this.probePending = true;
    return true;
  }

  /** A requested probe deliberately presents a stale plan to the scheduler. */
  shouldProbe(): boolean {
    return this.probePending;
  }

  /** Serial mode is the safety fallback between bounded probes. */
  serial(): boolean {
    return this.degraded && !this.probePending;
  }

  /** Storage failures back off before another model call, unless a retry explicitly rearmed it. */
  storeRetryAt(): number {
    return this.storeRetryAtValue;
  }

  onPlanningFailure(reason: unknown, now: number): void {
    this.plannerFailures++;
    this.plannerRetryAt = now + this.options.retryMs;
    this.lastErrorValue = safeError(reason);
    this.probePending = false;
    if (this.plannerFailures >= this.options.failureCap) this.degraded = true;
  }

  onStoreFailure(reason: unknown, now: number): void {
    this.storeFailures++;
    const wait = this.options.storeBackoffMs * 2 ** Math.max(0, this.storeFailures - 1);
    this.storeRetryAtValue = now + Math.min(wait, this.options.storeBackoffMaxMs);
    this.lastErrorValue = safeError(reason);
    this.probePending = false;
    if (this.storeFailures >= this.options.failureCap) this.degraded = true;
  }

  /** A plan is healthy only once both the provider answer and daemon write succeeded. */
  onSuccess(): void {
    this.reset();
  }

  health(now: number): ForemanPlannerHealth | null {
    if (!this.identity) return null;
    // The two paths earn strikes independently, but once either opens the circuit a probe
    // failure on the other path must not make the visible count look lower than the cap.
    const failureCount = Math.max(this.plannerFailures, this.storeFailures);
    return {
      state: this.degraded ? "degraded" : "healthy",
      runner: this.identity.runner,
      model: this.identity.model,
      failureCount,
      lastError: this.lastErrorValue,
      nextRetryAt: this.degraded ? this.nextRetryAt(now) : null,
    };
  }

  private nextRetryAt(now: number): number {
    if (this.probePending) return now;
    const waits = [
      this.plannerFailures >= this.options.failureCap ? this.plannerRetryAt : 0,
      this.storeFailures >= this.options.failureCap ? this.storeRetryAtValue : 0,
    ];
    return Math.max(now, ...waits);
  }

  private reset(): void {
    this.plannerFailures = 0;
    this.plannerRetryAt = 0;
    this.storeFailures = 0;
    this.storeRetryAtValue = 0;
    this.degraded = false;
    this.probePending = false;
    this.lastErrorValue = null;
  }
}
