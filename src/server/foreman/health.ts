import { createHash } from "node:crypto";
import {
  FOREMAN_HEALTH_MAX_ISSUES, FOREMAN_HEALTH_MAX_SESSIONS, foremanErrorText,
} from "@shared/foreman-health.ts";
import type {
  ForemanHealthIssue, ForemanHealthOperation, ForemanHealthSnapshot,
} from "@shared/foreman-health.ts";
import type { LlmRunnerId } from "@shared/llm.ts";

export interface ForemanHealthContext {
  operation: ForemanHealthOperation;
  runner?: LlmRunnerId;
  model?: string;
  session?: { id: string; name: string };
}

/** Request identifiers and timestamps change between retries, not the underlying failure. */
function fingerprint(error: string): string {
  return error
    .replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, "<id>")
    .replace(/\b(?:req|request|trace)[_-][\w-]+\b/gi, "<request>")
    .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.]+Z?\b/g, "<time>");
}

/** Observability only: no retry, task, lease, or database ownership. */
export class ForemanHealthTracker {
  private issues = new Map<string, ForemanHealthIssue>();
  private revision = 0;
  private truncated = false;
  onChange: (() => void) | null = null;

  failure(context: ForemanHealthContext, reason: unknown, now = Date.now()): void {
    const error = foremanErrorText(reason);
    const { operation } = context;
    const runner = context.runner ?? null;
    const model = context.model?.slice(0, 200) || null;
    const id = createHash("sha256")
      .update(JSON.stringify([operation, runner, model, fingerprint(error)])).digest("hex");
    const previous = this.issues.get(id);
    const issue: ForemanHealthIssue = previous ?? {
      id, operation, runner, model, error, count: 0, firstSeenAt: now, lastSeenAt: now,
      sessions: [], sessionsTruncated: false,
    };
    issue.error = error;
    issue.count = Math.min(1_000_000, issue.count + 1);
    issue.lastSeenAt = Math.max(issue.lastSeenAt, now);
    const session = context.session;
    if (session && !issue.sessions.some((entry) => entry.id === session.id)) {
      if (issue.sessions.length < FOREMAN_HEALTH_MAX_SESSIONS) {
        issue.sessions.push({ id: session.id.slice(0, 200), name: session.name.slice(0, 160) });
      } else issue.sessionsTruncated = true;
    }
    // Refresh insertion order so the bounded record keeps the most recently failing groups.
    this.issues.delete(id);
    this.issues.set(id, issue);
    if (this.issues.size > FOREMAN_HEALTH_MAX_ISSUES) {
      this.issues.delete(this.issues.keys().next().value!);
      this.truncated = true;
    }
    this.changed();
  }

  /** Only a successful execution of the SAME activity/provider/model establishes recovery. */
  success(context: ForemanHealthContext): void {
    let changed = false;
    for (const [id, issue] of this.issues) {
      if (issue.operation !== context.operation || issue.runner !== (context.runner ?? null)
        || issue.model !== (context.model ?? null)) continue;
      this.issues.delete(id);
      changed = true;
    }
    if (changed) this.changed();
  }

  /** A replaced model's diagnostics are no longer about the configured activity. */
  useModel(operation: ForemanHealthOperation, runner: LlmRunnerId, model: string): void {
    let changed = false;
    for (const [id, issue] of this.issues) {
      if (issue.operation === operation && issue.runner !== null
        && (issue.runner !== runner || issue.model !== model)) {
        this.issues.delete(id);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  snapshot(): ForemanHealthSnapshot {
    return structuredClone({
      revision: this.revision, issues: [...this.issues.values()].reverse(), truncated: this.truncated,
    });
  }

  /** Preserve both returned failure values and thrown failures without changing control flow. */
  async observe<T>(
    context: ForemanHealthContext,
    run: () => Promise<T>,
    { recoverOnSuccess = true }: { recoverOnSuccess?: boolean } = {},
  ): Promise<T> {
    try {
      const result = await run();
      const value = result as { kind?: string; reason?: string } | null;
      if (value?.kind === "failed") this.failure(context, value.reason || "Foreman operation failed");
      else if (recoverOnSuccess) this.success(context);
      return result;
    } catch (error) {
      this.failure(context, error);
      throw error;
    }
  }

  private changed(): void {
    this.revision++;
    this.onChange?.();
  }
}

/** Serial, coalesced delivery. A missed report stays pending until the next change/heartbeat. */
export class ForemanHealthPublisher {
  private sentRevision = -1;
  private pending: Promise<void> | null = null;
  private force = false;
  constructor(
    private readonly tracker: ForemanHealthTracker,
    private readonly send: (snapshot: ForemanHealthSnapshot) => Promise<void>,
  ) {}

  flush(force = false): Promise<void> {
    this.force ||= force;
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      for (;;) {
        const snapshot = this.tracker.snapshot();
        if (!this.force && snapshot.revision === this.sentRevision) return;
        this.force = false;
        try { await this.send(snapshot); } catch { return; }
        this.sentRevision = snapshot.revision;
      }
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
