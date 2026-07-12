import { PR_POLL_MS } from "./config.ts";
import type { Registry } from "./registry.ts";
import { unref } from "./util/timers.ts";
import { run } from "./util/exec.ts";

// Keeps each session's PR link honest by asking `gh` whether the session's
// current branch has an open pull request. It is the source of truth behind the
// card's PR chip: it discovers PRs the hook never saw (Codex sessions, PRs
// opened in the web UI) and - crucially - clears the chip the moment a PR merges
// or closes, or the session is reset onto a branch with no open PR. The hook
// only ever sets a link optimistically; nothing but this poller can retract one,
// because a merge happens outside the session where no hook can observe it.
//
// Cheap by construction: only feature-branch sessions are queried (one `gh` call
// per distinct worktree), and an all-idle or all-on-main fleet spawns nothing.

/** Branches that never carry a PR, so we never spend a `gh` call on them. */
const DEFAULT_BRANCHES = new Set(["main", "master"]);

type PrLookup = "error" | null | { url: string; number: number | null };

/**
 * Ask `gh` for the single open PR whose head is `branch`, run from `cwd` so `gh`
 * resolves the repo from that checkout's `origin`. Returns the PR when one is
 * open, `null` when there is provably none (an empty list), or `"error"` when
 * `gh` is missing/unauthenticated/timed out - which the reconciler treats as
 * "unknown, leave the existing link alone" rather than a reason to clear it.
 */
async function queryOpenPr(cwd: string, branch: string): Promise<PrLookup> {
  const res = await run(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "url,number", "--limit", "1"],
    { cwd, timeoutMs: 8000 },
  );
  if (res.code !== 0) return "error";
  try {
    const arr = JSON.parse(res.stdout || "[]") as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const { url, number } = arr[0] as { url?: unknown; number?: unknown };
    if (typeof url !== "string") return null;
    return { url, number: typeof number === "number" ? number : null };
  } catch {
    return "error"; // malformed output is an anomaly, not a confirmed "no PR"
  }
}

/**
 * Query every feature-branch session's open PR and reconcile the results onto
 * the fleet in one pass. Sessions on a default branch (or none) are never
 * queried; reconciliation still clears any stale link they carry, which is what
 * retires a chip after the session moves off the branch its PR belonged to.
 */
export async function pollAndReconcilePrs(registry: Registry): Promise<void> {
  const targets = registry.prPollTargets();
  const found = new Map<string, { url: string; number: number | null }>();
  const skip = new Set<string>();

  const queryable = targets.filter((t) => t.branch && !DEFAULT_BRANCHES.has(t.branch));
  if (queryable.length === 0) {
    registry.reconcilePrs(found, skip); // clears any lingering link, spawns nothing
    return;
  }

  // A branch is checked out in exactly one worktree, so one `gh` call per cwd
  // answers for every session sharing it.
  const byCwd = new Map<string, string>();
  for (const t of queryable) byCwd.set(t.cwd, t.branch as string);
  const results = new Map<string, PrLookup>();
  await Promise.all(
    [...byCwd].map(async ([cwd, branch]) => {
      results.set(cwd, await queryOpenPr(cwd, branch));
    }),
  );

  for (const t of queryable) {
    const r = results.get(t.cwd);
    if (r === "error") skip.add(t.id);
    else if (r) found.set(t.id, r);
    // r === null (no open PR) -> omitted from both -> reconcile clears the link
  }
  registry.reconcilePrs(found, skip);
}

/**
 * Drive PR reconciliation on an interval. Ticks never overlap; a slow sweep just
 * delays the next. A no-op (no subprocesses) whenever no session sits on a
 * feature branch.
 */
export function startPrPoller(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollAndReconcilePrs(registry);
    } catch (err) {
      console.error("[pr] poll failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, PR_POLL_MS));
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
