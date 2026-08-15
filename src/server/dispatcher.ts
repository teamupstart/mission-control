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
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { innermostTerminalResourceId } from "@shared/pane.ts";
import { deriveTitle as deriveTaskTitle } from "@shared/title.ts";
import { WORKTREES_DIR, envVar } from "./config.ts";
import { resolveAgentBin } from "./harness/index.ts";
import { askChannelArgs } from "./ask-channel.ts";
import { injectPrompt } from "./actions.ts";
import { hooksFor } from "./harness/index.ts";
import {
  getHarnessesConfig,
  resolveDispatchEffort,
  resolveDispatchModel,
  resolveDispatchRuntime,
} from "./harnesses.ts";
import { harnessFor } from "./harness/index.ts";
import type { SdkSupervisor } from "./sdk/supervisor.ts";
import { poolAvailableFor, poolPins, reapPool, type PoolPins } from "./pool.ts";
import {
  acquireLease,
  defaultTreehouseCli,
  settleLease,
  withPoolLock,
  type TreehouseCli,
} from "./pool-lease.ts";
import { heldHomeNames, homeAlive, homeNameRules, killHome, launchHome } from "./terminal/home.ts";
import type { Registry } from "./registry.ts";
import { resetWorktreeToCommit, verifyHeadIs } from "./git/ensemble-snapshot.ts";
import {
  kindMissionMcpRequirement,
  missionMcpDescriptor,
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
import { hasBin, resolveBinPath, run, type RunResult } from "./util/exec.ts";
import { mainRepoRoot } from "./util/git.ts";
import { sleep } from "./util/timers.ts";
import { prepareCodexLaunch } from "./harness/codex/launch.ts";
import { preparePiLaunch } from "./harness/pi/launch.ts";

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
 * Every step patches the task through the registry so progress streams to the UI
 * over SSE. `dispatch` never throws - a failure lands the task in `failed` with a
 * human-readable reason rather than crashing the daemon.
 */
export class Dispatcher {
  constructor(
    private registry: Registry,
    private teardown: typeof teardownWorktree = teardownWorktree,
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
      resolveRuntime?: typeof resolveDispatchRuntime;
    } = {},
  ) {}

  async dispatch(taskId: string, options: TaskDispatchOptions = {}): Promise<void> {
    const task = this.registry.getTask(taskId);
    if (!task) return;
    // Clear any stale error from a prior failed attempt so a retry starts honest.
    this.patch(taskId, {
      status: "dispatching",
      error: null,
      dispatchedAt: task.dispatchedAt ?? Date.now(),
    });

    try {
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
      const { primary: wt, extras } = await this.provisionAll(task, taskId, slug, shortId, baseSha);
      // Record every worktree BEFORE spawning, so a spawn failure can still tear them down.
      // The collection lands in the SAME patch as the primary's triple: `poolPins` reads
      // the task row, so a secondary recorded a moment later would be unpinned in between -
      // and an unpinned tree is one the reaper may hard-reset.
      this.patch(taskId, {
        worktreePath: wt.path,
        branch: wt.branch,
        provider: wt.provider,
        baseSha: wt.baseSha,
        extraRepos: extras,
      });
      // The task now names these trees, so `PoolPins.taskWorktrees` speaks for them and the
      // acquisition no longer has to. Handed over immediately after the record lands, which
      // is the moment the reaper can see it - see `settleLease`.
      settleLease(wt.path);
      for (const entry of extras) if (entry.worktreePath) settleLease(entry.worktreePath);
      if (await this.abortIfSettled(taskId)) return;

      // The task as it now stands, since `task` is the snapshot taken before any of this
      // was provisioned. Both the manifest and the write-access grant describe worktrees,
      // so both have to read the provisioned shape rather than the backlog row.
      const provisioned: Task = {
        ...task,
        worktreePath: wt.path,
        branch: wt.branch,
        provider: wt.provider,
        baseSha: wt.baseSha,
        extraRepos: extras,
      };
      // The repo manifest is a PREFIX (context the agent needs before the request) and the
      // kind's contract is a SUFFIX (what "delivered" means once it has read it), so the
      // operator's own words are never buried and the ordering is the same on both delivery
      // seams. A ship task passes through `withTaskKindContract` unchanged, which is what
      // keeps its intent bytes identical to what they were.
      const intent = withTaskKindContract(provisioned, intentWithRepoManifest(provisioned), {
        planSkills: planSkills?.ok ? planSkills.commands : null,
      });
      // Which of OUR tools this launch has to be able to call. A scout ALWAYS has to be able
      // to submit its report and a plan ALWAYS has to be able to ask its human and file the
      // phases it schedules, so the requirement is unioned in here rather than left to
      // whichever caller happened to dispatch it. A ship task is unaffected:
      // `kindMissionMcpRequirement` returns the caller's requirement untouched, `null`
      // included.
      const missionMcp = kindMissionMcpRequirement(task, options.missionMcp ?? null);
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
      const model = resolveDispatchModel(task.agent, task.model, options.defaultModel ?? null);
      const effort = resolveDispatchEffort(task.agent, task.effort);
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
      const piLaunch = task.agent === "pi"
        ? preparePiLaunch(withRepoMemoryPointer(wt.path, intent))
        : { args: [] as string[], sessionId: null };
      const askArgs = await askChannelArgs(task.agent, missionMcp);
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
      const missionMcpRegistered = codexLaunch.missionMcp || askArgs.includes("--mcp-config");
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

      const homeName = await spawnUniquely(label, shortId, wt.path, agentBin, agentArgs);
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
        try {
          await this.deliverIntent(deliverySession.id, intent, wt.path, instrumented);
        } catch (err) {
          // A boundary with no delivery behind it claims the agent saw a task it never
          // received, and a later capture would anchor into a conversation that never
          // started. Discard it before the failure propagates.
          discardScoutPromptBoundary(boundary);
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
                ? `${message} - its session and worktree were kept; open or Cancel it`
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
      model,
      effort,
      permissionMode: dispatchPermissionMode(task.agent),
      mcp,
      extraDirs,
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
    this.patch(taskId, { status: "running", sessionId: session.id });
    // Both orders are covered on purpose. If the driver has already bound, the episode
    // exists and this binds it; if it has not, `applyDriverBinding` binds it when it does,
    // because the task now records this session id. Neither can be relied on alone.
    this.registry.bindTaskToWorkEpisode(taskId, session.id);
    // AFTER the start rather than before it, because on this runtime the prompt IS the
    // start: there is no session to measure a boundary against until the driver has one.
    // The anchor is `launch` for the same reason - turn one travelled with the process, so
    // every byte the transcript will ever hold belongs to this episode.
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
   * for its first - a pool lease, most likely - and nothing downstream would ever tear that
   * down: the dispatch throws before any of it reaches the task row, so teardown and
   * startup reconciliation, which both read the row, cannot see it. The pool would simply
   * lose a slot per failed dispatch.
   *
   * Unwinding is provider-aware because `teardownWorktree` is: a treehouse lease is
   * RETURNED (never git-removed, which would delete a pooled tree the pool still believes
   * it owns) and a git fallback tree is removed with its `harness/` branch. Mixed providers
   * across one task are ordinary - a treehouse repo takes a lease while a plain repo does
   * not - so both orderings unwind correctly.
   *
   * A failure during the unwind is logged, never thrown: the caller is already failing, and
   * replacing the cause with a cleanup error would hide the thing that actually went wrong.
   */
  private async provisionAll(
    task: Task,
    taskId: string,
    slug: string,
    shortId: string,
    baseSha: string | null,
  ): Promise<{ primary: ProvisionedWorktree; extras: TaskRepoEntry[] }> {
    const pins = () => poolPins(this.registry);
    const primary = await provisionWorktree(task.repoRoot, taskId, slug, shortId, pins, baseSha, 0);
    const taken: Array<{ repoRoot: string; wt: ProvisionedWorktree }> = [
      { repoRoot: task.repoRoot, wt: primary },
    ];
    const extras: TaskRepoEntry[] = [];
    try {
      for (const [index, entry] of task.extraRepos.entries()) {
        // Slot is the entry's position in `task_repos`, offset by one for the primary at
        // slot 0. `baseSha` pins the PRIMARY's repo and means nothing in another one, so a
        // secondary is cut from its own HEAD and records where that landed.
        const wt = await provisionWorktree(
          entry.repoRoot,
          taskId,
          slug,
          shortId,
          pins,
          null,
          index + 1,
        );
        taken.push({ repoRoot: entry.repoRoot, wt });
        extras.push({
          ...entry,
          worktreePath: wt.path,
          branch: wt.branch,
          provider: wt.provider,
          baseSha: wt.baseSha,
        });
      }
    } catch (err) {
      for (const { repoRoot, wt } of taken) {
        await this.teardown({
          repoRoot,
          worktreePath: wt.path,
          branch: wt.branch,
          provider: wt.provider,
          // No terminal home exists yet - nothing has been spawned at this point.
          homeName: null,
        }).catch((cleanupError: unknown) => {
          console.error(
            `[mission-control] could not unwind ${wt.path} after a failed multi-repo ` +
              `provision: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        });
        settleLease(wt.path);
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
      // leave `poolPins` sparing trees that are already back in their pools.
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
  }
}

// ---- worktree provisioning ----

export interface ProvisionedWorktree {
  path: string; // realpath, so it matches a pane's reported cwd exactly
  branch: string | null;
  provider: "treehouse" | "git";
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
 * Point a leased pool worktree at one exact commit, or refuse to touch it.
 *
 * The ownership check is not paranoia about treehouse - it is the guard on a HARD RESET.
 * `reset --hard` plus a clean is destructive by design, and the one thing that makes it
 * safe is that the tree belongs to the repository whose commit we are about to force it
 * to. A lease from a pool we could not prove is this repo's would be somebody else's
 * checkout, and the reset would land in it.
 *
 * Exported because the pool binary is not a test dependency: `provisionWorktree` only
 * reaches this arm on a machine with treehouse installed and a `treehouse.toml` repo, so
 * the behaviour is exercised here directly against a real linked worktree instead.
 */
export async function pinLeasedWorktree(
  repoRoot: string,
  leasePath: string,
  baseSha: string,
): Promise<void> {
  const owner = mainRepoRoot(leasePath);
  const asked = mainRepoRoot(repoRoot) ?? realpathSync(repoRoot);
  if (!owner || owner !== asked) {
    throw new Error(
      `the pooled worktree ${leasePath} belongs to ${owner ?? "no repository we can name"}, not ${asked} - ` +
        "refusing to reset a checkout we cannot prove is this repository's",
    );
  }
  await resetWorktreeToCommit(leasePath, baseSha);
}

/**
 * Give a task its own isolated tree. Repos that opted into treehouse (a
 * `treehouse.toml` at the root) get a pre-warmed pooled worktree; everything else
 * gets a plain `git worktree` on a fresh `harness/<slug>` branch. Either way the
 * agent never shares a working tree with another session - the whole reason this
 * harness exists.
 *
 * `baseSha` pins the tree's starting point. Absent - which is every ordinary dispatch -
 * nothing about this function changes: the git fallback still cuts from `HEAD` and a pool
 * lease is still taken as it comes. Present, both providers converge on that ONE commit and
 * then re-read `HEAD` to prove they did, because a member that silently started somewhere
 * else is not comparable with its siblings and nothing downstream could tell.
 */
export async function provisionWorktree(
  repoRoot: string,
  taskId: string,
  slug: string,
  shortId: string,
  /**
   * What the harness is already holding, so a reap here can't evict a tree that is
   * someone else's. Read as a callback rather than a snapshot because the lease
   * attempt below can block for minutes: a concurrent dispatch that leases the last
   * tree in that window records its worktree on its task, and only a reading taken
   * AT the reap can see it.
   *
   * Required, with no empty default: this function can reach a forced return, and
   * an empty spared set silently disarms the two rungs that carry that gate - a
   * just-pushed agent's tree is clean, merged, and momentarily processless, so
   * treehouse's process list alone would not save it. Better a caller that won't
   * compile than one that reaps by omission.
   */
  pins: () => PoolPins,
  /** The exact commit the tree must start at, verified by `verifyPinnedBase` already. */
  baseSha: string | null = null,
  /**
   * Which of the task's repos this is: 0 is the primary, n > 0 the nth attached secondary.
   *
   * It exists to make the git-fallback DESTINATION unique. That path was keyed on the task
   * alone, so a task attaching two non-pool repositories provisioned the first and then ran
   * `git worktree add` against a directory that already existed. Keyed on the slot rather
   * than on the repo's basename because two attached repos can share one (`~/a/api` and
   * `~/b/api`), while the slot is unique by construction and persisted as the entry's
   * `position`, so the path stays stable across restarts.
   *
   * Defaulted to 0, whose destination is byte-identical to what it always was - single-repo
   * dispatch, existing tasks and startup reconciliation are untouched. The pool arm ignores
   * it entirely: those paths come from each repo's own pool and are already distinct.
   */
  slot = 0,
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

  // The gate is no longer spelled here. Both halves live in `pool.ts` beside
  // `isTreehouseRepo`, because this used to be the ONLY place in the codebase that asked
  // whether the pool is usable - and the Workflow check path, which needs the same answer,
  // therefore never asked it at all. A check asks the binary half alone
  // (`treehouseInstalled`); this is the full gate, opt-in included.
  if (await poolAvailableFor(repoRoot)) {
    // Each acquisition takes the pool lock on its own rather than one held across the
    // whole arm: `reapPool` below takes the same lock per candidate, and this lock is
    // deliberately not reentrant, so holding it here would deadlock against the reap that
    // is this branch's whole recovery strategy.
    let lease = await withPoolLock(repoRoot, () => acquireLease(repoRoot));
    // A dry pool is usually a LEAKED pool: leases are durable, so every agent that
    // went away without returning its tree still holds a slot, and at `max_trees`
    // the pool has nothing left to give. Collect those and ask once more - the
    // alternative (below) is silently abandoning the pool for this dispatch.
    if (!lease.path) {
      const { reaped } = await reapPool(repoRoot, pins);
      if (reaped.length > 0) {
        console.log(
          `[mission-control] pool was dry; returned ${reaped.length} leaked lease(s): ${reaped
            .map((t) => t.name)
            .join(", ")}`,
        );
        lease = await withPoolLock(repoRoot, () => acquireLease(repoRoot));
      }
    }
    if (lease.path !== null) {
      const path = realpathSync(lease.path);
      if (baseSha) {
        try {
          await pinLeasedWorktree(repoRoot, path, baseSha);
          // Asserted again HERE, and not only inside the reset, so both arms of this
          // function make the same promise in the same place - the guarantee belongs to
          // provisioning rather than to whatever a helper happens to check today.
          await verifyHeadIs(path, baseSha);
        } catch (err) {
          // The lease is LIVE and this function is about to throw, so nothing downstream
          // will ever record this tree on a task - which means teardown will never see it
          // and the pool loses a slot permanently. Hand it back here, while we still know
          // it is ours and nothing has been launched into it. A return that itself fails is
          // reported alongside the real cause rather than replacing it.
          const returned = await withPoolLock(repoRoot, () => returnLease(path));
          // Whether or not the return succeeded, this dispatch is done with the tree, so it
          // must stop claiming to be provisioning it. A return that failed leaves a leaked
          // lease for the sweep to collect later, which it cannot do while we hold it.
          settleLease(path);
          const cause = err instanceof Error ? err.message : String(err);
          throw new Error(
            returned.code === 0
              ? cause
              : `${cause} - and the pool lease could not be returned: ${returned.stderr.trim() || `exit ${returned.code}`}`,
          );
        }
      }
      return {
        path,
        // Whatever the leased tree is standing on - a pool lease is not given a branch of
        // our choosing, and it is not renamed here. That is why a multi-repo task's branch
        // names are read back from the provisioned entries rather than assumed to be the
        // git fallback's `harness/<slug>-<shortId>`; see `intentWithRepoManifest`.
        branch: await currentBranch(path),
        provider: "treehouse",
        baseSha: baseSha ?? (await headCommit(path)),
      };
    }
    // Fall through to a plain worktree - but say so. This used to be silent, which
    // hid a full pool behind trees that merely looked unfamiliar; the fallback is a
    // throwaway checkout with none of the pool's pre-warming.
    //
    // Report what we OBSERVED, not what we assume: a full pool is the likely cause
    // and the reason we just tried to reap, but `get` fails the same shape for an
    // unresolvable pool or a bad config, and telling someone their pool is full
    // sends them to a `treehouse status` that will look perfectly healthy. So the
    // failure names itself and treehouse's own words ride along verbatim.
    const { what, stderr } = lease.failure;
    console.warn(
      `[mission-control] treehouse pool in ${repoRoot} could not hand over a worktree: ${what}` +
        (stderr ? ` - treehouse said: ${stderr}` : "") +
        ` - falling back to a throwaway git worktree. Inspect the pool with: treehouse status`,
    );
  }

  mkdirSync(WORKTREES_DIR, { recursive: true });
  const path = worktreeSlotPath(taskId, slot);
  // Deliberately the SAME branch name in every repo the task touches. They live in
  // different repositories, so they cannot collide, and one name across the set is what
  // makes the resulting pull requests legible as one piece of work.
  //
  // This arm is the only one that can promise it. The pool arm above reports the branch its
  // LEASE came on and does not rename it - renaming there would change what a single-repo
  // pooled dispatch does, which this phase leaves untouched - so a set mixing the two can
  // hold two names. `intentWithRepoManifest` reads the provisioned branches rather than
  // assuming this one, and says so when they differ.
  const branch = `harness/${slug}-${shortId}`;
  const add = await run(
    "git",
    ["-C", repoRoot, "worktree", "add", path, "-b", branch, baseSha ?? "HEAD"],
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
  return { path: real, branch, provider: "git", baseSha: baseSha ?? (await headCommit(real)) };
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
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Hand a pooled worktree back to the pool - dispatch's one spelling of that command, shared
 * by ordinary teardown and by a pinned provisioning that has to unwind a lease it just took.
 *
 * **Unforced, deliberately, and this is not the same command the reaper runs.** Dispatch is
 * returning a tree it believes is idle and whose agent it has just closed, so it can afford
 * to be told "no" by a treehouse that disagrees; the reaper and the check reclaimer are
 * returning trees they believe are ABANDONED, from a poller with no stdin, so they pass
 * `--force` ("clean, reset, and return without prompting"). Collapsing the two spellings
 * onto whichever is read first is a silent behaviour change to dispatch teardown in one
 * direction and a hang in the other, so `force` is an argument the adapter makes every
 * caller answer. `cwd` stays unset here for the same reason: it is what this path has always
 * done, and treehouse resolves the pool from the path argument.
 *
 * The argv itself lives in `pool-lease.ts`. What lives here is the policy.
 */
function returnLease(path: string, cli: TreehouseCli = defaultTreehouseCli): Promise<RunResult> {
  return cli.return({ cwd: null, path, force: false });
}

/**
 * Tear down a task's live resources (best-effort): close the terminal home it was
 * dispatched into and return/remove its worktree + throwaway branch. Provider-aware so a
 * treehouse lease is handed back to the pool rather than leaked by a bare
 * `git worktree remove`.
 *
 * `homeName` names the home vendor-neutrally: which backend holds that name is resolved
 * through the registry (`killHome`) rather than assumed here.
 */
export async function teardownWorktree(
  task: {
    repoRoot: string;
    worktreePath: string | null;
    branch: string | null;
    provider: WorktreeProvider | null;
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
    }[];
  },
  /**
   * The pool CLI, injectable for one reason: dispatch teardown must keep returning a tree
   * WITHOUT `--force` now that the argv is shared with two callers that do force it, and
   * that is only provable by watching what this function actually asks for.
   */
  cli: TreehouseCli = defaultTreehouseCli,
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
  // remaining trees leased or on disk with nothing left that will ever come back for them -
  // the caller nulls the whole collection on the row either way.
  //
  // A single-repo task has no extras, so this is one entry and one error message, exactly
  // as it was before.
  const trees = [
    { repoRoot: task.repoRoot, worktreePath: task.worktreePath, branch: task.branch, provider: task.provider },
    ...(task.extraRepos ?? []).map((entry) => ({
      repoRoot: entry.repoRoot,
      worktreePath: entry.worktreePath,
      branch: entry.branch,
      provider: entry.provider,
    })),
  ];
  const failures: string[] = [];
  const reclaimed: string[] = [];
  for (const tree of trees) {
    await teardownOneWorktree(tree, cli).then(
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
 * the row claiming trees that are already gone: `poolPins` would go on sparing them, and a
 * retry would re-issue a lease return against a tree the pool has already taken back.
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
  task: Pick<Task, "worktreePath" | "branch" | "provider" | "baseSha" | "extraRepos">,
  reclaimed: readonly string[] | null,
): Pick<Task, "worktreePath" | "branch" | "provider" | "baseSha" | "extraRepos"> {
  // A tree with no recorded path has nothing to reclaim and nothing to keep.
  const gone = (path: string | null): boolean =>
    path === null || reclaimed === null || reclaimed.includes(path);
  return {
    worktreePath: gone(task.worktreePath) ? null : task.worktreePath,
    branch: gone(task.worktreePath) ? null : task.branch,
    provider: gone(task.worktreePath) ? null : task.provider,
    // The primary's baseline is a fact about the primary's tree, so it goes with it.
    baseSha: gone(task.worktreePath) ? null : task.baseSha,
    extraRepos: task.extraRepos.map((entry) =>
      gone(entry.worktreePath)
        ? { ...entry, worktreePath: null, branch: null, provider: null, baseSha: null }
        : entry,
    ),
  };
}

/** One tree's return-or-remove, provider-aware. See `teardownWorktree` for the policy. */
async function teardownOneWorktree(
  task: {
    repoRoot: string;
    worktreePath: string | null;
    branch: string | null;
    provider: WorktreeProvider | null;
  },
  cli: TreehouseCli,
): Promise<void> {
  if (!task.worktreePath) return;
  // Read once, so the return below keeps its narrowing inside the closure the pool lock
  // wraps it in.
  const worktreePath = task.worktreePath;

  if (task.provider === "treehouse") {
    // Hand the lease back to the pool. Never fall back to `git worktree remove` for
    // a pooled checkout - that would delete a tree behind treehouse's bookkeeping
    // and leak the lease. If return fails, leave it for the pool to reconcile.
    const returned = await withPoolLock(task.repoRoot, () => returnLease(worktreePath, cli));
    if (returned.code !== 0) {
      throw new Error(`treehouse return failed: ${returned.stderr.trim() || `exit ${returned.code}`}`);
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
 * requests legible as one task - and the git fallback delivers it, but a treehouse-pooled
 * repo arrives on whatever branch its lease was already on. Claiming a shared name the
 * secondary does not have would send the agent to push a branch that does not exist there,
 * so the manifest reports the set it got and says plainly when they differ.
 *
 * Repos with no worktree are omitted rather than listed as unavailable: this text is
 * delivered after provisioning, so an entry without one is a bug being reported to the
 * wrong audience.
 */
export function intentWithRepoManifest(task: Task): string {
  const attached = task.extraRepos.filter((entry) => entry.worktreePath !== null);
  if (attached.length === 0) return task.intent;
  const branchOf = (branch: string | null): string => (branch ? `, on branch ${branch}` : "");
  // Whether the whole set really did land on one branch name. The git fallback cuts
  // `harness/<slug>-<shortId>` in every repo, but a treehouse-pooled repo does NOT: its
  // lease arrives on whatever branch the pooled tree was already standing on, and nothing
  // in provisioning renames it (doing so would change single-repo pooled dispatch, which
  // this phase leaves byte-identical). So a mixed set can genuinely hold two names, and
  // this is READ from what was provisioned rather than asserted from the design's intent -
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
  return `${lines.join("\n")}${task.intent}`;
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
