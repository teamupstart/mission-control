// The alert engine: turn session state transitions into notifications. Pure and
// unit-tested - callers just deliver what this produces. Reuses the shared
// bucketing so "who needs you" matches the report exactly.
//
// Lives in shared/ because away mode made the daemon a consumer too: the stall
// detector runs server-side (sessionEqual excludes lastActivity from the SSE
// change comparison, so the client cannot see a session go quiet), and the away
// buffer folds these same alerts into the return digest.
//
// DETECTION IS UNCONDITIONAL. This engine used to take an `afk` flag and emit the
// informational kinds only when it was set, which is backwards: it made away mode
// *louder* than being at the desk. Detection now always reports everything that
// happened, and DELIVERY decides what is worth interrupting for (see
// deliverable/bufferable below). That inversion is the whole point of away mode.

import type { Session, Task } from "./types.ts";
import {
  activePaneDialog,
  dialogIdentity,
  paneDialogReason,
  reportBucket,
} from "./session.ts";
import { newWrapupAsk, wrapupAskCopy } from "./queue.ts";
import type { Stall } from "./stall.ts";
import type { WorkflowRunRepeatOffender, WorkflowRunSummary } from "./workflow.ts";
import { ensembleIsTerminal, type EnsembleSummary } from "./ensemble.ts";

export type AlertKind =
  | "needs-input"
  | "review"
  | "task-done"
  | "task-failed"
  | "idle"
  | "stuck"
  | "foreman"
  | "workflow"
  /**
   * A workflow member has failed the same work several rounds running.
   *
   * Its own kind rather than another `workflow` transition because it is not a transition at
   * all: the run is progressing normally by every status it reports, and the thing worth
   * saying is that the progress is circular. It became worth SAYING when repair rounds stopped
   * needing a human click - a `resumptionPolicy: "auto"` run can spend its entire repair
   * budget with nobody watching, and five rounds of the same Persona rejecting the same change
   * is a loop to interrupt, not a digest line.
   */
  | "workflow-repeat"
  | "ensemble";
export type AlertSeverity = "attention" | "info";

export interface Alert {
  /** Stable per (kind, subject) so a repeat replaces its toast via the Notification tag. */
  id: string;
  kind: AlertKind;
  title: string;
  body: string;
  sessionId: string | null;
  workflowRunId?: string | null;
  /** The ensemble a `kind === "ensemble"` alert points at, for deep-linking its toast. */
  ensembleId?: string | null;
  severity: AlertSeverity;
}

export interface AlertScope {
  sessions: Session[];
  tasks: Task[];
  /**
   * Currently-stalled sessions, from the daemon's stall detector. Optional because
   * nothing but the daemon can COMPUTE it - the elapsed-time signal never reaches
   * the client, which fetches the result instead (see useStalls) - so a scope built
   * before that read lands simply carries no stalls and emits no `stuck` alerts.
   */
  stalls?: Stall[];
  workflowRuns?: WorkflowRunSummary[];
  /**
   * Workflow members failing consecutive rounds, from the daemon's own derivation.
   *
   * On its own channel for the reason `stalls` is: nothing but the daemon can COMPUTE it. The
   * derivation walks every submission and attempt of a run, which is why it lives on
   * `WorkflowRunDetail` and deliberately NOT on `WorkflowRunSummary` - summaries travel over
   * SSE for every run in the fleet and must stay compact. Absent therefore means "not read
   * yet", exactly as it does for stalls, and a scope without it emits no repeat alerts rather
   * than reporting every offender as newly resolved.
   */
  workflowRepeatOffenders?: WorkflowRunRepeatOffender[];
  /**
   * The compact ensemble catalog projection, from the same SSE snapshot the rest of the
   * scope comes from. Optional for the reason `workflowRuns` is: a scope built before the
   * first snapshot lands simply carries none and emits no `ensemble` alerts. Only the
   * bounded `EnsembleSummary` enters here - never a member, artifact, patch or evaluation,
   * so an ensemble alert or an Away digest can never carry run detail.
   */
  ensembleSummaries?: EnsembleSummary[];
}

