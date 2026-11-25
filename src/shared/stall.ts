// Stall detection: which sessions are STUCK right now, as opposed to merely busy
// or merely finished. Pure and unit-tested, shared so the daemon's away-mode
// poller and the client's rendering can never disagree about what "stuck" means.
//
// This is the one piece of genuinely new detection in away mode. Everything the
// alert engine already fires is edge-triggered off a state CHANGE; a stall is the
// opposite - it is defined by nothing having changed for
// long enough that the silence itself is the signal. That needs a clock, which is
// why this takes `now` and why it runs server-side: `sessionEqual`
// (src/server/registry.ts) deliberately excludes `lastActivity` from the SSE
// change comparison, so a session going quiet emits no client event at all.

import { isActiveTask } from "./task-status.ts";
import type { Session } from "./types.ts";
import { hasBlocker, isAwaiting, reportBucket } from "./session.ts";
import { workflowRunIsOpen, workflowRunParkedOnSession, workflowRunResumesItself } from "./workflow.ts";
import type { WorkflowExternalSourceKind, WorkflowRunSummary } from "./workflow.ts";
import { unpushedClause } from "./unpushed.ts";
import type { UnpushedCommits } from "./unpushed.ts";

/**
 * What the daemon observed about each parked run's checkout, keyed by RUN id.
 *
 * A parameter rather than a field on `WorkflowRunSummary`, for the same reason `runs` is a
 * parameter rather than a field on `Session`: this is a local git read, it belongs to the
 * daemon, and shared code stays pure. Keying by run rather than by session is what keeps a
 * multi-repo task honest - one session can hold a run per repository, each bound to a
 * DIFFERENT checkout, and a session-keyed map would report one repository's commits against
 * another's run.
 *
 * A MISSING key means "not observed", which `unpushedClause` already renders as no claim. So
 * an empty map is the correct pre-observation state and needs no special case: the first
 * watcher tick, an embedder that wired no observer, and a run whose read is still in flight
 * all say exactly what they said before this existed.
 */
export type UnpushedByRun = ReadonlyMap<string, UnpushedCommits>;

/** The shared empty observation, so callers with nothing to say need not allocate one. */
export const NO_UNPUSHED: UnpushedByRun = new Map();

/**
 * Why a session is stuck. Ordered by how explicitly it is waiting on a human:
 * an escalation was handed to you deliberately, while the three silence kinds are
 * inferred from a clock.
 *
 * `workflow-parked` is its own kind rather than a flavour of `unfinished-work` because it is
 * the one whose cause can be NAMED. The others report that something is open; this one knows
 * which run is parked, on which status, and therefore what the missing step is - and the
 * alert it produces deep-links to that run instead of to the session. Keeping it separate is
 * also what lets its copy say "round N+1 never opened" while `unfinished-work` keeps the
 * wording its own tests pin.
 */
export type StallKind =
  | "escalated"
  | "silent-working"
  | "unfinished-work"
  | "workflow-parked";

/**
 * The stall kinds that fire only on an IDLE session: the two rules that read "went quiet with
 * something still expected". With the `idle-stalled` flag on these leave the inbox for Idle's
 * Stalled section, because the session is already drawn in Idle and its card is where the
 * context and the fix belong. The other two stay inbox rows: a silent-working session is in
 * Working, and an escalation is a decision handed to a person, whatever column it sits in.
 */
export const IDLE_STALL_KINDS: readonly StallKind[] = ["unfinished-work", "workflow-parked"];

/** Whether a stall is one Idle's Stalled section draws (`IDLE_STALL_KINDS`). */
export function isIdleStall(stall: Pick<Stall, "kind">): boolean {
  return IDLE_STALL_KINDS.includes(stall.kind);
}

export interface StallThresholds {
  /** Instrumented + working, but no hook event for this long. */
  workingMs: number;
  /** Idle this long with work still open against the session (see unfinished-work). */
  unfinishedMs: number;
  /** A Foreman escalation nobody answered for this long. */
  escalationMs: number;
}

/**
 * Deliberately unequal. An escalation fires soonest because something is definitely
 * blocked on a human. `workingMs` is longer
 * because a quiet stretch mid-turn is normal (a long build, a slow test run), and
 * `unfinishedMs` is longest of all because it is the most inferential of the four.
 */
