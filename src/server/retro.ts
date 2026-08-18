import { canMessage } from "@shared/pane.ts";
import { HARNESS_CAPABILITIES, skillLoadingAgents } from "@shared/harness-capabilities.ts";
import { MEMORY_DIR } from "@shared/memory.ts";
import { PULL_REQUEST_SKILL } from "@shared/skills.ts";
import type { RetroResponse } from "@shared/protocol.ts";
import type { AgentType, Session, Task } from "@shared/types.ts";
import { BUILTIN_SESSION_ACTIONS, RETRO_SESSION_ACTION_ID } from "./workflows/builtin-session-actions.ts";
import { renderSessionAction } from "./workflows/feedback.ts";
import { requiredSkillCommand, skillInvocationForAgent } from "./skills/invoke.ts";
import { recordInjection } from "./injections.ts";
import { injectPromptForRuntime } from "./sdk/deliver.ts";
import { resolveTaskRepoRoot } from "./repos.ts";
import type { SdkSupervisor } from "./sdk/supervisor.ts";
import type { TaskManager } from "./tasks.ts";
import {
  retroFollowupForSource,
  retroPrPostureForTask,
  taskWorkEpisodeForSession,
  type RetroPrPosture,
  type TaskWorkEpisodeBinding,
} from "./db.ts";
import { COMPLETE_RETRO_NO_CHANGE_TOOL } from "./retro-tool.ts";

// Delivering the retro on demand, which is the one session action a human asks for directly.
//
// Everything a workflow's action delivery does - render the packet, gate it on the required
// skill, type it, attribute the turn - happens here too, and deliberately NOT by calling into
// `WorkflowManager.prepareSessionAction`. That path is workflow-coupled all the way down: it
// resolves a run binding, writes a durable delivery row against a submission, moves a run into
// `waiting_for_action`, and arms the completion observer that eventually reports the run
// finished. A retro has no run, so every one of those would have to be faked, and a faked run
// is a row an operator can open.
//
// What is lost by composing the primitives instead is stated rather than glossed: an on-demand
// retro has no delivery ledger entry, so it cannot be retried from the Runs page, and no
// completion attempt, so the `repo_commit` adapter never observes it. The commit is reviewed in
// the pull request, which is where a memory commit was always going to be judged.
//
// The R3 fallback below - dispatch a retro task when the session can no longer be typed into -
// is the source plan's, and it keeps the daemon out of git either way: a task is a row, and the
// agent it launches is what commits.
//
// Every arm fails closed on the skills it names, and the task arms are the easier ones to get
// wrong. They type nothing, so it looks like they have nothing to gate - but the skill is where the
// human-approval ceremony lives, so a task filed while the skill is off would reach an agent
// holding an intent that names a procedure it cannot load. The arms ask different questions of
// the same config, because they are about different agents at different times: the live arm
// asks whether THIS session can run the skill NOW, watermark included; the dispatch arm asks
// whether the harness it is about to pick could run it at launch, where a watermark about some
// other session's history is not evidence.

/**
 * What the retro route did, or the reason it did nothing.
 *
 * The success arms are `RetroResponse` itself rather than a copy of it, so the shape this
 * returns and the shape the browser is promised cannot drift. The refusal arm stays here: an
 * error is reported as every other route reports one, `{ error }` under a status, and putting
 * it in the union would invite a caller to look for `kind` on a 409.
 */
export type RetroResult =
  | RetroResponse
  | {
    kind: "refused";
    status: 409 | 500 | 503;
    error: string;
    /**
     * Whether text reached the session's composer, on a refusal that ATTEMPTED a write.
     *
     * Present only for a delivery failure, and it is the difference between a refusal a
     * caller may retry and one it must not. Delivery is a non-atomic sequence (paste, then
     * submit), and a submit that fails leaves the packet sitting in the composer unsent -
     * `pasted: true`. Retrying that appends a second retro instruction under the first.
     *
     * Absent means no write was attempted at all, which every other refusal here is. The
     * same rule `/inject` holds, for the same reason: absence of evidence is not evidence,
     * so a route that can know this has to say it rather than let a caller assume.
     */
    pasted?: boolean;
  };

