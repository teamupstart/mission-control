import { PR_POLL_MS } from "./config.ts";
import type { PrMatch, Registry } from "./registry.ts";
import type { PrChecks, PrState } from "@shared/types.ts";
import { unref } from "./util/timers.ts";
import { run } from "./util/exec.ts";

// Keeps each session's PR chip honest by asking `gh` for the pull request on the
// session's current branch. It is the source of truth behind the chip: it
// discovers PRs the hook never saw (Codex sessions, PRs opened in the web UI),
// surfaces whether that PR is open or merged, and retracts the chip only when the
// session moves to a branch that no longer matches the PR's head. The hook only
// ever sets a link optimistically; nothing but this poller can confirm a merge,
// because a merge happens outside the session where no hook can observe it.
//
// A merged PR is deliberately kept (not cleared): once your work lands you can
// still see the PR that carried it, right up until the session is reset onto a
// different branch. Only a *closed-unmerged* PR is treated as "no PR".
//
// Cheap by construction: live sessions cost one `gh` call per distinct worktree;
// persisted links are concurrency-limited and back off independently.
//
// The by-URL half answers for pull requests no live session can be asked about. It serves
// two harvests - unsatisfied dependency edges, and the bindings of tasks a merge could
// still complete - through ONE cadence, because they overlap constantly (the task you are
// waiting on is usually also a task) and two would poll the same URL twice at two
// backoffs.

/** Branches that never carry a PR, so we never spend a `gh` call on them. */
const DEFAULT_BRANCHES = new Set(["main", "master"]);

type PrLookup = "error" | null | Omit<PrMatch, "branch" | "agentSessionId" | "episodeId">;
type PrStateMatch = { state: PrState; mergedAt: number | null };
type PrStateLookup = "error" | PrStateMatch | null;

const PR_URL_CONCURRENCY = 4;
const PR_URL_MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Per-URL cadence for the by-URL poller: when each pull request may be asked about again,
 * and how far its backoff has grown. One instance serves every harvest - see the header.
 */
export class PrUrlPollState {
  private entries = new Map<string, { attempts: number; nextAt: number }>();

  due(urls: string[], now: number): string[] {
    const current = new Set(urls);
    for (const url of this.entries.keys()) {
      if (!current.has(url)) this.entries.delete(url);
    }
    return urls.filter((url) => (this.entries.get(url)?.nextAt ?? 0) <= now);
  }

  record(url: string, result: PrStateLookup, now: number): void {
    if (result !== "error" && result?.state === "merged") {
      this.entries.delete(url);
      return;
    }
    const attempts = (this.entries.get(url)?.attempts ?? 0) + 1;
    const delay = Math.min(
      PR_POLL_MS * 2 ** Math.min(attempts - 1, 8),
      PR_URL_MAX_BACKOFF_MS,
    );
    this.entries.set(url, { attempts, nextAt: now + delay });
  }
}

async function forEachConcurrent<T>(
  values: T[],
  limit: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const value = values[next++];
        if (value !== undefined) await visit(value);
      }
    }),
  );
}

/**
 * Ask `gh` for the pull request whose head is `branch`, run from `cwd` so `gh`
 * resolves the repo from that checkout's `origin`. Prefers a still-open PR, else
 * falls back to a merged one (so a landed PR keeps showing). Returns `null` when
 * the branch has provably no open/merged PR (only closed-unmerged, or none), or
 * `"error"` when `gh` is missing/unauthenticated/timed out - which the reconciler
 * treats as "unknown, leave the existing chip alone" rather than a reason to clear.
 */
