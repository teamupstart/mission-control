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

import type { Session } from "./types.ts";
import { reportBucket } from "./session.ts";
import { workflowRunParkedOnSession } from "./workflow.ts";
import type { WorkflowRunSummary } from "./workflow.ts";

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
}

/** Terminal task states - work that is over, however it ended. */
function taskOpen(s: Session): boolean {
  const st = s.task?.status;
  return st === "backlog" || st === "dispatching" || st === "running";
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
  if (taskOpen(s)) return { kind: "unfinished-work" };
  const q = s.queue;
  return q && q.openCount > 0 && !q.drained ? { kind: "unfinished-work" } : null;
}

/**
 * What a person has to do about a parked run, named per status.
 *
 * The two statuses are un-parked by different machinery and therefore by different missing
 * steps, and saying so is most of this rule's value: "resubmit it" and "push the branch" are
 * not interchangeable advice, and a single sentence covering both would be right about
 * neither.
 */
function parkedReason(run: WorkflowRunSummary, age: number): string {
  const what = run.status === "waiting_for_new_head"
    // The Inspector poller clears this by observing a head ON THE REMOTE. A session that
    // fixed the findings and committed looks identical from here to one that did nothing.
    ? `${run.workflowName} is waiting for a pushed head`
    : `${run.workflowName} repair round ${run.round} never reopened`;
  return `idle ${mins(age)}m - ${what}`;
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
 * expected of this session, and a parked run is one of the things that can be.
 */
export function detectStall(
  s: Session,
  sessions: Session[],
  runs: readonly WorkflowRunSummary[],
  now: number,
  th: StallThresholds = DEFAULT_STALL_THRESHOLDS,
): Stall | null {
  if (s.state === "exited" || s.state === "stopping") return null;

  // 1. Foreman escalated a decision to you and it is still sitting there. The most
  //    certain of the three: something explicitly asked for a human and got no reply.
  if (s.note?.disposition === "escalated") {
    const age = now - s.note.updatedAt;
    if (age >= th.escalationMs) {
      return {
        sessionId: s.id,
        kind: "escalated",
        forMs: age,
        reason: `escalated to you ${mins(age)}m ago, still unanswered`,
      };
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
      return {
        sessionId: s.id,
        kind: "silent-working",
        forMs: age,
        reason: `working but silent for ${mins(age)}m${s.activity ? ` (last: ${s.activity})` : ""}`,
      };
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
  const outstanding = reportBucket(s, sessions) === "idle" ? workOutstanding(s, runs) : null;
  if (outstanding) {
    const age = now - quietSince(s);
    if (age >= th.unfinishedMs) {
      return outstanding.kind === "workflow-parked"
        ? {
          sessionId: s.id,
          kind: "workflow-parked",
          forMs: age,
          reason: parkedReason(outstanding.run, age),
          workflowRunId: outstanding.run.id,
        }
        : {
          sessionId: s.id,
          kind: "unfinished-work",
          forMs: age,
          reason: `idle ${mins(age)}m with work unfinished`,
        };
    }
  }

  return null;
}

/** Every currently-stuck session, at most one stall each. */
export function detectStalls(
  sessions: Session[],
  runs: readonly WorkflowRunSummary[],
  now: number,
  th: StallThresholds = DEFAULT_STALL_THRESHOLDS,
): Stall[] {
  const out: Stall[] = [];
  for (const s of sessions) {
    const stall = detectStall(s, sessions, runs, now, th);
    if (stall) out.push(stall);
  }
  return out;
}