export const DEFAULT_STALL_THRESHOLDS: StallThresholds = {
  escalationMs: 5 * 60_000,
  workingMs: 10 * 60_000,
  unfinishedMs: 20 * 60_000,
};

export interface Stall {
  sessionId: string;
  kind: StallKind;
  /** How long it has been stuck, ms. */
  forMs: number;
  /** Start of the episode measured by the daemon, in epoch ms. Older daemons omit it. */
  since?: number;
  /** One line naming the stall, for the alert body and the digest. */
  reason: string;
  /**
   * The parked run this stall is about, on a `workflow-parked` stall only.
   *
   * Present so the alert can deep-link to the run rather than to the session: the fix for a
   * parked round is a control on the Runs page, and a notification that lands you on the
   * session leaves you to find which of its runs stopped.
   */
  workflowRunId?: string;
  /**
   * What the rule observed, by kind, for a surface that offers the fix in place (the inbox's
   * Stuck row). Structured so nothing has to parse `reason`, whose wording is pinned and whose
   * minutes climb. Optional on the wire: a stall from a daemon that predates it carries none.
   */
  facts?: StallFacts;
  /**
   * The kind, `facts` and when this stall episode began, with the climbing age left out: equal
   * while minutes pass, different when what is stuck changes (a new round, a different open
   * task) or when the session moved and then stalled again. A dismissal is keyed on it.
   */
  fingerprint?: string;
}

/** The open task a stall names, by id and title. */
export interface StallTask {
  id: string;
  title: string;
}

/**
 * The facts each rule observed. `unfinished-work` keeps its two sources apart, because only an
 * open task can be completed from the inbox: a queue's items are handled in the session.
 */
export type StallFacts =
  | {
    kind: "silent-working";
    /** The session's last activity line, or null when it reported none. */
    activity: string | null;
    /** When the hook stream last spoke, epoch ms. */
    quietSince: number;
  }
  | {
    kind: "unfinished-work";
    /** The session's open task, or null when only its queue is open. */
    task: StallTask | null;
    /** Open queue items, zero when the queue is drained or absent. */
    queueOpen: number;
  }
  | {
    kind: "workflow-parked";
    runId: string;
    workflowName: string;
    status: WorkflowRunSummary["status"];
    round: number;
    /** Whether Resubmit can open the next round: a manual or Preview run, not external. */
    resubmittable: boolean;
    /**
     * The orchestrator that started this run (an ensemble), or null for a run an operator or
     * Foreman started. Such a run reviews one exact external result: only its source can submit
     * again, so neither Resubmit nor the session's next turn moves it.
     */
    externalSource: WorkflowExternalSourceKind | null;
    /** Commits the remote has not seen, zero when none or not observed. */
    unpushedCommits: number;
  }
  | {
    kind: "escalated";
    /** What Foreman escalated, or null when its note carries no text. */
    text: string | null;
  };

/** Open work that needs completion, rather than a resident's standing role. */
export function hasOpenStallTask(s: Session): boolean {
  // A resident keeps its task running between iterations. That alone is not a stall;
  // explicit queue work and parked workflows still count in workOutstanding.
  if (s.task?.kind === "resident") return false;
  const st = s.task?.status;
  return st !== undefined && (st === "backlog" || isActiveTask(st));
}

/** Any open run exempts its session from stalls while the next move belongs to the workflow.
 * A run parked on the session is waiting for the session to act. */
export function workflowOwnsNextMove(
  sessionId: string,
  runs: readonly WorkflowRunSummary[] | undefined,
): boolean {
  return runs?.some((run) => run.sessionId === sessionId
    && workflowRunIsOpen(run.status) && !workflowRunParkedOnSession(run.status)) ?? false;
}

/**
 * The parked workflow run this session owes a turn to, or null.
 *
 * Runs arrive as a PARAMETER rather than on `Session`, and that is the whole design of this
 * change. A run is not a property of a session - it outlives one, a session can have several,
 * and `orphanBinding` nulls the link when the session goes - so denormalising it onto the
 * shared `Session` type would put a fleet-wide collection behind every session that crosses
 * the SSE wire. The daemon already holds both halves at the one call site that matters:
 * `registry.snapshot()` returns `workflowRunSummaries` beside `sessions`, and the away
 * watcher reads them together.
 *
 * The first match wins rather than the newest. A session with two parked runs is stuck for
 * one reason, and naming either of them gets a person to the same place.
 */
