import type { SubagentSummary } from "@shared/types.ts";

/**
 * How often a driver may report a change that moved only an agent's counters.
 *
 * Every `session_upsert` schedules a Line recompute, and a busy sub-agent reports progress
 * after nearly every tool call. Membership and state changes are what a person is watching
 * for, so those go out at once; token and tool counts can wait a few seconds.
 */
export const SUBAGENT_COUNTER_INTERVAL_MS = 5_000;

/**
 * The part of a summary that must reach the board at once: which agents are listed, in what
 * state, and how many have folded. Counters, last tool and summary text are left out.
 */
function membershipKey(summary: SubagentSummary | null): string {
  if (!summary) return "null";
  return JSON.stringify([
    summary.finishedFolded,
    summary.agents.map((a) => [a.id, a.state, a.type, a.description, a.endedAt, a.launchTurnId]),
  ]);
}

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Coalesces a driver's sub-agent summaries into `subagents` events.
 *
 * Harness-neutral on purpose: every source (Claude SDK, Codex app-server) reduces its own
 * frames into a summary and hands each new one here, so the emission rule is stated once.
 */
export class SubagentEmitter {
  private sent: SubagentSummary | null = null;
  private sentAt = Number.NEGATIVE_INFINITY;
  private latest: SubagentSummary | null = null;
  private timer: unknown = null;

  constructor(
    private readonly emit: (summary: SubagentSummary | null) => void,
    private readonly intervalMs = SUBAGENT_COUNTER_INTERVAL_MS,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Offer the current summary; it is sent now, later, or not at all if nothing moved. */
  update(summary: SubagentSummary | null): void {
    this.latest = summary;
    if (JSON.stringify(summary) === JSON.stringify(this.sent)) {
      this.cancel();
      return;
    }
    if (membershipKey(summary) !== membershipKey(this.sent)) {
      this.flush();
      return;
    }
    const wait = this.sentAt + this.intervalMs - this.clock.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.flush();
      }, wait);
    }
  }

  /** Stop any pending send; the driver is going away. */
  dispose(): void {
    this.cancel();
  }

  private flush(): void {
    this.cancel();
    if (JSON.stringify(this.latest) === JSON.stringify(this.sent)) return;
    this.sent = this.latest;
    this.sentAt = this.clock.now();
    this.emit(this.latest);
  }

  private cancel(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
