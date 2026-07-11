import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Task, WorktreeProvider } from "@shared/types.ts";
import { WORKTREES_DIR, resolveAgentBin } from "./config.ts";
import { sendText } from "./actions.ts";
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
    let task = this.registry.getTask(taskId);
    if (!task) return;
    task = this.patch(task, { status: "dispatching", dispatchedAt: task.dispatchedAt ?? Date.now() });

    try {
      const configured = resolveAgentBin(task.agent);
      const agentBin = await resolveBinPath(configured);
      if (!agentBin) throw new Error(`agent binary "${configured}" not found on PATH`);

      const slug = slugify(task.title);
      const shortId = task.id.slice(0, 6);
      const tmuxSession = await uniqueTmuxSessionName(slug, shortId);

      const wt = await provisionWorktree(task.repoRoot, task.id, slug, shortId);
      task = this.patch(task, {
        worktreePath: wt.path,
        branch: wt.branch,
        provider: wt.provider,
        tmuxSession,
      });

      await spawnDetachedSession(tmuxSession, wt.path, agentBin);

      const session = await this.registry.waitForSessionAtCwd(wt.path, READY_TIMEOUT_MS);
      if (!session) {
        throw new Error("agent session never appeared (the launch may have exited immediately)");
      }
      await delay(SETTLE_MS);

      const sent = await sendText(session, task.intent, true);
      if (!sent.ok) throw new Error(`could not send the initial prompt: ${sent.error ?? "unknown"}`);

      this.patch(task, { status: "running", sessionId: session.id });
    } catch (err) {
      // A partial dispatch may have already spawned the agent + worktree. Tear
      // that orphan down and clear the worktree fields so a retry starts clean
      // (a leftover `harness/…` branch or worktree dir would make the retry's
      // `git worktree add -b` fail permanently).
      await teardownWorktree(task).catch(() => {});
      this.patch(this.registry.getTask(task.id) ?? task, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        worktreePath: null,
        branch: null,
        provider: null,
        tmuxSession: null,
        sessionId: null,
      });
    }
  }

  private patch(task: Task, fields: Partial<Task>): Task {
    const next: Task = { ...task, ...fields, updatedAt: Date.now() };
    this.registry.upsertTask(next);
    return next;
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
