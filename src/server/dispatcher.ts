import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentType,
  PermissionMode,
  Session,
  Task,
  TaskRepoEntry,
  ThinkingLevel,
  WorktreeProvider,
} from "@shared/types.ts";
import {
  capabilitiesFor,
  skillCommand,
  supportsSdkSkillInvocation,
} from "@shared/harness-capabilities.ts";
import { pipelineRunKeyOf } from "@shared/pipeline.ts";
import { innermostTerminalResourceId } from "@shared/pane.ts";
import {
  dispatchHasNoProvisionedResources,
  taskKindAllowsBacklog,
} from "@shared/task.ts";
import { deriveTitle as deriveTaskTitle } from "@shared/title.ts";
import { WORKTREES_DIR, envVar } from "./config.ts";
import { resolveAgentBin } from "./harness/index.ts";
import { askChannelContribution, systemPromptAppendArgs } from "./ask-channel.ts";
import { withStandingInstructions } from "./instructions/compose.ts";
import { standingInstructionsForLaunch } from "./instructions/resolve.ts";
import type { StandingInstructionsDelivery } from "@shared/standing-instructions.ts";
import { injectPrompt } from "./actions.ts";
import { hooksFor } from "./harness/index.ts";
import {
  getHarnessesConfig,
  resolveDispatchEffort,
  resolveDispatchModel,
  resolveDispatchRuntime,
} from "./harnesses.ts";
import { harnessFor } from "./harness/index.ts";
import { newSdkSessionId, type SdkSupervisor } from "./sdk/supervisor.ts";
import { heldHomeNames, homeAlive, homeNameRules, killHome, launchHome } from "./terminal/home.ts";
import type { Registry } from "./registry.ts";
import { verifyHeadIs } from "./git/ensemble-snapshot.ts";
import { freshRemoteDefaultSha, originConfigured } from "./git/remote-default.ts";
import { FULL_SHA } from "./workflows/commit-id.ts";
import {
  kindMissionMcpRequirement,
  missionMcpDescriptor,
  missionMcpDescriptorForPipelineTask,
  newPipelineCallerCredential,
  verifyMissionMcpTools,
  type MissionMcpRequirement,
} from "./mission-mcp.ts";
import { isPlanTask } from "./plans/prompt.ts";
import { planSkillsForAgent } from "./plans/skills.ts";
import { withTaskKindContract } from "./task-contract.ts";
import { provisionScoutSubmissionCredential } from "./scouts/submission-auth.ts";
import {
  discardScoutPromptBoundary,
  freezeScoutPromptBoundary,
} from "./scouts/prompt-journal.ts";
import { withRepoMemoryPointer } from "./memory.ts";
import type { LaunchTurnMarker } from "./launch-presentation.ts";
import { hasBin, resolveBinPath, run, type RunResult } from "./util/exec.ts";
import { sleep } from "./util/timers.ts";
import { prepareCodexLaunch } from "./harness/codex/launch.ts";
import { preparePiLaunch } from "./harness/pi/launch.ts";
import { pipelineTaskLaunch } from "./pipelines/index.ts";
import {
  appendPipelineCommissionAttempt,
  bindPipelineCommissionAttempt,
  createPipelineCommission,
} from "./pipelines/commissions.ts";
import { PIPELINE_PROVIDERS } from "./pipelines/providers.ts";
import type { PipelineEngineerRunSnapshot } from "./pipelines/types.ts";
import { WorktreeManager } from "./worktrees/manager.ts";
import { LegacyTreehouseService } from "./worktrees/legacy-treehouse.ts";

/** How long to wait for the dispatched agent's pane to be discovered before failing. */
const READY_TIMEOUT_MS = Number(envVar("DISPATCH_READY_MS") ?? 30000);
/**
 * Fallback settle time for a live agent that cannot prove readiness. Reached when the
 * hook wait times out or this launch cannot report hooks; an observed exit fails instead.
 * This is a guess about boot time, which is exactly why it is no longer the primary path.
 */
const SETTLE_MS = Number(envVar("DISPATCH_SETTLE_MS") ?? 2000);
/**
 * How long to wait for the agent's first hook - the real "I can read input" signal.
 * Generous: overshooting costs a few seconds on an uninstrumented agent, undershooting
 * costs the whole prompt.
 */
const HOOK_READY_MS = Number(envVar("DISPATCH_HOOK_READY_MS") ?? 20000);
/** How long to wait for the injected prompt to show up as `working` before retrying it. */
const ACCEPT_MS = Number(envVar("DISPATCH_ACCEPT_MS") ?? 15000);

/**
 * What ONE launch may be asked for, beyond what the Task itself says.
 *
 * Deliberately ephemeral and server-only: nothing here is persisted on the Task, because
 * these are properties of a launch attempt rather than of the work. A caller that needs a
 * relaunch to make the same request holds that request in its own durable state and asks
 * again - which is exactly what a restart-safe orchestrator has to do anyway, and what a
 * nullable column on `tasks` would have quietly pretended was unnecessary.
 *
 * MECHANISM ONLY. `baseSha` says "start this worktree at exactly this commit"; it does not
 * say why, and the Dispatcher never learns why. `missionMcp` says which of our own MCP
 * tools the launched session has to be able to call, as capabilities rather than as flags -
 * which flags that costs is each harness's answer (`mission-mcp.ts`).
 */
export interface TaskDispatchOptions {
  /** A launch-time default model for an otherwise-unpinned backlog task. See `TaskManager.dispatch`. */
  defaultModel?: string | null;
  /** A full commit id in the task's `repoRoot` to provision the worktree at. */
  baseSha?: string;
  /** Mission MCP tools this launch requires. */
  missionMcp?: MissionMcpRequirement;
}

/**
 * The launch argv that starts a dispatched session already in its harness's autonomous
 * mode when "auto mode on dispatch" is on - `--permission-mode auto` for Claude - or no
 * args at all.
 *
 * Empty in three cases, each correct rather than a fallback: the setting is off; the
 * harness has no `onDispatch` mode to arm; or the harness has such a mode but no argv
 * renderer (`launchArgs: null`). Codex is the third case: the terminal path keeps its
 * posture in `prepareCodexLaunch`, while the embedded path receives the mode itself from
 * `dispatchPermissionMode` and applies it through app-server.
 *
 * This replaced the post-launch `setPermissionMode` walk on the dispatch path: the walk
 * read the mode off the pane footer, which a fresh session's folder-trust dialog hides,
 * so it silently left the session in its default mode. A flag needs no readable footer.
 */
export function dispatchPermissionMode(agent: AgentType): PermissionMode | null {
  if (!getHarnessesConfig().autoModeOnDispatch) return null;
  return harnessFor(agent).permissionModes?.onDispatch ?? null;
}

export function dispatchPermissionModeArgs(agent: AgentType): string[] {
  const mode = dispatchPermissionMode(agent);
  const spec = harnessFor(agent).permissionModes;
  // The extra `launchArgs` gate belongs to THIS renderer, not to the mode: a harness that
  // names an autonomous mode reachable only through its live TUI has a mode to arm and no
  // flag to arm it with, and the embedded runtime - which sets the mode through its own
  // control protocol rather than through argv - is not held back by that absence.
  if (!mode || !spec?.launchArgs) return [];
  return [...spec.launchArgs(mode)];
}

/**
 * Turns a task into a live agent: provision an isolated worktree, launch the agent through
 * its selected runtime, bind that exact live session, then deliver the task as turn one
 * through the harness's native launch or pane-input path.
 *
 * Every step patches the task through the registry so progress streams to the UI over SSE.
 * `dispatch` never throws. A resource-preflight or provisioning failure that leaves no
 * resources returns backlog-capable work with its reason; deterministic refusals and failures
 * after launch resources exist land in `failed` rather than crashing the daemon.
 */
export class Dispatcher {
  private readonly teardown: typeof teardownWorktree;
  private readonly worktrees: WorktreeManager;
  private readonly legacy: LegacyTreehouseService;

  constructor(
    private registry: Registry,
    teardown: typeof teardownWorktree | undefined = undefined,
    private deps: {
      inject?: typeof injectPrompt;
      sleep?: typeof sleep;
      /**
       * The owner of embedded sessions, when the daemon constructed one.
       *
       * Optional so the existing route-unit and dispatcher tests still build a Dispatcher
       * with a Registry and nothing else; a dispatch that RESOLVES to the SDK runtime with
       * no supervisor fails loudly rather than silently taking the terminal path, because
       * the operator asked for one thing and would have got another.
       */
      supervisor?: SdkSupervisor;
      /** How the launch reaches our own MCP server. Injected for the same reason. */
      missionMcpDescriptor?: typeof missionMcpDescriptor;
      /** Whether that server actually publishes the tools this launch declares. Injected so a test need not spawn one. */
      verifyMissionMcpTools?: typeof verifyMissionMcpTools;
      /** Publish the checkout-scoped scout bearer before its agent starts. */
      provisionScoutCredential?: typeof provisionScoutSubmissionCredential;
      /**
       * Which planning-skill invocations a plan task's contract may name.
       *
       * A seam only so a test can drive the refusal, and the launch-time resolver by
       * construction: this launch's conversation does not exist yet.
       */
      planSkills?: typeof planSkillsForAgent;
      /** Server-owned immutable graph check; kept injectable so this launch layer stays DB-free. */
      workflowEvidenceEnabled?: (task: Pick<Task, "kind" | "workflowId">) => boolean;
      /**
       * Fired once, when a task first acquires the session it will run on.
       *
       * The seam that lets a launch stop waiting for a model to name it. Dispatch reads
       * `task.title` to build the terminal home name, so naming used to gate the whole
       * launch behind the titling call - measured at 4.5-7.7s against the configured
       * provider, all of it in front of an agent that was otherwise ready to start. The
       * launch now takes the heuristic title and the LATE title renames the session
       * afterwards, which is the same operation `assign` already performs when it hands a
       * task to a running agent.
       *
       * It has to be a notification rather than a return value because the two facts
       * settle in either order: the model can answer before the session is discovered, or
       * long after it. Whoever finishes second does the rename; this is the half that
       * reports the session arriving.
       *
       * Deliberately fired from `patch`, which is the ONE place every runtime records its
       * session - the terminal path, the embedded path and the pipeline path all land
       * there. Hanging it off the three call sites instead would leave a runtime silently
       * un-renamed the day a fourth is added.
       */
      onSessionBound?: (taskId: string) => void;
      resolveRuntime?: typeof resolveDispatchRuntime;
      /**
       * What the operator's standing instructions resolve to for these checkouts.
       *
       * A seam only so a focused test can drive composition and delivery without seeding a
       * settings document and a repository per case. Production always takes
       * `standingInstructionsForLaunch`.
       */
      standingInstructions?: typeof standingInstructionsForLaunch;
      /**
       * Which commit each of the task's repositories is frozen at before provisioning.
       *
       * A seam only so a focused test can prove the ORDERING - that a base failure happens
       * in front of every lease and every spawn - without standing up a remote per case.
       * Production always takes `resolveTaskBases`.
       */
      resolveBases?: typeof resolveTaskBases;
      /** Provider-owned launch facts for a pipeline task. */
      pipelineLaunch?: typeof pipelineTaskLaunch;
      /**
       * Terminal-home launch seam, used by BOTH terminal arms - the ordinary agent launch
       * and the pipeline host.
       *
       * A focused test that needs to reach the delivery boundary has to stop short of the
       * real backend: `spawnUniquely` opens an actual tmux session on the machine running
       * the suite, which is a side effect a unit test has no business having and which
       * collides with itself on a second run. Left unset - which is every daemon - the real
       * launcher is used and nothing changes.
       */
      spawn?: typeof spawnUniquely;
      /** The daemon's singleton native allocator. Focused tests may inject an isolated one. */
      worktrees?: WorktreeManager;
      /** Release-only bridge for persisted historical Treehouse resources. */
      legacy?: LegacyTreehouseService;
    } = {},
  ) {
    this.worktrees = deps.worktrees ?? new WorktreeManager();
    this.legacy = deps.legacy ?? new LegacyTreehouseService();
    this.teardown = teardown ?? ((task, legacy, priority) =>
      teardownWorktree(task, legacy ?? this.legacy, priority, this.worktrees));
  }