/**
 * Whether an alert is worth interrupting a human for, even mid-coffee.
 *
 * Attention alerts mean something is BLOCKED on you and will not proceed until you
 * act; info alerts are things that happened and can wait for the digest. Away mode
 * delivers the former and buffers the latter.
 */
export function deliverable(a: Alert): boolean {
  return a.severity === "attention";
}

/** The complement: what accumulates into the return digest rather than notifying. */
export function bufferable(a: Alert): boolean {
  return !deliverable(a);
}

function sessionLabel(s: Session): string {
  return s.task?.title || s.name || "a session";
}

/**
 * The baseline `next` should be diffed against, given that stalls arrive on their
 * own channel and may land after the one the rest of the scope came in on.
 *
 * An absent `stalls` means NOT READ YET, which is not the same as read-and-empty -
 * and the difference decides whether a stall is news. Without this, the dashboard
 * would re-announce every already-stuck session on page load whenever the SSE
 * snapshot won its race against the stalls fetch (and stay quiet when it lost),
 * making a "looks stuck" notification a coin flip on every refresh. Absent stalls
 * are therefore adopted into the baseline rather than read as N new stalls, which is
 * exactly what the snapshot does for every other alert kind.
 */
export function withKnownStalls(prev: AlertScope, next: AlertScope): AlertScope {
  if (prev.stalls !== undefined || next.stalls === undefined) return prev;
  return { ...prev, stalls: next.stalls };
}

/** Stalls keyed for edge-triggering, so a stall that persists doesn't re-alert. */
function stallKeys(scope: AlertScope): Set<string> {
  return new Set((scope.stalls ?? []).map((x) => `${x.sessionId}:${x.kind}`));
}

/**
 * The alert one stall implies, whether or not it is new.
 *
 * Split out because the away watcher re-derives it every tick to refresh the wording
 * already sitting in the buffer (see refreshAlerts): a stall alerts ONCE, so without
 * a second reading the digest would describe it in the words it had when the
 * threshold tripped. Deriving both from here means the refreshed line and the alert
 * that announced it can never diverge.
 */
export function stuckAlert(st: Stall, sessions: Session[]): Alert {
  const s = sessions.find((x) => x.id === st.sessionId);
  return {
    id: `stuck:${st.sessionId}:${st.kind}`,
    kind: "stuck",
    title: `${s ? sessionLabel(s) : "a session"} looks stuck`,
    body: st.reason,
    sessionId: st.sessionId,
    // Spread, so only the one stall kind that HAS a run carries the key. The toast turns
    // this into a `#/runs/:id` deep link, which is where the control that clears a parked
    // round lives - landing on the session instead would leave a reader to work out which
    // of its runs stopped.
    ...(st.workflowRunId ? { workflowRunId: st.workflowRunId } : {}),
    severity: "attention",
  };
}

/**
 * The NEW alerts implied by the transition prev -> next. Each attention cause is
 * detected from session FIELDS directly (not the coarse bucket or a reason string),
 * edge-triggered per cause - so a review landing on a session that's already
 * awaiting input still alerts, and the alert kind can't drift from wording changes.
 */
