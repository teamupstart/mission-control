import type { Session } from "@shared/types.ts";
import { resumeArgvFor, sdkFor } from "../harness/index.ts";
import { spawnUniquely, sessionLabel } from "../dispatcher.ts";
import type { Registry } from "../registry.ts";
import type { SdkSupervisor } from "./supervisor.ts";
import { clearSdkSessionTask, restoreSdkSessionTask } from "./store.ts";

/**
 * "Continue in terminal": end the embedded session and reopen the SAME conversation in a
 * real terminal.
 *
 * This exists because of the one thing the embedded runtime genuinely takes away. A
 * pane-backed session is somewhere you can look and type; an embedded one is a card and a
 * transcript. Both vendors keep ONE session store across their programmatic and
 * interactive surfaces, so taking over is a handoff rather than a lost conversation - and
 * shipping it with the first driver is what stops the first embedded session an operator
 * dispatches from being a trap.
 *
 * ## The ordering, which is the whole of the correctness here
 *
 * A task's binding TRANSFERS; it must not settle. `session_remove` is what settles a task,
 * and it fires from the eviction the driver's `exited` begins - so the task's `sessionId`
 * is cleared BEFORE the driver is stopped, not after. Relying on the eviction linger to
 * outrun a patch would work today and be a silent `failed` on the day it does not.
 *
 * Then, in order: stop the driver (and WAIT for it, so the harness has closed its session
 * file before another process opens the same conversation), open the home, record it on the
 * task so teardown can still find it, and wait for discovery to adopt the new process so
 * the card the operator ends up looking at is bound to their task again.
 */

/** The seam: everything here that leaves the process, so a test can drive the real flow. */
export interface HandoffDeps {
  spawn: typeof spawnUniquely;
  waitForSessionAtCwd: (cwd: string, timeoutMs: number) => Promise<Session | null>;
  /**
   * Settle a task whose agent this handoff stopped and then could not replace.
   *
   * Injected rather than reached for, because settling a task has exactly one owner
   * (`TaskManager.agentWentAway`) and this module must not become a second one - the rules
   * that matter here are its rules: keep the worktree, and read a merged pull request as
   * `done` rather than as a failure.
   */
  settleTask: (taskId: string) => void;
}

/** How long to wait for the `ps` sweep to find the terminal successor. */
const ADOPT_TIMEOUT_MS = 30_000;

export type HandoffResult =
  | { ok: true; homeName: string; sessionId: string | null }
  | { ok: false; error: string };

export async function handOffToTerminal(
  registry: Registry,
  supervisor: SdkSupervisor,
  session: Session,
  deps: HandoffDeps,
): Promise<HandoffResult> {
  if (session.runtime !== "sdk") {
    return { ok: false, error: "this session already runs in a terminal" };
  }
  // TWO guards, because they catch different races and neither covers the other.
  //
  // A live driver is what makes this a handoff at all, and requiring one is what refuses a
  // REPEAT: after a successful transfer the handle is gone, so a second request (a double
  // click, a retry, the card lingering its eviction out) cannot stop nothing and then spawn
  // a second `claude --resume` on the same conversation.
  //
  // The claim below is for the CONCURRENT case, which the check above cannot see: two
  // requests can both read a live handle before either has stopped it. Taken before any
  // mutation - the task binding is cleared a few lines down, and two callers doing that is
  // how one conversation ends up with two agents and one of them holding the task.
  if (!supervisor.handleFor(session.id)) {
    return { ok: false, error: "this session has no live embedded driver to hand over" };
  }
  if (!supervisor.beginHandoff(session.id)) {
    return { ok: false, error: "this session is already being handed over to a terminal" };
  }
  try {
    return await transfer(registry, supervisor, session, deps);
  } finally {
    // Released either way. On success the session is gone and the handle check above is
    // what keeps a later request out; on failure the session may still be live and a
    // retry has to be possible.
    supervisor.endHandoff(session.id);
  }
}