  async dispatch(taskId: string, options: TaskDispatchOptions = {}): Promise<void> {
    const task = this.registry.getTask(taskId);
    if (!task) return;
    // Only failures in the resource preflight/provisioning phase are safe ordinary backlog
    // retries. Earlier refusals describe a task or launch configuration that must change,
    // while anything after this phase may have crossed into an agent runtime.
    let backlogRecoveryEligible = false;
    // Clear any stale error from a prior failed attempt so a retry starts honest.
    this.patch(taskId, {
      status: "dispatching",
      error: null,
      dispatchedAt: task.dispatchedAt ?? Date.now(),
      // A retry must prove its new provider run instead of inheriting the prior attempt's
      // slug and completing against a projection it did not launch.
      ...(task.kind === "pipeline"
        ? { pipelineRun: null, pipelineWorkspacePath: null }
        : {}),
    });

    try {
      if (task.kind === "pipeline") {
        await this.dispatchPipeline(taskId, task);
        return;
      }
      const configured = resolveAgentBin(task.agent);
      const agentBin = await resolveBinPath(configured);
      if (!agentBin) throw new Error(`agent binary "${configured}" not found on PATH`);

      // The branch and worktree take the git-safe slug; the terminal home (which is what
      // the card is named after) takes the human-readable label, so an untitled dispatch
      // reads like a heading instead of `add-a-dark-mode-toggle`.
      const slug = slugify(task.title);
      const label = sessionLabel(task.title);
      const shortId = taskId.slice(0, 6);

      // Resolved BEFORE anything is provisioned, so a caller that named a commit this
      // repository does not have costs nothing but an error - rather than a worktree, a
      // terminal home and an agent that has to be torn down again.
      const baseSha = options.baseSha ? await verifyPinnedBase(task.repoRoot, options.baseSha) : null;

      // Which runtime this launch takes, resolved ONCE and read twice: the guard below and
      // the fork further down. Resolved here rather than after provisioning so the guard can
      // refuse before any worktree exists - the same ordering, and the same reason, as the
      // pinned-base check above. Reading a toggle flipped mid-batch still reaches the next
      // session rather than the next restart, which is all the later position bought.
      const runtime = (this.deps.resolveRuntime ?? resolveDispatchRuntime)(task.agent);

      // A plan task's contract POINTS AT the two planning skills rather than restating them,
      // so their invocations have to be resolved before it can be composed - and a launch that
      // cannot resolve them cannot honour the contract at all. Resolved HERE, in front of the
      // worktree, for the same reason the pinned base above is: a refusal at this line costs
      // an error, and a refusal after provisioning costs a worktree, a terminal home and an
      // agent that has to be torn down again.
      //
      // Throwing is how this reports: `dispatch` never throws OUT, it lands the task in
      // `failed` with the reason on its card, which is the honest place for a refusal that
      // reached the launch. The doors an operator dispatches through refuse earlier and
      // synchronously (`planDispatchBlock`), so this is the backstop for a schedule, a task
      // source, and the window in which a toggle is flipped while a title is being derived.
      //
      // `skillInvocationForAgent`, never the watermark-aware resolver: the conversation this
      // is resolving for does not exist yet and will start after the current skill generation
      // by construction. See `skills/invoke.ts`.
      const planSkills = isPlanTask(task)
        ? (this.deps.planSkills ?? planSkillsForAgent)(task.agent)
        : null;
      if (planSkills && !planSkills.ok) throw new Error(planSkills.message);
      // `multiRepoDispatch`, enforced ONCE here for BOTH runtimes rather than per launch
      // path. A task that attaches repositories and cannot be given write access to them
      // must not start at all: the worktrees would be provisioned and the intent manifest
      // would tell the agent "You have write access to all of them", which would be false.
      //
      // Runtime-agnostic on purpose. The routes and `TaskManager.update` check the
      // capability before a multi-repo task can be stored, but `TaskManager.create` does not
      // - its contract is that the CALLER validated - so any future producer of one (an MCP
      // `create_task`, a schedule, an ensemble) would otherwise reach a launch that silently
      // rendered no flags. Enforced at the one place every dispatch passes through, the
      // invariant cannot be reintroduced by adding a door.
      //
      // Refused, never quietly downgraded to the other runtime: the operator chose it, and a
      // session that took the other one is not what they asked for (`dispatchEmbedded`
      // refuses a missing supervisor on the same grounds).
      const multiRepo =
        task.extraRepos.length > 0 ? capabilitiesFor(task.agent).multiRepoDispatch : null;
      if (task.extraRepos.length > 0) {
        const others = `${task.extraRepos.length === 1 ? "repo" : "repos"}`;
        if (!multiRepo) {
          throw new Error(
            `${task.agent} cannot be given write access to this task's other ${others} - ` +
              `dispatch it on a harness that can, or detach them`,
          );
        }
        if (runtime === "sdk" && !multiRepo.sdk) {
          throw new Error(
            `${task.agent}'s embedded driver cannot be given write access to this task's ` +
              `other ${others} - dispatch it on the terminal runtime, or detach them`,
          );
        }
      }

      // One worktree per attached repo, primary first. `provisionAll` is all-or-nothing:
      // a failure part-way through returns every tree it had already taken, provider-aware,
      // and rethrows - so a partial dispatch never leaves leased trees nothing will ever
      // tear down. On a single-repo task this is exactly one call with slot 0.
      //
      // Every repository's base is frozen HERE, in front of the loop, rather than inside
      // it: an unpinned task takes a freshly fetched remote-default commit instead of
      // whatever the main checkout's local HEAD happens to be, and a fetch that fails in
      // the third repository must not leave the first two leased. Placed after the cheap
      // refusals above so a dispatch that was going to be turned away for its runtime or
      // its harness capability does not pay for a network round trip first.
      backlogRecoveryEligible = true;
      const bases = await (this.deps.resolveBases ?? resolveTaskBases)(
        { primary: task.repoRoot, extras: task.extraRepos.map((entry) => entry.repoRoot) },
        baseSha,
      );
      const { primary: wt, extras } = await this.provisionAll(task, taskId, slug, shortId, bases);
      backlogRecoveryEligible = false;
      // Record every worktree BEFORE spawning, so a spawn failure can still tear them down.
      // The collection lands in the SAME patch so every durable native owner becomes visible
      // atomically before provisional allocator state settles.
      try {
        this.patch(taskId, {
          worktreePath: wt.path,
          branch: wt.branch,
          provider: wt.provider,
          worktreeLeaseId: wt.leaseId,
          baseSha: wt.baseSha,
          extraRepos: extras,
        });
      } catch (recordError) {
        const paths = [wt.path, ...extras.flatMap((entry) => entry.worktreePath ?? [])];
        let reclaimed: readonly string[] = [];
        try {
          await this.teardown({
            taskId,
            repoRoot: task.repoRoot,
            worktreePath: wt.path,
            branch: wt.branch,
            provider: wt.provider,
            worktreeLeaseId: wt.leaseId,
            homeName: null,
            extraRepos: extras,
          });
          reclaimed = paths;
        } catch (cleanupError) {
          reclaimed = reclaimedFrom(cleanupError);
          console.error(
            `[mission-control] could not fully unwind task ${taskId} after its lease record failed: ` +
              (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
          );
        }
        if (reclaimed.includes(wt.path) && wt.leaseId) {
          this.worktrees.settleDomainLease(wt.leaseId);
        }
        for (const entry of extras) {
          if (
            entry.worktreePath &&
            reclaimed.includes(entry.worktreePath) &&
            entry.worktreeLeaseId
          ) {
            this.worktrees.settleDomainLease(entry.worktreeLeaseId);
          }
        }
        throw recordError;
      }
      if (wt.leaseId) this.worktrees.settleDomainLease(wt.leaseId);
      for (const entry of extras) {
        if (entry.worktreeLeaseId) this.worktrees.settleDomainLease(entry.worktreeLeaseId);
      }
      if (await this.abortIfSettled(taskId)) return;

      // The task as it now stands, since `task` is the snapshot taken before any of this
      // was provisioned. Both the manifest and the write-access grant describe worktrees,
      // so both have to read the provisioned shape rather than the backlog row.
      const provisioned: Task = {
        ...task,
        worktreePath: wt.path,
        branch: wt.branch,
        provider: wt.provider,
        worktreeLeaseId: wt.leaseId,
        baseSha: wt.baseSha,
        extraRepos: extras,
      };
      // The repo manifest is a PREFIX (context the agent needs before the request) and the
      // kind's contract is a SUFFIX (what "delivered" means once it has read it), so the
      // operator's own words are never buried and the ordering is the same on both delivery
      // seams. The operator's intent remains the exact prefix; server-owned authorization
      // and the narrower kind contract follow it in one deterministic order.
      const workflowEvidence = this.deps.workflowEvidenceEnabled?.(task) ?? false;
      // The operator's own standing instructions for these checkouts, resolved ONCE, here.
      //
      // A LAUNCH is the only occasion that resolves them: an assignment into a live session
      // replays this session's snapshot instead (see `tasks.ts`), because a running
      // process's system prompt cannot be rewritten and re-resolving would give
      // `claude · terminal` one mid-session semantic and `pi · terminal` another for the
      // same feature. A session keeps the standing instructions it launched with.
      //
      // Every attached repository contributes, in the manifest's order, because this
      // dispatch hands the agent write access to all of them - sending only the primary's
      // rules would be the same laundering `taskReposAllowlisted` refuses for consent.
      const standing = await (this.deps.standingInstructions ?? standingInstructionsForLaunch)(
        [wt.path, ...extras.map((entry) => entry.worktreePath).filter((p): p is string => !!p)],
        task.agent,
        runtime,
      );
      // EXACTLY ONE delivery. A pair with an out-of-band channel carries the block there and
      // is NOT also prefixed; a pair without one is prefixed and sends nothing out of band.
      // Both would have the agent read the same rule twice in its first turn, which for a
      // rule phrased as a prohibition invites reading the repetition as emphasis about
      // something the operator only said once. `standingInstructionsChannel` is the single
      // reading of which case this is, via the mechanism the composer already recorded.
      const standingPrefix = standing.mechanism === "prompt-prefix" ? standing.text : "";
      const composeTurnOne = (standingBlock: string) =>
        withTaskKindContract(provisioned, intentWithRepoManifest(provisioned, standingBlock), {
          planSkills: planSkills?.ok ? planSkills.commands : null,
          workflowEvidence,
        });
      const intent = composeTurnOne(standingPrefix);
      // The SAME turn one with the block in the SAME slot, for an out-of-band pair whose
      // channel turns out to be unusable once the driver is already talking to its subprocess.
      //
      // Composed here rather than by the supervisor or the adapter because this is the only
      // place that can: the ordering the operator's text belongs to - manifest, then rules,
      // then request - is produced BY `intentWithRepoManifest`, not by wrapping a finished
      // prompt, and wrapping one would put the rules above the manifest that names the
      // checkouts they are about. Empty unless there is an out-of-band delivery to fall back
      // FROM: `standingPrefix` is non-empty exactly when the block is already inside `intent`.
      const standingFallbackTurnOne =
        !standingPrefix && standing.text ? composeTurnOne(standing.text) : "";
      // Which of OUR tools this launch has to be able to call. A scout ALWAYS has to be able
      // to submit its report and a plan ALWAYS has to be able to ask its human and file the
      // phases it schedules, so the requirement is unioned in here rather than left to
      // whichever caller happened to dispatch it. A ship task is unaffected:
      // `kindMissionMcpRequirement` returns the caller's requirement untouched, `null`
      // included.
      const missionMcp = kindMissionMcpRequirement(
        task,
        options.missionMcp ?? null,
        workflowEvidence,
      );
      if (task.kind === "scout") {
        (this.deps.provisionScoutCredential ?? provisionScoutSubmissionCredential)(taskId, wt.path);
      }
      // The directories this session needs write access to beyond its cwd, and the argv
      // that grants them. Empty on every single-repo dispatch, which renders no flags at
      // all - so those command lines stay byte-identical.
      const extraDirs = extras
        .map((entry) => entry.worktreePath)
        .filter((p): p is string => p !== null);

      // Resolved here, not at task creation: a backlogged task launches on the defaults
      // in force NOW. Both CLIs spell the model flag `--model <id>`; effort syntax comes
      // from the harness registry. Null means let the harness's own configuration decide.
      //
      // `options.defaultModel` is Foreman's per-harness backlog model, ranked between the
      // task's own pin and the panel default - see `resolveDispatchModel` for the tiers and
      // for why it is passed here rather than written onto the task row.
      //
      // The kind tier sits below Foreman's launch-only model and above the per-harness
      // default in both resolvers, and the two calls are now ORDERED rather than merely
      // adjacent: a kind's effort is checked against the model THIS launch resolved, because
      // `levelsFor` narrows per model. Passing `task.model` here instead would ask the
      // question about a pin the task may not even carry.
      const model = resolveDispatchModel(
        task.agent,
        task.model,
        options.defaultModel ?? null,
        task.kind,
      );
      const effort = resolveDispatchEffort(task.agent, task.effort, task.kind, model);
      // The fork. `runtime` was resolved before provisioning (see the multi-repo guard up
      // there) but nothing between here and there depends on it: provisioning a worktree is
      // not a runtime question, and everything above this line is identical on both paths.
      // After the SDK return, EVERYTHING below is terminal-branch-only: the argv and
      // ask-channel redirect, terminal home, `waitForSessionAtCwd`, `awaitReady`, and
      // `deliverIntent` exist because pane launch and delivery cannot be acknowledged.
      if (runtime === "sdk") {
        await this.dispatchEmbedded(
          taskId,
          task,
          wt,
          model,
          effort,
          missionMcp,
          intent,
          extraDirs,
          standing,
          standingFallbackTurnOne,
        );
        return;
      }
      const effortArgs = effort ? (harnessFor(task.agent).effort?.launchArgs(effort) ?? []) : [];
      // "Auto mode on dispatch" as a LAUNCH FLAG (`--permission-mode auto` for Claude),
      // not a post-launch Shift+Tab walk. The walk read the mode off the pane's footer,
      // which a fresh session's folder-trust dialog hides, so it gave up and the session
      // ran in its default mode. The flag sets the mode whether or not the footer is
      // readable, and is scoped to sessions WE launch by construction. Codex is reached by
      // its own launch builder below (widened sandbox), so this is empty for it; live TUI
      // control stays only for a human swapping an existing session's mode from the card.
      const modeArgs = dispatchPermissionModeArgs(task.agent);
      // The ask channel rides along on every dispatch: it takes Claude's built-in
      // `AskUserQuestion` away and hands the agent our blocking `request_input` instead, so
      // a clarifying question arrives as structured arguments in the dashboard rather than
      // as a menu we read off the child's screen. Scoped to dispatch for the same reason
      // `modeArgs` is - we only reconfigure agents WE launched, never one the operator
      // started and we merely discovered. It returns nothing rather than half its flags on
      // ANY failure - a missing bundle, an unwritable state dir - and never throws, so it
      // cannot sink a dispatch that is otherwise fine; see `askChannelArgs`.
      const codexLaunch = task.agent === "codex"
        ? await prepareCodexLaunch(getHarnessesConfig().autoModeOnDispatch, missionMcp)
        : { args: [] as string[], instrumented: true, missionMcp: false };
      // Pi is the one harness with no file channel: Claude and Codex load the worktree's
      // root doc themselves, and the committed `.agents/memory` reference line rides in
      // on it, but Pi's only channel is turn one. So the pointer is composed INTO the
      // intent here, at the call site, rather than in `preparePiLaunch` - that function
      // is pure argv construction and turn one is not always a dispatch. The pointer is
      // added only when the worktree actually carries an index, and it lands in front of
      // the task, which also means `preparePiLaunch`'s leading `-`/`@` guard sees the
      // pointer's first character; an intent that opens with either one is then
      // unambiguously positional anyway, mid-string.
      //
      // Pi is terminal-only today (`HARNESS_CAPABILITIES.pi.runtimes`), so this is its one
      // launch seam. Whoever gives it an SDK runtime composes the same pointer into turn
      // one on the embedded path, which returns above this line.
      // Held in its own binding because two different things need it: `preparePiLaunch`
      // needs it to build the argv, and the launch marker needs to fingerprint the exact
      // text that argv carries. Recomposing it at the second site is how the two answers
      // drift apart.
      const piText = task.agent === "pi" ? withRepoMemoryPointer(wt.path, intent) : null;
      const piLaunch = piText !== null
        ? preparePiLaunch(piText)
        : { args: [] as string[], sessionId: null };
      const askChannel = await askChannelContribution(task.agent, missionMcp);
      // ONE `--append-system-prompt`, carrying every contributor to it. The flag is
      // single-valued and repeating it is last-wins with no warning, so a second flag beside
      // this one would silently discard whichever came first - see `systemPromptAppendArgs`.
      //
      // The ask channel's redirect keeps its all-or-nothing tie to the MCP flags: an agent
      // with `AskUserQuestion` removed and no replacement is worse than one with the
      // built-in intact. The standing instruction does NOT acquire that tie - a missing MCP
      // bundle has nothing to do with the operator's own words - so it still ships when
      // `askChannelContribution` returns nothing at all.
      const askArgs = [
        ...askChannel.args,
        ...systemPromptAppendArgs([
          askChannel.redirect,
          standing.mechanism === "claude-append-system-prompt" ? standing.text : null,
        ]),
      ];
      // Rendered by the harness that has to honour it, from a capability measured against a
      // real installation - Claude's `--add-dir`, Codex's writable-roots override. Read off
      // the spec the guard above already resolved rather than re-asking with a `?.` that
      // would render NO flags for a harness without one: that is precisely the silent drop
      // the guard exists to turn into a refusal, and asking twice is how the two answers
      // drift apart.
      const extraDirArgs =
        extraDirs.length > 0 && multiRepo ? multiRepo.launchArgs(extraDirs) : [];
      const agentArgs = [
        ...(model ? ["--model", model] : []),
        ...effortArgs,
        ...modeArgs,
        ...askArgs,
        ...extraDirArgs,
        ...codexLaunch.args,
        ...piLaunch.args,
      ];
      // Claude's registration rides on the ask channel and Codex's is its own override
      // block, so "did this launch get our MCP server" has two sources - but the question is
      // asked of the ARGV that actually reaches the child rather than of the agent id,
      // because that is the only reading a builder which failed halfway cannot contradict.
      // Passing `missionMcp` IS the caller declaring those tools REQUIRED, so a launch that could
      // not carry them is a failure of that launch, not a session worth starting crippled: an
      // ensemble member that cannot reach `submit_ensemble_result` would run to completion and then
      // be unable to signal it is ready. Fail here, before the agent spawns, so the worktree is torn
      // down for a clean retry rather than left holding an agent that can never submit. A dispatch
      // that passes no `missionMcp` is unaffected - this is effectively ensemble-scoped.
      const missionMcpRegistered =
        codexLaunch.missionMcp || askChannel.args.includes("--mcp-config");
      if (missionMcp && !missionMcpRegistered) {
        throw new Error(
          `the launch could not carry the required Mission MCP tools ` +
            `${missionMcp.tools.join(", ")} (is the MCP bundle built?), so this ${task.agent} ` +
            `session could not submit its result`,
        );
      }
      // …and that the registration points at a server which actually PUBLISHES them.
      //
      // The check above proves the argv carries a registration; it cannot prove what is inside
      // the file that registration names, and those are different questions with the same
      // silent failure. The daemon runs from source under `tsx watch` while handing the agent
      // a build artifact that only `npm run build` refreshes, so the bundle drifts behind
      // source by design - observed live, with `submit_scout_artifacts` missing from a bundle
      // six days older than the source that introduced it. The scout that lands on it is told
      // to call a tool it has not been given, and its task can never reach `done`.
      //
      // One real `initialize` + `tools/list` against that exact bundle, cached per build, so
      // the cost is one handshake per daemon rather than one per dispatch. Refusing here is
      // the same trade the guard above already makes and for the same reason: a loud failure
      // with the worktree torn down for a clean retry beats an agent that works to completion
      // and then discovers it has nowhere to put the result.
      if (missionMcp) {
        const published = await (this.deps.verifyMissionMcpTools ?? verifyMissionMcpTools)(
          missionMcp.tools,
        );
        if (!published.ok) {
          throw new Error(
            `this ${task.agent} session requires the Mission MCP tools ` +
              `${missionMcp.tools.join(", ")}, but ${published.reason}`,
          );
        }
      }

      // Pi's launch marker goes down BEFORE the process starts, and under the FINAL key.
      //
      // Pi is the one harness whose turn one travels in the argv, so by the time anything can
      // observe the conversation the prompt has already been written - there is no delivery
      // seam later to record against. Recording after discovery instead would leave the
      // ordering resting on two unstated accidents: that `locatePiTranscript` refuses a
      // session with no `agentSessionId`, and that the bind and the write sit in one
      // synchronous block. Either could be undone by an unrelated change - discovery learning
      // to read `--session-id` off the argv is the obvious one, since the id is right there -
      // and the symptom would be a first frame carrying the whole launch contract, which SSE
      // never re-decorates afterwards.
      //
      // `preparePiLaunch` has already minted the native conversation id, so this needs no
      // provisional key and no later move: it is written under the key the session will hold
      // once `bindLaunchedAgentSession` runs.
      const piMarker = piLaunch.sessionId && piText !== null
        ? this.recordLaunchPresentationForKey(piLaunch.sessionId, piText, task.intent)
        : null;
      let homeName: string;
      try {
        homeName = await (this.deps.spawn ?? spawnUniquely)(
          label,
          shortId,
          wt.path,
          agentBin,
          agentArgs,
        );
      } catch (err) {
        // Nothing was launched, so the marker describes a turn that will never be written.
        this.registry.discardLaunchTurn(piMarker);
        throw err;
      }
      this.patch(taskId, { homeName });
      if (await this.abortIfSettled(taskId)) return;

      const discovered = await this.registry.waitForSessionAtCwd(wt.path, READY_TIMEOUT_MS);
      if (!discovered) {
        throw new Error("agent session never appeared (the launch may have exited immediately)");
      }
      this.patch(taskId, { terminalResourceId: innermostTerminalResourceId(discovered) });
      // Mission Control launched this session, so Foreman is invited by construction -
      // recorded the moment discovery confirms the spawn, through the registry (the
      // dispatcher deliberately has no db access). The row lands under whatever key the
      // session holds right now (almost always the synthetic id - hooks have not fired
      // yet) and the registry's rotation move carries it to the agent-session key when
      // the binding arrives. The embedded branch above needs no row: an SDK session is
      // invited by its runtime.
      this.registry.setForemanInvite(discovered.id, "dispatch");
      if (await this.abortIfSettled(taskId)) return;

      // Discovery only proves the process exists. Hooked agents prove they can READ before
      // we type; launch-prompt agents such as Pi only need to survive the settle window.
      const ready = await this.awaitReady(
        wt.path,
        discovered,
        codexLaunch.instrumented,
      );
      const session = piLaunch.sessionId
        ? this.registry.bindLaunchedAgentSession(ready.session.id, task.agent, piLaunch.sessionId)
        : ready.session;
      if (!session) throw new Error("agent session changed before its launch identity was recorded");
      // Pi's launch marker was recorded before the spawn, under this exact key. Nothing to do
      // here - see the note at that call site for why the ordering is not deferred to now.

      // The standing-instruction record on the terminal arm, under the key the session holds now. For
      // Claude that is usually still the synthetic id - the hooks bind moments later - and
      // the registry's rotation move carries the row to the native key, and to every key a
      // later `/clear` rotates to. Pi has already bound its pre-minted conversation id
      // above, so it records under that.
      this.registry.recordStandingInstructions(session.id, standing);
      const { instrumented } = ready;
      const readyResourceId = innermostTerminalResourceId(session);
      if (readyResourceId) this.patch(taskId, { terminalResourceId: readyResourceId });
      if (await this.abortIfSettled(taskId)) return;

      // The permission mode is already set: it rode in on the launch argv (`modeArgs`),
      // so the task runs in it from the first prompt with no post-launch keystrokes to
      // race the process exiting or a launch-time dialog to read it off. Re-read the
      // session at the send boundary so a lingered exited snapshot cannot lend its pane.
      const deliverySession = this.requireLiveSession(session.id);
      // Freeze the scout's title and transcript boundary here, after every preflight has
      // passed and before the prompt crosses into the runtime - the last instant at which
      // "what the agent had already been told" is still measurable. Pi anchors at `launch`
      // because its turn one travelled in the argv below, so the whole file is this
      // episode's; everything else anchors at the transcript's current size.
      const boundary = freezeScoutPromptBoundary(
        this.registry,
        provisioned,
        deliverySession.id,
        piLaunch.sessionId ? "launch" : "current",
      );
      // Pi received turn one through its positional launch message. That native path calls
      // `session.prompt()` only after the TUI is initialized, so injecting it here would run
      // the task twice. Other terminal harnesses still need the pane delivery below.
      if (!piLaunch.sessionId) {
        // Recorded BEFORE the paste, for the same reason the scout boundary above is: this
        // is the last instant at which "what the agent is about to be told" is still a fact
        // rather than a guess, and a marker written after an acknowledged delivery would
        // race the transcript poller that has already read the turn.
        const launchMarker = this.recordLaunchPresentation(
          deliverySession.id,
          intent,
          task.intent,
        );
        try {
          await this.deliverIntent(deliverySession.id, intent, wt.path, instrumented);
        } catch (err) {
          // A boundary with no delivery behind it claims the agent saw a task it never
          // received, and a later capture would anchor into a conversation that never
          // started. Discard it before the failure propagates. The launch marker is
          // discarded on the same terms and for the same reason: it would tell the dashboard
          // to project a turn nothing ever wrote, and the next real human message under that
          // key is what it would be compared against.
          discardScoutPromptBoundary(boundary);
          this.registry.discardLaunchTurn(launchMarker);
          throw err;
        }
      }

      if (await this.abortIfSettled(taskId)) return;
      // First set for a dispatched task: `Task.sessionId` means "currently executing on"
      // and nothing more. Provenance lives in the work-episode bindings used by
      // `bindTaskToWorkEpisode` and `mergedPrFor`.
      this.patch(taskId, { status: "running", sessionId: deliverySession.id });
      this.registry.bindTaskToWorkEpisode(taskId, deliverySession.id);
    } catch (err) {
      const cur = this.registry.getTask(taskId);
      if (!cur) return;
      // A cancel/complete that settled the task in flight owns its terminal state
      // (and outcome) - don't overwrite it to `failed`. Only a cancel tears down;
      // a mid-flight complete keeps its worktree (Mark done must not discard work),
      // leaving it as a reclaimable done-with-worktree task.
      if (cur.status !== "dispatching") {
        if (cur.status === "cancelled") {
          await this.teardownTaskResources(taskId, cur, cur.error);
        }
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // The same resource proof startup reconciliation uses, restricted to the base-freeze
      // and all-or-nothing worktree phase. A fetch or provisioning failure can leave no
      // hidden agent or checkout, so put backlog-capable work back where the operator is
      // already watching and carry the exact failure reason onto its card. Deterministic
      // launch refusals before this phase remain failed so an unchanged retry is not
      // presented as ordinary work; failures after it retain the conservative cleanup path.
      if (backlogRecoveryEligible && dispatchHasNoProvisionedResources(cur)) {
        const returnsToBacklog = taskKindAllowsBacklog(cur.kind);
        this.patch(taskId, {
          status: returnsToBacklog ? "backlog" : "failed",
          error: message,
          sessionId: null,
          ...(returnsToBacklog ? { dispatchedAt: null } : {}),
        });
        return;
      }
      // If the terminal home still exists (e.g. discovery was merely slow, or only
      // the prompt send failed), do NOT destroy its work: keep the home + worktree
      // and fail the task with guidance. Only when no home remains do we tear the
      // (empty) tree down for a clean retry. A retained home does not prove that the
      // agent process itself survived.
      //
      // Three answers, not two. `null` is "no installed backend could tell us", and it must
      // land on the KEEP side with the `true` case rather than on the reclaim side with
      // `false`: erring towards keeping costs one Reclaim click, erring the other way runs
      // `git worktree remove --force` over a checkout an agent is working in.
      // An embedded session has no home to ask after, and the supervisor always knows: it
      // either holds the handle or has a row saying what became of it. Asked FIRST because
      // a `homeName`-less task would otherwise read as "no home was ever spawned" - true,
      // and the wrong reason - and reclaim a worktree an embedded agent is working in.
      const embedded = this.deps.supervisor?.taskLiveness(taskId) ?? null;
      const alive = embedded ?? (cur.homeName ? await homeAlive(cur.homeName) : false);
      if (alive !== false) {
        this.patch(taskId, {
          status: "failed",
          error:
            alive === true
              ? embedded === true
                ? task.kind === "pipeline"
                  ? `${message} - its managed session was kept; Focus or Cancel it`
                  : `${message} - its session and worktree were kept; open or Cancel it`
                : `${message} - its terminal home and worktree were kept; Focus or Cancel it`
              : `${message} - and no terminal backend could say whether the agent survived, so its worktree was kept; Focus or Cancel it`,
        });
      } else {
        this.patch(taskId, {
          status: "failed",
          error: message,
          sessionId: null,
        });
        await this.teardownTaskResources(taskId, cur, message);
      }
    }
  }

  /** Launch Conductor's Engineer host, leaving provider worktree creation to the engine. */
  private async dispatchPipeline(taskId: string, task: Task): Promise<void> {
    if (task.extraRepos.length > 0) {
      throw new Error("a pipeline task owns one enabled conductor repository; detach the other repos");
    }
    if (task.workflowId !== null) {
      throw new Error("a pipeline task cannot hand off to an after-work Workflow");
    }
    const launch = await (this.deps.pipelineLaunch ?? pipelineTaskLaunch)(
      task.repoRoot,
      task.intent,
    );
    if (!launch.ok) throw new Error(launch.error);
    let engineerRunId: string | null = null;

    if ("provider" in launch) {
      const lifecycle = PIPELINE_PROVIDERS[launch.provider].engineerLifecycle;
      if (!lifecycle) {
        throw new Error("the pipeline provider lost Engineer lifecycle support before launch");
      }
      let commission = task.pipelineCommissionId
        ? this.registry.pipelineCommission(task.pipelineCommissionId)
        : null;
      if (task.pipelineCommissionId && !commission) {
        throw new Error("the task names a Pipeline commission that could not be restored");
      }
      if (!commission) {
        commission = createPipelineCommission({
          taskId,
          provider: launch.provider,
          repoRoot: task.repoRoot,
        });
        this.patch(taskId, { pipelineCommissionId: commission.id, pipelineRun: null });
        this.registry.upsertPipelineCommission(commission);
      } else {
        const active = commission.attempts.find(
          (attempt) => attempt.attempt === commission!.activeAttempt,
        );
        if (active && ["failed", "cancelled"].includes(active.state)) {
          commission = appendPipelineCommissionAttempt({ commissionId: commission.id });
          this.registry.upsertPipelineCommission(commission);
        } else if (active?.state === "settled" || commission.lifecycle === "awaiting_spec_merge") {
          throw new Error("the Pipeline specification is already awaiting merge and cannot restart Engineer");
        }
      }

      const attempt = commission.attempts.find(
        (candidate) => candidate.attempt === commission!.activeAttempt,
      );
      if (!attempt) throw new Error("the Pipeline commission has no active Engineer attempt");
      let reserved: PipelineEngineerRunSnapshot | null = null;
      const created = await lifecycle.create({
        repoRoot: task.repoRoot,
        idea: task.intent,
        correlationId: commission.correlationId,
        attemptKey: attempt.launchKey,
      });
      if (created.ok) {
        reserved = created.value;
      } else {
        // Creation is idempotent. Inspecting the exact correlation closes the response-lost
        // case without minting another run or another launch key.
        const inspected = await lifecycle.inspectCorrelation({
          repoRoot: task.repoRoot,
          correlationId: commission.correlationId,
        });
        reserved = inspected.ok
          ? (inspected.value.find((candidate) => candidate.attemptKey === attempt.launchKey) ?? null)
          : null;
        if (!reserved) {
          throw new Error(`could not reserve the provider Engineer run: ${created.error}`);
        }
      }
      const reservedRun = reserved;
      if (!reservedRun) throw new Error("the provider did not return an Engineer run");
      commission = bindPipelineCommissionAttempt({
        commissionId: commission.id,
        attempt: attempt.attempt,
        engineerRunId: reservedRun.engineerRunId,
        providerAttempt: reservedRun.attempt,
        attemptKey: reservedRun.attemptKey,
        previousEngineerRunId: reservedRun.previousEngineerRunId,
      });
      engineerRunId = reservedRun.engineerRunId;
      this.registry.upsertPipelineCommission(commission);
    } else {
      const runKey = pipelineRunKeyOf(launch.pipelineRun);
      const owner = this.registry.listTasks().find(
        (candidate) =>
          candidate.id !== taskId &&
          candidate.kind === "pipeline" &&
          (candidate.status === "running" || candidate.status === "dispatching") &&
          candidate.pipelineRun !== null &&
          pipelineRunKeyOf(candidate.pipelineRun) === runKey,
      );
      if (owner) {
        throw new Error(
          `pipeline run "${launch.pipelineRun.slug}" is already owned by active task ${owner.id}`,
        );
      }
      this.patch(taskId, { pipelineRun: launch.pipelineRun });
    }

    if (launch.launchRuntime === "agent-sdk") {
      if (!supportsSdkSkillInvocation(task.agent, "engineer")) {
        throw new Error(
          `agent "${task.agent}" cannot host this managed Pipeline; choose an agent with Agent SDK support and a typed engineer skill invocation`,
        );
      }
      const engineerCommand = skillCommand(task.agent, "engineer");
      if (engineerCommand === null) {
        throw new Error(
          `agent "${task.agent}" has no typed engineer skill invocation; choose a supported Pipeline agent`,
        );
      }
      const supervisor = this.deps.supervisor;
      if (!supervisor) {
        throw new Error("this build has no session supervisor, so it cannot launch Conductor through Agent SDK");
      }
      const sessionId = newSdkSessionId();
      const callerCredential = newPipelineCallerCredential();
      const mcp = missionMcpDescriptorForPipelineTask(
        await (this.deps.missionMcpDescriptor ?? missionMcpDescriptor)(),
        callerCredential,
      );
      if (!mcp) {
        throw new Error(
          "managed Pipeline dispatch requires Mission Control's MCP server - rebuild with: npm run build",
        );
      }
      const published = await (this.deps.verifyMissionMcpTools ?? verifyMissionMcpTools)(
        "provider" in launch
          ? ["report_pipeline_workspace"]
          : ["adopt_pipeline_run", "report_pipeline_workspace"],
        mcp,
      );
      if (!published.ok) {
        throw new Error(
          `managed Pipeline dispatch requires its Pipeline reporting tools, but ${published.reason}`,
        );
      }
      // Held in its own binding for the same reason `piText` is: turn one now has a second
      // reader, and the launch marker has to fingerprint the exact string the driver was
      // given. Recomposing it at the second site is how the two answers drift apart.
      const engineerPrompt = "provider" in launch
        ? `${engineerCommand} ${task.intent}\n\n` +
          `[Pipeline Engineer lifecycle context: the provider reserved Engineer run ${engineerRunId}. ` +
          `Pass that exact id as --engineer-run-id when creating the authoring worktree. ` +
          `After Engineer creates or enters that worktree, call report_pipeline_workspace with ` +
          `its absolute path before editing files there.]`
        : `${engineerCommand} ${task.intent}\n\n` +
          `[Mission Control launch context: the reserved Pipeline run is ${launch.pipelineRun.slug}. ` +
          `If Engineer resumes a different existing run, call adopt_pipeline_run with that run's ` +
          `slug before continuing. No call is needed when Engineer creates the reserved run. ` +
          `After Engineer creates or enters its authoring worktree, call report_pipeline_workspace ` +
          `with that absolute path before editing files there.]`;
      // Persist the exact host identity before launch. The driver can invoke MCP before
      // `start` returns, so assigning it afterward would create a valid-tool race window.
      this.patch(taskId, { sessionId });
      this.registry.registerManagedPipelineCaller(
        taskId,
        sessionId,
        launch.cwd,
        callerCredential,
      );
      let session: Session;
      try {
        this.registry.beginManagedPipelineLaunch(taskId, sessionId, launch.cwd);
        session = await supervisor.start({
          sessionId,
          agent: task.agent,
          name: task.title.trim() || launch.cwd,
          cwd: launch.cwd,
          prompt: engineerPrompt,
          acceptedGoalPrompt: task.intent,
          // A pipeline task on this arm launches a directly streamable agent conversation, so
          // it has the same launch turn to present as an ordinary embedded dispatch. The
          // terminal arm below launches the Conductor host instead - not an agent conversation,
          // no transcript turn, nothing to classify.
          launchPresentation: { prompt: engineerPrompt, displayText: task.intent },
          model: null,
          effort: null,
          permissionMode: dispatchPermissionMode(task.agent),
          mcp,
          extraDirs: [],
          taskId,
          gitBranch: null,
          gitRoot: launch.cwd,
          repoRoot: launch.cwd,
        });
      } catch (error) {
        this.registry.endManagedPipelineCaller(taskId, sessionId, callerCredential);
        const current = this.registry.getTask(taskId);
        // This preallocated ID never became a registered session. A concurrent
        // completion owns every settlement field, but not this failed launch's
        // phantom host attribution. Restore the prior owner only while the task
        // still names the ID allocated by this attempt.
        if (current?.sessionId === sessionId) {
          this.patch(taskId, { sessionId: task.sessionId });
        }
        throw error;
      } finally {
        this.registry.endManagedPipelineLaunch(taskId, sessionId);
      }
      if (await this.abortIfSettled(taskId)) {
        // Cancel can land while the SDK driver is starting, before the managed host is
        // registered or `start` returns. The returned session is still this launch's
        // responsibility and must not leak.
        await supervisor.stop(session.id).catch(() => {});
        const settled = this.registry.getTask(taskId);
        if (settled?.sessionId === session.id) this.patch(taskId, { sessionId: null });
        return;
      }
      this.patch(taskId, {
        status: "running",
        sessionId: session.id,
        homeName: null,
        terminalResourceId: null,
      });
      // Cover both driver-binding orders, as ordinary embedded dispatch does. A bound
      // session is linked now; a later `bound` event sees Task.sessionId and links then.
      this.registry.bindTaskToWorkEpisode(taskId, session.id);
      return;
    }

    if (task.agent !== "claude") {
      throw new Error(
        "Terminal Pipeline launches are Claude-only; choose Claude or switch the Pipelines launch runtime to Agent SDK",
      );
    }

    const label = sessionLabel(task.title);
    const shortId = taskId.slice(0, 6);
    const terminalLaunch = launch;
    const [command, ...args] = terminalLaunch.argv;
    if (!command) throw new Error("the pipeline provider returned no launch command");
    const homeName = await (this.deps.spawn ?? spawnUniquely)(
      label,
      shortId,
      terminalLaunch.cwd,
      command,
      args,
    );
    this.patch(taskId, { homeName });
    if (await this.abortIfSettled(taskId)) return;

    // The terminal is conductor's live stdin, not an agent session. Agent sessions appear
    // later in the engine's worktree; their correlation remains a compatibility backstop
    // for tasks created before provider identity was known at launch.
    this.patch(taskId, { status: "running", sessionId: null });
  }

  /**
   * The embedded arm of the dispatch: hand the task to the supervisor and stop.
   *
   * What is NOT here is the point of it. No terminal home, so no `homeName`, no name
   * collision to dodge and nothing to kill at teardown. No `waitForSessionAtCwd`, because
   * this session does not have to be discovered - we are holding it. No `awaitReady`,
   * because there is no TUI that might not exist yet and no 20-second hook wait to hedge
   * with; the driver's own `bound` is the readiness signal, and it cannot be missed. And no
   * `deliverIntent`, because the intent IS turn one of the conversation the supervisor
   * starts - there is no paste to verify, no settle window, and no retry whose cost is the
   * agent reading its task twice.
   *
   * The ask channel is dropped with them, and deliberately: it exists because a menu on a
   * child's terminal is unreadable to the dashboard, and an embedded session's questions
   * arrive as structured requests the card draws directly. Our MCP server still rides
   * along, because `report_status` and the rest were never about asking questions.
   */
  private async dispatchEmbedded(
    taskId: string,
    task: Task,
    wt: ProvisionedWorktree,
    model: string | null,
    effort: ThinkingLevel | null,
    missionMcp: MissionMcpRequirement | null,
    /** Turn one, already carrying the repo manifest when the task has attached repos. */
    intent: string,
    /** Secondary worktrees this session must be able to write to. Empty for single-repo. */
    extraDirs: string[],
    /** What the operator's standing instructions resolved to for this launch. */
    standing: StandingInstructionsDelivery,
    /** `intent` recomposed with the block in its ordered slot, if the channel proves unusable. */
    standingFallbackTurnOne: string,
  ): Promise<void> {
    const supervisor = this.deps.supervisor;
    if (!supervisor) {
      // Never silently fall back to the terminal path: the operator set this harness to the
      // Agent SDK, and a session that quietly launched the other way is one whose whole
      // behaviour - where its questions appear, whether it survives a restart - is not what
      // they asked for.
      throw new Error("this build has no session supervisor, so it cannot dispatch embedded");
    }
    const mcp = await (this.deps.missionMcpDescriptor ?? missionMcpDescriptor)();
    // Same rule the terminal path applies to its argv, asked of the thing that actually
    // reaches the child: a caller passing `missionMcp` declared those tools REQUIRED, and a
    // session that cannot call them would run to completion unable to report it.
    if (missionMcp && !mcp) {
      throw new Error(
        `the launch could not carry the required Mission MCP tools ` +
          `${missionMcp.tools.join(", ")} (is the MCP bundle built?), so this ${task.agent} ` +
          `session could not submit its result`,
      );
    }
    // The terminal arm's content check, applied to the same bundle for the same reason: an
    // embedded session reaches our MCP server through the descriptor rather than an argv, but
    // a descriptor pointing at a stale bundle publishes exactly as little. See the sibling
    // guard in `dispatch` for what drifts and why the existence check cannot see it.
    if (missionMcp) {
      const published = await (this.deps.verifyMissionMcpTools ?? verifyMissionMcpTools)(
        missionMcp.tools,
        mcp,
      );
      if (!published.ok) {
        throw new Error(
          `this ${task.agent} session requires the Mission MCP tools ` +
            `${missionMcp.tools.join(", ")}, but ${published.reason}`,
        );
      }
    }
    const session = await supervisor.start({
      agent: task.agent,
      // The task's own title, unsanitized: `sessionLabel` cuts a name down to a terminal
      // backend's target grammar, and there is no terminal here to satisfy. It is also what
      // makes a restored card come back under the same name (see `restoredName`).
      name: task.title.trim() || wt.path,
      cwd: wt.path,
      prompt: intent,
      acceptedGoalPrompt: task.intent,
      // Turn one IS the composed prompt on this runtime, so the dashboard's projection is
      // recorded here rather than at a delivery seam that does not exist. `task.intent` is
      // the operator's own words; everything the composition added above stays in the
      // transcript, in the agent's context, and in every server-side evidence read.
      launchPresentation: { prompt: intent, displayText: task.intent },
      model,
      effort,
      permissionMode: dispatchPermissionMode(task.agent),
      mcp,
      extraDirs,
      // The WHOLE delivery, because the supervisor is the only place that learns what the
      // driver actually did with it - Codex can find its channel unusable at launch and fall
      // back to turn one - and it therefore owns this runtime's launch snapshot. On the pairs
      // with no channel the block is already inside `intent` above, and the supervisor sends
      // nothing out of band for them.
      standingInstructions: { delivery: standing, fallbackPrompt: standingFallbackTurnOne },
      taskId,
      gitBranch: wt.branch,
      gitRoot: wt.path,
      repoRoot: task.repoRoot,
    });
    if (await this.abortIfSettled(taskId)) {
      // A cancel landed while the driver was starting. `abortIfSettled` tore down the
      // worktree; the session it would have worked in has to go with it.
      await supervisor.stop(session.id).catch(() => {});
      return;
    }
    // The launch snapshot for this runtime was written by `supervisor.start`, which is the
    // only caller that sees what the driver reported back. See the terminal arm below for the
    // same record on the path where the argv settles the question synchronously.
    this.patch(taskId, { status: "running", sessionId: session.id });
    // Both orders are covered on purpose. If the driver has already bound, the episode
    // exists and this binds it; if it has not, `applyDriverBinding` binds it when it does,
    // because the task now records this session id. Neither can be relied on alone.
    this.registry.bindTaskToWorkEpisode(taskId, session.id);
    // AFTER the start rather than before it, because on this runtime the prompt IS the
    // start: there is no session to measure a boundary against until the driver has one.
    // The anchor is `launch` for the same reason - turn one travelled with the process, so
    // every byte the transcript will ever hold belongs to this episode.
    //
    // Being last is what makes it safe to be unguarded here. The task is already `running`
    // by this line, so a throw would reach `dispatch`'s catch, find a status that is no
    // longer `dispatching`, and take the branch that assumes somebody else settled the task
    // - returning with no log and no trace of what went wrong. It cannot throw: the seam
    // logs and swallows, which turns exactly that invisible loss into a visible one.
    freezeScoutPromptBoundary(this.registry, task, session.id, "launch");
  }

  /**
   * Wait for the agent to be able to READ the prompt we're about to type.
   *
   * Discovery is a `ps` sweep: it fires when the binary is exec'd, seconds before any
   * TUI exists. A hook-capable launch proves readiness with its first hook. Pi needs no
   * pane-write readiness signal because its initial prompt rides on the launch argv and is
   * submitted by Pi after its own TUI initialization.
   *
   * The fallback is deliberate. An agent whose hooks aren't installed will never satisfy
   * this, and refusing to dispatch to it would be a regression, so a timeout degrades
   * to the old fixed sleep - the pre-existing best-effort behaviour, now confined to
   * the only case that has no better option instead of applying to everything.
   *
   * "Aren't installed" and "don't exist" are different, though, and only the first is
   * worth waiting out. A harness that declares no `hooks` and no launch-scoped readiness
   * signal takes the fallback immediately. Ask the registry rather than the session for
   * hook capability.
   */
  private async awaitReady(
    cwd: string,
    discovered: Session,
    hooksPrepared = true,
  ): Promise<{ session: Session; instrumented: boolean }> {
    if (hooksPrepared && hooksFor(discovered.agent)) {
      const ready = await this.registry.waitForReadySessionAtCwd(
        cwd,
        discovered.id,
        HOOK_READY_MS,
      );
      if (ready) return { session: ready, instrumented: true };
    }
    // A null readiness result means either hook silence or an observed exit. Preserve
    // the fallback settle only for a live-but-silent session; an exited one has no TUI
    // left to settle and must fail immediately.
    this.requireLiveSession(discovered.id);
    await (this.deps.sleep ?? sleep)(SETTLE_MS);
    // Re-read: `discovered` is a snapshot from before the wait, and its pane may have
    // been filled in since. Typing needs the freshest pane we have.
    return {
      session: this.requireLiveSession(discovered.id),
      instrumented: false,
    };
  }

  /** Reject a discovery snapshot that the registry is retaining only for exit visibility. */
  private requireLiveSession(sessionId: string): Session {
    const session = this.registry.getSession(sessionId);
    if (!session || session.state === "exited") {
      throw new Error("agent session exited before the initial prompt could be sent");
    }
    return session;
  }

  /**
   * Record how the dashboard should present this launch, without ever risking the launch.
   *
   * Presentation is strictly secondary to delivery: the prompt reaching the agent is the
   * task, and the conversation window drawing it nicely is a courtesy. So a failed marker
   * write is logged and swallowed - the conversation simply renders the composed prompt the
   * way it did before this feature existed, which is a degradation a person can read past
   * rather than a dispatch that did not happen.
   *
   * Returns the marker so a caller whose delivery then fails can roll it back.
   */
  private recordLaunchPresentation(
    sessionId: string,
    prompt: string,
    displayText: string | null,
  ): LaunchTurnMarker | null {
    try {
      return this.registry.recordLaunchTurn(sessionId, prompt, displayText);
    } catch (err) {
      console.error(
        `[dispatch] could not record the launch presentation for session ${sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /**
   * The same door addressed by logical conversation key rather than by session.
   *
   * For the one launch that has its native conversation id BEFORE it has a session: Pi's,
   * minted by `preparePiLaunch` so it can travel in the argv. Recording under that key needs
   * no session to look it up from, and no later move.
   */
  private recordLaunchPresentationForKey(
    noteKey: string,
    prompt: string,
    displayText: string | null,
  ): LaunchTurnMarker | null {
    try {
      return this.registry.recordLaunchTurnForKey(noteKey, prompt, displayText);
    } catch (err) {
      console.error(
        `[dispatch] could not record the launch presentation for conversation ${noteKey}:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /**
   * Type the intent and - when we can - confirm the agent actually took it.
   * Each attempt resolves the session id again at the send boundary, so a retained
   * exited snapshot can never lend its old pane to an initial send or retry.
   *
   * `injectPrompt` succeeding means the terminal accepted the write, NOT that the agent read
   * it: a pty swallows keystrokes just as happily when nothing is listening. Trusting
   * it is what let a task sit `running` for 13 minutes against a session whose first
   * prompt was pasted 647ms before its TUI existed. Hooked sessions wait for the
   * `working` transition only `UserPromptSubmit` can produce.
   *
   * The retry is gated on positive evidence: a hooked session is STILL idle. It is not
   * free: if the paste reached the input box but the Enter did not, a second paste
   * concatenates onto the first and the agent reads its intent twice over. That is the
   * accepted cost - a garbled-but-visible prompt a human can fix beats a session that sits
   * empty and calls itself `running`, and if neither attempt takes, the task now FAILS
   * loudly instead of lying.
   *
   * None of this transfers to the wrap-up, whose instruction pushes: there a second
   * delivery is a second PR, so it never retries. See queue-apply's `auto-wrapup`.
   *
   * Uninstrumented sessions get one best-effort send: with no hook there is no signal,
   * and absence of evidence is not evidence.
   */
  private async deliverIntent(
    sessionId: string,
    intent: string,
    cwd: string,
    instrumented: boolean,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      // Preflight before subscribing. If the process already exited, there will be no
      // prompt acknowledgement and no reason to retain a listener until its timeout.
      const session = this.requireLiveSession(sessionId);

      // Listen BEFORE typing - the hook can land before the next line runs.
      const acceptanceAbort = instrumented ? new AbortController() : null;
      const accepted = instrumented
        ? this.registry.waitForPromptAcceptedAtCwd(cwd, ACCEPT_MS, acceptanceAbort?.signal)
        : null;

      let sent: Awaited<ReturnType<typeof injectPrompt>>;
      try {
        sent = await (this.deps.inject ?? injectPrompt)(
          session,
          intent,
          undefined,
          () => this.registry.promptResourceBlockerForSession(session.id),
        );
      } catch (err) {
        acceptanceAbort?.abort();
        throw err;
      }
      if (!sent.ok) {
        acceptanceAbort?.abort();
        throw new Error(`could not send the initial prompt: ${sent.error ?? "unknown"}`);
      }
      if (!accepted) return;
      if (await accepted) return;

      // Still idle after typing at it. Positive evidence the paste went nowhere - but
      // only if it's STILL idle now; a `working` we merely raced past means it landed.
      const now = this.requireLiveSession(sessionId);
      if (now.state !== "idle") return;
      if (attempt >= 2) {
        throw new Error(
          "the agent never acknowledged the initial prompt (it was typed but not ingested)",
        );
      }
    }
  }

  /**
   * A dispatch stays `dispatching` until its own final transition; if the status
   * changed underneath it (a cancel or a mid-flight complete), that transition
   * owns the task and this dispatch must stand down.
   */
  private stillDispatching(taskId: string): boolean {
    return this.registry.getTask(taskId)?.status === "dispatching";
  }

  /**
   * Checkpoint between dispatch steps: if a cancel/complete settled the task in
   * flight, tear down whatever this dispatch already created (it may have run
   * before those resources existed and so couldn't clean them up) and stop.
   */
  private async abortIfSettled(taskId: string): Promise<boolean> {
    if (this.stillDispatching(taskId)) return false;
    // A cancel wants resources gone; a mid-flight complete ("done") explicitly wants
    // them KEPT (Mark done must not discard work). Only tear down for a cancel.
    const cur = this.registry.getTask(taskId);
    if (cur?.status === "cancelled") {
      await this.teardownTaskResources(taskId, cur, cur.error);
    }
    return true;
  }

  /**
   * Provision one worktree per attached repo, or none at all.
   *
   * All-or-nothing, and that is the whole reason this is a method rather than a loop at the
   * call site. A task whose second repo fails to provision has already taken a real tree
   * for its first - a native lease, most likely - and nothing downstream would ever tear that
   * down: the dispatch throws before any of it reaches the task row, so teardown and
   * startup reconciliation, which both read the row, cannot see it. The pool would simply
   * lose a slot per failed dispatch.
   *
   * Unwinding is provider-aware because `teardownWorktree` is: a native lease is returned
   * conditionally through its exact allocator identity, while a Git fallback tree is removed
   * with its `harness/` branch. Mixed providers across one task are ordinary because native
   * policy is per physical repository, so both orderings unwind correctly.
   *
   * A failure during the unwind is logged, never thrown: the caller is already failing, and
   * replacing the cause with a cleanup error would hide the thing that actually went wrong.
   */
  private async provisionAll(
    task: Task,
    taskId: string,
    slug: string,
    shortId: string,
    bases: TaskDispatchBases,
  ): Promise<{ primary: ProvisionedWorktree; extras: TaskRepoEntry[] }> {
    const primary = await provisionWorktree(
      task.repoRoot,
      taskId,
      slug,
      shortId,
      bases.primary,
      0,
      this.worktrees,
    );
    const taken: Array<{ repoRoot: string; position: number; wt: ProvisionedWorktree }> = [
      { repoRoot: task.repoRoot, position: 0, wt: primary },
    ];
    const extras: TaskRepoEntry[] = [];
    try {
      for (const [index, entry] of task.extraRepos.entries()) {
        // Slot is the entry's position in `task_repos`, offset by one for the primary at
        // slot 0. Its base was frozen alongside every other repository's before this loop
        // started - a pin means nothing in another repository, so a secondary took its own
        // repository's freshly fetched remote default and records where that landed.
        const wt = await provisionWorktree(
          entry.repoRoot,
          taskId,
          slug,
          shortId,
          bases.extras[index] ?? null,
          index + 1,
          this.worktrees,
        );
        taken.push({ repoRoot: entry.repoRoot, position: index + 1, wt });
        extras.push({
          ...entry,
          worktreePath: wt.path,
          branch: wt.branch,
          provider: wt.provider,
          worktreeLeaseId: wt.leaseId,
          baseSha: wt.baseSha,
        });
      }
    } catch (err) {
      for (const { repoRoot, position, wt } of taken) {
        await this.teardown({
          repoRoot,
          worktreePath: wt.path,
          branch: wt.branch,
          provider: wt.provider,
          worktreeLeaseId: wt.leaseId,
          taskId,
          position,
          // No terminal home exists yet - nothing has been spawned at this point.
          homeName: null,
        }).catch((cleanupError: unknown) => {
          console.error(
            `[mission-control] could not unwind ${wt.path} after a failed multi-repo ` +
              `provision: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        });
        if (wt.leaseId) this.worktrees.settleDomainLease(wt.leaseId);
      }
      throw err;
    }
    return { primary, extras };
  }

  private async teardownTaskResources(
    taskId: string,
    task: Task,
    baseError: string | null,
  ): Promise<boolean> {
    try {
      await this.teardown(task);
      this.patch(taskId, {
        ...releasedTaskResources(task, null),
        homeName: null,
        terminalResourceId: null,
      });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // The trees that DID come back are released even though the teardown failed overall.
      // Anything still standing keeps its record, so it remains reclaimable; anything gone
      // stops being pinned. Reporting the failure and keeping the whole collection would
      // leave durable rows naming trees that are already back in their pools.
      this.patch(taskId, {
        ...releasedTaskResources(task, reclaimedFrom(error)),
        error: baseError
          ? `${baseError} - resource cleanup failed: ${detail}`
          : `resource cleanup failed: ${detail}`,
      });
      return false;
    }
  }

  /** Merge fields onto the CURRENT registry task, never a stale local snapshot. */
  private patch(taskId: string, fields: Partial<Task>): void {
    const cur = this.registry.getTask(taskId);
    if (!cur) return;
    this.registry.upsertTask({ ...cur, ...fields, updatedAt: Date.now() });
    // The one transition worth announcing: this task now has a session to be named on.
    // Read off the BEFORE and AFTER rather than off `fields`, so a patch that merely
    // restates the id it already had stays silent and the notification means "newly
    // bound" exactly once.
    if (cur.sessionId === null && typeof fields.sessionId === "string") {
      // Never allowed to fail the launch. The listener renames a terminal home, which is
      // cosmetic next to an agent that is already running with its worktree recorded.
      try {
        this.deps.onSessionBound?.(taskId);
      } catch (err) {
        console.error(`[dispatch] session-bound listener failed for ${taskId}:`, err);
      }
    }
  }
}

// ---- worktree provisioning ----

export interface ProvisionedWorktree {
  path: string; // realpath, so it matches a pane's reported cwd exactly
  branch: string | null;
  provider: Extract<WorktreeProvider, "mission" | "git">;
  /** Present only for the native provider. */
  leaseId: string | null;
  /**
   * The full 40-character commit this tree was cut at, or null when HEAD could not be
   * read. Recorded for every repo on every dispatch, single-repo included: it costs one
   * column write, keeps one code path, and is the baseline later phases compare a head
   * against to decide whether a repo changed at all.
   */
  baseSha: string | null;
}

/**
 * How long a read-only `git` preflight gets to answer.
 *
 * `run`'s 4s default was chosen for discovery commands against a terminal multiplexer, and
 * it was never a git budget. A dispatch asks these questions of a git dir that every linked
 * worktree on the machine shares, during a burst, while the agents in those trees are
 * running git of their own - and `teardownWorktree` already pays 15-30s for exactly that
 * reason. A `rev-parse` costs single-digit milliseconds on an idle machine, so this ceiling
 * is only ever reached by a machine that is not idle, which is precisely the moment a wrong
 * answer here is most expensive.
 */
const GIT_PREFLIGHT_TIMEOUT_MS = 15_000;

/**
 * The error for a git preflight that never got an answer.
 *
 * `run` reports a child that DIED - our own timeout, the OOM killer, an operator's `pkill` -
 * as `code: 1` with empty stdout, which is byte-for-byte what a git that ran and said "no"
 * looks like. A caller reading `code` alone therefore converts "we could not find out" into
 * a confident negative FACT, and the callers below go on to state that fact in an
 * operator-facing error that ends the dispatch: "X is not a git repository", "X is not a
 * commit in Y". Neither is something we know.
 *
 * That is not hypothetical. A dispatch died with "is not a git repository" against a
 * checkout that had served a `git pull` twelve seconds earlier and provisioned the next
 * dispatch fifteen seconds later; the operator read it as a broken checkout, and the task
 * that depended on its pull request waited on a merge that could never happen.
 *
 * `RunResult.outcomeUnknown` is the flag this difference already travels on. This is the
 * message that spends it - and it says the tree is untouched, because a read-only check
 * that died provisioned nothing and is therefore safe to try again.
 */
function gitNeverAnswered(question: string, r: RunResult): Error {
  return new Error(
    `could not determine ${question}: git did not answer ` +
      `(${r.stderr.trim() || `exit ${r.code}`}) - nothing was provisioned, so this can be retried`,
  );
}

/**
 * Where an ordinary, unpinned task starts: a freshly fetched remote-default commit.
 *
 * The alternative - the main checkout's current local `HEAD` - is what shipped, and it is
 * wrong for a scheduled task in two ways at once. It is whatever the operator happened to
 * have checked out at that instant, which for a checkout sitting on a feature branch is a
 * base nobody chose; and it is stale by however long it has been since somebody pulled,
 * which for a task scheduled to run after a dependency merged is the specific commit the
 * task exists to build on. Freezing the remote default makes both deterministic, and
 * freezing ONE full id (rather than passing the ref name down) makes it observable: the
 * task records exactly what it started from.
 *
 * Every uncertain answer fails the dispatch instead of falling back. The fallback is the
 * dangerous direction here: refusing costs a retryable error before anything is
 * provisioned, while guessing costs an agent that has already been launched from a base
 * nobody can reconstruct afterwards. So only a `git remote` listing that SUCCEEDED and did
 * not name `origin` may take the local-HEAD path - a probe that timed out cannot.
 */
export async function resolveDispatchBase(repoRoot: string): Promise<string> {
  const origin = await originConfigured(repoRoot);
  if (!origin.ok) {
    throw new Error(
      `could not determine whether ${repoRoot} has an origin remote: ${origin.reason} - ` +
        "nothing was provisioned, so this can be retried",
    );
  }
  // A local-only repository is ordinary - a scratch checkout, a fixture, a repo whose
  // remote was never added. Its local HEAD is the only base that exists, so it is not a
  // fallback so much as the whole answer.
  if (!origin.value) {
    const head = await headCommit(repoRoot);
    if (!head) {
      throw new Error(
        `${repoRoot} has no origin remote and its exact HEAD commit could not be resolved`,
      );
    }
    return head;
  }
  const fresh = await freshRemoteDefaultSha(repoRoot);
  if (!fresh.ok) {
    throw new Error(
      `could not freeze ${repoRoot}'s remote default branch: ${fresh.reason} - ` +
        "nothing was provisioned, so this can be retried",
    );
  }
  return fresh.value;
}

/** The exact commit each of a task's repositories will be provisioned at, by slot. */
export interface TaskDispatchBases {
  /** Slot 0, the task's own repository. */
  primary: string;
  /** Slot n+1, aligned index-for-index with `task.extraRepos`. */
  extras: string[];
}

/**
 * Freeze every repository's base BEFORE the first worktree is taken.
 *
 * A multi-repository task is all-or-nothing, and resolving lazily inside the provisioning
 * loop would break that in the one case it matters: the second repository's fetch fails,
 * the first repository's lease already exists, and the unwind has to return a tree that
 * should never have been taken. Resolving up front makes a fetch failure cost an error and
 * nothing else.
 *
 * Sequential and memoized rather than concurrent. Two fetches racing in one repository
 * contend for the same lock file for no benefit, and a task may legitimately attach the
 * same repository twice; one resolution per distinct root, in a fixed order, keeps both the
 * cost and the failure order predictable.
 */
export async function resolveTaskBases(
  repoRoots: { primary: string; extras: readonly string[] },
  /** The verified `options.baseSha`, which pins the PRIMARY repository only. */
  pinned: string | null,
  resolve: (repoRoot: string) => Promise<string> = resolveDispatchBase,
): Promise<TaskDispatchBases> {
  const frozen = new Map<string, string>();
  const forRepo = async (repoRoot: string): Promise<string> => {
    const already = frozen.get(repoRoot);
    if (already) return already;
    const resolved = await resolve(repoRoot);
    frozen.set(repoRoot, resolved);
    return resolved;
  };
  // A pin names one commit in one repository. It cannot mean anything in another, so an
  // attached repository resolves its own remote default even on a pinned dispatch - the
  // same rule the old code stated by passing `null` for every secondary.
  const primary = pinned ?? (await forRepo(repoRoots.primary));
  const extras: string[] = [];
  for (const repoRoot of repoRoots.extras) extras.push(await forRepo(repoRoot));
  return { primary, extras };
}

/**
 * Confirm a caller's pinned base is a real commit in this repository, and return it.
 *
 * FULL ids only. A short id or a ref name would resolve here and still be the wrong
 * contract: `main` means a different commit an hour later, which is precisely the drift a
 * pinned base exists to remove, and a caller that persisted "main" would have no record of
 * what its member actually started from. So the id has to name one immutable object and
 * `rev-parse` has to hand back that same object - anything else is refused rather than
 * quietly resolved to something near it.
 */
export async function verifyPinnedBase(repoRoot: string, baseSha: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new Error(`pinned base "${baseSha}" is not a full 40-character commit id`);
  }
  const r = await run(
    "git",
    ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${baseSha}^{commit}`],
    { timeoutMs: GIT_PREFLIGHT_TIMEOUT_MS },
  );
  // `--quiet` makes a genuine miss an exit 1 with empty stderr, which is exactly the shape a
  // killed child arrives in. Refusing a caller's pinned base is a claim about THEIR commit,
  // so it has to come from git having actually looked.
  if (r.outcomeUnknown) {
    throw gitNeverAnswered(`whether ${baseSha} is a commit in ${repoRoot}`, r);
  }
  const resolved = r.stdout.trim();
  if (r.code !== 0 || resolved !== baseSha) {
    throw new Error(`pinned base ${baseSha} is not a commit in ${repoRoot}`);
  }
  return baseSha;
}

/**
 * Give a task its own isolated tree. Native pooling is the default; a repository whose
 * native policy is disabled or positively refuses an acquisition gets a disposable Git
 * worktree on a fresh `harness/<slug>` branch. An ambiguous native outcome fails closed.
 *
 * `baseSha` pins the tree's starting point. Absent, the current exact HEAD is captured before
 * either provider runs. Both providers start from that immutable commit, because a member
 * that silently started somewhere else is not comparable with its siblings.
 */
export async function provisionWorktree(
  repoRoot: string,
  taskId: string,
  slug: string,
  shortId: string,
  /** The exact commit the tree must start at, verified by `verifyPinnedBase` already. */
  baseSha: string | null = null,
  /**
   * Which of the task's repos this is: 0 is the primary, n > 0 the nth attached secondary.
   *
   * It exists to identify the durable native owner and make the Git fallback destination
   * unique. The fallback path was keyed on the task alone, so a task attaching two repos
   * provisioned the first and then ran
   * `git worktree add` against a directory that already existed. Keyed on the slot rather
   * than on the repo's basename because two attached repos can share one (`~/a/api` and
   * `~/b/api`), while the slot is unique by construction and persisted as the entry's
   * `position`, so the path stays stable across restarts.
   *
   * Defaulted to 0, whose fallback destination is byte-identical to what it always was.
   */
  slot = 0,
  manager?: WorktreeManager,
): Promise<ProvisionedWorktree> {
  const check = await run("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
    timeoutMs: GIT_PREFLIGHT_TIMEOUT_MS,
  });
  // Asked BEFORE `code`, because a killed child and a git that answered "no" are the same
  // `code: 1` with the same empty stdout - see `gitNeverAnswered`.
  if (check.outcomeUnknown) {
    throw gitNeverAnswered(`whether ${repoRoot} is a git repository`, check);
  }
  if (check.code !== 0 || check.stdout.trim() !== "true") {
    throw new Error(`${repoRoot} is not a git repository`);
  }

  const exactBase = baseSha ?? await headCommit(repoRoot);
  if (!exactBase) throw new Error(`could not resolve the exact HEAD commit in ${repoRoot}`);

  if (manager) {
    const acquired = await manager.acquire({
      repositoryPath: repoRoot,
      baseSha: exactBase,
      owner: { kind: "task", key: `${taskId}:${slot}` },
      awaitingDomainRecord: true,
    });
    if (acquired.outcome === "acquired") {
      return {
        path: acquired.lease.path,
        branch: await currentBranch(acquired.lease.path),
        provider: "mission",
        leaseId: acquired.lease.leaseId,
        baseSha: acquired.lease.baseSha,
      };
    }
    if (acquired.outcome === "outcomeUnknown") {
      throw new Error(
        `native worktree acquisition outcome is unknown for ${repoRoot}: ${acquired.reason}`,
      );
    }
    if (!/disabled for this repository/.test(acquired.reason)) {
      console.warn(
        `[mission-control] native worktree in ${repoRoot} was not acquired: ${acquired.reason}` +
          " - falling back to a throwaway git worktree",
      );
    }
  }

  mkdirSync(WORKTREES_DIR, { recursive: true });
  const path = worktreeSlotPath(taskId, slot);
  // Deliberately the SAME branch name in every repo the task touches. They live in
  // different repositories, so they cannot collide, and one name across the set is what
  // makes the resulting pull requests legible as one piece of work.
  //
  // This arm is the only one that creates a branch. Native leases are detached, so a set
  // mixing the two can hold a branch only for its Git fallback repos. The manifest reads the
  // provisioned branches rather than assuming a shared name.
  const branch = `harness/${slug}-${shortId}`;
  const add = await run(
    "git",
    ["-C", repoRoot, "worktree", "add", path, "-b", branch, exactBase],
    { timeoutMs: 60000 },
  );
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim() || "unknown"}`);
  const real = realpathSync(path);
  if (baseSha) {
    try {
      await verifyHeadIs(real, baseSha);
    } catch (err) {
      // Same rule as the pool arm: this tree exists on disk but no task will ever record
      // it, so tear it down here rather than leave an unreferenced worktree and branch
      // behind. `teardownWorktree` is the one owner of that removal, and a removal that
      // itself fails rides along with the real cause instead of replacing or hiding it -
      // somebody has a directory to delete by hand.
      const cause = err instanceof Error ? err.message : String(err);
      const cleanup = await teardownWorktree({
        repoRoot, worktreePath: real, branch, provider: "git", homeName: null,
      }).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
      throw new Error(cleanup ? `${cause} - and its worktree could not be removed: ${cleanup}` : cause);
    }
  }
  return { path: real, branch, provider: "git", leaseId: null, baseSha: exactBase };
}

/**
 * Where the git fallback puts slot `n`'s tree.
 *
 * Slot 0 is `WORKTREES_DIR/<taskId>` - the path this has always used, unchanged so that
 * every single-repo task, every row written before multi-repo tasks existed, and startup
 * reconciliation all resolve exactly as before.
 *
 * A cross-phase contract: teardown and reconciliation read the RECORDED `worktree_path`
 * rather than recomputing it here, so nothing may renumber a provisioned entry's position
 * without also moving its tree.
 */
export function worktreeSlotPath(taskId: string, slot: number): string {
  return join(WORKTREES_DIR, slot === 0 ? taskId : `${taskId}-${slot}`);
}

/**
 * The full object id a freshly provisioned tree stands on, or null if it cannot be read.
 *
 * Null is "unknown", which is the same thing the column already means for every task
 * dispatched before it existed - and it is the only honest answer here. Every rule that
 * consumes a baseline compares a later head against it, so a fabricated value would be
 * indistinguishable from a measured one and would report an untouched repo as changed (or
 * the reverse). A failure to read HEAD is deliberately NOT fatal: the tree is provisioned
 * and the agent can work in it, and refusing the whole dispatch over a baseline that is
 * only consumed by later phases would trade a working session for a bookkeeping field.
 */
async function headCommit(dir: string): Promise<string | null> {
  const r = await run("git", ["-C", dir, "rev-parse", "HEAD"], {
    timeoutMs: GIT_PREFLIGHT_TIMEOUT_MS,
  });
  const sha = r.stdout.trim();
  return r.code === 0 && FULL_SHA.test(sha) ? sha : null;
}

/**
 * Tear down a task's live resources (best-effort): close the terminal home it was
 * dispatched into and return/remove its worktree + throwaway branch. Provider-aware so a
 * provider-owned lease is returned through its recorded provider rather than leaked or
 * bypassed with a bare `git worktree remove`.
 *
 * `homeName` names the home vendor-neutrally: which backend holds that name is resolved
 * through the registry (`killHome`) rather than assumed here.
 */
export async function teardownWorktree(
  task: {
    taskId?: string;
    /** `Task.id` when the full durable task is passed. */
    id?: string;
    repoRoot: string;
    worktreePath: string | null;
    branch: string | null;
    provider: WorktreeProvider | null;
    worktreeLeaseId?: string | null;
    /** Position when this shape names one tree during provisioning unwind. */
    position?: number;
    homeName: string | null;
    /**
     * The task's secondary repos, when it has any. Optional so the handful of callers that
     * build this shape by hand for a single tree - provisioning's own unwind paths - stay
     * unchanged; a `Task` satisfies it as-is and gets the whole collection torn down.
     */
    extraRepos?: readonly {
      repoRoot: string;
      worktreePath: string | null;
      branch: string | null;
      provider: WorktreeProvider | null;
      worktreeLeaseId?: string | null;
    }[];
  },
  legacy: LegacyTreehouseService = new LegacyTreehouseService(),
  /** Startup reconciliation remains a background scheduling hint for focused test seams. */
  _priority: "foreground" | "background" = "foreground",
  /** The daemon's singleton allocator. Required only when a recorded provider is `mission`. */
  manager?: WorktreeManager,
): Promise<void> {
  if (task.homeName) {
    const killed = await killHome(task.homeName);
    // An adapter lookup that found nothing must not read as "there was nothing to kill".
    // This is the one path where the difference is destructive: we are about to hand the
    // worktree back to the pool, so an agent still running in it loses its checkout with no
    // trace of why. `asked` is false only when no installed backend can kill a home at all -
    // an emulator tab is not a group - and then the honest thing is to say so out loud and
    // name what the operator has to do by hand.
    if (!killed.asked) {
      console.warn(
        `[mission-control] no terminal backend can close the session '${task.homeName}' - ` +
          "if an agent is still running there, stop it yourself; its worktree is being reclaimed now",
      );
    }
  }
  // Every tree the task holds, primary first. Each is attempted even if an earlier one
  // failed, and the failures are reported together: stopping at the first would leave the
  // remaining trees leased or on disk with nothing left that will ever come back for them.
  //
  // A single-repo task has no extras, so this is one entry and one error message, exactly
  // as it was before.
  const taskId = task.taskId ?? task.id ?? null;
  const trees = [
    {
      repoRoot: task.repoRoot,
      worktreePath: task.worktreePath,
      branch: task.branch,
      provider: task.provider,
      worktreeLeaseId: task.worktreeLeaseId ?? null,
      taskId,
      position: task.position ?? 0,
    },
    ...(task.extraRepos ?? []).map((entry, index) => ({
      repoRoot: entry.repoRoot,
      worktreePath: entry.worktreePath,
      branch: entry.branch,
      provider: entry.provider,
      worktreeLeaseId: entry.worktreeLeaseId ?? null,
      taskId,
      position: index + 1,
    })),
  ];
  const failures: string[] = [];
  const reclaimed: string[] = [];
  for (const tree of trees) {
    await teardownOneWorktree(tree, legacy, manager).then(
      () => {
        if (tree.worktreePath) reclaimed.push(tree.worktreePath);
      },
      (err: unknown) => {
        failures.push(err instanceof Error ? err.message : String(err));
      },
    );
  }
  // The reclaimed set rides on the error so a caller can clear exactly the trees that came
  // back. Without it a partial failure reads as a total one and the row goes on naming
  // worktrees that no longer exist - see `releasedTaskResources`.
  if (failures.length > 0) throw new WorktreeTeardownError(failures.join("; "), reclaimed);
}

/**
 * A teardown in which at least one of a task's trees could not be reclaimed.
 *
 * It carries the paths that DID come back, which is the whole reason it is a type rather
 * than a plain Error. `teardownWorktree` attempts every tree even after one fails, so a
 * failure is no longer all-or-nothing - and a caller that treated it as such would leave
 * the row claiming trees that are already gone, and a retry would re-issue release against a
 * resource the provider has already taken back.
 */
export class WorktreeTeardownError extends Error {
  constructor(message: string, readonly reclaimed: readonly string[]) {
    super(message);
    this.name = "WorktreeTeardownError";
  }
}

/** The worktrees a failed teardown did manage to reclaim; everything, on any other error. */
export function reclaimedFrom(error: unknown): readonly string[] {
  return error instanceof WorktreeTeardownError ? error.reclaimed : [];
}

/**
 * The provisioning fields a task should be left holding after a teardown.
 *
 * `reclaimed` is the set of worktree paths that actually came back, or `null` for the
 * ordinary case where every one of them did. A tree that came back has its record cleared;
 * a tree that did not KEEPS it, because a row that stopped naming a worktree still standing
 * is a row nothing can ever reclaim.
 *
 * One function rather than the same five-field literal at each of the six teardown sites.
 * That duplication has now been the cause of two separate defects - a site that forgot
 * `baseSha`, and a site that forgot the collection entirely - and partial reclaim makes the
 * rule too subtle to restate correctly by hand.
 *
 * The repo SET always survives, for both the primary and the secondaries: `repoRoot` stays
 * while the worktree facts go. That is what lets a reclaimed multi-repo task be dispatched
 * again as the task the operator filed rather than silently becoming a single-repo one.
 */
export function releasedTaskResources(
  task: Pick<
    Task,
    "worktreePath" | "branch" | "provider" | "worktreeLeaseId" | "baseSha" | "extraRepos"
  >,
  reclaimed: readonly string[] | null,
): Pick<
  Task,
  "worktreePath" | "branch" | "provider" | "worktreeLeaseId" | "baseSha" | "extraRepos"
> {
  // A tree with no recorded path has nothing to reclaim and nothing to keep.
  const gone = (path: string | null): boolean =>
    path === null || reclaimed === null || reclaimed.includes(path);
  return {
    worktreePath: gone(task.worktreePath) ? null : task.worktreePath,
    branch: gone(task.worktreePath) ? null : task.branch,
    provider: gone(task.worktreePath) ? null : task.provider,
    worktreeLeaseId: gone(task.worktreePath) ? null : task.worktreeLeaseId,
    // The primary's baseline is a fact about the primary's tree, so it goes with it.
    baseSha: gone(task.worktreePath) ? null : task.baseSha,
    extraRepos: task.extraRepos.map((entry) =>
      gone(entry.worktreePath)
        ? {
            ...entry,
            worktreePath: null,
            branch: null,
            provider: null,
            worktreeLeaseId: null,
            baseSha: null,
          }
        : entry,
    ),
  };
}

/** One tree's return-or-remove, provider-aware. See `teardownWorktree` for the policy. */
async function teardownOneWorktree(
  task: {
    taskId: string | null;
    position: number;
    repoRoot: string;
    worktreePath: string | null;
    branch: string | null;
    provider: WorktreeProvider | null;
    worktreeLeaseId: string | null;
  },
  legacy: LegacyTreehouseService,
  manager?: WorktreeManager,
): Promise<void> {
  if (!task.worktreePath) return;
  // Read once so every provider check and diagnostic names the same requested path.
  const worktreePath = task.worktreePath;

  if (task.provider === "mission") {
    if (!manager) throw new Error("native worktree manager is unavailable");
    if (!task.taskId || !task.worktreeLeaseId) {
      throw new Error("native task worktree is missing its task or lease identity");
    }
    const owner = { kind: "task" as const, key: `${task.taskId}:${task.position}` };
    const lookup = manager.lookupLease({
      leaseId: task.worktreeLeaseId,
      path: worktreePath,
      owner,
    });
    if (lookup.state === "missing" || lookup.state === "mismatch") {
      throw new Error(
        lookup.state === "missing"
          ? "native task lease is unknown"
          : `native task lease is stale: ${lookup.reason}`,
      );
    }
    const released = await manager.release(lookup.lease, { ownerAuthorized: true });
    if (released.outcome === "released" || released.outcome === "alreadyReleased") return;
    throw new Error(`native worktree release ${released.outcome}: ${released.reason}`);
  }

  if (task.provider === "treehouse") {
    if (!task.taskId) throw new Error(`legacy Treehouse task owner is missing for ${worktreePath}`);
    const returned = await legacy.executeReturn({
      kind: "task",
      id: task.taskId,
      position: task.position,
      path: worktreePath,
      leaseId: task.worktreeLeaseId,
    });
    if (returned.outcome !== "returned") {
      throw new Error(
        `legacy Treehouse cleanup refused for ${task.repoRoot} at ${worktreePath} ` +
          `(provider treehouse, lease ${task.worktreeLeaseId ?? "missing"}): ${returned.reason}`,
      );
    }
    return;
  }
  const removed = await run("git", ["-C", task.repoRoot, "worktree", "remove", "--force", task.worktreePath], {
    timeoutMs: 30000,
  });
  if (removed.code !== 0) {
    // Same budget as the dispatch preflight, and for the same reason: on the 4s default a
    // loaded machine turned "the tree is already gone, nothing to reclaim" into a spurious
    // reclaim failure. A non-zero `code` here already covers `outcomeUnknown` (a killed
    // child never exits 0), and both land on the safe side - re-raising git's real
    // complaint about the removal rather than swallowing it.
    const repo = await run("git", ["-C", task.repoRoot, "rev-parse", "--is-inside-work-tree"], {
      timeoutMs: GIT_PREFLIGHT_TIMEOUT_MS,
    });
    if (repo.code !== 0 || existsSync(task.worktreePath)) {
      throw new Error(`git worktree remove failed: ${removed.stderr.trim() || `exit ${removed.code}`}`);
    }
  }
  // Our git-fallback trees sit on a throwaway `harness/…` branch; drop it so a
  // retry of the same task can recreate it. Never touch a non-harness branch.
  if (task.branch && task.branch.startsWith("harness/")) {
    const deleted = await run("git", ["-C", task.repoRoot, "branch", "-D", task.branch], {
      timeoutMs: 15000,
    });
    if (deleted.code !== 0) {
      const exists = await run("git", ["-C", task.repoRoot, "show-ref", "--verify", `refs/heads/${task.branch}`]);
      if (exists.code === 0) {
        throw new Error(`git branch delete failed: ${deleted.stderr.trim() || `exit ${deleted.code}`}`);
      }
    }
  }
}

// ---- pure helpers (unit-tested) ----

/**
 * The repo manifest prepended to a multi-repo task's intent, or the intent unchanged.
 *
 * Everything here is something the agent cannot work out for itself from inside its cwd:
 *
 *  - **Where the other repos are.** Nothing in the primary worktree names them.
 *  - **Read each repo's own AGENTS.md/CLAUDE.md.** Only the primary's loads automatically -
 *    both harnesses resolve instruction files from the working directory, so a sibling
 *    checkout's conventions are invisible unless the agent goes and reads them.
 *  - **One pull request per repo you actually changed.** The default assumption is one
 *    branch, one pull request; without this an agent will commit across repos and open a
 *    single pull request in the one it happens to be standing in, leaving the rest of the
 *    work on unpushed local branches.
 *
 * Each repo's branch is stated PER REPO and read from what was actually provisioned. The
 * design's intent is one shared name across the set - that is what makes the resulting pull
 * requests legible as one task - and the Git fallback delivers it, while a native lease is
 * detached. Claiming a shared name a native repo does not have would send the agent to push
 * a branch that does not exist there, so the manifest reports the set it got and says plainly
 * when they differ.
 *
 * Repos with no worktree are omitted rather than listed as unavailable: this text is
 * delivered after provisioning, so an entry without one is a bug being reported to the
 * wrong audience.
 */
export function intentWithRepoManifest(task: Task, standingBlock = ""): string {
  const attached = task.extraRepos.filter((entry) => entry.worktreePath !== null);
  if (attached.length === 0) return withStandingInstructions(standingBlock, task.intent);
  const branchOf = (branch: string | null): string => (branch ? `, on branch ${branch}` : "");
  // Whether the whole set really did land on one branch name. The Git fallback cuts
  // `harness/<slug>-<shortId>` in every repo, while a native lease is detached. A mixed set
  // can therefore carry branch names and nulls, and this is read from what was provisioned -
  // a manifest that promised one shared branch would send the agent to push a branch that
  // does not exist in the secondary.
  const branches = [task.branch, ...attached.map((entry) => entry.branch)];
  const shared = task.branch !== null && branches.every((b) => b === task.branch)
    ? task.branch
    : null;
  const lines = [
    "## Repositories for this task",
    "",
    "This task spans several repositories. You have write access to all of them.",
    "",
    `- ${task.worktreePath ?? task.repoRoot} - PRIMARY (your working directory), from ${task.repoRoot}${branchOf(task.branch)}`,
    ...attached.map(
      (entry) => `- ${entry.worktreePath} - from ${entry.repoRoot}${branchOf(entry.branch)}`,
    ),
    "",
    ...(shared
      ? [`Every one of them is on the branch ${shared}.`, ""]
      : [
          "They are NOT all on the same branch - each repo's branch is listed above. Work on the",
          "branch each repo is already checked out on; do not assume one shared name.",
          "",
        ]),
    "Before you touch a repository, read its own AGENTS.md / CLAUDE.md - only the primary's",
    "loads automatically, so the others' conventions are invisible until you read them.",
    "",
    "Commit and push in each repository you change, and open ONE pull request per repository",
    "you actually changed. A repository you did not change needs no commit and no pull request.",
    "",
    "---",
    "",
  ];
  // Manifest, then standing instructions, then the intent - all three, in that order. The
  // manifest names the checkouts these rules are ABOUT, so putting the instructions above it
  // would invert the reason they are next to each other; putting them below the intent would
  // bury the operator's own words under server-owned prose.
  return `${lines.join("\n")}${withStandingInstructions(standingBlock, task.intent)}`;
}

/** A filesystem/git-safe slug from a task title - the branch and worktree name. */
export function slugify(title: string): string {
  const out = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return out || "task";
}

/**
 * A human-readable session name from a task title - what the card shows.
 *
 * Unlike `slugify` (which the git branch needs, so it is lowercase and hyphenated), this
 * keeps the title's spaces and capitals so the card reads like a heading rather than a slug.
 * What it STRIPS is the backend's business: the rules that used to live here were tmux's
 * target grammar written out a second time, half a file away from the rejection rules in
 * `validateSessionName` that were supposed to agree with them. They are one `NameRules` now,
 * declared by the adapter, and this asks the backend a dispatch would actually land on
 * (`homeNameRules`) rather than assuming which one that is.
 *
 * Still exported and still named for the session, because the composition it is half of -
 * `sessionLabel(deriveTitle(intent))` - is what an untitled dispatch is named by.
 */
export function sessionLabel(title: string): string {
  return homeNameRules().sanitize(title);
}

/**
 * A sensible default task title from the intent: its first non-empty line, title-cased
 * so a dispatch left untitled still names its card like a heading, capped at
 * `TITLE_MAX_CHARS` - the same bound the model tier clamps to, taken from the same
 * constant so the two tiers cannot drift apart.
 *
 * Keeps its own slice-based clamp rather than adopting `titleLine`'s word-boundary cut:
 * this is the fallback, and changing where it cuts is a behaviour change the model tier
 * does not need.
 */
export function deriveTitle(intent: string): string {
  return deriveTaskTitle(intent);
}

/**
 * Spawn the agent under a session name, closing the check-then-spawn race: if a concurrent
 * dispatch claimed the bare name between our listing and our spawn, retry once under the
 * always-unique `name-shortId`. Returns the name actually used.
 *
 * A backend that cannot be enumerated (`heldHomeNames` answering null) goes straight to the
 * unique name. "We could not ask" is not "the name is free" - taking the bare label on that
 * basis is how two dispatches end up sharing a home, which for a multiplexer means the second
 * agent's prompt is typed into the first agent's pane.
 *
 * Exported for the terminal handoff, which opens a home for a session that already exists:
 * the same race, the same rule, and no reason for a second spelling of it.
 */
export async function spawnUniquely(
  baseName: string,
  shortId: string,
  cwd: string,
  agentBin: string,
  agentArgs: readonly string[] = [],
): Promise<string> {
  const argv = [agentBin, ...agentArgs];
  const held = await heldHomeNames();
  const unique = `${baseName}-${shortId}`;
  const name = held === null || held.has(baseName) ? unique : baseName;

  const first = await launchHome({ name, cwd, argv, sidePane: true });
  if (first.ok) return name;
  if (name === unique) throw new Error(first.error);
  const retry = await launchHome({ name: unique, cwd, argv, sidePane: true });
  if (retry.ok) return unique;
  throw new Error(retry.error);
}

async function currentBranch(dir: string): Promise<string | null> {
  const r = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  const b = r.stdout.trim();
  return r.code === 0 && b && b !== "HEAD" ? b : null;
}

/**
 * Whether the binary a given agent would launch is resolvable on this machine.
 *
 * Exported for ensemble creation preflight, which refuses to persist a run whose members name a
 * harness that is not installed - the same resolution `dispatch` does at launch, asked once up
 * front so a whole roster fails visibly before any worktree is cut rather than one member at a time.
 */
export async function agentBinPresent(agent: AgentType): Promise<boolean> {
  return hasBin(resolveAgentBin(agent));
}