export function detectAlerts(prev: AlertScope, next: AlertScope): Alert[] {
  const alerts: Alert[] = [];
  const prevSessions = new Map(prev.sessions.map((s) => [s.id, s]));

  for (const s of next.sessions) {
    const before = prevSessions.get(s.id);
    const label = sessionLabel(s);

    // needs-input: the agent is blocked on you (awaiting input or a review decision).
    const blocked = (st: Session["state"]) => st === "awaiting_input" || st === "awaiting_review";
    const dialog = activePaneDialog(s);
    const beforeDialog = before ? activePaneDialog(before) : null;
    if (blocked(s.state) && !(before && blocked(before.state))) {
      alerts.push({
        id: `input:${s.id}`,
        kind: "needs-input",
        title: `${label} needs you`,
        body: s.state === "awaiting_review" ? "needs review" : "needs input",
        sessionId: s.id,
        severity: "attention",
      });
    } else if (dialog && (!beforeDialog || dialogIdentity(beforeDialog) !== dialogIdentity(dialog))) {
      // The same "blocked on you" alert, reached the other way: the states above are
      // hook-reported and therefore blank for exactly the uninstrumented session a menu
      // is the only evidence for - the case `reportBucket` and `stateDisplay` were taught
      // to see and this was not, so the board badged it and nothing rang.
      //
      // Edge-triggered on a DIFFERENT question rather than on a dialog merely being
      // present: answering a permission prompt only for the next one to open inside the
      // same 1.5s poll leaves a menu on both sides of the transition, and a presence test
      // reads that as "still parked" and says nothing about the new question.
      //
      // `else if` rather than its own block: an instrumented session hits both paths on
      // the same tick (the Notification hook flips the state as the dialog is captured),
      // and one blocked session is one alert. Same id for the same reason - kind and
      // subject match, so a repeat replaces its toast rather than stacking a second.
      //
      // Worded off the dialog rather than through `needsYouReason`, whose ranking is
      // built for triage and puts an open review first: the event being announced here
      // is the menu, so a session that also has reviews waiting must not get a toast
      // that says "to review" about a question that just opened.
      alerts.push({
        id: `input:${s.id}`,
        kind: "needs-input",
        title: `${label} needs you`,
        body: paneDialogReason(dialog),
        sessionId: s.id,
        severity: "attention",
      });
    }

    // review: a review item landed (pending count rose from zero).
    if (s.pendingReviews > 0 && (before?.pendingReviews ?? 0) === 0) {
      alerts.push({
        id: `review:${s.id}`,
        kind: "review",
        title: `${label} needs review`,
        body: s.pendingReviews > 1 ? `${s.pendingReviews} to review` : "to review",
        sessionId: s.id,
        severity: "attention",
      });
    }

    // foreman: the auto-responder handed a decision back to you (a design fork or
    // a risky ask it declined to answer). Edge-triggered on the note flipping to
    // escalated, so it fires once when Foreman escalates.
    if (s.note?.disposition === "escalated" && before?.note?.disposition !== "escalated") {
      alerts.push({
        id: `foreman:${s.id}`,
        kind: "foreman",
        title: `${label} - Foreman needs your call`,
        body: s.note.lastAction ?? "a decision was escalated to you",
        sessionId: s.id,
        severity: "attention",
      });
    }

    // queue: an item Foreman was driving needs you (it escalated), or the batch
    // drained and it's asking whether to ship. Read from the ITEM state rather
    // than overloading the note to get this for free: the note is triage's record
    // for a prompt episode, and a queue write there would skew its tallies.
    const esc = s.queue?.escalatedCount ?? 0;
    if (esc > (before?.queue?.escalatedCount ?? 0)) {
      alerts.push({
        id: `queue:${s.id}`,
        kind: "foreman",
        title: `${label} - Foreman is stuck on a queued item`,
        body: "an item couldn't be finished and needs you",
        sessionId: s.id,
        severity: "attention",
      });
    }
    // Which trigger raised this decides the wording, and the answer is the row itself:
    // the `prompted` trigger fires only on a checkout with NO queued work, so a
    // zero-item row is a wrap-up about a prompt, not about a batch. `wrapupAskCopy` is
    // the same call the Ship it? card makes, so the toast and the card it points at
    // cannot describe the same ask two different ways.
    //
    // Edge-detected per EPISODE by `newWrapupAsk`, not on the timestamp appearing from
    // null - see there for why the null transition is the drain path's property alone
    // and silently drops every prompted episode after the first.
    if (newWrapupAsk(s.queue, before?.queue)) {
      alerts.push({
        id: `wrapup:${s.id}`,
        kind: "foreman",
        title: `${label} - ${wrapupAskCopy((s.queue?.totalCount ?? 0) > 0).alert}`,
        body: "ship it? Foreman is waiting on you",
        sessionId: s.id,
        severity: "attention",
      });
    }

    // idle: finished a burst of work and is now waiting. Informational - it means
    // something FINISHED, which is digest material rather than an interruption.
    if (before && reportBucket(s) === "idle" && reportBucket(before) === "working") {
      alerts.push({
        id: `idle:${s.id}`,
        kind: "idle",
        title: `${label} went idle`,
        // `activity` is the last hook one-liner, which on a Stop is literally
        // "idle" - so using it unconditionally yields "X went idle - idle", which
        // adds nothing and reads as noise in the digest (and, fed to the digest
        // model, as though nothing happened at all).
        body: s.activity && s.activity !== "idle" ? s.activity : "",
        sessionId: s.id,
        severity: "info",
      });
    }
  }

  // stuck: the stall detector newly flagged this session. Edge-triggered on
  // (session, kind) so a stall that persists across polls alerts once, not every
  // tick - and a session whose stall CHANGES kind (went quiet, then escalated)
  // legitimately alerts again, because that is new information.
  const before = stallKeys(prev);
  for (const st of next.stalls ?? []) {
    if (before.has(`${st.sessionId}:${st.kind}`)) continue;
    alerts.push(stuckAlert(st, next.sessions));
  }

  const prevTasks = new Map(prev.tasks.map((t) => [t.id, t]));
  for (const t of next.tasks) {
    const beforeTask = prevTasks.get(t.id);
    if (t.status === "failed" && beforeTask?.status !== "failed") {
      alerts.push({
        id: `failed:${t.id}`,
        kind: "task-failed",
        title: `Task failed: ${t.title}`,
        body: t.error ?? "dispatch failed",
        sessionId: t.sessionId,
        severity: "attention",
      });
    } else if (t.status === "done" && beforeTask?.status !== "done") {
      alerts.push({
        id: `done:${t.id}`,
        kind: "task-done",
        title: `Task done: ${t.title}`,
        body: t.outcome ?? "completed",
        sessionId: t.sessionId,
        severity: "info",
      });
    }
  }

  const previousRuns = new Map((prev.workflowRuns ?? []).map((run) => [run.id, run]));
  for (const run of next.workflowRuns ?? []) {
    const beforeRun = previousRuns.get(run.id);
    const beforeUncertain = beforeRun?.uncertainDeliveryCount ?? 0;
    const uncertain = run.uncertainDeliveryCount ?? 0;
    let transition: {
      className: string;
      title: string;
      body: string;
      severity: AlertSeverity;
    } | null = null;

    if (uncertain > beforeUncertain) {
      transition = {
        className: "uncertain",
        title: `${run.workflowName} delivery is uncertain`,
        body: "Confirm whether the packet arrived before choosing a resolution.",
        severity: "attention",
      };
    } else if (
      run.status === "blocked"
      && run.phase === "inspector_disabled"
      && (
        beforeRun?.status !== "blocked"
        || beforeRun.phase !== "inspector_disabled"
      )
    ) {
      transition = {
        className: "inspector-enablement",
        title: `${run.workflowName} needs Inspector enabled`,
        body: "Enable Inspector for the repository to continue.",
        severity: "attention",
      };
    } else if (
      (run.status === "blocked" || run.status === "failed")
      && run.status !== beforeRun?.status
    ) {
      transition = {
        className: run.status,
        title: `${run.workflowName} ${run.status}`,
        body: run.phase.replaceAll("_", " "),
        severity: "attention",
      };
    // NOTE: there is deliberately no arm here for entering `waiting_for_session`.
    //
    // There used to be - a `manual-resubmit` attention alert, edge-triggered the moment the
    // run parked. It was wrong in both directions at once on the configuration this repo
    // ships. It fired the INSTANT the packet was prepared, before the agent had read a word
    // of it, so it named a resubmit that was not yet owed and could not yet be performed;
    // and it fired on `auto` runs the resumption observer picks up fifteen seconds later,
    // because the summary carried no `resumptionPolicy` to tell the two apart. Meanwhile the
    // moment a resubmit genuinely IS owed - the agent finished, went quiet, and nothing
    // reopened the round - is not a status change at all, so nothing fired then.
    //
    // Retimed, not deleted. That moment is a silence rather than a transition, which is what
    // the stall detector is for: `workOutstanding` counts a parked run as outstanding work,
    // and the resulting `workflow-parked` stall arrives on `AlertScope.stalls` and alerts
    // through the `stuck` arm above - on a clock, naming the run, deep-linked to it. The
    // runs that will never resume themselves do not wait for that clock either; they are on
    // the Line strip and in the Review drawer from the instant they park, via
    // `workflowRunWaitsOnOperator`.
    } else if (run.gate === "waiting_pr" && beforeRun?.gate !== "waiting_pr") {
      transition = {
        className: "missing-pr",
        title: `${run.workflowName} needs a pull request`,
        body: "Open or adopt the intended pull request to continue.",
        severity: "attention",
      };
    } else if (run.status === "completed" && beforeRun?.status !== "completed") {
      transition = {
        className: "completed",
        title: `${run.workflowName} completed`,
        body: `Run ${run.id}`,
        severity: "info",
      };
    } else if (
      ["capturing", "running", "waiting_for_inspector"].includes(run.status)
      && beforeRun?.status === "blocked"
    ) {
      transition = {
        className: "resumed",
        title: `${run.workflowName} resumed`,
        body: run.phase.replaceAll("_", " "),
        severity: "info",
      };
    }
    if (!transition) continue;
    alerts.push({
      id: `workflow:${run.id}:${transition.className}`,
      kind: "workflow",
      title: transition.title,
      body: transition.body,
      sessionId: run.sessionId,
      workflowRunId: run.id,
      severity: transition.severity,
    });
  }

  // workflow-repeat: the same member has now rejected the same work several rounds running.
  //
  // Edge-triggered on the STREAK GROWING, not on the offender merely existing, so a loop that
  // persists across ticks announces once per round it burns rather than every five seconds -
  // and so the third failure is still news after the second was reported. Keyed per
  // (run, node) for the same reason the workflow loop is keyed per (run, cause): two members
  // stuck on the same run are two different things to look at.
  const previousOffenders = new Map(
    (prev.workflowRepeatOffenders ?? []).map((o) => [`${o.runId}:${o.nodeId}`, o]),
  );
  for (const o of next.workflowRepeatOffenders ?? []) {
    const before = previousOffenders.get(`${o.runId}:${o.nodeId}`);
    if (before && before.rounds >= o.rounds) continue;
    alerts.push({
      id: `workflow-repeat:${o.runId}:${o.nodeId}`,
      kind: "workflow-repeat",
      title: `${o.personaName} has failed ${o.rounds} rounds running`,
      body: `${o.workflowName} is on round ${o.round} of ${o.maxRepairRounds}`,
      sessionId: o.sessionId,
      workflowRunId: o.runId,
      severity: "attention",
    });
  }

  // ensemble: an orchestration run crossed a boundary worth telling you about. Edge-triggered
  // per (run, cause) off the compact summary - never off the full detail, which stays on HTTP -
  // so a reconnect that re-delivers the same summary, or a recovery that re-derives it, does not
  // re-announce a decision you already saw. These three run-owned causes raise attention alerts;
  // `EnsembleSummary.attention` additionally rolls up a blocked member for visible attention, but
  // deliberately leaves its notification to that member's existing session-level alert.
  const previousEnsembles = new Map((prev.ensembleSummaries ?? []).map((e) => [e.id, e]));
  for (const e of next.ensembleSummaries ?? []) {
    const beforeE = previousEnsembles.get(e.id);
    const label = e.title || "an ensemble";
    let transition: {
      className: string;
      title: string;
      body: string;
      severity: AlertSeverity;
    } | null = null;

    if (e.status === "awaiting_decision" && beforeE?.status !== "awaiting_decision") {
      // The one moment an ensemble is genuinely blocked on you: the comparison is done and
      // nothing destructive happens until you confirm a winner (or declare no consensus).
      transition = {
        className: "decision",
        title: `${label} needs your decision`,
        body: "Review the candidates and confirm a winner.",
        severity: "attention",
      };
    } else if (e.unreadable !== null && beforeE?.unreadable == null) {
      // A run this build cannot execute - written by a newer build, or naming a driver this
      // binary no longer has. Actionable in that it will never proceed until it is upgraded or
      // cancelled, and it must never be read as "the only strategy we have".
      transition = {
        className: "unreadable",
        title: `${label} can't be run by this build`,
        body: e.unreadable.reason,
        severity: "attention",
      };
    } else if (
      e.status === "finalizing"
      && e.error != null
      && !(beforeE?.status === "finalizing" && beforeE.error != null)
    ) {
      // Finalization is normally a few milliseconds; a `finalizing` run holding an error is
      // stuck part-way through a destructive, restart-safe sequence and needs `resolve_finalization`.
      transition = {
        className: "finalizing",
        title: `${label} finalization needs attention`,
        body: e.error,
        severity: "attention",
      };
    } else if (e.status === "completed" && beforeE?.status !== "completed") {
      transition = {
        className: "completed",
        title: `${label} completed`,
        body: e.outcomeKind === "selected" ? "A winner was selected." : "The ensemble finished.",
        severity: "info",
      };
    } else if (e.status === "cancelled" && beforeE?.status !== "cancelled") {
      transition = {
        className: "cancelled",
        title: `${label} cancelled`,
        body: "The ensemble was cancelled; its snapshots are kept.",
        severity: "info",
      };
    } else if (e.status === "failed" && beforeE?.status !== "failed") {
      // Informational, not attention: a failed run offers Retry/Restore/Cancel from the
      // dashboard, so it belongs in the digest rather than interrupting you mid-coffee.
      transition = {
        className: "failed",
        title: `${label} failed`,
        body: e.error ?? "The ensemble could not continue.",
        severity: "info",
      };
    }
    if (!transition) continue;
    alerts.push({
      id: `ensemble:${e.id}:${transition.className}`,
      kind: "ensemble",
      title: transition.title,
      body: transition.body,
      sessionId: null,
      ensembleId: e.id,
      severity: transition.severity,
    });
  }

  return alerts;
}

