import type { Session } from "@shared/types.ts";
import { resolveAgentBin, sdkFor } from "../harness/index.ts";
import { spawnUniquely, sessionLabel } from "../dispatcher.ts";
import type { Registry } from "../registry.ts";
import type { SdkSupervisor } from "./supervisor.ts";
import { clearSdkSessionTask } from "./store.ts";

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
  const argv = [resolveAgentBin(session.agent), ...spec.resumeArgv(session.agentSessionId)];

  // Before the stop, deliberately. See the ordering note above.
  const task = registry.listTasks().find((t) => t.sessionId === session.id) ?? null;
  if (task) {
    clearSdkSessionTask(session.id);
    registry.upsertTask({ ...task, sessionId: null, updatedAt: Date.now() });
  }

  await supervisor.stop(session.id);

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