function parkedRunFor(
  s: Session,
  runs: readonly WorkflowRunSummary[],
): WorkflowRunSummary | null {
  return runs.find((run) => run.sessionId === s.id && workflowRunParkedOnSession(run.status))
    ?? null;
}

/**
 * What is still expected of a session, in the two flavours the stall rule can SAY.
 *
 * A discriminated result rather than the boolean this used to return, because the two
 * outcomes produce different sentences and the caller cannot re-derive which it got.
 */
type Outstanding =
  | { kind: "workflow-parked"; run: WorkflowRunSummary }
  | { kind: "unfinished-work" };

/**
 * What is still outstanding against this session, or null when it is genuinely done.
 *
 * This is what separates "stuck" from "done". A finished session is idle forever,
 * so a plain idle-timeout would eventually flag every session that ever completed
 * anything - which is noise, not signal. The distinguishing fact is whether
 * anything was still expected of it. This repo had already scored that exact gap
 * against itself before away mode existed - see the "Turn-end safety" row of the
 * capability comparison in todo/foreman-upgrades.md, which is what this rule
 * partially closes.
 *
 * A PARKED WORKFLOW RUN counts, and is reported ahead of the other two. Until it did, a
 * session that received a repair packet, made the fix and went quiet reported no outstanding
 * work at all - its task had usually already reached `done`, and its queue was empty - so the
 * one rule built for exactly this silence never fired, and a run could sit parked for ever
 * with nothing anywhere saying so. It is reported FIRST because it is the most specific: it
 * names a run, so its sentence can say which step is missing, where an open task can only say
 * that something is.
 */
function workOutstanding(s: Session, runs: readonly WorkflowRunSummary[]): Outstanding | null {
  const parked = parkedRunFor(s, runs);
  if (parked) return { kind: "workflow-parked", run: parked };
  if (hasOpenStallTask(s)) return { kind: "unfinished-work" };
  return openStallQueueCount(s) > 0 ? { kind: "unfinished-work" } : null;
}

/** Open queue items that still count as outstanding: none once the queue has drained. */
export function openStallQueueCount(s: Session): number {
  const q = s.queue;
  return q && q.openCount > 0 && !q.drained ? q.openCount : 0;
}

/**
 * Whether Resubmit can move a parked run. Only a round parked in `waiting_for_session` that
 * will not pick itself back up: a `waiting_for_new_head` run waits on a push and the manager
 * refuses to resubmit it, and an externally started run is refused too
 * (`WorkflowManager.resubmit`).
 */
function resubmittable(run: WorkflowRunSummary): boolean {
  return run.status === "waiting_for_session" && !workflowRunResumesItself(run) && !run.externalSource;
}

function factsFor(
  kind: StallKind,
  s: Session,
  run: WorkflowRunSummary | null,
  unpushed: UnpushedByRun,
): StallFacts {
  switch (kind) {
    case "silent-working":
      return { kind, activity: s.activity ?? null, quietSince: quietSince(s) };
    case "unfinished-work":
      return {
        kind,
        task: hasOpenStallTask(s) && s.task ? { id: s.task.id, title: s.task.title } : null,
        queueOpen: openStallQueueCount(s),
      };
    case "workflow-parked": {
      const observed = unpushed.get(run!.id);
      return {
        kind,
        runId: run!.id,
        workflowName: run!.workflowName,
        status: run!.status,
        round: run!.round,
        resubmittable: resubmittable(run!),
        externalSource: run!.externalSource?.kind ?? null,
        unpushedCommits: observed?.state === "ahead" ? observed.commits : 0,
      };
    }
    case "escalated":
      return { kind, text: s.note?.brief || s.note?.lastAction || s.note?.purpose || null };
  }
}

/**
 * The facts and the episode they belong to, as one string.
 *
 * `since` is when this stall episode began: the moment the session last spoke for the three
 * silence rules, and when Foreman wrote its note for an escalation. It holds still for as long
 * as the stall lasts, so minutes passing never change the fingerprint, and it moves only when
 * the session speaks or Foreman escalates again. That is what makes a session that worked,
 * then went quiet again with the same activity line or the same escalation text, a new row
 * rather than one that stays dismissed.
 */