export interface RetroDeps {
  tasks: TaskManager;
  sdkSessions?: SdkSupervisor;
  /** The pre-write refusal a live session may currently have. Same guard `/inject` passes. */
  promptBlocker: (sessionId: string) => string | null;
  requireSkill?: typeof requiredSkillCommand;
  /** The launch-time half of the same gate, asked of the harness a retro TASK would run on. */
  skillForAgent?: typeof skillInvocationForAgent;
  inject?: typeof injectPromptForRuntime;
  remember?: typeof recordInjection;
  /** Injected so a route test never shells out to git. Returns the task's main checkout. */
  resolveRepoRoot?: typeof resolveTaskRepoRoot;
  /** Durable seams for focused routing tests; production always reads the database. */
  sourceBindingForSession?: typeof taskWorkEpisodeForSession;
  retroPostureForTask?: typeof retroPrPostureForTask;
}

/** The shipped Retro action, resolved from the build rather than from the operator library.
 *
 * Deliberately not `SessionActionManager.get`: a human clicking Retro is asking for THE retro,
 * and a library lookup would let a same-named operator row - or an archived built-in - decide
 * what gets typed into their session. Duplicating and customizing the action remains supported
 * for workflow stages, which is where an operator chooses an action by name.
 */
function retroAction() {
  return BUILTIN_SESSION_ACTIONS.find((action) => action.id === RETRO_SESSION_ACTION_ID) ?? null;
}

/**
 * Route a retro by durable review posture, then by whether its source session is reachable.
 *
 * A current open pull request keeps the source session and its context. A merged review moves
 * branch and review ownership into one linked Task before reachability is considered. With no
 * merged posture, an unreachable session retains the original backlog fallback.
 */
