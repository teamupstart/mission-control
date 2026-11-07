import type { ForemanConfig } from "@shared/protocol.ts";
import type { InspectorPr, Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { reportBucket } from "@shared/session.ts";
import {
  buildStackPrompt,
  deriveStackState,
  stackActions,
  stackBrokenReason,
  stackLifecycleLabel,
  stackPrNumber,
  stackPromptNeed,
  type StackPromptActionKind,
  type StackPromptRequest,
  type StackObservation,
  type StackPromptStatus,
  type StackStanding,
} from "@shared/stacking.ts";
import { latestStackedPr, readStackPromptClaim } from "../db.ts";
import type { StackGitHub } from "./github.ts";
import { activeWorkflowOwnsSession, followupPrs, followupSessionBlocker, followupStableBlocker, foremanSettleMs } from "../foreman/review-followup.ts";
import { foremanMayActLive } from "../foreman/verdict.ts";
import { hasPane } from "../foreman/queue-machine.ts";

// Stacked pull requests: delivering the catch-up and restack prompts, and the broken-stack
// actions, through the SAME path the CodeRabbit follow-up uses. Foreman's review follow-up
// decides when to type (`decideReviewFollowup`), the daemon's inject route claims before it
// sends and settles the claim after, and the text is rebuilt here from the row - never taken
// from the caller. The daemon never becomes a second autonomous writer into a pane
// (`src/server/skills/reload.ts` says why), and it never runs git in the worktree: the session
// does the merge, the cherry-pick or the new pull request.

/** The blocker that reads as plain "Foreman is off". */
const FOREMAN_OFF = "Foreman is off";

/** What standing and delivery need from the Registry. */
export interface StackDeliveryRegistry {
  liveSessions(): Session[];
  getSession(id: string): Session | undefined;
  workflowRunSummaries(): WorkflowRunSummary[];
}

/**
 * The live sessions that own a stacked child: the ones running the task its lineage names.
 * Keyed to the TASK rather than the session that opened the pull request, so a session the
 * operator resumes with **Resume** owns it as soon as it is live.
 */
export function stackOwners(sessions: readonly Session[], row: InspectorPr): Session[] {
  const taskId = row.stack?.taskId;
  if (!taskId) return [];
  return sessions.filter((s) => s.state !== "exited" && s.task?.id === taskId);
}

/**
 * Why Foreman will never type into this session as things stand, or null when it will once the
 * session is free. Foreman's own stable session rule (`followupStableBlocker`), the one its
 * decision and the delivery recheck also apply, so the merge queue can never show a prompt as
 * on its way that Foreman would refuse: switched off or not live, not invited, an agent it
 * cannot drive, no hooks seen, no pane, or not allowed to act here. Transient holds (busy, a
 * queue, a workflow, not settled yet) are not reasons: they clear by themselves.
 */
function foremanBlocker(cfg: ForemanConfig, s: Session): string | null {
  if (!cfg.enabled || cfg.mode !== "live") return FOREMAN_OFF;
  // The session half of the rule, then the repository half said in the operator's words
  // (Foreman's own log line for it is "dry-run or off-allowlist - won't type").
  return followupStableBlocker(s, true)
    ?? (foremanMayActLive(cfg, s.cwd, s.repoRoot) ? null : "Foreman is not allowed in this repository");
}

/**
 * Where one stacked child stands, for the merge queue, the session card and Foreman. Null for
 * a row without lineage. Computed on read, from the row's lineage, its last observation and
 * the prompt claims - never from the task or the Shipping setting.
 */
export function stackStandingFor(
  row: InspectorPr,
  sessions: readonly Session[],
  foreman: ForemanConfig,
): StackStanding | null {
  const lineage = row.stack;
  if (!lineage) return null;
  // An observation of a different parent (written before a replacement took over) describes
  // nothing about this one: read as unobserved until the next tick.
  const o = lineage.observation?.parentUrl === lineage.parentPrUrl ? lineage.observation : null;
  const state = deriveStackState({ observation: o, releasedHeadSha: lineage.releasedHeadSha });
  const owners = stackOwners(sessions, row);
  const owner = owners.length === 1 ? owners[0]! : null;
  const need = row.state === "open" ? stackPromptNeed(state, o) : null;
  let prompt: StackStanding["prompt"] = null;
  if (need) {
    const claim = readStackPromptClaim(row.key, need.kind, need.tip);
    const blocker = owner ? foremanBlocker(foreman, owner) : null;
    const status: StackPromptStatus = claim?.outcome === "delivered"
      ? "sent"
      : claim
      ? "uncertain"
      : !owner
      ? "no-session"
      : !hasPane(owner)
      ? "no-pane"
      : blocker
      ? "foreman-off"
      : "pending";
    prompt = { ...need, status, ...(status === "foreman-off" && blocker && blocker !== FOREMAN_OFF ? { blocker } : {}) };
  }
  const parentUrl = lineage.parentPrUrl;
  const parentNumber = stackPrNumber(lineage.parentPrUrl);
  const retargetError = row.state === "open" ? o?.retargetError ?? null : null;
  const brokenReason = state === "broken" && o ? stackBrokenReason(o) : null;
  // A closed child that a later pull request of the same task and episode has replaced (the
  // *Move onto main* or *Reopen against main* result, which inherited this row's lineage) is
  // history: nothing is offered on it, and it says what replaced it.
  const latest = row.state === "open" ? null : latestStackedPr(lineage.taskId, row.owner, row.repo, lineage.episode);
  const replacedBy = latest && latest.key !== row.key && latest.stack && latest.stack.adoptedAt >= lineage.adoptedAt ? latest : null;
  const actions = replacedBy
    ? []
    : stackActions(state, o).filter((action) => action !== "await-replacement" || !lineage.awaitReplacementAt);
  // Recovery prompts already delivered for this exact stack state: shown as sent, not offered.
  const actionTip = stackActionTip(o);
  const sentActions = actions.filter((action) =>
    (action === "move-onto-main" || action === "reopen-against-main" || action === "reopen-on-parent")
    && readStackPromptClaim(row.key, action, actionTip)?.outcome === "delivered");
  const lifecycle = stackLifecycleLabel({ state, parentNumber, brokenReason, retargetError, prompt }, o);
  // The parent could not be read on the last tick: say so instead of acting on what may be
  // stale - no prompt and no action is offered (`stackPromptNeed`, `stackActions`).
  const unread = Boolean(o?.parentUnreadSince) && lifecycle.label !== null && !replacedBy;
  const inProgress = unread ? false : lifecycle.inProgress;
  const label = replacedBy && lifecycle.label
    ? `Replaced by #${replacedBy.number}`
    : unread
    ? `Checking ${parentNumber === null ? "its parent" : `#${parentNumber}`} on GitHub - prompts wait until it can be read`
    : lifecycle.label;
  return {
    state,
    parentUrl,
    parentNumber,
    brokenReason,
    retargetError,
    prompt,
    actions,
    awaitingReplacement: Boolean(lineage.awaitReplacementAt) && state === "broken",
    sessionId: owner?.id ?? null,
    sentActions,
    sessionHasPane: owner ? hasPane(owner) : false,
    parentTaskId: o?.parentTaskId ?? null,
    label: lineage.awaitReplacementAt && state === "broken" && brokenReason === "parent-closed" && !unread
      ? `${label} - waiting for a replacement`
      : label,
    inProgress,
    facts: {
      prNumber: row.number,
      prUrl: row.url,
      headRefName: row.headRefName,
      parentNumber,
      parentUrl: lineage.parentPrUrl,
      parentHeadRefName: o?.parentHeadRefName ?? null,
      defaultBranch: o?.defaultBranch ?? null,
    },
  };
}

/**
 * Read the current parent again right before a broken-stack recovery prompt is typed, and
 * refuse when it no longer matches what the offer was based on. The action was chosen from the
 * parent's last observed state, and the parent can merge or close in between: *Reopen on #A's
 * branch* sent after #A merged would name a branch that may be gone. A read of GitHub only;
 * null when the offer still stands.
 */
export async function recheckStackParent(
  row: InspectorPr | null,
  kind: StackPromptActionKind,
  github: StackGitHub,
): Promise<string | null> {
  const lineage = row?.stack;
  const o = lineage?.observation;
  if (!row || !lineage || !o || o.parentUrl !== lineage.parentPrUrl) return "The stack has not been checked yet - try again after the next check";
  const parent = stackPrNumber(lineage.parentPrUrl);
  const name = parent === null ? "The parent" : `#${parent}`;
  const read = await github.prRefs(row.cwd ?? row.repoRoot, lineage.parentPrUrl);
  if (!read.ok || !read.value) return `${name} could not be read from GitHub - try again once it can`;
  const changed = read.value.state !== o.parentState
    || (kind === "reopen-on-parent" && (read.value.headRefName || null) !== o.parentHeadRefName);
  return changed ? `${name} changed since it was last checked - the row updates on the next check` : null;
}

/**
 * The stack state a broken-stack recovery action answers, as its claim key: the current parent
 * and its state and branch, and the child's state. A recovery that changes any of them (a
 * replacement opened, the parent merged) makes a new key, so the action can be offered again.
 */
export function stackActionTip(o: StackObservation | null): string {
  return [o?.parentUrl ?? "", o?.parentState ?? "", o?.parentHeadRefName ?? "", o?.childState ?? ""].join("|");
}

export type StackCandidate =
  | { error: string }
  | {
      error?: undefined;
      session: Session;
      standing: StackStanding;
      payload: string;
      /** The claim key for a prompt; null for an action, which is not claimed. */
      /** The claim key: a prompt's condition tip, or the stack state a recovery action answers. */
      claim: { kind: StackPromptRequest["kind"]; tip: string };
    };

/**
 * Rebuilt at claim AND inside the transport's write lock, like `codeRabbitCandidate`: no
 * caller's boolean is authority. Refuses unless the request still names what this child needs
 * right now, the session is its one live owner, and nothing else owns the session.
 *
 * `origin` decides the one thing that differs. Foreman's automatic delivery passes the whole
 * review follow-up decision (invited, live, allowlisted, settled idle, no work queue, no
 * workflow) and only for a prompt that is still pending. The operator's manual send - the
 * button shown when Foreman is off, or when a delivery is uncertain - skips Foreman's own
 * switches, never the session's: it must be idle, with no queued turns, no work queue and no
 * active workflow.
 */
export function stackPromptCandidate(
  registry: StackDeliveryRegistry,
  sessionId: string,
  request: StackPromptRequest,
  origin: "foreman" | "human",
  row: InspectorPr | null,
  foreman: ForemanConfig,
  /** True on the re-check inside the transport, once this delivery's own claim is held. */
  claimed = false,
  now = Date.now(),
): StackCandidate {
  const session = registry.getSession(sessionId);
  if (!session || !row?.stack) return { error: "The stacked pull request or its session is unavailable" };
  const sessions = registry.liveSessions();
  const standing = stackStandingFor(row, sessions, foreman);
  if (!standing) return { error: "That pull request is not stacked" };
  if (standing.sessionId !== sessionId) return { error: "The stacked pull request's owning session is unknown or changed" };
  let claim: { kind: StackPromptRequest["kind"]; tip: string };
  if (request.kind === "catch-up" || request.kind === "restack") {
    const prompt = standing.prompt;
    if (!prompt || prompt.kind !== request.kind || prompt.tip !== request.tip) {
      return { error: "That stack prompt is no longer needed" };
    }
    if (prompt.status === "sent") return { error: "That stack prompt was already delivered" };
    // Once this delivery holds its claim the prompt reads as uncertain until it settles.
    const sendable = origin === "foreman"
      ? prompt.status === "pending" || (claimed && prompt.status === "uncertain")
      : prompt.status !== "no-session";
    if (!sendable) return { error: "That stack prompt is not Foreman's to send" };
    claim = { kind: prompt.kind, tip: prompt.tip };
  } else {
    if (origin !== "human") return { error: "Broken-stack actions are sent by the operator" };
    if (!standing.actions.includes(request.kind)) return { error: "That action is not offered for this stack" };
    // Claimed like a prompt, keyed to the stack state it answers: once delivered it is not sent
    // again - a second Move onto main would ask for a second replacement - until that changes.
    const tip = stackActionTip(row.stack.observation ?? null);
    if (readStackPromptClaim(row.key, request.kind, tip)?.outcome === "delivered" || standing.sentActions.includes(request.kind)) {
      return { error: "That action was already sent - the row changes once the session acts on it" };
    }
    claim = { kind: request.kind, tip };
  }
  if (session.state === "exited") return { error: "The session exited" };
  if (session.pendingTurns?.length) return { error: "Queued conversation turns own this session" };
  if ((session.queue?.openCount ?? 0) > 0) return { error: "A work queue owns this session" };
  const runs = registry.workflowRunSummaries().filter((run) => run.sessionId === session.id);
  const workflowOwnsSession = activeWorkflowOwnsSession(runs);
  if (workflowOwnsSession) return { error: "An active workflow owns this session" };
  if (origin === "foreman") {
    // The session half of Foreman's own follow-up rule, the same function its decision uses:
    // invited, drivable, live, not held by a human, a work queue or a workflow, settled idle
    // with a pane, and cleared to act live. The prompt half was judged above, from the claim.
    if (!followupPrs(session).some((candidate) => candidate.prKey === row.key)) {
      return { error: "The session no longer carries this pull request" };
    }
    const blocked = followupSessionBlocker({
      session,
      bucket: reportBucket(session, sessions),
      mayActLive: foremanMayActLive(foreman, session.cwd, session.repoRoot),
      workflowOwnsSession,
      now,
      settleMs: foremanSettleMs(),
    });
    if (blocked) return { error: blocked };
  } else if (session.state !== "idle") {
    return { error: "The session is still working - send it once it is idle" };
  } else if (!hasPane(session)) {
    return { error: "The session has no pane to type into - resume its task to restore one" };
  }
  return { session, standing, payload: buildStackPrompt(request.kind, standing.facts), claim };
}
