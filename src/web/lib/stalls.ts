import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { workflowRunParkedOnSession, type WorkflowRunSummary } from "@shared/workflow.ts";
import {
  hasOpenStallTask, isIdleStall, legacyStallFingerprint, openStallQueueCount, stallFingerprint,
  workflowOwnsNextMove, type Stall,
} from "@shared/stall.ts";
import { fetchAwayStalls } from "./api.ts";

/** Matches useAwayMode's cadence, and the daemon's own poll - a faster read finds nothing new. */
const POLL_MS = 5000;

/** Shared empty array, so "no stalls" is one stable reference across renders. */
export type ObservedStall = Stall & { legacy?: true };
const NONE: ObservedStall[] = [];

/** Bind an older daemon's response to the session episode observed when its poll started. */
export function captureStalls(stalls: Stall[], sessions: readonly Session[]): ObservedStall[] {
  if (stalls.every(stall => stall.fingerprint && (!isIdleStall(stall) || stall.since !== undefined))) return stalls;
  const byId = new Map(sessions.map(session => [session.id, session]));
  return stalls.map(stall => {
    const session = byId.get(stall.sessionId);
    const observed = isIdleStall(stall) && stall.since === undefined && session
      ? { ...stall, since: session.lastActivity ?? session.firstSeen } : stall;
    return stall.fingerprint ? observed : {
      ...observed, legacy: true, fingerprint: legacyStallFingerprint(stall, session),
    };
  });
}

/** Keep a polled stall's controls and dismissal key in sync with live session updates. */
function currentStall(stall: ObservedStall, session: Session | undefined): ObservedStall | null {
  if (!session) return stall.legacy ? null : stall;
  const activity = session.lastActivity ?? session.firstSeen;
  if (isIdleStall(stall) && stall.since !== undefined && activity > stall.since) return null;
  const facts = stall.facts;
  if (facts?.kind !== "unfinished-work") {
    return stall.legacy && legacyStallFingerprint(stall, session) !== stall.fingerprint ? null : stall;
  }

  const queueOpen = openStallQueueCount(session);
  if (facts.task && (facts.task.id !== session.task?.id || !hasOpenStallTask(session))) return null;
  if (!facts.task && !queueOpen) return null;
  if (stall.legacy && stall.since === undefined) return null;
  const task = facts.task && session.task && facts.task.title !== session.task.title
    ? { id: session.task.id, title: session.task.title } : facts.task;
  const updated = task === facts.task && queueOpen === facts.queueOpen ? facts : { ...facts, task, queueOpen };
  if (updated === facts && !stall.legacy) return stall;
  const fingerprint = stall.legacy
    ? legacyStallFingerprint({ ...stall, facts: updated }, session)
    : stallFingerprint(updated, stall.since ?? activity);
  return updated === facts && fingerprint === stall.fingerprint ? stall : { ...stall, facts: updated, fingerprint };
}

export function currentStalls(
  stalls: ObservedStall[] | undefined,
  sessions: readonly Session[],
  runs?: readonly WorkflowRunSummary[],
): Stall[] | undefined {
  if (!stalls?.length) return stalls;
  const byId = new Map(sessions.map(session => [session.id, session]));
  const byRun = runs && new Map(runs.map(run => [run.id, run]));
  const current: ObservedStall[] = [];
  for (const stall of stalls) {
    // A live run update can arrive ahead of the next stall poll.
    if (workflowOwnsNextMove(stall.sessionId, runs)) continue;
    if (stall.kind === "workflow-parked" && byRun) {
      const facts = stall.facts?.kind === "workflow-parked" ? stall.facts : undefined;
      const id = facts?.runId ?? stall.workflowRunId;
      if (id) {
        const run = byRun.get(id);
        if (!run || run.sessionId !== stall.sessionId || !workflowRunParkedOnSession(run.status)) continue;
        if (facts && (run.round !== facts.round || run.status !== facts.status)) continue;
      }
    }
    const latest = currentStall(stall, byId.get(stall.sessionId));
    if (latest) current.push(latest);
  }
  return current.length === stalls.length && current.every((stall, i) => stall === stalls[i]) ? stalls : current;
}

/**
 * The daemon's currently-stuck sessions, polled into the client.
 *
 * This is what gives the `stuck` alert a delivery path. Detection is server-side by
 * necessity (a stall is elapsed silence, which `sessionEqual` keeps out of the SSE
 * change comparison), but the browser is the only thing that can raise a desktop
 * notification - so the signal has to come back the other way for a stuck session to
 * interrupt you rather than wait for the return digest.
 *
 * Polled rather than pushed for the same reason useAwayMode is: an SSE event would
 * mean touching the registry's event plumbing and the ServerEvent protocol for data
 * the daemon only recomputes on its own 5s tick.
 *
 * The reference is held stable while the stalls are unchanged - the common case by
 * far - so a poll that finds nothing new doesn't re-render the dashboard.
 *
 * `undefined` until the first read lands, and deliberately NOT an empty array: this
 * arrives on its own channel, so it can land either side of the SSE snapshot, and
 * "not read yet" has to stay distinguishable from "read, nothing stuck" or the
 * consumer cannot tell a stall that is news from one that was there all along (see
 * withKnownStalls).
 */
export function useStalls(sessions: readonly Session[], runs: readonly WorkflowRunSummary[] | undefined) {
  const [poll, setPoll] = useState<{ reported: Stall[]; observed: ObservedStall[] }>();
  const currentSessions = useRef(sessions);
  currentSessions.current = sessions;
  const seen = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    let reading = false;
    const read = async (): Promise<void> => {
      if (reading) return;
      reading = true;
      const atStart = currentSessions.current;
      const response = await fetchAwayStalls().finally(() => { reading = false; });
      if (!alive || !response) return;
      const next = captureStalls(response, atStart);
      // `forMs` climbs every tick, so it is deliberately not part of the signature:
      // comparing on it would re-render on each poll for a stall nothing changed
      // about. The alert engine edge-triggers on (session, kind) anyway. The fingerprint is in
      // it because a Stuck row draws the facts, which can change while the sentence does not.
      const sig = next.map((s) => `${s.sessionId}:${s.kind}:${s.reason}:${s.fingerprint}:${s.since}`).join("|");
      if (sig === seen.current) return;
      seen.current = sig;
      setPoll({ reported: response.length ? response : NONE, observed: next.length ? next : NONE });
    };
    void read();
    const id = setInterval(() => void read(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const current = useMemo(() => currentStalls(poll?.observed, sessions, runs), [poll, sessions, runs]);
  return { reported: poll?.reported, current };
}
