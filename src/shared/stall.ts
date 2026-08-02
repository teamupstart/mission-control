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

/**
 * Why a session is stuck. Ordered by how explicitly it is waiting on a human:
 * an escalation was handed to you deliberately, while the two silence kinds are
 * inferred from a clock.
 */
export type StallKind = "escalated" | "silent-working" | "unfinished-work";

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
}

/** Terminal task states - work that is over, however it ended. */
function taskOpen(s: Session): boolean {
  const st = s.task?.status;
  return st === "backlog" || st === "dispatching" || st === "running";
}

/**
 * True when work is still outstanding against this session: a task that never
 * reached a terminal state, or a queue with un-drained items.
 *
 * This is what separates "stuck" from "done". A finished session is idle forever,
 * so a plain idle-timeout would eventually flag every session that ever completed
 * anything - which is noise, not signal. The distinguishing fact is whether
 * anything was still expected of it. This repo had already scored that exact gap
 * against itself before away mode existed - see the "Turn-end safety" row of the
 * capability comparison in todo/foreman-upgrades.md, which is what this rule
 * partially closes.
 */
function workOutstanding(s: Session): boolean {
  if (taskOpen(s)) return true;
  const q = s.queue;
  return Boolean(q && q.openCount > 0 && !q.drained);
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
 * agree about whether the session is working or idle.
 */
export function detectStall(
  s: Session,
  sessions: Session[],
  now: number,
  th: StallThresholds = DEFAULT_STALL_THRESHOLDS,
): Stall | null {
  if (s.state === "exited") return null;

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
  if (reportBucket(s, sessions) === "idle" && workOutstanding(s)) {
    const age = now - quietSince(s);
    if (age >= th.unfinishedMs) {
      return {
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
  now: number,
  th: StallThresholds = DEFAULT_STALL_THRESHOLDS,
): Stall[] {
  const out: Stall[] = [];
  for (const s of sessions) {
    const stall = detectStall(s, sessions, now, th);
    if (stall) out.push(stall);
  }
  return out;
}
