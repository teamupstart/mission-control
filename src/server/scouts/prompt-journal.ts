import type { Session, Task } from "@shared/types.ts";
import type { SessionWorkEpisode } from "../db.ts";
import { sessionMessages } from "../harness/index.ts";
import { isScoutTask } from "./prompt.ts";
import {
  appendScoutPromptTurn,
  clearScoutPromptContext,
  openScoutPromptContext,
  scoutPromptTurnId,
  type ScoutPromptContext,
  type ScoutPromptOrigin,
  type ScoutPromptTurn,
} from "./prompt-context.ts";

/**
 * The seam between "a delivery happened" and "a scout episode owns it".
 *
 * Split from the store so the store stays a table and this stays a decision. Everything
 * here answers one question - does this delivery belong to a scout work episode, and
 * which - and it answers it from ownership the Registry already tracks. It never infers a
 * scout from a repository, a session name, a worktree path or a prompt's contents: those
 * are all things an operator can make look like anything, and a wrong yes here archives a
 * conversation that was never meant to be archived.
 */

/**
 * The slice of Registry this needs, named structurally.
 *
 * A narrow interface rather than the class, because these are pure lookups and a test
 * that had to build a Registry to prove a non-scout session journals nothing would be
 * testing the Registry instead.
 */
export interface ScoutEpisodeSource {
  getSession(id: string): Session | undefined;
  taskForSession(sessionId: string, cwd: string | null): Task | undefined;
  /**
   * Narrowed to the one field this reads, so `SessionWorkEpisode` satisfies it structurally
   * and a fixture does not have to invent a branch, a pull request and a merge time to say
   * "this session is on episode 1".
   */
  workEpisodeForSession(sessionId: string): Pick<SessionWorkEpisode, "episodeId"> | null;
}

/**
 * Where the boundary is measured from.
 *
 * `current` is a prompt about to be typed into a session that already has history, so the
 * anchor is the transcript's size right now. `launch` is a prompt that travelled in the
 * process launch itself - pi's positional argument, and an embedded session's opening
 * turn - where there is no "before", so the whole file belongs to this episode.
 */
export type ScoutPromptAnchor = "current" | "launch";

/**
 * Freeze one scout episode's title and transcript boundary, immediately before its
 * composed prompt crosses into the runtime.
 *
 * Returns null for every delivery that is not a scout's, which is most of them, and for a
 * session with no work episode yet - a scout whose episode has not landed is a scout whose
 * follow-ups could not be attributed to it either, and inventing a key here would let two
 * different runs of one task share a boundary.
 *
 * The task is passed rather than resolved because both callers already hold it and neither
 * has published it yet: at dispatch the task's `sessionId` is set AFTER delivery, so asking
 * `taskForSession` here would fall through to a worktree lookup and answer about whatever
 * else was in that directory.
 */
export function freezeScoutPromptBoundary(
  source: ScoutEpisodeSource,
  task: Task,
  sessionId: string,
  anchor: ScoutPromptAnchor,
  now?: number,
): ScoutPromptContext | null {
  if (!isScoutTask(task)) return null;
  const session = source.getSession(sessionId);
  if (!session) return null;
  const episode = source.workEpisodeForSession(sessionId);
  if (!episode) return null;

  const located = sessionMessages(session);
  // Zero and null are different answers, not a value and its fallback.
  //
  // A `launch` anchor is zero whether or not a path was found. The prompt travelled with the
  // process, so the episode owns the file from its first byte - that is true of an embedded
  // session whose transcript does not exist YET, and a collector that re-locates the file
  // later can page all of it. Writing null there because the name was not available at this
  // instant would discard a fact that is true, and would make every embedded scout's trail
  // report as incomplete for no reason.
  //
  // A `current` anchor is null when nothing could be located or measured, because then
  // nothing separates this task's turns from the conversation the session was already
  // having. `size` can also answer null for a file that vanished between locating and
  // measuring, which is the same "no anchor" and reads as it.
  const offset =
    anchor === "launch" ? 0 : located ? (located.read.size(located.path) ?? null) : null;
  return openScoutPromptContext(
    {
      taskId: task.id,
      episodeId: episode.episodeId,
      sessionId: session.id,
      sessionName: session.name,
      transcriptPath: located?.path ?? null,
      transcriptOffset: offset,
    },
    now,
  );
}

/**
 * Discard a boundary whose delivery did not happen.
 *
 * A frozen context that was never followed by a prompt is worse than no context: it says
 * an episode saw a task it never received, and a later capture would archive an anchor
 * into a conversation that never started.
 */
export function discardScoutPromptBoundary(context: ScoutPromptContext | null): void {
  if (context) clearScoutPromptContext(context.taskId, context.episodeId);
}

/**
 * Record one user-role delivery that positively reached the runtime.
 *
 * Every caller is a POSITIVE acceptance point - a verified terminal pickup, an accepted
 * SDK turn. A queued draft, a recalled row, a refused paste and an unresolved uncertain
 * delivery all reach this function never, and that is the difference between a record of
 * what the agent was told and a record of what somebody typed into a box.
 *
 * **For whoever adds the immediate `/inject` seam**, which is a route change and therefore
 * a later phase's: `r.ok` is NOT its acceptance boundary on a terminal session. `injectPrompt`
 * returns `{ ok: true, submitVerified: false }` on two reachable paths - a harness that
 * renders no pending-paste placeholder, so one Enter is spent and the outcome is honestly
 * unverified, and a run of unreadable captures that ends the wait with the Enter already
 * sent. In both, the text may still be sitting in the composer, which is the same doubt
 * `PendingTurnManager` records as `uncertain` and refuses to journal. Require
 * `submitVerified` as well. Embedded sessions are unaffected either way: `deliverToDriver`
 * has no ambiguous state. This is written down because it is not visible from the route,
 * and getting it wrong archives a prompt the agent may never have received.
 *
 * Non-scout sessions, sessions with no episode, and episodes with no frozen boundary all
 * return null and write nothing.
 */
export function journalScoutPrompt(
  source: ScoutEpisodeSource,
  sessionId: string,
  text: string,
  origin: ScoutPromptOrigin,
  id: string = scoutPromptTurnId(),
  now?: number,
): ScoutPromptTurn | null {
  const session = source.getSession(sessionId);
  if (!session) return null;
  const task = source.taskForSession(sessionId, session.cwd);
  if (!task || !isScoutTask(task)) return null;
  const episode = source.workEpisodeForSession(sessionId);
  if (!episode) return null;
  return appendScoutPromptTurn(
    { id, taskId: task.id, episodeId: episode.episodeId, origin, text },
    now,
  );
}
