import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AgentType, Session, Task, WorktreeProvider } from "@shared/types.ts";
import { innermostTerminalResourceId } from "@shared/pane.ts";
import { TITLE_MAX_CHARS } from "@shared/title.ts";
import { WORKTREES_DIR, envVar } from "./config.ts";
import { resolveAgentBin } from "./harness/index.ts";
import { askChannelArgs } from "./ask-channel.ts";
import { injectPrompt, setPermissionMode } from "./actions.ts";
import { hooksFor } from "./harness/index.ts";
import { getHarnessesConfig, resolveDispatchEffort, resolveDispatchModel } from "./harnesses.ts";
import { harnessFor } from "./harness/index.ts";
import { isTreehouseRepo, LEASE_HOLDER, poolPins, reapPool, type PoolPins } from "./pool.ts";
import { heldHomeNames, homeAlive, homeNameRules, killHome, launchHome } from "./terminal/home.ts";
import type { Registry } from "./registry.ts";
import { resetWorktreeToCommit, verifyHeadIs } from "./git/ensemble-snapshot.ts";
import type { MissionMcpRequirement } from "./mission-mcp.ts";
import { run } from "./util/exec.ts";
import { mainRepoRoot } from "./util/git.ts";
import { sleep } from "./util/timers.ts";
import { prepareCodexLaunch } from "./harness/codex/launch.ts";
import {
  piPromptBaseline,
  preparePiLaunch,
  waitForPiLaunchReady,
  waitForPiPromptAccepted,
} from "./harness/pi/launch.ts";

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
 * Turns a task into a live agent: provision an isolated worktree, launch the
 * agent in a detached terminal home there, wait for passive discovery and readiness to
 * bind that exact live session, then inject the task as its first prompt.
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
      waitForPiReady?: typeof waitForPiLaunchReady;
      waitForPiAcceptance?: typeof waitForPiPromptAccepted;
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

      const wt = await provisionWorktree(
        task.repoRoot,
        taskId,
        slug,
        shortId,
        () => poolPins(this.registry),
        baseSha,
      );
      // Record the worktree BEFORE spawning, so a spawn failure can still tear it down.
      this.patch(taskId, { worktreePath: wt.path, branch: wt.branch, provider: wt.provider });
      if (await this.abortIfSettled(taskId)) return;

      // Resolved here, not at task creation: a backlogged task launches on the defaults
      // in force NOW. Both CLIs spell the model flag `--model <id>`; effort syntax comes
      // from the harness registry. Null means let the harness's own configuration decide.
      const model = resolveDispatchModel(task.agent, task.model);
      const effort = resolveDispatchEffort(task.agent, task.effort);
      const effortArgs = effort ? (harnessFor(task.agent).effort?.launchArgs(effort) ?? []) : [];
      // Which of OUR tools this launch has to be able to call, if the caller said. Passed to
      // each harness's launch builder as a requirement, never as flags - see `mission-mcp.ts`.
      const missionMcp = options.missionMcp ?? null;
      // The ask channel rides along on every dispatch: it takes Claude's built-in
      // `AskUserQuestion` away and hands the agent our blocking `request_input` instead, so
      // a clarifying question arrives as structured arguments in the dashboard rather than
      // as a menu we read off the child's screen. Scoped to dispatch for the same reason
      // `applyAutoMode` is - we only reconfigure agents WE launched, never one the operator
      // started and we merely discovered. It returns nothing rather than half its flags on
      // ANY failure - a missing bundle, an unwritable state dir - and never throws, so it
      // cannot sink a dispatch that is otherwise fine; see `askChannelArgs`.
      const codexLaunch = task.agent === "codex"
        ? await prepareCodexLaunch(getHarnessesConfig().autoModeOnDispatch, missionMcp)
        : { args: [] as string[], instrumented: true, missionMcp: false };
      const piLaunch = task.agent === "pi"
        ? preparePiLaunch()
        : { args: [] as string[], sessionId: null };
      const askArgs = await askChannelArgs(task.agent, missionMcp);
      const agentArgs = [
        ...(model ? ["--model", model] : []),
        ...effortArgs,
        ...askArgs,
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

      const homeName = await spawnUniquely(label, shortId, wt.path, agentBin, agentArgs);
      this.patch(taskId, { homeName });
      if (await this.abortIfSettled(taskId)) return;

      const discovered = await this.registry.waitForSessionAtCwd(wt.path, READY_TIMEOUT_MS);
      if (!discovered) {
        throw new Error("agent session never appeared (the launch may have exited immediately)");
      }
      this.patch(taskId, { terminalResourceId: innermostTerminalResourceId(discovered) });
      if (await this.abortIfSettled(taskId)) return;

      // Discovery only proves the process exists. Wait for the agent to prove it can
      // READ before typing at it - see `awaitReady`.
      const ready = await this.awaitReady(
        wt.path,
        discovered,
        codexLaunch.instrumented,
        piLaunch.sessionId,
      );
      const session = piLaunch.sessionId
        ? this.registry.bindLaunchedAgentSession(ready.session.id, task.agent, piLaunch.sessionId)
        : ready.session;
      if (!session) throw new Error("agent session changed before its launch identity was recorded");
      const { instrumented, piTranscriptPath } = ready;
      const readyResourceId = innermostTerminalResourceId(session);
      if (readyResourceId) this.patch(taskId, { terminalResourceId: readyResourceId });
      if (await this.abortIfSettled(taskId)) return;

      // Set the mode BEFORE the first prompt, so the task runs in it from the start -
      // see `applyAutoMode`.
      await this.applyAutoMode(this.requireLiveSession(session.id), task.agent);
      if (await this.abortIfSettled(taskId)) return;

      // Mode selection takes terminal I/O and can race the process exiting. Re-read at
      // the actual send boundary so a lingered session cannot type into its dead pane.
      const deliverySession = this.requireLiveSession(session.id);
      await this.deliverIntent(
        deliverySession.id,
        task.intent,
        wt.path,
        instrumented,
        piTranscriptPath,
      );

      if (await this.abortIfSettled(taskId)) return;
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
      const alive = cur.homeName ? await homeAlive(cur.homeName) : false;
      if (alive !== false) {
        this.patch(taskId, {
          status: "failed",
          error:
            alive === true
              ? `${message} - its terminal home and worktree were kept; Focus or Cancel it`
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
   * Wait for the agent to be able to READ the prompt we're about to type.
   *
   * Discovery is a `ps` sweep: it fires when the binary is exec'd, seconds before any
   * TUI exists. A hook-capable launch proves readiness with its first hook. A pi launch
   * proves it when the file for its injected session id appears. The result keeps hook
   * instrumentation separate from pi's transcript path because prompt acceptance uses
   * different evidence after the send.
   *
   * The fallback is deliberate. An agent whose hooks aren't installed will never satisfy
   * this, and refusing to dispatch to it would be a regression, so a timeout degrades
   * to the old fixed sleep - the pre-existing best-effort behaviour, now confined to
   * the only case that has no better option instead of applying to everything.
   *
   * "Aren't installed" and "don't exist" are different, though, and only the first is
   * worth waiting out. A harness that declares no `hooks` and no launch-scoped readiness
   * signal takes the fallback immediately. Ask the registry rather than the session for
   * hook capability; pi's exact file is launch data supplied separately.
   */
  private async awaitReady(
    cwd: string,
    discovered: Session,
    hooksPrepared = true,
    piSessionId: string | null = null,
  ): Promise<{ session: Session; instrumented: boolean; piTranscriptPath: string | null }> {
    if (piSessionId) {
      this.requireLiveSession(discovered.id);
      const path = await (this.deps.waitForPiReady ?? waitForPiLaunchReady)(
        cwd,
        piSessionId,
        HOOK_READY_MS,
        SETTLE_MS,
        {
          isLive: () => {
            const current = this.registry.getSession(discovered.id);
            return !!current && current.state !== "exited";
          },
        },
      );
      if (!path) {
        this.requireLiveSession(discovered.id);
        throw new Error("pi session file never appeared before the initial prompt");
      }
      return {
        session: this.requireLiveSession(discovered.id),
        instrumented: false,
        piTranscriptPath: path,
      };
    }
    if (hooksPrepared && hooksFor(discovered.agent)) {
      const ready = await this.registry.waitForReadySessionAtCwd(
        cwd,
        discovered.id,
        HOOK_READY_MS,
      );
      if (ready) return { session: ready, instrumented: true, piTranscriptPath: null };
    }
    // A null readiness result means either hook silence or an observed exit. Preserve
    // the fallback settle only for a live-but-silent session; an exited one has no TUI
    // left to settle and must fail immediately.
    this.requireLiveSession(discovered.id);
    await sleep(SETTLE_MS);
    // Re-read: `discovered` is a snapshot from before the wait, and its pane may have
    // been filled in since. Typing needs the freshest pane we have.
    return {
      session: this.requireLiveSession(discovered.id),
      instrumented: false,
      piTranscriptPath: null,
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
   * When the "auto mode on dispatch" harness setting is on, drive a freshly-ready
   * session to its harness's autonomous mode before the first prompt lands, so the whole
   * task runs without pausing on permission prompts.
   *
   * Scoped to the dispatch path on purpose: this only ever touches sessions the
   * harness launched, never one the operator started themselves and the harness
   * merely discovered - the contract the setting promises.
   *
   * `permissionModes.onDispatch` rather than a literal `"auto"`, and null is the whole
   * answer for a harness with no autonomous mode to arm: it is skipped, silently and
   * correctly, instead of the setting quietly meaning something different per agent.
   *
   * Best-effort by design. `setPermissionMode` walks the Shift+Tab cycle, which can
   * legitimately fall short - `auto` isn't enabled for every account, and a dialog
   * over the mode line makes it unreadable (though a fresh, pre-prompt Claude has
   * neither) - and none of that should sink a dispatch that otherwise launched
   * cleanly: the agent simply stays in whatever mode it booted in.
   */
  private async applyAutoMode(session: Session, agent: AgentType): Promise<void> {
    const mode = harnessFor(agent).permissionModes?.onDispatch;
    if (!mode) return;
    if (!getHarnessesConfig().autoModeOnDispatch) return;
    const r = await setPermissionMode(session, mode);
    if (!r.ok) {
      console.warn(
        `[mission-control] could not put dispatched session ${session.id} into ${mode} mode: ` +
          `${r.error ?? "unknown"} - it will run in its default mode`,
      );
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
   * `working` transition only `UserPromptSubmit` can produce; pi waits for a user turn
   * appended after the transcript byte boundary captured before delivery.
   *
   * The retry is gated on positive evidence: a hooked session is STILL idle, or pi's
   * exact transcript still has no new user turn. It is not free: if the paste reached
   * the input box but the Enter did not, a second paste concatenates onto the first and
   * the agent reads its intent twice over. That is the accepted cost - a
   * garbled-but-visible prompt a human can fix beats a session that sits empty and calls
   * itself `running`, and if neither attempt takes, the task now FAILS loudly instead of
   * lying.
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
    piTranscriptPath: string | null = null,
  ): Promise<void> {
    const piOffset = piTranscriptPath ? piPromptBaseline(piTranscriptPath) : null;
    if (piTranscriptPath && piOffset === null) {
      throw new Error("pi transcript disappeared before the initial prompt could be sent");
    }

    for (let attempt = 1; ; attempt++) {
      // Preflight before subscribing. If the process already exited, there will be no
      // prompt acknowledgement and no reason to retain a listener until its timeout.
      const session = this.requireLiveSession(sessionId);

      // Listen BEFORE typing - the hook can land before the next line runs.
      const acceptanceAbort = instrumented && !piTranscriptPath ? new AbortController() : null;
      const accepted = instrumented && !piTranscriptPath
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
      if (piTranscriptPath) {
        const piAccepted = await (
          this.deps.waitForPiAcceptance ?? waitForPiPromptAccepted
        )(piTranscriptPath, piOffset!, ACCEPT_MS, {
          isLive: () => {
            const current = this.registry.getSession(sessionId);
            return !!current && current.state !== "exited";
          },
        });
        if (piAccepted) return;
        this.requireLiveSession(sessionId);
        if (attempt >= 2) {
          throw new Error(
            "the agent never acknowledged the initial prompt (it was typed but not ingested)",
          );
        }
        continue;
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

  private async teardownTaskResources(
    taskId: string,
    task: Task,
    baseError: string | null,
  ): Promise<boolean> {
    try {
      await this.teardown(task);
      this.patch(taskId, {
        worktreePath: null,
        branch: null,
        provider: null,
        homeName: null,
        terminalResourceId: null,
      });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.patch(taskId, {
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
  const r = await run("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${baseSha}^{commit}`]);
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
): Promise<ProvisionedWorktree> {
  const check = await run("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"]);
  if (check.code !== 0 || check.stdout.trim() !== "true") {
    throw new Error(`${repoRoot} is not a git repository`);
  }

  if ((await hasBin("treehouse")) && isTreehouseRepo(repoRoot)) {
    let lease = await leaseFromPool(repoRoot);
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
        lease = await leaseFromPool(repoRoot);
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
          const returned = await returnLease(path);
          const cause = err instanceof Error ? err.message : String(err);
          throw new Error(
            returned.code === 0
              ? cause
              : `${cause} - and the pool lease could not be returned: ${returned.stderr.trim() || `exit ${returned.code}`}`,
          );
        }
      }
      return { path, branch: await currentBranch(path), provider: "treehouse" };
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
  const path = join(WORKTREES_DIR, taskId);
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
  return { path: real, branch, provider: "git" };
}

/**
 * Hand a pooled worktree back to the pool - the one spelling of that command, shared by
 * ordinary teardown and by a pinned provisioning that has to unwind a lease it just took.
 */
function returnLease(path: string): ReturnType<typeof run> {
  return run("treehouse", ["return", path], { timeoutMs: 30000 });
}

/**
 * Why the pool didn't hand a tree over. Carried rather than collapsed to null,
 * because the three ways `get` can fail look identical to the caller and mean
 * completely different things - a dry pool is routine and reaping may fix it, a
 * broken binary or an unreadable pool never will. `stderr` is treehouse's own
 * account: `get --help` promises stdout carries the path ALONE and every banner
 * and error goes to stderr, so it is the only channel a cause we never
 * anticipated can arrive on, and it is quoted rather than interpreted.
 */
interface LeaseFailure {
  what: string;
  stderr: string;
}

type LeaseAttempt = { path: string; failure?: undefined } | { path: null; failure: LeaseFailure };

/**
 * Ask the pool for a tree. Returns its path, or the reason it got nothing (which
 * `provisionWorktree` treats as "maybe leaked", not "no pool").
 *
 * The holder label is what later marks this lease as ours to reclaim, so it comes
 * from the reaper's own constant rather than a literal here.
 */
async function leaseFromPool(repoRoot: string): Promise<LeaseAttempt> {
  const r = await run("treehouse", ["get", "--lease", "--lease-holder", LEASE_HOLDER], {
    cwd: repoRoot,
    timeoutMs: 180000,
  });
  const stderr = r.stderr.trim();
  const path = r.stdout.trim().split("\n").filter(Boolean).pop();
  if (r.code !== 0) return { path: null, failure: { what: `treehouse get exited ${r.code}`, stderr } };
  if (!path) return { path: null, failure: { what: "treehouse get printed no worktree path", stderr } };
  if (!existsSync(path)) {
    return { path: null, failure: { what: `treehouse get printed a path that does not exist: ${path}`, stderr } };
  }
  return { path };
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
export async function teardownWorktree(task: {
  repoRoot: string;
  worktreePath: string | null;
  branch: string | null;
  provider: WorktreeProvider | null;
  homeName: string | null;
}): Promise<void> {
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
  if (!task.worktreePath) return;

  if (task.provider === "treehouse") {
    // Hand the lease back to the pool. Never fall back to `git worktree remove` for
    // a pooled checkout - that would delete a tree behind treehouse's bookkeeping
    // and leak the lease. If return fails, leave it for the pool to reconcile.
    const returned = await returnLease(task.worktreePath);
    if (returned.code !== 0) {
      throw new Error(`treehouse return failed: ${returned.stderr.trim() || `exit ${returned.code}`}`);
    }
    return;
  }
  const removed = await run("git", ["-C", task.repoRoot, "worktree", "remove", "--force", task.worktreePath], {
    timeoutMs: 30000,
  });
  if (removed.code !== 0) {
    const repo = await run("git", ["-C", task.repoRoot, "rev-parse", "--is-inside-work-tree"]);
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

// Small words a title leaves lowercase unless they lead it - so an auto-title reads the
// way a person would write one, not Shouting Every Word.
const TITLE_MINOR_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "per",
  "the", "to", "vs", "via", "with",
]);

/**
 * Title-case a line so an auto-derived title reads like a heading. Words that already
 * carry a capital are left exactly as typed - so acronyms, camelCase and file names
 * (`API`, `useEffect`, `App.tsx`) survive rather than being flattened.
 */
function titleCase(line: string): string {
  return line
    .split(/\s+/)
    .map((word, i) => {
      if (!word || /[A-Z]/.test(word)) return word;
      if (i > 0 && TITLE_MINOR_WORDS.has(word.toLowerCase())) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
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
  const line = intent.split("\n").map((l) => l.trim()).find(Boolean) ?? "task";
  const titled = titleCase(line);
  return titled.length > TITLE_MAX_CHARS ? titled.slice(0, TITLE_MAX_CHARS - 1) + "…" : titled;
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
 */
async function spawnUniquely(
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

async function resolveBinPath(bin: string): Promise<string | null> {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  const r = await run("which", [bin]);
  const p = r.stdout.trim().split("\n")[0];
  return r.code === 0 && p ? p : null;
}

async function hasBin(bin: string): Promise<boolean> {
  return (await resolveBinPath(bin)) !== null;
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