export function stallFingerprint(facts: StallFacts, since: number): string {
  return JSON.stringify({ ...facts, since });
}

/** Mixed-version peers may omit the fingerprint. Use the session's episode start and the
 * reported work identity so a changing elapsed minute never creates a new dismissal key. */
export function legacyStallFingerprint(stall: Stall, session?: Session): string {
  const since = stall.kind === "escalated" ? session?.note?.updatedAt : session?.lastActivity ?? session?.firstSeen;
  return JSON.stringify([
    stall.kind, since, stall.workflowRunId, stall.facts,
    stall.kind === "unfinished-work" ? session?.task?.id : null,
    stall.kind === "unfinished-work" ? session?.queue?.openCount : null,
  ]);
}

/** A stall with its facts and fingerprint attached. */
function withFacts(stall: Stall, facts: StallFacts, since: number): Stall {
  return { ...stall, facts, since, fingerprint: stallFingerprint(facts, since) };
}

/**
 * What a person has to do about a parked run, named per status.
 *
 * The two statuses are un-parked by different machinery and therefore by different missing
 * steps, and saying so is most of this rule's value: "resubmit it" and "push the branch" are
 * not interchangeable advice, and a single sentence covering both would be right about
 * neither.
 *
 * `waiting_for_new_head` gets a second clause when, and only when, a local observation
 * positively supports one. The Inspector poller clears that status by observing a head ON THE
 * REMOTE, so from the daemon's side a session that fixed the findings and committed is
 * indistinguishable from one that did nothing - both are quiet, both hold the parked run. A
 * count of commits the remote has never seen is the one fact that separates them, and it
 * turns a description of the wait into the missing step.
 *
 * It APPENDS rather than replaces, which is the contract `unpushedClause` documents: the
 * clause names the step, and the caller keeps saying which workflow is waiting, because the
 * alert this feeds deep-links to that run and a sentence that dropped the workflow name would
 * strand a person on a Runs page with nothing to match. Every non-`ahead` observation - a
 * branch tracking nothing, a detached HEAD, a git call that errored, or no observation yet -
 * returns null from `unpushedClause` and leaves the original sentence exactly as it was.
 * Silence is the required direction here: telling a session it forgot to push when its branch
 * simply has no remote sends a person hunting for a mistake nobody made.
 */
function parkedReason(
  run: WorkflowRunSummary,
  age: number,
  unpushed: UnpushedByRun,
): string {
  const what = run.status === "waiting_for_new_head"
    ? `${run.workflowName} is waiting for a pushed head`
      + suffix(unpushedClause(unpushed.get(run.id)))
    : `${run.workflowName} repair round ${run.round} never reopened`;
  return `idle ${mins(age)}m - ${what}`;
}

/** " and <clause>", or nothing at all. Kept here so the null case has one spelling. */
function suffix(clause: string | null): string {
  return clause ? ` and ${clause}` : "";
}

/** The clock a silence is measured against. `firstSeen` is the floor, as settledIdle does. */
function quietSince(s: Session): number {
  return s.lastActivity ?? s.firstSeen;
}

function mins(ms: number): number {
  return Math.floor(ms / 60_000);
}

/**
 * The single most urgent stall for one session, or null when it isn't stuck.
 *
 * At most one per session on purpose: a session that is both escalated and quiet
 * is one problem, and reporting it twice would double-count it in the digest and
 * fire two notifications for one cause.
 *
 * `sessions` is used by shared report bucketing so the detector and dashboard
 * agree about whether the session is working or idle. `runs` is the fleet's open workflow
 * runs, for the same reason and on the same terms: the rule needs to know what is still
 * expected of this session, and a parked run is one of the things that can be. `unpushed`
 * arrives the same way and for the same reason again - it is a git read, so the daemon makes
 * it and this module only decides what it licenses saying.
 */
