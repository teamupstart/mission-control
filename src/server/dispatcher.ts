import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Session, Task, WorktreeProvider } from "@shared/types.ts";
import { WORKTREES_DIR, resolveAgentBin, envVar } from "./config.ts";
import { injectPrompt } from "./actions.ts";
import type { Registry } from "./registry.ts";
import { run } from "./util/exec.ts";
import { sleep } from "./util/timers.ts";

/** How long to wait for the dispatched agent's pane to be discovered before failing. */
const READY_TIMEOUT_MS = Number(envVar("DISPATCH_READY_MS") ?? 30000);
/**
 * Fallback settle time for an agent that never reports a hook. Only reached when
 * `DISPATCH_HOOK_READY_MS` elapses with no signal - see `awaitReady`. This is a guess
 * about boot time, which is exactly why it is no longer the primary path.
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
 * Turns a task into a live agent: provision an isolated worktree, launch the
 * agent in a detached tmux session there, wait for passive discovery to bind the
 * session (by worktree cwd), then inject the task as its first prompt.
 *
 * Every step patches the task through the registry so progress streams to the UI
 * over SSE. `dispatch` never throws - a failure lands the task in `failed` with a
 * human-readable reason rather than crashing the daemon.
 */
export class Dispatcher {
  constructor(private registry: Registry) {}

  async dispatch(taskId: string): Promise<void> {
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

      const slug = slugify(task.title);
      const shortId = taskId.slice(0, 6);

      const wt = await provisionWorktree(task.repoRoot, taskId, slug, shortId);
      // Record the worktree BEFORE spawning, so a spawn failure can still tear it down.
      this.patch(taskId, { worktreePath: wt.path, branch: wt.branch, provider: wt.provider });
      if (await this.abortIfSettled(taskId)) return;

      const tmuxSession = await spawnUniquely(slug, shortId, wt.path, agentBin);
      this.patch(taskId, { tmuxSession });
      if (await this.abortIfSettled(taskId)) return;

      const discovered = await this.registry.waitForSessionAtCwd(wt.path, READY_TIMEOUT_MS);
      if (!discovered) {
        throw new Error("agent session never appeared (the launch may have exited immediately)");
      }
      if (await this.abortIfSettled(taskId)) return;

      // Discovery only proves the process exists. Wait for the agent to prove it can
      // READ before typing at it - see `awaitReady`.
      const { session, instrumented } = await this.awaitReady(wt.path, discovered);
      if (await this.abortIfSettled(taskId)) return;

      await this.deliverIntent(session, task.intent, wt.path, instrumented);

      if (await this.abortIfSettled(taskId)) return;
      this.patch(taskId, { status: "running", sessionId: session.id });
    } catch (err) {
      const cur = this.registry.getTask(taskId);
      if (!cur) return;
      // A cancel/complete that settled the task in flight owns its terminal state
      // (and outcome) - don't overwrite it to `failed`. Only a cancel tears down;
      // a mid-flight complete keeps its worktree (Mark done must not discard work),
      // leaving it as a reclaimable done-with-worktree task.
      if (cur.status !== "dispatching") {
        if (cur.status === "cancelled") {
          await teardownWorktree(cur).catch(() => {});
          this.patch(taskId, { worktreePath: null, branch: null, provider: null, tmuxSession: null });
        }
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // If the agent actually launched and is still running (e.g. discovery was
      // merely slow, or only the prompt send failed), do NOT destroy its work:
      // keep the session + worktree and fail the task with guidance. Only when no
      // live agent remains do we tear the (empty) tree down for a clean retry.
      const alive = cur.tmuxSession ? await tmuxSessionAlive(cur.tmuxSession) : false;
      if (alive) {
        this.patch(taskId, {
          status: "failed",
          error: `${message} - the agent is still running; Focus or Cancel it`,
        });
      } else {
        await teardownWorktree(cur).catch(() => {});
        this.patch(taskId, {
          status: "failed",
          error: message,
          worktreePath: null,
          branch: null,
          provider: null,
          tmuxSession: null,
          sessionId: null,
        });
      }
    }
  }