export async function runRetro(session: Session, deps: RetroDeps): Promise<RetroResult> {
  const action = retroAction();
  if (!action) {
    return {
      kind: "refused",
      status: 500,
      error: "This build ships no retro session action.",
    };
  }

  // An OPEN current review remains the source session's review, so it falls through to the
  // existing delivery path below. A MERGED review cannot accept another commit: branch and
  // review ownership move together into one linked follow-up Task while the source stays done.
  const sourceBinding = (deps.sourceBindingForSession ?? taskWorkEpisodeForSession)(session.id);
  if (sourceBinding) {
    const posture = (deps.retroPostureForTask ?? retroPrPostureForTask)(sourceBinding.taskId);
    if (posture?.kind === "merged") {
      return startPostMergeRetro(session, posture, action.requiredSkillId, deps);
    }
  }

  // "Gone" for a retro's purposes is "cannot be typed into", not "absent from the registry".
  // An exited session lingers on the board with its cwd, branch and pull request still
  // readable, and that lingering row is exactly what the fallback needs to name the work.
  // `state === "exited"` is never read as durable removal (see `session_remove`); it is read
  // here as "a turn sent now would land nowhere", which is the question being asked.
  if (session.state === "exited" || !canMessage(session)) {
    return dispatchRetroTask(session, action.requiredSkillId, deps);
  }

  const requireSkill = deps.requireSkill ?? requiredSkillCommand;
  const skill = action.requiredSkillId
    ? requireSkill(session, action.requiredSkillId)
    : ({ ok: true, command: "" } as const);
  // Fails CLOSED, and 409 rather than 400: the request is well-formed and the machine is not
  // ready for it. The message is the skills panel's own sentence, so an operator is told which
  // toggle to flip rather than that something went wrong.
  if (!skill.ok) return { kind: "refused", status: 409, error: skill.message };

  const rendered = renderSessionAction({
    origin: { kind: "session", sessionId: session.id },
    actionName: action.name,
    promptMarkdown: action.promptMarkdown,
    skillCommand: action.requiredSkillId ? skill.command : null,
    workflowEvidence: false,
  });
  // Refused whole, never sent as a prefix - the same rule the workflow path applies, and for
  // the same reason. A shipped action cannot reach this, so it is a build-integrity failure.
  if (!rendered.ok) {
    return {
      kind: "refused",
      status: 500,
      error: `The retro instruction is ${rendered.bytes} bytes once addressed to the session, `
        + `over the ${rendered.limit} a single packet can carry.`,
    };
  }

  const inject = deps.inject ?? injectPromptForRuntime;
  const result = await inject(
    deps.sdkSessions,
    session,
    rendered.payload,
    undefined,
    // Re-checked INSIDE the write lock, which is the same guarantee `deliveryBlock` gives a
    // workflow's delivery. Rendering and typing look adjacent here, but an embedded session
    // serializes sends per session, so the packet can wait behind another turn - and a skill
    // switched off in that window would have this type `/retro` at a session that no longer
    // loads it, which is an instruction with no procedure behind it.
    () => deps.promptBlocker(session.id) ?? staleSkill(session, rendered.payload, action.requiredSkillId, requireSkill),
  );
  if (!result.ok) {
    return {
      kind: "refused",
      status: 503,
      error: result.error ?? "The retro instruction could not be delivered to this session.",
      // Reported rather than inferred. A live session is not a promise of delivery, and the
      // two ways it fails are opposite problems: nothing reached the pane (retry it), or the
      // packet is sitting in the composer with the submit refused (do not retype over it).
      pasted: result.pasted,
    };
  }
  // Only once it landed, exactly as `/inject` does: attributing a turn that was never typed
  // would colour a LATER turn that happens to repeat the text as machine-typed.
  //
  // `harness` rather than `workflow`, because that is what typed it. No workflow run exists,
  // and the transcript reader's three origins are about WHO drove the session: this is the
  // daemon acting on a human's click, which is the same authorship as the `/reload-skills`
  // broadcast that already uses it.
  (deps.remember ?? recordInjection)(session.id, rendered.payload, "harness");
  return {
    kind: "delivered",
    sessionId: session.id,
    payloadSha256: rendered.payloadSha256,
    submitVerified: result.submitVerified,
  };
}

/**
 * Whether the skill invocation this packet leads with has stopped being the right one.
 *
 * Both halves matter, and they are the pair `deliveryBlock` checks: the skill must still
 * resolve, AND the payload must still start with the line it resolves to. A skill re-enabled
 * under a different name between render and write would pass the first check and fail the
 * second, and typing the stale line would invoke nothing at all.
 */
function staleSkill(
  session: Session,
  payload: string,
  requiredSkillId: string | null,
  requireSkill: typeof requiredSkillCommand,
): string | null {
  if (!requiredSkillId) return null;
  const required = requireSkill(session, requiredSkillId);
  if (!required.ok) return required.message;
  return payload.startsWith(`${required.command}\n`)
    ? null
    : `The ${requiredSkillId} skill's invocation changed while this retro was being prepared.`;
}