async function queryPr(cwd: string, branch: string): Promise<PrLookup> {
  const [res, head] = await Promise.all([
    run(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "url,number,state,statusCheckRollup,createdAt,mergedAt,headRefOid",
        "--limit",
        "20",
      ],
      { cwd, timeoutMs: 8000 },
    ),
    run("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 8000 }),
  ]);
  const worktreeHeadSha = head.stdout.trim();
  if (res.code !== 0 || head.code !== 0 || !worktreeHeadSha) return "error";
  try {
    const arr = JSON.parse(res.stdout || "[]") as unknown;
    if (!Array.isArray(arr)) return "error"; // malformed output is an anomaly, not "no PR"
    // `gh` lists newest-first; prefer an open PR, else the most recent merged one.
    // A closed-unmerged PR is ignored, so the chip drops like there's no PR.
    const open = arr.find((p) => prStateOf(p) === "open");
    const match = open ?? arr.find((p) => prStateOf(p) === "merged");
    if (!match) return null;
    const { url, number, createdAt, mergedAt, headRefOid } = match as {
      url?: unknown;
      number?: unknown;
      createdAt?: unknown;
      mergedAt?: unknown;
      headRefOid?: unknown;
    };
    const state = prStateOf(match);
    const createdAtMs = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
    const mergedAtMs = typeof mergedAt === "string" ? Date.parse(mergedAt) : Number.NaN;
    if (typeof url !== "string" || !Number.isFinite(createdAtMs) || typeof headRefOid !== "string") {
      return "error";
    }
    if (state === "merged" && !Number.isFinite(mergedAtMs)) return "error";
    return {
      url,
      number: typeof number === "number" ? number : null,
      state: state as PrState,
      checks: checksOf(match),
      createdAt: createdAtMs,
      mergedAt: state === "merged" ? mergedAtMs : null,
      headSha: headRefOid,
      worktreeHeadSha,
    };
  } catch {
    return "error";
  }
}

async function queryPrUrl(url: string): Promise<PrStateLookup> {
  const res = await run("gh", ["pr", "view", url, "--json", "state,mergedAt"], { timeoutMs: 8000 });
  if (res.code !== 0) return "error";
  try {
    const parsed = JSON.parse(res.stdout) as { state?: unknown; mergedAt?: unknown };
    const state = prStateOf(parsed);
    if (state === null) return parsed.state === "CLOSED" ? null : "error";
    if (state === "open") return { state, mergedAt: null };
    const mergedAt = typeof parsed.mergedAt === "string" ? Date.parse(parsed.mergedAt) : Number.NaN;
    return Number.isFinite(mergedAt) ? { state, mergedAt } : "error";
  } catch {
    return "error";
  }
}

/** Map `gh`'s uppercase PR state to our surfaced states; closed-unmerged -> null. */
function prStateOf(p: unknown): PrState | null {
  const raw = (p as { state?: unknown })?.state;
  if (raw === "OPEN") return "open";
  if (raw === "MERGED") return "merged";
  return null; // CLOSED (unmerged) or anything unexpected
}

// CheckRun conclusions and StatusContext states that we count as a failed check.
// SUCCESS / NEUTRAL / SKIPPED are treated as passing; anything unrecognized as
// passing too, so an unknown value never raises a false alarm.
const FAIL_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);
const FAIL_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

type CheckState = "fail" | "pending" | "pass";

/**
 * Classify one `statusCheckRollup` entry. Entries are either a GraphQL `CheckRun`
 * (has a `status` like QUEUED/IN_PROGRESS/COMPLETED plus, once done, a
 * `conclusion`) or a legacy `StatusContext` (has a `state` like SUCCESS/PENDING/
 * FAILURE). Returns null for a shape we don't recognize.
 */
function checkEntryState(e: unknown): CheckState | null {
  const o = e as { status?: unknown; conclusion?: unknown; state?: unknown };
  if (typeof o.status === "string") {
    if (o.status.toUpperCase() !== "COMPLETED") return "pending";
    const c = typeof o.conclusion === "string" ? o.conclusion.toUpperCase() : "";
    return FAIL_CONCLUSIONS.has(c) ? "fail" : "pass";
  }
  if (typeof o.state === "string") {
    const s = o.state.toUpperCase();
    if (FAIL_STATES.has(s)) return "fail";
    if (PENDING_STATES.has(s)) return "pending";
    return "pass";
  }
  return null;
}