export function detectStall(
  s: Session,
  sessions: Session[],
  runs: readonly WorkflowRunSummary[],
  unpushed: UnpushedByRun,
  now: number,
  th: StallThresholds = DEFAULT_STALL_THRESHOLDS,
): Stall | null {
  if (s.state === "exited" || s.state === "stopping") return null;
  // Paused on purpose: silence is the point, and a stalled-session alert would only report
  // the operator's own decision back to them.
  if (s.pause) return null;
  if (workflowOwnsNextMove(s.id, runs)) return null;

  // 1. Foreman escalated a decision to you and it is still sitting there. The most
  //    certain of the three: something explicitly asked for a human and got no reply.
  if (s.note?.disposition === "escalated") {
    const age = now - s.note.updatedAt;
    if (age >= th.escalationMs) {
      return withFacts({
        sessionId: s.id,
        kind: "escalated",
        forMs: age,
        reason: `escalated to you ${mins(age)}m ago, still unanswered`,
      }, factsFor("escalated", s, null, unpushed), s.note.updatedAt);
    }
  }

  // The two silence rules below gate on `instrumented`, without which `lastActivity`
  // is not a usable clock. An uninstrumented session posts no hooks, so its
  // `lastActivity` is stale or null and every one of them would read as stuck the
  // moment the threshold elapsed.
  if (!s.instrumented) return null;

  // 3. Claims to be working, but the hook stream has gone silent.
  if (reportBucket(s, sessions) === "working" && (s.state === "working" || s.state === "starting")) {
    const age = now - quietSince(s);
    if (age >= th.workingMs) {
      return withFacts({
        sessionId: s.id,
        kind: "silent-working",
        forMs: age,
        reason: `working but silent for ${mins(age)}m${s.activity ? ` (last: ${s.activity})` : ""}`,
      }, factsFor("silent-working", s, null, unpushed), quietSince(s));
    }
  }

  // 4. Went idle and stayed there while work was still outstanding. This is the
  //    isIdleNudge hole (src/server/harness/claude/hooks.ts): a turn that ended with a question
  //    in prose is indistinguishable by state from one that ended having finished,
  //    so neither nags. Scoping to sessions with open work is what makes this
  //    signal rather than noise - see workOutstanding.
  //
  //    A parked workflow run is the third kind of outstanding work and shares this clock
  //    rather than getting one of its own. It is the same rule - idle this long with
  //    something still expected - and the operator knob it would otherwise need
  //    (`stallUnfinishedMinutes`) is set by a human reasoning about how long to leave a quiet
  //    agent alone, which is one judgement and not two. 20 minutes is also the right ORDER
  //    here rather than merely the convenient one: the resumption observer retries every 15
  //    seconds, so a run still parked twenty minutes later is one that observer has already
  //    failed to move some eighty times, and firing sooner would announce runs it is on the
  //    point of resuming. The runs that will never resume do not wait for this clock at all -
  //    `workflowRunWaitsOnOperator` puts them on the Line the moment they park.
  //    A blocked session is exempt: its blocker already explains the silence, and its age is
  //    on the card. It is not stuck, it is waiting on someone else. A session awaiting its own
  //    background process is exempt until the deadline it declared, and only until then: past
  //    it this rule applies again, so a watcher that died cannot hide a stalled session.
  const outstanding = reportBucket(s, sessions) === "idle" && !hasBlocker(s) && !isAwaiting(s, now)
    ? workOutstanding(s, runs)
    : null;
  if (outstanding) {
    const age = now - quietSince(s);
    if (age >= th.unfinishedMs) {
      return outstanding.kind === "workflow-parked"
        ? withFacts({
          sessionId: s.id,
          kind: "workflow-parked",
          forMs: age,
          reason: parkedReason(outstanding.run, age, unpushed),
          workflowRunId: outstanding.run.id,
        }, factsFor("workflow-parked", s, outstanding.run, unpushed), quietSince(s))
        : withFacts({
          sessionId: s.id,
          kind: "unfinished-work",
          forMs: age,
          reason: `idle ${mins(age)}m with work unfinished`,
        }, factsFor("unfinished-work", s, null, unpushed), quietSince(s));
    }
  }

  return null;
}

/** Every currently-stuck session, at most one stall each. */
export function detectStalls(
  sessions: Session[],
  runs: readonly WorkflowRunSummary[],
  unpushed: UnpushedByRun,
  now: number,
  th: StallThresholds = DEFAULT_STALL_THRESHOLDS,
): Stall[] {
  const out: Stall[] = [];
  for (const s of sessions) {
    const stall = detectStall(s, sessions, runs, unpushed, now, th);
    if (stall) out.push(stall);
  }
  return out;
}
