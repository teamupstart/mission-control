import type { CodeRabbitFollowup, CodeRabbitSummary } from "@shared/code-rabbit.ts";
import { resolvedSessionIntent } from "@shared/goal.ts";
import { reportBucket } from "@shared/session.ts";
import { taskRepoRefs } from "@shared/task-repos.ts";
import { codeRabbitSummary, getInspectorPr, readCodeRabbit } from "../db.ts";
import { getForemanConfig } from "../foreman/config.ts";
import { activeWorkflowOwnsSession, decideReviewFollowup, followupPrs } from "../foreman/review-followup.ts";
import { foremanMayActLive } from "../foreman/verdict.ts";
import { noteKeyFor, type Registry } from "../registry.ts";
import { codeRabbitEnabled } from "../shipping/config.ts";

/** Rebuilt at claim AND inside the runtime's write lock. No worker boolean is authority. */
export function codeRabbitCandidate(registry: Registry, sessionId: string, request: CodeRabbitFollowup, claimId?: string) {
  const session = registry.getSession(sessionId);
  const row = getInspectorPr(request.prKey);
  if (!session || !row || row.state !== "open") return { error: "PR or owning session is unavailable" } as const;
  const sessions = registry.liveSessions();
  const owners = sessions.filter((s) => followupPrs(s).some((p) => p.prKey === row.key));
  if (owners.length !== 1 || owners[0]!.id !== sessionId) return { error: "PR ownership is unknown or changed" } as const;
  const pr = followupPrs(session).find((p) => p.prKey === row.key);
  const episodeKey = resolvedSessionIntent(registry.getGoal(sessionId))?.episodeKey;
  if (!pr || !episodeKey) return { error: "Current PR intent episode is unknown" } as const;
  const owner = { noteKey: noteKeyFor(session), episodeKey };
  const task = session.task ? registry.getTask(session.task.id) : null;
  const target = task ? taskRepoRefs(task).find((r) => r.repoRoot === (pr.repoRoot ?? session.repoRoot)) : null;
  const checkout = target?.worktreePath ?? (pr.repoRoot === null || pr.repoRoot === session.repoRoot ? session.cwd : null);
  const branch = target?.branch ?? session.gitBranch;
  if (!checkout || checkout !== row.cwd || (pr.repoRoot ?? session.repoRoot) !== row.repoRoot || branch !== row.headRefName) {
    return { error: "PR checkout or branch ownership changed" } as const;
  }
  const record = readCodeRabbit(row.key);
  const summary = codeRabbitSummary(row.key, owner);
  if (summary.status !== "complete" || record?.observationId !== request.observationId
    || record.headSha !== row.observedHeadSha || record.state !== "OPEN" || record.draft) {
    return { error: "CodeRabbit observation is stale, incomplete, closed or draft" } as const;
  }
  if (claimId && !record.receipts.some((receipt) => receipt.claimId === claimId && receipt.outcome === "uncertain"
    && receipt.noteKey === owner.noteKey && receipt.episodeKey === owner.episodeKey
    && receipt.observationId === request.observationId && receipt.headSha === record.headSha)) {
    return { error: "CodeRabbit delivery claim is no longer current" } as const;
  }
  if (!codeRabbitEnabled()) return { error: "CodeRabbit follow-up is off or unavailable" } as const;
  if (session.pendingTurns?.length) return { error: "Queued conversation turns own this session" } as const;
  const cfg = getForemanConfig();
  const workflowOwnsSession = activeWorkflowOwnsSession(registry.workflowRunSummaries().filter((r) => r.noteKey === owner.noteKey || r.sessionId === sessionId));
  const currentPr = { ...pr, repoRoot: checkout, inspector: { ...pr.inspector!, codeRabbit: summary } };
  const decision = decideReviewFollowup({
    session, pr: currentPr, mark: null, now: Date.now(), bucket: reportBucket(session, sessions),
    mayActLive: foremanMayActLive(cfg, session.cwd, session.repoRoot) && foremanMayActLive(cfg, checkout, row.repoRoot),
    workflowOwnsSession,
    ...(claimId ? { claimedCodeRabbit: request } : {}),
    cfg: { trackReviewComments: cfg.trackReviewFeedback, trackCiFailures: cfg.trackCiFailures, codeRabbitAutoResolve: true,
      settleMs: Number(process.env.FOREMAN_QUEUE_SETTLE_MS || 10_000) },
  });
  if (decision.kind === "skip") return { error: decision.why } as const;
  if (!decision.codeRabbit) return { error: "No eligible CodeRabbit feedback" } as const;
  return { owner, session, payload: decision.payload, summary, checkout } as const;
}

/** Settings uses the same live eligibility explanation as delivery. */
export function codeRabbitStanding(registry: Registry, prKey: string): CodeRabbitSummary {
  const sessions = registry.liveSessions().filter((s) => followupPrs(s).some((p) => p.prKey === prKey));
  const session = sessions.length === 1 ? sessions[0] : undefined;
  const episodeKey = session && resolvedSessionIntent(registry.getGoal(session.id))?.episodeKey;
  const summary = codeRabbitSummary(prKey, session && episodeKey ? { noteKey: noteKeyFor(session), episodeKey } : undefined);
  if (!session || !summary.observationId || !summary.pending) return summary;
  try {
    const candidate = codeRabbitCandidate(registry, session.id, { prKey, observationId: summary.observationId });
    if (candidate.error !== undefined) return { ...summary, delivery: candidate.error };
  } catch { return { ...summary, delivery: "Delivery prerequisites are unavailable" }; }
  return summary;
}
