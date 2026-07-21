// Stall detection: which sessions are STUCK right now, as opposed to merely busy
// or merely finished. Pure and unit-tested, shared so the daemon's away-mode
// poller and the client's rendering can never disagree about what "stuck" means.
//
// This is the one piece of genuinely new detection in away mode. Everything the
// alert engine already fires is edge-triggered off a state CHANGE ("a gate just
// parked"); a stall is the opposite - it is defined by nothing having changed for
// long enough that the silence itself is the signal. That needs a clock, which is
// why this takes `now` and why it runs server-side: `sessionEqual`
// (src/server/registry.ts) deliberately excludes `lastActivity` from the SSE
// change comparison, so a session going quiet emits no client event at all.

import type { Session } from "./types.ts";
import { gateParked, reportBucket } from "./session.ts";

/**
 * Why a session is stuck. Ordered by how explicitly it is waiting on a human:
 * an escalation and a parked gate were handed to you deliberately, while the two
 * silence kinds are inferred from a clock.
 */
export type StallKind = "escalated" | "gate-parked" | "silent-working" | "unfinished-work";

export interface StallThresholds {
  /** Instrumented + working, but no hook event for this long. */
  workingMs: number;
  /** Idle this long with work still open against the session (see unfinished-work). */
  unfinishedMs: number;
  /** A gate parked and waiting on you for this long. */
  gateMs: number;
  /** A Foreman escalation nobody answered for this long. */
  escalationMs: number;
}

/**
 * Deliberately unequal. The two "handed to you" kinds fire soonest because they are
 * certain - something is definitely blocked on a human. `workingMs` is longer
 * because a quiet stretch mid-turn is normal (a long build, a slow test run), and
 * `unfinishedMs` is longest of all because it is the most inferential of the four.
 */
export const DEFAULT_STALL_THRESHOLDS: StallThresholds = {
  escalationMs: 5 * 60_000,
  gateMs: 5 * 60_000,
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

/**
 * When each parked gate was FIRST OBSERVED parked, keyed by session id.
 *
 * A parked gate carries no timestamp of its own - `axi status` dates nothing, and
 * `awaitingAgent` is a rendered duration string, not a clock - so the only honest
 * measure of how long it has been waiting on you is how long WE have seen it
 * waiting. Threaded through rather than derived per call because it is the one
 * thing a single snapshot cannot answer.
 */
export type ParkedSince = ReadonlyMap<string, number>;

/**
 * Carry the parked-gate observations forward one poll.
 *
 * A session that is no longer parked drops out, so a gate that parks, gets answered
 * and parks again is timed from the SECOND park rather than the first.
 */
export function trackParked(
  prev: ParkedSince | null,
  sessions: Session[],
  now: number,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const s of sessions) {
    if (s.state === "exited" || !gateParked(s, sessions)) continue;
    next.set(s.id, prev?.get(s.id) ?? now);
  }
  return next;
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
 * `sessions` is passed through to `gateParked` for its cross-session check (a gate
 * one session parked may still be driven by a sibling on the same run).
 *
 * `parkedSince` is the caller's record of when it first saw each gate park (see
 * trackParked); without it the gate rule cannot fire, because there is no honest
 * clock to measure the wait against.
 */
export function detectStall(
  s: Session,
  sessions: Session[],
  now: number,
  th: StallThresholds = DEFAULT_STALL_THRESHOLDS,
  parkedSince?: ParkedSince,
): Stall | null {
  if (s.state === "exited") return null;

  // 1. Foreman escalated a decision to you and it is still sitting there. The most
  //    certain of the four: something explicitly asked for a human and got no reply.
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

  // 2. A no-mistakes gate parked with no agent driving it. gateParked already did
  //    the work of proving no sibling session will answer it.
  //
  //    Timed from when the gate was first SEEN parked, never from `quietSince`: an
  //    agent can background an `axi run` that parks a gate long after its last hook
  //    event, so `now - quietSince` would call a gate that parked a minute ago
  //    "parked for 31m" - and a hookless session, whose clock falls back to
  //    `firstSeen`, would trip the threshold the instant it parked. A park nobody
  //    has observed yet is not a stall; the next poll has a baseline to measure from.
  const parkedAt = parkedSince?.get(s.id);
  if (parkedAt != null && gateParked(s, sessions)) {
    const age = now - parkedAt;
    if (age >= th.gateMs) {
      return {
        sessionId: s.id,
        kind: "gate-parked",
        forMs: age,
        reason: `gate parked at ${s.nomistakes?.gateStep ?? "a gate"} for ${mins(age)}m`,
      };
    }
  }

  // The two silence rules below gate on `instrumented`, without which `lastActivity`
  // is not a usable clock. An uninstrumented session posts no hooks, so its
  // `lastActivity` is stale or null and every one of them would read as stuck the
  // moment the threshold elapsed. A session that reportBucket calls "working" purely
  // via runInFlight is likewise excluded - that is a live no-mistakes process
  // re-confirmed every poll, which is the strongest evidence of progress we have.
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
  parkedSince?: ParkedSince,
): Stall[] {
  const out: Stall[] = [];
  for (const s of sessions) {
    const stall = detectStall(s, sessions, now, th, parkedSince);
    if (stall) out.push(stall);
  }
  return out;
}