/** Start or recover the separate task that owns a retrospective after its work PR merged. */
async function startPostMergeRetro(
  session: Session,
  posture: Extract<RetroPrPosture, { kind: "merged" }>,
  retroSkillId: string | null,
  deps: RetroDeps,
): Promise<RetroResult> {
  const sourceTask = deps.tasks.getDurable(posture.binding.taskId);
  if (!sourceTask) {
    return {
      kind: "refused",
      status: 409,
      error: "The merged pull request no longer has its source task, so its retro cannot be linked safely.",
    };
  }
  // A primary review can merge before an attached repository's review. The durable posture
  // above answers where a retro would belong, not whether the whole source task has shipped.
  // Task completion is the existing merge-quorum projection, so wait for that single source of
  // truth rather than reimplementing the per-repository changed-set rule in retro routing.
  if (sourceTask.status !== "done") {
    return {
      kind: "refused",
      status: 409,
      error: `The source task is still ${sourceTask.status}. Wait until it is complete, including every attached repository review, before starting its post-merge retro.`,
    };
  }

  const requiredSkills = [retroSkillId, PULL_REQUEST_SKILL].filter(
    (skillId): skillId is string => skillId !== null,
  );
  const existingRelation = retroFollowupForSource(sourceTask.id, posture.binding.episodeId);
  const existingTask = existingRelation
    ? deps.tasks.getDurable(existingRelation.retroTaskId)
    : undefined;
  if (existingTask && ["dispatching", "running", "done"].includes(existingTask.status)) {
    return { kind: "started", task: existingTask };
  }
  if (
    existingTask &&
    (existingTask.status === "cancelled" ||
      (existingTask.status === "failed" &&
        (existingTask.worktreePath !== null ||
          existingTask.homeName !== null ||
          existingTask.sessionId !== null ||
          existingTask.extraRepos.some((repo) => repo.worktreePath !== null))))
  ) {
    return {
      kind: "refused",
      status: 409,
      error: `The linked retro task is ${existingTask.status} and still needs operator cleanup; a duplicate task was not created.`,
    };
  }
  const runner = retroRunner(session, requiredSkills, deps, existingTask?.agent);
  if ("problem" in runner) {
    if (existingTask) {
      return {
        kind: "queued",
        task: existingTask,
        reason: boundedReason(runner.problem),
      };
    }
    return {
      kind: "refused",
      status: 409,
      error: `${runner.problem} A post-merge retro needs both its approval procedure and its own pull-request shipping procedure.`,
    };
  }

  let task: Task;
  try {
    task = deps.tasks.createRetroFollowup({
      sourceTask,
      sourceEpisodeId: posture.binding.episodeId,
      sourceSessionId: posture.binding.sessionId,
      title: `Retro: ${sourceTask.title}`.slice(0, 120),
      intent: postMergeRetroIntent(session, sourceTask, posture.binding),
      agent: runner.agent,
    });
  } catch (error) {
    return {
      kind: "refused",
      status: 500,
      error: `The linked retro task could not be created safely: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const dispatched = await deps.tasks.dispatch(task.id, {
    missionMcp: { tools: [COMPLETE_RETRO_NO_CHANGE_TOOL] },
  });
  if (dispatched.ok) return { kind: "started", task: dispatched.task };

  const current = dispatched.task ?? deps.tasks.get(task.id) ?? task;
  const cleanRetry =
    current.status === "backlog" ||
    (current.status === "failed" &&
      current.worktreePath === null &&
      current.homeName === null &&
      current.sessionId === null &&
      current.extraRepos.every((repo) => repo.worktreePath === null));
  if (cleanRetry) {
    return { kind: "queued", task: current, reason: boundedReason(dispatched.error) };
  }
  return {
    kind: "refused",
    status: 409,
    error: `The linked retro task exists but cannot be launched safely: ${dispatched.error}`,
  };
}

function boundedReason(reason: string): string {
  return reason.trim().slice(0, 400) || "the task could not be launched yet";
}

/** A self-contained brief for an agent that did not perform the source work. */
function postMergeRetroIntent(
  clickedSession: Session,
  sourceTask: Task,
  sourceBinding: TaskWorkEpisodeBinding,
): string {
  const repoRoots = [sourceTask.repoRoot, ...sourceTask.extraRepos.map((repo) => repo.repoRoot)];
  const facts = [
    `Source task: ${sourceTask.title} (${sourceTask.id})`,
    `Source work episode: ${sourceBinding.episodeId}`,
    `Source session: ${clickedSession.name} (${clickedSession.id})`,
    sourceBinding.branch ? `Source branch: ${sourceBinding.branch}` : null,
    sourceBinding.prUrl ? `Merged pull request: ${sourceBinding.prUrl}` : null,
    clickedSession.cwd ? `Former worktree: ${clickedSession.cwd}` : null,
    `Repository set: ${repoRoots.join(", ")}`,
  ].filter((line): line is string => line !== null);
  return [
    "Run the retrospective for the completed Mission Control work named below. The work pull",
    "request has already merged, so this is a separate follow-up task with fresh branches and",
    "must never reopen, reassign, or rewrite the source task.",
    "",
    ...facts,
    "",
    "Invoke the retro skill and follow its approval ceremony. Propose at most three memories",
    `and write only what the human explicitly approves into the appropriate ${MEMORY_DIR}.`,
    "Use the source transcript when available; otherwise reconstruct from the merged changes,",
    "review conversation, and corrections, and state that limitation in the proposals.",
    "",
    "If the human approves memory changes, commit them as this task's agent-authored work, invoke",
    "the pull-request skill, and open or update this task's own pull request in each repository",
    "that changed. Never add commits to the already-merged source branch or pull request.",
    "",
    `If no memory is approved or the proposals are dismissed, call ${COMPLETE_RETRO_NO_CHANGE_TOOL}.`,
    "Do not create an empty commit, open a pull request, or request review for a no-change retro.",
  ].join("\n");
}

/**
 * The R3 fallback: file a retro task against the repository the dead session worked in.
 *
 * A backlog task rather than an immediate dispatch. The retro is a small piece of housekeeping
 * about work that has already finished, so it must not jump a queue of real work or take a
 * worktree lease the moment somebody clicks; the operator dispatches it when they want it.
 *
 * Gated on the skill FIRST, and that is not symmetry for its own sake. The retro skill is not
 * decoration on this path: it is where the human-approval ceremony lives, so an agent that
 * reaches the task without it would run a retrospective whose one hard rule - write nothing a
 * human did not approve - exists only as a sentence in an intent nobody enforces. Filing a
 * task whose procedure is switched off is exactly the failure "fails closed" promises not to
 * be, and refusing it here is what makes that promise true of both arms rather than one.
 */
async function dispatchRetroTask(
  session: Session,
  requiredSkillId: string | null,
  deps: RetroDeps,
): Promise<RetroResult> {
  const runner = retroRunner(session, requiredSkillId ? [requiredSkillId] : [], deps);
  if ("problem" in runner) {
    return {
      kind: "refused",
      status: 409,
      error: `${runner.problem} A retro task filed now would reach an agent that cannot load `
        + "the procedure its intent names.",
    };
  }

  const from = session.repoRoot ?? session.gitRoot ?? session.cwd;
  if (!from) {
    return {
      kind: "refused",
      status: 409,
      error: "This session cannot receive a retro and no repository can be resolved from it, "
        + "so there is nowhere to file one.",
    };
  }
  const resolved = await (deps.resolveRepoRoot ?? resolveTaskRepoRoot)(from);
  if (!resolved.ok) return { kind: "refused", status: 409, error: resolved.error };

  const task = deps.tasks.create({
    repoRoot: resolved.repoRoot,
    // Bounded because a session's name is whatever its pane or process was called, and this
    // one is not schema-validated on the way in - `create` is called directly, not through
    // `DispatchSchema`. A card's title is a label, not the brief; the brief is the intent.
    title: `Retro: ${session.name}`.slice(0, 120),
    intent: retroTaskIntent(session),
    kind: "ship",
    agent: runner.agent,
    backlog: true,
  });
  return { kind: "dispatched", task };
}

/**
 * Which harness a dispatched retro should run on, or why none of them can.
 *
 * Asked of the AGENT rather than of the dead session, because the session is not what will run
 * the task - it is gone, which is why there is a task at all. Its harness is only a preference:
 * it read the same repository and wrote the transcript being reviewed, so it is tried first,
 * and a harness that cannot actually invoke the skill hands the work to one that can.
 *
 * All three shipped harnesses declare a skills directory today, so the fallback is about
 * INVOCABILITY rather than about a harness that loads nothing: a drifted symlink under one
 * agent's directory is the case it really covers, and the candidate list stays written as a
 * capability question so a future skill-less harness needs no change here.
 *
 * `skillInvocationForAgent` rather than `requiredSkillCommand`: the reload watermark is a fact
 * about a live conversation's history, and the conversation this picks a harness for has not
 * started. See that function for why borrowing the stricter check would answer wrongly in both
 * directions.
 *
 * The reported problem comes from the first SKILL-LOADING candidate rather than from whichever
 * candidate was tried first, so a harness that was never going to run the task cannot supply
 * the sentence an operator acts on. With Skills switched off every candidate returns the same
 * "enable it" sentence and the distinction does not arise.
 */
function retroRunner(
  session: Session,
  requiredSkillIds: readonly string[],
  deps: RetroDeps,
  requiredAgent?: AgentType,
): { agent: AgentType } | { problem: string } {
  // No required skill means nothing to prove, and the session's own harness is the honest
  // default. Unreachable for the shipped action, which always requires one.
  if (requiredSkillIds.length === 0) return { agent: requiredAgent ?? session.agent };

  const loaders = skillLoadingAgents();
  const candidates = requiredAgent
    ? [requiredAgent]
    : HARNESS_CAPABILITIES[session.agent].skills
      ? [session.agent, ...loaders.filter((agent) => agent !== session.agent)]
      : loaders;
  if (candidates.length === 0) {
    return {
      problem: `No harness in this build loads Mission Control skills, so ${requiredSkillIds.join(" and ")} `
        + "skills have nowhere to run.",
    };
  }

  const resolve = deps.skillForAgent ?? skillInvocationForAgent;
  let problem: string | null = null;
  for (const agent of candidates) {
    let ready = true;
    for (const skillId of requiredSkillIds) {
      const resolved = resolve(agent, skillId);
      if (!resolved.ok) {
        problem ??= resolved.message;
        ready = false;
        break;
      }
    }
    if (ready) return { agent };
  }
  return { problem: problem ?? `The ${requiredSkillIds.join(" and ")} skills are unavailable.` };
}

/**
 * What a dispatched retro is told, written for an agent that was never in the session.
 *
 * Every fact it can act on is named - the session id it can still try to read a transcript
 * for, the branch and worktree the work happened on, the pull request it can read a diff from -
 * and the honest limit is named too. A fresh session reconstructing a retrospective from a
 * transcript it may not be able to open must say so in its proposals rather than inventing the
 * corrections it would have found.
 */
function retroTaskIntent(session: Session): string {
  const facts = [
    `Session: ${session.name} (${session.id})`,
    session.gitBranch ? `Branch: ${session.gitBranch}` : null,
    session.cwd ? `Worktree it ran in: ${session.cwd}` : null,
    session.prUrl ? `Pull request: ${session.prUrl}` : null,
  ].filter((line): line is string => line !== null);
  return [
    "Run a retrospective over a Mission Control session that can no longer be reached, and",
    `commit what it learned into this repository's ${MEMORY_DIR}.`,
    "",
    ...facts,
    "",
    "Invoke the retro skill and follow it: it owns the procedure, the cap of three proposed",
    "memories, the approval step, and the file layout. Nothing is written that the human has",
    "not approved.",
    "",
    "That session is gone, so its transcript may no longer be readable. Try it",
    `(GET /api/sessions/${session.id}/transcript on the local daemon), and when it is`,
    "unavailable work from what the branch and its pull request show instead: the commits, the",
    "review conversation, and the fixes that followed a finding. Say in each proposal which of",
    "those you actually had. Do not invent a correction you did not read.",
    "",
    "The memory commit is this task's entire deliverable, and it has no existing review to ride,",
    "so ship it the way this repository ships any other task.",
  ].join("\n");
}
