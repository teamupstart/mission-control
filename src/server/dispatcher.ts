import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Task, WorktreeProvider } from "@shared/types.ts";
import { WORKTREES_DIR, resolveAgentBin } from "./config.ts";
import { injectPrompt } from "./actions.ts";
import type { Registry } from "./registry.ts";
import { run } from "./util/exec.ts";

/** How long to wait for the dispatched agent's pane to be discovered before failing. */
const READY_TIMEOUT_MS = Number(process.env.HARNESS_DISPATCH_READY_MS ?? 30000);
/** Settle time after discovery so the agent's input is ready for the first prompt. */
const SETTLE_MS = Number(process.env.HARNESS_DISPATCH_SETTLE_MS ?? 2000);

/**
 * Turns a task into a live crewmate: provision an isolated worktree, launch the
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

      const tmuxSession = await spawnUniquely(slug, shortId, wt.path, agentBin);
      this.patch(taskId, { tmuxSession });

      const session = await this.registry.waitForSessionAtCwd(wt.path, READY_TIMEOUT_MS);
      if (!session) {
        throw new Error("agent session never appeared (the launch may have exited immediately)");
      }
      await delay(SETTLE_MS);

      const sent = await injectPrompt(session, task.intent);
      if (!sent.ok) throw new Error(`could not send the initial prompt: ${sent.error ?? "unknown"}`);

      // A concurrent cancel may have finished the task while we were dispatching;
      // don't resurrect it to `running`.
      if (this.cancelledOrGone(taskId)) return;
      this.patch(taskId, { status: "running", sessionId: session.id });
    } catch (err) {
      if (this.cancelledOrGone(taskId)) return; // cancel already owns the terminal state
      const cur = this.registry.getTask(taskId);
      if (!cur) return;
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

  /** True if the task was cancelled or removed while a dispatch was in flight. */
  private cancelledOrGone(taskId: string): boolean {
    const t = this.registry.getTask(taskId);
    return !t || t.status === "cancelled";
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
    const r = await run("treehouse", ["get", "--lease", "--lease-holder", "ai-harness"], {
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
    const r = await run("treehouse", ["return", task.worktreePath], { timeoutMs: 30000 });
    if (r.code === 0) return; // pool reclaims the checkout + its branch
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

/** Launch `agentBin` in a new detached tmux session rooted at `cwd`. */
export async function spawnDetachedSession(
  sessionName: string,
  cwd: string,
  agentBin: string,
): Promise<void> {
  const r = await run("tmux", ["new-session", "-d", "-s", sessionName, "-c", cwd, agentBin], {
    timeoutMs: 10000,
  });
  if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || "unknown"}`);
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

async function tmuxSessionAlive(name: string): Promise<boolean> {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && "unref" in t) t.unref();
  });
}