  /**
   * Wait for the agent to be able to READ the prompt we're about to type.
   *
   * Discovery is a `ps` sweep: it fires when the binary is exec'd, seconds before any
   * TUI exists. The only honest "I'm listening" signal an agent gives is its first
   * hook, so wait for that. Returns whether we got it, because that decides whether a
   * later silence is evidence of anything.
   *
   * The fallback is deliberate. An agent with no hooks installed will never satisfy
   * this, and refusing to dispatch to it would be a regression, so a timeout degrades
   * to the old fixed sleep - the pre-existing best-effort behaviour, now confined to
   * the only case that has no better option instead of applying to everything.
   */
  private async awaitReady(
    cwd: string,
    discovered: Session,
  ): Promise<{ session: Session; instrumented: boolean }> {
    const ready = await this.registry.waitForReadySessionAtCwd(cwd, HOOK_READY_MS);
    if (ready) return { session: ready, instrumented: true };
    await sleep(SETTLE_MS);
    // Re-read: `discovered` is a snapshot from before the wait, and its pane may have
    // been filled in since. Typing needs the freshest pane we have.
    return {
      session: this.registry.getSession(discovered.id) ?? discovered,
      instrumented: false,
    };
  }

  /**
   * Type the intent and - when we can - confirm the agent actually took it.
   *
   * `injectPrompt` succeeding means tmux accepted the write, NOT that the agent read
   * it: a pty swallows keystrokes just as happily when nothing is listening. Trusting
   * it is what let a task sit `running` for 13 minutes against a session whose first
   * prompt was pasted 647ms before its TUI existed. So on an instrumented session we
   * wait for the `working` transition only `UserPromptSubmit` can produce.
   *
   * The retry is gated on positive evidence (it typed, and the agent is STILL idle 15s
   * later), never on silence alone. It is not free: if the paste reached the input box
   * but the Enter did not, a second paste concatenates onto the first and the agent
   * reads its intent twice over. That is the accepted cost - a garbled-but-visible
   * prompt a human can fix beats a session that sits empty and calls itself `running`,
   * and if neither attempt takes, the task now FAILS loudly instead of lying.
   *
   * None of this transfers to the wrap-up, whose instruction pushes: there a second
   * delivery is a second PR, so it never retries. See queue-apply's `auto-wrapup`.
   *
   * Uninstrumented sessions get one best-effort send: with no hook there is no signal,
   * and absence of evidence is not evidence.
   */
  private async deliverIntent(
    session: Session,
    intent: string,
    cwd: string,
    instrumented: boolean,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      // Listen BEFORE typing - the hook can land before the next line runs.
      const accepted = instrumented
        ? this.registry.waitForPromptAcceptedAtCwd(cwd, ACCEPT_MS)
        : null;

      const sent = await injectPrompt(session, intent);
      if (!sent.ok) {
        throw new Error(`could not send the initial prompt: ${sent.error ?? "unknown"}`);
      }
      if (!accepted) return;
      if (await accepted) return;

      // Still idle after typing at it. Positive evidence the paste went nowhere - but
      // only if it's STILL idle now; a `working` we merely raced past means it landed.
      const now = this.registry.getSession(session.id);
      if (now && now.state !== "idle") return;
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
      await teardownWorktree(cur).catch(() => {});
      this.patch(taskId, { worktreePath: null, branch: null, provider: null, tmuxSession: null });
    }
    return true;
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
 * Give a task its own isolated tree. Repos that opted into treehouse (a
 * `treehouse.toml` at the root) get a pre-warmed pooled worktree; everything else
 * gets a plain `git worktree` on a fresh `harness/<slug>` branch. Either way the
 * agent never shares a working tree with another session - the whole reason this
 * harness exists.
 */
export async function provisionWorktree(
  repoRoot: string,
  taskId: string,
  slug: string,
  shortId: string,
): Promise<ProvisionedWorktree> {
  const check = await run("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"]);
  if (check.code !== 0 || check.stdout.trim() !== "true") {
    throw new Error(`${repoRoot} is not a git repository`);
  }

  if ((await hasBin("treehouse")) && existsSync(join(repoRoot, "treehouse.toml"))) {
    const r = await run("treehouse", ["get", "--lease", "--lease-holder", "fleet-control"], {
      cwd: repoRoot,
      timeoutMs: 180000,
    });
    const path = r.stdout.trim().split("\n").filter(Boolean).pop();
    if (r.code === 0 && path && existsSync(path)) {
      return { path: realpathSync(path), branch: await currentBranch(path), provider: "treehouse" };
    }
    // Fall through to a plain worktree if the pool couldn't hand one over.
  }

