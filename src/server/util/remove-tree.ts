import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { trackOwnWorktreeProcess } from "../worktrees/own-processes.ts";

/**
 * The daemon's one recursive delete for operator trees: pool slots, task checkouts, seed
 * staging, and archive bundles.
 *
 * Why not `fs.rm`. The daemon runs in Electron's utility process, where Node's `fs` treats any
 * `.asar` file as a virtual archive. A checkout with dependencies installed holds Electron's own
 * `node_modules/electron/dist/Electron.app/Contents/Resources/default_app.asar`, and
 * `rm(path, { recursive: true })` there neither unlinks it nor fails: it hangs, or answers
 * ENOTEMPTY for every parent of the file. On 2026-11-26 that kept a whole pool quarantined and
 * every claim falling back to a throwaway worktree. Plain Node has no asar layer, so only a spec
 * run under Electron's Node sees it (`test/remove-tree-electron.test.ts`).
 *
 * Why a child process rather than `process.noAsar`. That flag is process-global. Holding it
 * across an asynchronous delete lets every other read in the daemon (the dashboard's file
 * views, archive captures, a seed's walk) observe it for as long as the delete takes, and a
 * synchronous delete that keeps it unobservable blocks the event loop for the length of a
 * multi-gigabyte `node_modules`, with no way to time it out. The platform's `/bin/rm` has no
 * asar layer, runs off the event loop, and can be killed: so the deadline below makes a delete
 * that cannot finish a bounded, reported failure instead of a hang.
 *
 * The child runs in its own process group with `/` as its working directory, and its PID is
 * registered as the daemon's own while it runs, so the worktree occupancy scan never reads the
 * delete as somebody working in the slot it is removing.
 */

/** How long one tree removal may run before its process group is killed. */
export const TREE_REMOVAL_TIMEOUT_MS = 5 * 60_000;
/** Further `rm` runs after one that failed, as the `fs.rm` `maxRetries: 2` this replaced. */
export const TREE_REMOVAL_MAX_RETRIES = 2;
/** Linear backoff between attempts: this, then twice this, as `fs.rm`'s `retryDelay` default. */
export const TREE_REMOVAL_RETRY_DELAY_MS = 100;
/** After the kill, how long to wait for the child to report before settling without it. */
const KILL_DRAIN_MS = 5_000;
const MAX_REASON_BYTES = 1_024;

export type TreeRemovalEnd = "failed" | "stopped" | "timedOut";

/** A removal that did not finish. What it left behind is unknown: callers verify the path. */
export class TreeRemovalError extends Error {
  constructor(message: string, readonly ended: TreeRemovalEnd) {
    super(message);
    this.name = "TreeRemovalError";
  }
}

export interface RemoveTreeOptions {
  /** Defaults to `TREE_REMOVAL_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Aborting kills the removal and rejects with `ended: "stopped"`. */
  signal?: AbortSignal;
  /**
   * Whether a path that is already gone counts as removed, as `fs.rm`'s `force` does. Defaults
   * to true. False rejects with the `lstat` ENOENT error, for a caller that proved the path was
   * there and must hear that it vanished.
   */
  allowMissing?: boolean;
  /** Further attempts after an `rm` that fails. Defaults to `TREE_REMOVAL_MAX_RETRIES` (2). */
  maxRetries?: number;
  /** Backoff unit between attempts. Defaults to `TREE_REMOVAL_RETRY_DELAY_MS` (100 ms). */
  retryDelayMs?: number;
  /** Overrides the pinned `rm`, so a test can model one that hangs or fails. */
  executable?: string;
}

function bounded(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= MAX_REASON_BYTES ? value : bytes.subarray(0, MAX_REASON_BYTES).toString("utf8");
}

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** The exact path to remove: absolute, never a filesystem root, no trailing separator. */
function target(path: string): string {
  if (!path || !isAbsolute(path)) throw new TreeRemovalError(`refusing to remove a path that is not absolute: ${path}`, "failed");
  // Only `/` separates on the platforms the daemon runs on. A trailing `\` is part of the file
  // name, so stripping it would aim the delete at a different sibling (`deps\` -> `deps`).
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (!trimmed || resolve(trimmed) === parse(resolve(trimmed)).root) {
    throw new TreeRemovalError("refusing to remove a filesystem root", "failed");
  }
  return trimmed;
}

