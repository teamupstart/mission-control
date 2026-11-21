import { randomUUID } from "node:crypto";
import type { ManualWorktreeRequestView } from "@shared/types.ts";
import { unref } from "../util/timers.ts";
import { renderClaimArgv } from "./claim.ts";
import type {
  WorktreeAcquireResult,
  WorktreeManager,
  WorktreeOwner,
  WorktreeReleaseResult,
} from "./manager.ts";

// A manual lease whose pool has a dependency claim cannot be acquired inside one HTTP request:
// the claim may run for hours, and Node's fetch gives up after 300 s without response headers,
// leaving a lease granted to an owner nobody holds. So the route accepts with `202` and a
// request id, the acquire runs here in the background, and `make session` polls for it.
//
// In memory by design. After a restart a request is unknown, which the poller reports as a
// restart. Startup recovers a slot whose claim was cut off, and a grant nobody picked up
// before the restart is an ordinary manual lease that Settings > Worktrees can return.

/** How long a grant waits to be picked up by a poll before the daemon returns it. */
export const MANUAL_PICKUP_WINDOW_MS = 10 * 60_000;
/** Settled requests beyond this many are dropped oldest first, so memory stays bounded. */
const MAX_SETTLED_REQUESTS = 256;

/** The part of the worktree manager a manual request uses. */
export type ManualAcquireHost = Pick<WorktreeManager, "acquire" | "release" | "runningClaimFor">;

type RequestState =
  | { kind: "claiming" }
  | {
      kind: "granted";
      result: Extract<WorktreeAcquireResult, { outcome: "acquired" }>;
      pickedUp: boolean;
      timer: ReturnType<typeof setTimeout> | null;
    }
  | { kind: "failed"; reason: string; outcome: "notAcquired" | "outcomeUnknown" | "expired" };

interface ManualRequest {
  id: string;
  owner: WorktreeOwner;
  acceptedAt: number;
  /** When it last stopped changing: a failure, a pickup, or a refused return. */
  settledAt: number | null;
  state: RequestState;
}

export class ManualAcquireRequests {
  private readonly requests = new Map<string, ManualRequest>();
  private stopped = false;

  constructor(
    private readonly host: ManualAcquireHost,
    private readonly options: {
      now: () => number;
      pickupWindowMs: number;
    },
  ) {}

  /**
   * Accept one manual acquire and run it in the background, claim included, under `owner`.
   * Returns the request id the caller polls with.
   */
  start(input: { repositoryPath: string; baseSha: string; owner: WorktreeOwner }): string {
    this.prune();
    const request: ManualRequest = {
      // Unguessable, and never a manager test seam: a request id only ever names this request.
      id: randomUUID(),
      owner: { ...input.owner },
      acceptedAt: this.options.now(),
      settledAt: null,
      state: { kind: "claiming" },
    };
    this.requests.set(request.id, request);
    void this.run(request, input);
    return request.id;
  }