/** Compact one-line summary of several alerts, for the reconnect catch-up toast. */
export function summarizeAlerts(alerts: Alert[]): string {
  const titles = alerts.map((a) => a.title);
  const shown = titles.slice(0, 3).join(" · ");
  return titles.length > 3 ? `${shown} · +${titles.length - 3} more` : shown;
}

/** The most urgent severity in a batch - an "attention" alert must not be masked. */
export function batchSeverity(alerts: Alert[]): AlertSeverity {
  return alerts.some((a) => a.severity === "attention") ? "attention" : "info";
}

/** Whether anything is worth reporting, so a quiet digest can be skipped. */
export function hasReportable(scope: AlertScope): boolean {
  for (const s of scope.sessions) if (reportBucket(s) !== "exited") return true;
  return scope.tasks.some((t) => t.status === "backlog")
    || (scope.workflowRuns ?? []).some((run) =>
      !["completed", "cancelled", "failed"].includes(run.status))
    || (scope.ensembleSummaries ?? []).some((e) =>
      e.attention || e.status === null || !ensembleIsTerminal(e.status));
}

/** Compact scope digest, e.g. "2 need you · 3 working · 1 idle · 1 in backlog". */
export function digestLine(scope: AlertScope): string {
  let needsYou = 0;
  let working = 0;
  let idle = 0;
  for (const s of scope.sessions) {
    const b = reportBucket(s);
    if (b === "needs-you") needsYou++;
    else if (b === "working") working++;
    else if (b === "idle") idle++;
  }
  const backlog = scope.tasks.filter((t) => t.status === "backlog").length;
  const parts = [`${needsYou} need you`, `${working} working`, `${idle} idle`];
  if (backlog > 0) parts.push(`${backlog} in backlog`);
  const stuck = (scope.stalls ?? []).length;
  if (stuck > 0) parts.push(`${stuck} stuck`);
  // `waiting_for_new_head` belongs here for the reason the other parked statuses do, and its
  // absence was the quietest half of the stranded-run bug: it is where the shipped
  // No-Mistakes Review parks Inspector findings under `inspector_only`, it clears only when
  // the Inspector poller observes a PUSHED head, and until it was counted a session that
  // fixed the findings and forgot to push produced no digest line at all.
  const workflowAttention = (scope.workflowRuns ?? []).filter((run) =>
    ["blocked", "failed", "waiting_for_session", "waiting_for_pr", "waiting_for_new_head"]
      .includes(run.status)
    || (run.uncertainDeliveryCount ?? 0) > 0).length;
  if (workflowAttention > 0) parts.push(`${workflowAttention} workflow attention`);
  const ensembleAttention = (scope.ensembleSummaries ?? []).filter((e) => e.attention).length;
  if (ensembleAttention > 0) parts.push(`${ensembleAttention} ensemble attention`);
  return parts.join(" · ");
}