  mkdirSync(WORKTREES_DIR, { recursive: true });
  const path = join(WORKTREES_DIR, taskId);
  const branch = `harness/${slug}-${shortId}`;
  const add = await run("git", ["-C", repoRoot, "worktree", "add", path, "-b", branch, "HEAD"], {
    timeoutMs: 60000,
  });
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim() || "unknown"}`);
  return { path: realpathSync(path), branch, provider: "git" };
}

/**
 * Tear down a task's live resources (best-effort): kill its detached tmux session
 * and return/remove its worktree + throwaway branch. Provider-aware so a treehouse
 * lease is handed back to the pool rather than leaked by a bare `git worktree remove`.
 */
export async function teardownWorktree(task: {
  repoRoot: string;
  worktreePath: string | null;
  branch: string | null;
  provider: WorktreeProvider | null;
  tmuxSession: string | null;
}): Promise<void> {
  if (task.tmuxSession) {
    await run("tmux", ["kill-session", "-t", task.tmuxSession], { timeoutMs: 10000 });
  }
  if (!task.worktreePath) return;

  if (task.provider === "treehouse") {
    // Hand the lease back to the pool. Never fall back to `git worktree remove` for
    // a pooled checkout - that would delete a tree behind treehouse's bookkeeping
    // and leak the lease. If return fails, leave it for the pool to reconcile.
    await run("treehouse", ["return", task.worktreePath], { timeoutMs: 30000 });
    return;
  }
  await run("git", ["-C", task.repoRoot, "worktree", "remove", "--force", task.worktreePath], {
    timeoutMs: 30000,
  });
  // Our git-fallback trees sit on a throwaway `harness/…` branch; drop it so a
  // retry of the same task can recreate it. Never touch a non-harness branch.
  if (task.branch && task.branch.startsWith("harness/")) {
    await run("git", ["-C", task.repoRoot, "branch", "-D", task.branch], { timeoutMs: 15000 });
  }
}

/**
 * Launch `agentBin` in a new detached tmux session rooted at `cwd`, alongside a
 * plain shell pane in the same worktree. The agent lives in pane 0 (what discovery
 * binds to and injects the first prompt into); a second pane split beside it drops
 * you straight into a terminal at the worktree for ad-hoc git/build/inspection work.
 * The split is best-effort - a shell pane is a convenience, so if tmux can't add it
 * we keep the agent session rather than failing the whole dispatch.
 */
export async function spawnDetachedSession(
  sessionName: string,
  cwd: string,
  agentBin: string,
): Promise<void> {
  const r = await run("tmux", ["new-session", "-d", "-s", sessionName, "-c", cwd, agentBin], {
    timeoutMs: 10000,
  });
  if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || "unknown"}`);

  const agentPane = `${sessionName}:0.0`;
  // Split a shell pane beside the agent (vertical divider), sized to a third so the
  // agent TUI keeps most of the width. `split-window` with no command opens the
  // default shell; `-c` roots it at the worktree.
  await run("tmux", ["split-window", "-h", "-l", "33%", "-t", agentPane, "-c", cwd], {
    timeoutMs: 10000,
  });
  // Leave the agent pane focused so attaching/Focus lands on it, not the shell.
  await run("tmux", ["select-pane", "-t", agentPane], { timeoutMs: 10000 });
}

// ---- pure helpers (unit-tested) ----

/** A tmux-safe, human-readable slug from a task title. */
export function slugify(title: string): string {
  const out = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return out || "task";
}

/** First non-empty line of the intent, trimmed - a sensible default task title. */
export function deriveTitle(intent: string): string {
  const line = intent.split("\n").map((l) => l.trim()).find(Boolean) ?? "task";
  return line.length > 60 ? line.slice(0, 59) + "…" : line;
}

async function uniqueTmuxSessionName(slug: string, shortId: string): Promise<string> {
  const r = await run("tmux", ["list-sessions", "-F", "#{session_name}"]);
  const taken = new Set(
    r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [],
  );
  return taken.has(slug) ? `${slug}-${shortId}` : slug;
}

/**
 * Spawn the agent under a session name, closing the check-then-spawn race: if a
 * concurrent dispatch claimed the bare slug between our listing and our spawn,
 * retry once under the always-unique `slug-shortId`. Returns the name actually used.
 */
async function spawnUniquely(
  slug: string,
  shortId: string,
  cwd: string,
  agentBin: string,
): Promise<string> {
  const name = await uniqueTmuxSessionName(slug, shortId);
  try {
    await spawnDetachedSession(name, cwd, agentBin);
    return name;
  } catch (err) {
    const alt = `${slug}-${shortId}`;
    if (name === alt) throw err;
    await spawnDetachedSession(alt, cwd, agentBin);
    return alt;
  }
}

export async function tmuxSessionAlive(name: string): Promise<boolean> {
  return (await run("tmux", ["has-session", "-t", name])).code === 0;
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