/** One `rm -rf` run, killed by `signal` or at `timeoutMs`. Never rejects. */
type RmOutcome =
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { kind: "ended"; ended: "stopped" | "timedOut" }
  | { kind: "error"; message: string };

function runRm(executable: string, exact: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<RmOutcome> {
  // Checked at the last moment before the spawn: the listener below hears only aborts that come
  // after it, so a Stop that landed during an earlier await (the `allowMissing` lstat) would
  // otherwise let a full delete run.
  if (signal?.aborted) return Promise.resolve({ kind: "ended", ended: "stopped" });
  return trackOwnWorktreeProcess((onSpawn) => new Promise<RmOutcome>((settle) => {
    let ending: "stopped" | "timedOut" | null = null;
    let stderr = "";
    let settled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const child = spawn(executable, ["-rf", "--", exact], {
      cwd: "/",
      detached: true,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (child.pid) onSpawn(child.pid);
    const finish = (value: RmOutcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle(value);
    };
    const end = (why: "stopped" | "timedOut"): void => {
      if (ending) return;
      ending = why;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
      // A child stuck in an uninterruptible disk wait may never report. The removal still ends.
      timers.push(setTimeout(() => finish({ kind: "ended", ended: why }), KILL_DRAIN_MS));
    };
    const onAbort = (): void => end("stopped");
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_REASON_BYTES) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish({ kind: "error", message: error.message }));
    child.once("close", (code, exitSignal) => {
      if (ending) finish({ kind: "ended", ended: ending });
      else finish({ kind: "exited", code, signal: exitSignal, stderr });
    });
    timers.push(setTimeout(() => end("timedOut"), timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  }));
}

/** Wait `ms` between attempts. Resolves false when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = (): void => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(true); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Remove `path` and everything under it, without following a symbolic link at `path` or inside
 * it. Resolves only once `lstat` proves nothing is left at `path`; rejects with a
 * `TreeRemovalError` (or, with `allowMissing: false`, the ENOENT) otherwise, never hangs.
 *
 * An `rm` that exits non-zero, or exits 0 with the path still there, is retried `maxRetries`
 * times (default 2, as the `fs.rm(..., { maxRetries: 2 })` it replaces) with a linear backoff of
 * `retryDelayMs` per attempt - a file another process held for a moment is gone by then. Every
 * attempt and pause shares the one `timeoutMs` deadline. A Stop, the deadline, or an `rm` that
 * cannot start ends the removal at once: none of those improves by trying again.
 */
export async function removeTree(path: string, options: RemoveTreeOptions = {}): Promise<void> {
  const exact = target(path);
  const timeoutMs = options.timeoutMs ?? TREE_REMOVAL_TIMEOUT_MS;
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? TREE_REMOVAL_MAX_RETRIES));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? TREE_REMOVAL_RETRY_DELAY_MS);
  const signal = options.signal;
  const stopped = (): TreeRemovalError => new TreeRemovalError(`removal of ${exact} was stopped`, "stopped");
  const timedOut = (): TreeRemovalError =>
    new TreeRemovalError(`removal of ${exact} timed out after ${Math.round(timeoutMs / 100) / 10} s`, "timedOut");
  if (signal?.aborted) throw stopped();
  if (timeoutMs <= 0) throw new TreeRemovalError(`removal of ${exact} had no time left`, "timedOut");
  if (options.allowMissing === false) await lstat(exact);
  const executable = options.executable ?? FIXED_OS_EXECUTABLES.rm;
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    const outcome = await runRm(executable, exact, remaining, signal);
    if (outcome.kind === "ended") throw outcome.ended === "stopped" ? stopped() : timedOut();
    if (outcome.kind === "error") throw new TreeRemovalError(bounded(`rm could not start: ${outcome.message}`), "failed");
    let failure: string;
    if (outcome.code !== 0) {
      const how = outcome.signal ? `was killed by ${outcome.signal}` : `exited with code ${outcome.code}`;
      failure = bounded(`rm -rf ${how}: ${outcome.stderr.trim()}`.trim());
    } else if (await absent(exact)) {
      return;
    } else {
      failure = bounded(`rm -rf reported success but ${exact} remains`);
    }
    if (attempt > maxRetries) {
      throw new TreeRemovalError(attempt > 1 ? `${failure} (after ${attempt} attempts)` : failure, "failed");
    }
    const wait = retryDelayMs * attempt;
    if (Date.now() + wait >= deadline) throw timedOut();
    if (!(await pause(wait, signal))) throw stopped();
  }
}