/** The transfer itself, once this caller holds the only claim on it. */
async function transfer(
  registry: Registry,
  supervisor: SdkSupervisor,
  session: Session,
  deps: HandoffDeps,
): Promise<HandoffResult> {
  const spec = sdkFor(session.agent);
  if (!spec) return { ok: false, error: `${session.agent} has no embedded driver` };
  if (!session.agentSessionId) {
    // Nothing to resume FROM. A session that has not bound yet has no conversation on disk
    // for a terminal to open, and launching one anyway would start a fresh agent wearing
    // the card of the one we just killed.
    return {
      ok: false,
      error: "this session has not reported its identity yet - try again in a moment",
    };
  }
  // Every embedded session is registered with the checkout it was launched into, so this
  // cannot be null in practice - but `Session.cwd` is nullable for the pane-backed sessions
  // discovery cannot read a cwd for, and a handoff has nowhere to open without one.
  const cwd = session.cwd;
  if (!cwd) return { ok: false, error: "this session has no checkout to open a terminal in" };
  // From the HARNESS, not from `spec` above. The two questions this route asks - "can this
  // be driven embedded" and "how is its conversation reopened" - used to be one slot, which
  // meant a harness had to have a driver before it could say how to continue itself. The
  // driver check stays because a handoff stops a driver; the argv comes from elsewhere.
  //
  // The mode rides along because an embedded session's mode lived only in the driver's
  // options - there is nothing on disk for the reopened CLI to restore it from, and
  // without it a session running in auto reopens in the CLI's own default mode.
  const argv = resumeArgvFor(session.agent, session.agentSessionId, session.permissionMode);
  if (!argv) return { ok: false, error: `${session.agent} cannot reopen a conversation` };

  // Before the stop, deliberately. See the ordering note above.
  const task = registry.listTasks().find((t) => t.sessionId === session.id) ?? null;
  if (task) {
    clearSdkSessionTask(session.id);
    registry.upsertTask({ ...task, sessionId: null, updatedAt: Date.now() });
  }

  try {
    await supervisor.stop(session.id);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // Nothing has been replaced yet, so the unbinding above has to be taken back or the
    // task is stranded exactly as it would be if the spawn had failed - and here it is
    // worse, because the agent may still be RUNNING. Which of the two undos is right turns
    // on one question the supervisor can answer: is the handle still there?
    //
    // Read ONCE, and both the branch and the sentence below use that reading. Asking twice
    // would let the message describe a decision the code did not take, on the one path
    // where a human has nothing else to go on.
    const stillDriving = supervisor.handleFor(session.id) !== null;
    if (task) {
      if (stillDriving) {
        // The driver survived its own stop, so this is a handoff that simply did not
        // happen: put the task back on the session that is still driving it. `taskLiveness`
        // reads the ROW, so restoring the card without the row would leave a live agent
        // whose worktree a restart reclaims.
        restoreSdkSessionTask(session.id, task.id);
        registry.upsertTask({ ...task, sessionId: session.id, updatedAt: Date.now() });
      } else {
        // The stop reported a failure but the driver is gone anyway, so there is nothing to
        // rebind to and no `session_remove` that can settle this task - the same dead end
        // the spawn-failure path reaches, and it takes the same exit.
        deps.settleTask(task.id);
      }
    }
    const consequence = !task
      ? ""
      : stillDriving
        ? " and the task is still bound to it"
        : " and the task was marked failed with its worktree kept";
    return {
      ok: false,
      error:
        `the embedded session's driver could not be stopped (${why}) - nothing was handed ` +
        `over${consequence}`,
    };
  }

  const name = sessionLabel(task?.title?.trim() || session.name || session.agent);
  let homeName: string;
  try {
    homeName = await deps.spawn(name, session.id.slice(-6), cwd, argv[0]!, argv.slice(1));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // The agent is gone and nothing is going to replace it, so the task has to be SETTLED
    // here or it never will be. Its binding was cleared before the stop - deliberately, so
    // an ordinary transfer does not settle it - which means the eviction this handoff
    // started matches no task, and `rebindTaskAtCwd` cannot rescue it either: no terminal
    // is ever going to appear in that checkout. Left alone the row sits `running` with no
    // agent for ever, which is the exact failure the ordering exists to prevent, arriving
    // through the error path instead.
    //
    // Settled, not restored: restoring the binding would race the eviction's linger and
    // strand the task again whenever the spawn took longer than it to fail.
    if (task) deps.settleTask(task.id);
    // The conversation itself is intact on disk, so tell the operator plainly what they are
    // holding and the exact command that picks it back up.
    return {
      ok: false,
      error:
        `the embedded session was stopped but no terminal could be opened (${why}) - ` +
        `its task was marked failed with its worktree kept; run \`${argv.join(" ")}\` in ` +
        `${cwd} to continue the conversation yourself`,
    };
  }
  if (task) registry.upsertTask({ ...registry.getTask(task.id)!, homeName, updatedAt: Date.now() });

  // Rebind the task to whatever discovery finds in that checkout. Absence is not an error -
  // the home is open and the sweep will keep looking - so this reports what it got rather
  // than failing a handoff that has already happened.
  const adopted = await deps.waitForSessionAtCwd(cwd, ADOPT_TIMEOUT_MS);
  if (adopted && task && registry.getTask(task.id)?.sessionId === null) {
    registry.upsertTask({
      ...registry.getTask(task.id)!,
      sessionId: adopted.id,
      updatedAt: Date.now(),
    });
    registry.bindTaskToWorkEpisode(task.id, adopted.id);
  }
  return { ok: true, homeName, sessionId: adopted?.id ?? null };
}