/**
 * Roll a PR's `statusCheckRollup` up to a single chip state: any failing check
 * dominates (that's what the card's alert keys off), else pending while any is
 * still running, else passing. Null when the PR carries no checks at all.
 */
function checksOf(p: unknown): PrChecks | null {
  const rollup = (p as { statusCheckRollup?: unknown })?.statusCheckRollup;
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let sawPending = false;
  let sawPass = false;
  for (const e of rollup) {
    const s = checkEntryState(e);
    if (s === "fail") return "failing";
    if (s === "pending") sawPending = true;
    else if (s === "pass") sawPass = true;
  }
  if (sawPending) return "pending";
  if (sawPass) return "passing";
  return null;
}

/**
 * Query every feature-branch session's open PR and reconcile the results onto
 * every session in one pass. Sessions on a default branch (or none) are never
 * queried; reconciliation still clears any stale link they carry, which is what
 * retires a chip after the session moves off the branch its PR belonged to.
 */
export async function pollAndReconcilePrs(
  registry: Registry,
  lookup: (cwd: string, branch: string) => Promise<PrLookup> = queryPr,
  lookupUrl: (url: string) => Promise<PrStateLookup> = queryPrUrl,
  urlState = new PrUrlPollState(),
  now = Date.now(),
): Promise<void> {
  const targets = registry.prPollTargets();
  // Both harvests, deduplicated: a task waiting on its own merge is very often also the
  // task something else declared a dependency on, and asking twice would spend two `gh`
  // calls and two backoffs on one pull request.
  const linkedUrls = [
    ...new Set([...registry.dependencyPrPollTargets(), ...registry.taskPrPollTargets()]),
  ];
  const found = new Map<string, PrMatch>();
  const skip = new Set<string>();

  const queryable = targets.filter((t) => t.branch && !DEFAULT_BRANCHES.has(t.branch));
  if (queryable.length === 0 && linkedUrls.length === 0) {
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
      results.set(cwd, await lookup(cwd, branch));
    }),
  );

  for (const t of queryable) {
    const r = results.get(t.cwd);
    if (r === "error") skip.add(t.id);
    else if (r) {
      found.set(t.id, {
        ...r,
        branch: t.branch as string,
        agentSessionId: t.agentSessionId,
        episodeId: t.episodeId,
      });
    }
    // r === null (no open/merged PR) -> omitted from both -> reconcile clears the chip
  }
  const observed = new Map([...found.values()].map((match) => [match.url, match]));
  const mergedUrls = new Map<string, number>();
  const dueUrls = urlState.due(linkedUrls, now);
  for (const url of linkedUrls) {
    const match = observed.get(url);
    if (!match) continue;
    if (match.state === "merged" && match.mergedAt !== null) {
      mergedUrls.set(url, match.mergedAt);
    }
  }
  await forEachConcurrent(
    dueUrls.filter((url) => !observed.has(url)),
    PR_URL_CONCURRENCY,
    async (url) => {
      const result = await lookupUrl(url);
      urlState.record(url, result, now);
      if (result !== "error" && result?.state === "merged" && result.mergedAt !== null) {
        mergedUrls.set(url, result.mergedAt);
      }
    },
  );
  registry.reconcilePrs(found, skip);
  registry.reconcilePrMerges(mergedUrls);
}

/**
 * Drive PR reconciliation on an interval. Ticks never overlap; a slow sweep just
 * delays the next. A no-op (no subprocesses) whenever no session sits on a
 * feature branch and no dependency or task binding contributes a URL.
 */
export function startPrPoller(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const urlState = new PrUrlPollState();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollAndReconcilePrs(registry, queryPr, queryPrUrl, urlState);
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