  private async run(
    request: ManualRequest,
    input: { repositoryPath: string; baseSha: string; owner: WorktreeOwner },
  ): Promise<void> {
    let result: WorktreeAcquireResult;
    try {
      result = await this.host.acquire({ ...input, owner: request.owner, runClaim: true });
    } catch (error) {
      result = { outcome: "outcomeUnknown", reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.outcome !== "acquired") {
      this.settle(request, { kind: "failed", reason: result.reason, outcome: result.outcome });
      return;
    }
    // Stopped while the claim ran, after the grant: no pickup timer, so the lease stays an
    // ordinary manual lease, which is what a restart would leave behind anyway.
    const timer = this.stopped
      ? null
      : unref(setTimeout(() => void this.expire(request), this.options.pickupWindowMs));
    request.state = { kind: "granted", result, pickedUp: false, timer };
  }

  /**
   * The request as its poller sees it, or null when this daemon never accepted it. Reading a
   * grant is what picks it up: from then on the daemon never returns it on the caller's behalf.
   */
  view(requestId: string): ManualWorktreeRequestView | null {
    const request = this.requests.get(requestId);
    if (!request) return null;
    const now = this.options.now();
    const elapsedMs = Math.max(0, now - request.acceptedAt);
    const { state } = request;
    switch (state.kind) {
      case "claiming": {
        const running = this.host.runningClaimFor(request.owner);
        const step = running?.step ?? null;
        return {
          requestId,
          state: "claiming",
          elapsedMs,
          step: step
            ? {
                step: step.step,
                stepCount: step.stepCount,
                command: renderClaimArgv(step.argv),
                elapsedMs: Math.max(0, now - step.startedAt),
              }
            : null,
        };
      }
      case "granted": {
        if (!state.pickedUp) {
          state.pickedUp = true;
          if (state.timer) clearTimeout(state.timer);
          state.timer = null;
          request.settledAt = now;
        }
        const { lease, claimWarning } = state.result;
        return {
          requestId,
          state: "granted",
          elapsedMs,
          lease: { path: lease.path, leaseId: lease.leaseId, baseSha: lease.baseSha },
          ...(claimWarning
            ? {
                claimWarning: {
                  step: claimWarning.step,
                  stepCount: claimWarning.stepCount,
                  command: renderClaimArgv(claimWarning.argv),
                  reason: claimWarning.reason,
                  tail: claimWarning.tail,
                  truncatedBytes: claimWarning.truncatedBytes,
                },
              }
            : {}),
        };
      }
      case "failed":
        return { requestId, state: "failed", elapsedMs, reason: state.reason, outcome: state.outcome };
    }
  }

  /**
   * A grant nobody polled for within the window. The caller is gone, so the lease would
   * otherwise belong to an owner nobody holds until someone found it in Settings. It goes back
   * through the ordinary owner-authorized return, which refuses a dirty or occupied slot: a
   * slot someone is working in stays leased.
   */
  private async expire(request: ManualRequest): Promise<void> {
    const { state } = request;
    if (state.kind !== "granted" || state.pickedUp) return;
    const minutes = Math.round(this.options.pickupWindowMs / 60_000);
    const window = minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${this.options.pickupWindowMs} ms`;
    const { lease } = state.result;
    // Settled before the return starts, so a late poll can never be handed a slot being reset.
    this.settle(request, {
      kind: "failed",
      outcome: "expired",
      reason: `The lease was not picked up within ${window}, so Mission Control is returning it.`,
    });
    let released: WorktreeReleaseResult;
    try {
      released = await this.host.release(lease, { ownerAuthorized: true, requireClean: true });
    } catch (error) {
      released = { outcome: "outcomeUnknown", reason: error instanceof Error ? error.message : String(error) };
    }
    if (released.outcome === "released" || released.outcome === "alreadyReleased") {
      this.settle(request, {
        kind: "failed",
        outcome: "expired",
        reason: `The lease was not picked up within ${window}, so Mission Control returned it to the pool.`,
      });
      console.warn(`[worktrees] returned manual lease ${lease.leaseId}: nobody picked it up within ${window}`);
      return;
    }
    this.settle(request, {
      kind: "failed",
      outcome: "expired",
      reason:
        `The lease was not picked up within ${window}, and Mission Control could not return it ` +
        `(${released.reason}). It stays leased; Settings > Worktrees can return it.`,
    });
    console.warn(
      `[worktrees] manual lease ${lease.leaseId} was not picked up within ${window} and stays leased: ${released.reason}`,
    );
  }

  private settle(request: ManualRequest, state: Extract<RequestState, { kind: "failed" }>): void {
    request.state = state;
    request.settledAt = this.options.now();
  }

  /**
   * Drop settled requests once their poller has had a pickup window to read the outcome, and
   * the oldest beyond a fixed count. A request still claiming, or a grant still waiting, is
   * never dropped.
   */
  private prune(): void {
    const now = this.options.now();
    const settled: ManualRequest[] = [];
    for (const request of this.requests.values()) {
      if (request.settledAt === null) continue;
      if (now - request.settledAt >= this.options.pickupWindowMs) this.requests.delete(request.id);
      else settled.push(request);
    }
    settled.sort((a, b) => a.settledAt! - b.settledAt!);
    for (const request of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_REQUESTS))) {
      this.requests.delete(request.id);
    }
  }

  /** Re-arm after `stop`, for a manager restarted in the same process (tests). */
  resume(): void {
    this.stopped = false;
  }

  /** Shutdown: no grant is returned on a caller's behalf after this. */
  stop(): void {
    this.stopped = true;
    for (const request of this.requests.values()) {
      if (request.state.kind === "granted" && request.state.timer) {
        clearTimeout(request.state.timer);
        request.state.timer = null;
      }
    }
  }
}
