import { PR_POLL_MS, ghBin } from "./config.ts";
import type { PrMatch, Registry } from "./registry.ts";
import type { PrChecks, PrState } from "@shared/types.ts";
import { unref } from "./util/timers.ts";
import { recordTelemetryPrMerges, telemetryPrPollTargets } from "./telemetry/index.ts";
import { run } from "./util/exec.ts";
import { activeStackGitHub } from "./stacking/github.ts";
import { StackMergeWatch } from "./stacking/merges.ts";
import { CHECK_CONTEXTS, rollUpChecks } from "./github/check-rollup.ts";

// Keeps each session's PR chip honest by asking `gh` for the pull request on the
// session's current branch. It is the source of truth behind the chip: it
// discovers PRs the hook never saw (Codex sessions, PRs opened in the web UI),
// surfaces whether that PR is open, merged, or closed, and retracts the chip only when the
// session moves to a branch that no longer matches the PR's head. The hook only
// ever sets a link optimistically; nothing but this poller can confirm a merge,
// because a merge happens outside the session where no hook can observe it.
//
// A merged PR is deliberately kept (not cleared): once your work lands you can
// still see the PR that carried it, right up until the session is reset onto a
// different branch. Closed-unmerged PRs are kept too, with their closed state.
//
// Cheap by construction: live sessions cost one `gh` call per distinct worktree;
// persisted links are concurrency-limited and back off independently.
//
// The by-URL half answers for pull requests no live session can be asked about. It serves
// two harvests - unsatisfied dependency edges, and the bindings of tasks a merge could
// still complete - through ONE cadence, because they overlap constantly (the task you are
// waiting on is usually also a task) and two would poll the same URL twice at two
// backoffs.
//
// A stacked pull request's merge counts only once it reached the default branch. Every merge
// this poller hands the Registry passes through one gate first (`StackMergeWatch.holds`): a
// stacked child merged into its parent's branch reads here exactly like a merge whose instant
// `gh` did not report - not a merge yet - so it marks no work episode merged, completes no task
// and satisfies no dependency edge. Ordinary pull requests are untouched and cost no extra read.
// A parent's merge also retargets its open stacked children at once (`retargetChildren`).

/** The stacked-merge state that must outlive one tick: settled verdicts and retargets done. */
const defaultStackMergeWatch = new StackMergeWatch();

/** Branches that never carry a PR, so we never spend a `gh` call on them. */
const DEFAULT_BRANCHES = new Set(["main", "master"]);

type PrCandidate = Omit<PrMatch, "branch" | "agentSessionId" | "episodeId">;
type PrLookup = "error" | null | PrCandidate | PrCandidate[];
type EpisodeSearch = { from: number; until: number | null; headSha: string | null };
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
 * falls back to a merged one, then a closed one. Returns `null` when
 * the branch has provably no matching PR, or
 * `"error"` when `gh` is missing/unauthenticated/timed out - which the reconciler
 * treats as "unknown, leave the existing chip alone" rather than a reason to clear.
 */
async function queryPr(cwd: string, branch: string, episode?: EpisodeSearch): Promise<PrLookup> {
  if (episode) {
    // Filter at GitHub before its result limit: a hundred newer uses of a branch must not
    // hide the PR in this episode's window. SHA search also finds late-opened PRs.
    const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const from = iso(Math.floor(episode.from / 1000) * 1000);
    const searches: string[] = [];
    if (episode.until !== null) searches.push(`created:${from}..${iso(Math.ceil(episode.until / 1000) * 1000)}`);
    if (episode.headSha) searches.push(`${episode.headSha} created:>=${from}`);
    const candidates: PrCandidate[] = [];
    for (const search of searches) {
      const result = await run(ghBin(), ["pr", "list", "--head", branch, "--state", "all",
        "--search", search, "--json", "url,number,state,statusCheckRollup,createdAt,mergedAt,headRefOid",
        "--limit", "100"], { cwd, timeoutMs: 8000 });
      if (result.code !== 0) return "error";
      try {
        const rows: unknown = JSON.parse(result.stdout || "[]");
        if (!Array.isArray(rows)) return "error";
        for (const row of rows) {
          const candidate = parsePrCandidate(row, null);
          if (candidate && !candidates.some(pr => pr.url === candidate.url)) candidates.push(candidate);
        }
      } catch { return "error"; }
    }
    // Prefer landed evidence when more than one PR belongs to an episode.
    return candidates.sort((a, b) => Number(b.state === "merged") - Number(a.state === "merged"));
  }
  const [res, head] = await Promise.all([
    run(
      ghBin(),
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
    // Keep closed PRs visible when no open or merged PR supersedes them.
    const open = arr.find((p) => prStateOf(p) === "open");
    const match = open ?? arr.find((p) => prStateOf(p) === "merged")
      ?? arr.find((p) => prStateOf(p) === "closed");
    if (!match) return null;
    const candidate = parsePrCandidate(match, worktreeHeadSha);
    if (!candidate) return "error";
    return { ...candidate, checks: await confirmRetriedChecks(cwd, candidate, match) };
  } catch {
    return "error";
  }
}

function parsePrCandidate(value: unknown, worktreeHeadSha: string | null): PrCandidate | null {
  if (!value || typeof value !== "object") return null;
  const { url, number, createdAt, mergedAt, headRefOid } = value as Record<string, unknown>;
  const state = prStateOf(value);
  const createdAtMs = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  const mergedAtMs = typeof mergedAt === "string" ? Date.parse(mergedAt) : Number.NaN;
  if (!state || typeof url !== "string" || !Number.isFinite(createdAtMs) || typeof headRefOid !== "string" ||
    (state === "merged" && !Number.isFinite(mergedAtMs))) return null;
  return { url, number: typeof number === "number" ? number : null, state, checks: checksOf(value),
    createdAt: createdAtMs, mergedAt: state === "merged" ? mergedAtMs : null,
    headSha: headRefOid, worktreeHeadSha };
}

function preferredPr(result: PrLookup): Exclude<PrLookup, PrCandidate[]> {
  if (!Array.isArray(result)) return result;
  return result.find(pr => pr.state === "open") ?? result.find(pr => pr.state === "merged") ?? result[0] ?? null;
}

/**
 * The head commit of a worktree, or null when nothing there can answer.
 *
 * Null is the honest answer for a tree that has been torn down or returned to the pool, and
 * the completion quorum reads it as "unchanged" - which is what lets a multi-repo task whose
 * checkouts were reclaimed ever complete. It is deliberately distinct from "nobody has
 * looked", which the registry represents by having no entry at all and which HOLDS
 * completion.
 */
async function queryHead(dir: string, branch?: string): Promise<string | null> {
  const r = await run("git", ["-C", dir, "rev-parse", "--verify", branch ? `refs/heads/${branch}` : "HEAD"], { timeoutMs: 8000 });
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

async function queryPrUrl(url: string): Promise<PrStateLookup> {
  const res = await run(ghBin(), ["pr", "view", url, "--json", "state,mergedAt"], {
    timeoutMs: 8000,
  });
  if (res.code !== 0) return "error";
  try {
    const parsed = JSON.parse(res.stdout) as { state?: unknown; mergedAt?: unknown };
    const state = prStateOf(parsed);
    // A confirmed unmerged closure can reopen discovery for completed dependencies.
    if (state === "closed") return { state, mergedAt: null };
    if (state === null) return "error";
    if (state === "open") return { state, mergedAt: null };
    const mergedAt = typeof parsed.mergedAt === "string" ? Date.parse(parsed.mergedAt) : Number.NaN;
    return Number.isFinite(mergedAt) ? { state, mergedAt } : "error";
  } catch {
    return "error";
  }
}

/** Map `gh`'s uppercase PR state to our surfaced states; including closed-unmerged. */
function prStateOf(p: unknown): PrState | null {
  const raw = (p as { state?: unknown })?.state;
  if (raw === "OPEN") return "open";
  if (raw === "MERGED") return "merged";
  if (raw === "CLOSED") return "closed";
  return null; // unexpected state
}

/** A PR's `statusCheckRollup` entries as `gh pr list` printed them, or none. */
function rollupOf(p: unknown): unknown[] {
  const rollup = (p as { statusCheckRollup?: unknown })?.statusCheckRollup;
  return Array.isArray(rollup) ? rollup : [];
}

/**
 * Roll a PR's `statusCheckRollup` up to a single chip state, through `rollUpChecks`, which the
 * merge gate shares. Null when the PR carries no checks at all. `gh pr list` does not say which
 * app or event each run belongs to, so this reading never retires a failure on its own - see
 * `confirmRetriedChecks`.
 */
function checksOf(p: unknown): PrChecks | null {
  return rollUpChecks(rollupOf(p)).checks;
}

/**
 * The verdicts `confirmRetriedChecks` already paid a GraphQL read for, by pull request url and
 * keyed by the exact `gh pr list` rollup they answered: while a pull request's checks stand still
 * - a stale failure lingers on a commit until the next push - the confirmation is read once, not
 * on every tick. Bounded, oldest first, because a long-lived daemon sees many pull requests.
 */
const confirmedChecks = new Map<string, { fingerprint: string; checks: PrChecks | null }>();
const CONFIRMED_CHECKS_LIMIT = 256;
/**
 * The most checks `gh pr list --json statusCheckRollup` reports for one commit. A rollup that
 * long may be cut short, so it cannot key a remembered verdict: a check added past the cut
 * leaves it unchanged.
 */
const GH_ROLLUP_PAGE = 100;

/**
 * The chip state, with a failure that LOOKS re-checked confirmed before it is cleared.
 *
 * A failing run followed by a later run with the same workflow and name is usually that check
 * running again - the title check after the title is edited - and the chip should follow the
 * later run. But it can also be a different check: the `push` and `pull_request` runs of one job
 * carry the same workflow and name, and a pass in one must never clear a failure in the other.
 * `gh pr list` cannot tell those apart, so this asks GitHub for the same commit's checks with
 * their app and triggering event (`CHECK_CONTEXTS`), and rolls those up instead. Anything short
 * of a complete answer about the same head commit keeps the failure.
 */
export async function confirmRetriedChecks(
  cwd: string,
  candidate: Pick<PrCandidate, "url" | "headSha">,
  raw: unknown,
): Promise<PrChecks | null> {
  const rollup = rollUpChecks(rollupOf(raw));
  if (rollup.checks !== "failing" || !rollup.unconfirmedRetry || !candidate.headSha) return rollup.checks;
  // A full page may be missing checks, so its fingerprint cannot stand for the head's checks.
  const cacheable = rollupOf(raw).length < GH_ROLLUP_PAGE;
  const fingerprint = `${candidate.headSha}\0${JSON.stringify(rollupOf(raw))}`;
  const known = cacheable ? confirmedChecks.get(candidate.url) : undefined;
  if (known?.fingerprint === fingerprint) return known.checks;
  const contexts = await queryHeadChecks(cwd, candidate.url, candidate.headSha);
  if (!contexts) return rollup.checks;
  // The merge gate's bar, so the chip never clears what the gate would still hold: an answer
  // with an unreadable entry or an unrecognised result keeps the failure.
  // The answer has to account for every failure gh reported: each must be there, retired by a
  // later run of the same check. A complete page that simply lacks one proves nothing about it.
  // Not remembered either way: GitHub may give a whole answer on the next tick.
  const confirmed = rollUpChecks(contexts);
  const accounted = rollup.failures.every((failure) => confirmed.retiredFailures.includes(failure));
  if (!confirmed.recognized || confirmed.checks === null || !accounted) return rollup.checks;
  const checks = confirmed.checks;
  if (!cacheable) return checks;
  confirmedChecks.delete(candidate.url);
  confirmedChecks.set(candidate.url, { fingerprint, checks });
  if (confirmedChecks.size > CONFIRMED_CHECKS_LIMIT) {
    const oldest = confirmedChecks.keys().next().value;
    if (oldest !== undefined) confirmedChecks.delete(oldest);
  }
  return checks;
}

const HEAD_CHECKS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    commits(last:1){ nodes{ commit{ oid statusCheckRollup{ ${CHECK_CONTEXTS} } } } }
  } }
}`;

/**
 * Every check on a pull request's head commit, with its app and event, or null when GitHub's
 * answer is not a complete one about `headSha`: a failed call, more checks than one page, or a
 * head that moved since `gh pr list` read it.
 */
async function queryHeadChecks(cwd: string, url: string, headSha: string): Promise<unknown[] | null> {
  const parts = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!parts) return null;
  const res = await run(ghBin(), ["api", "graphql", "-f", `query=${HEAD_CHECKS_QUERY}`,
    "-F", `owner=${parts[1]}`, "-F", `name=${parts[2]}`, "-F", `number=${parts[3]}`], { cwd, timeoutMs: 8000 });
  if (res.code !== 0) return null;
  try {
    const json = JSON.parse(res.stdout) as {
      errors?: unknown[];
      data?: { repository?: { pullRequest?: { commits?: { nodes?: Array<{ commit?: {
        oid?: unknown;
        statusCheckRollup?: { contexts?: { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } } | null;
      } }> } } | null } | null };
    };
    if (json.errors?.length) return null;
    const commit = json.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit;
    const contexts = commit?.statusCheckRollup?.contexts;
    if (commit?.oid !== headSha || contexts?.pageInfo?.hasNextPage !== false || !Array.isArray(contexts.nodes)) {
      return null;
    }
    return contexts.nodes;
  } catch {
    return null;
  }
}

/**
 * Query every feature-branch session's open PR and reconcile the results onto
 * every session in one pass. Sessions on a default branch (or none) are never
 * queried; reconciliation still clears any stale link they carry, which is what
 * retires a chip after the session moves off the branch its PR belonged to.
 */
export async function pollAndReconcilePrs(
  registry: Registry,
  lookup: (cwd: string, branch: string, episode?: EpisodeSearch) => Promise<PrLookup> = queryPr,
  lookupUrl: (url: string) => Promise<PrStateLookup> = queryPrUrl,
  urlState = new PrUrlPollState(),
  now = Date.now(),
  lookupHead: (dir: string, branch?: string) => Promise<string | null> = queryHead,
  /** Seam for the telemetry harvest, so a focused test can drive it without a real store. */
  telemetryTargets: (() => string[]) | null = null,
  stackMerges: StackMergeWatch = defaultStackMergeWatch,
): Promise<void> {
  const stackGitHub = activeStackGitHub();
  /** True when a merge must not complete anything yet: see the header. */
  const holdsMerge = (url: string, cwd: string | null, taskId: string | null): Promise<boolean> =>
    stackMerges.holds(url, cwd, taskId, registry, stackGitHub);
  /** Every merge observed this tick, landed or not: a parent's merge retargets its children. */
  const sawMerged = new Set<string>();
  const targets = registry.prPollTargets();
  const workHeadTargets = registry.dependencyWorkHeadTargets();
  // The SECONDARY repositories of every live multi-repo task, each with its own worktree and
  // branch. Same cost rule as the primary list - one `gh` call per distinct cwd - and empty
  // whenever no multi-repo task is running, which is the ordinary case.
  const repoTargets = registry.extraRepoPrPollTargets();
  const completedTargets = registry.completedDependencyBranchTargets()
    .filter((target) => target.binding.branch && !DEFAULT_BRANCHES.has(target.binding.branch));
  // Every multi-repo worktree the completion quorum still needs a head for. Read here rather
  // than at reconcile time because the reconciler is synchronous and runs on every session
  // event: a `git` call there would be a subprocess on the hot path. This tick is the one
  // place that already spends subprocesses, and it runs immediately before the reconciler it
  // feeds, so the observation is as fresh as the merge that triggers the question.
  const headTargets = registry.worktreeHeadTargets();
  const repoEvidenceTargets = registry.repoChangeEvidenceTargets();
  // Both harvests, deduplicated: a task waiting on its own merge is very often also the
  // task something else declared a dependency on, and asking twice would spend two `gh`
  // calls and two backoffs on one pull request.
  //
  // The OPERATIONAL set, kept as its own value rather than folded into `linkedUrls` below.
  // These are the URLs whose merge may complete a task and release its dependents, and only
  // these reach `reconcilePrMerges`. A telemetry-only URL - one whose task binding was
  // invalidated, so `taskPrPollTargets` no longer harvests it - must not acquire that
  // authority by riding along in the same map.
  const operationalUrls = new Set([
    ...registry.dependencyPrPollTargets(),
    ...registry.taskPrPollTargets(),
  ]);
  // The THIRD harvest: pull requests telemetry retained an observation of, whose operational
  // binding may be long gone. A third cadence would spend a second `gh` call and a second
  // backoff on a pull request the first two are usually already asking about, so it shares
  // this one and is deduplicated into it.
  const linkedUrls = [
    ...new Set([...operationalUrls, ...(telemetryTargets?.() ?? telemetryPrPollTargets(now))]),
  ];
  const found = new Map<string, PrMatch>();
  const skip = new Set<string>();
  const repoFound = new Map<string, PrMatch>();
  const repoSkip = new Set<string>();

  const queryable = targets.filter((t) => t.branch && !DEFAULT_BRANCHES.has(t.branch));
  const repoQueryable = repoTargets.filter((t) => !DEFAULT_BRANCHES.has(t.branch));
  if (
    queryable.length === 0 &&
    repoQueryable.length === 0 &&
    completedTargets.length === 0 &&
    linkedUrls.length === 0 &&
    headTargets.length === 0 &&
    workHeadTargets.length === 0
  ) {
    registry.reconcilePrs(found, skip); // clears any lingering link, spawns nothing
    return;
  }

  // A branch is checked out in exactly one worktree, so one `gh` call per cwd
  // answers for every session sharing it - and a secondary repo's worktree is simply
  // another cwd, so the whole fan-out still costs one call per checkout.
  const byCwd = new Map<string, string>();
  for (const t of queryable) byCwd.set(t.cwd, t.branch as string);
  for (const t of repoQueryable) byCwd.set(t.cwd, t.branch);
  const results = new Map<string, PrLookup>();
  const heads = new Map<string, string | null>();
  await Promise.all([
    ...[...byCwd].map(async ([cwd, branch]) => {
      results.set(cwd, await lookup(cwd, branch));
    }),
    forEachConcurrent(workHeadTargets, PR_URL_CONCURRENCY, async (target) => {
      const sha = await lookupHead(target.cwd, target.binding.branch!);
      registry.recordDependencyWorkHead(target, sha);
    }),
    forEachConcurrent(headTargets, PR_URL_CONCURRENCY, async (dir) => {
      heads.set(dir, await lookupHead(dir));
    }),
  ]);
  // Before the reconcilers below, which is the ordering the quorum depends on: both of them
  // can complete a task, and a task completed against last tick's heads is a task completed
  // against a repository whose work may since have moved off its baseline.
  if (headTargets.length > 0) registry.recordWorktreeHeads(heads, repoEvidenceTargets);

  for (const t of queryable) {
    const r = preferredPr(results.get(t.cwd) ?? null);
    if (r === "error") skip.add(t.id);
    else if (r) {
      if (r.state === "merged") sawMerged.add(r.url);
      const held = r.state === "merged"
        ? await stackMerges.held(r.url, t.cwd, registry.taskForSession(t.id, t.cwd)?.id ?? null, registry, stackGitHub)
        : null;
      // A merge GitHub cannot place yet says nothing about this session, like a `gh` that
      // failed: its chip and episode are left exactly as they were.
      if (held === "unknown") {
        skip.add(t.id);
        continue;
      }
      // Remembered on the Registry, so the session leaving this branch for its recovery keeps
      // its task even before the Inspector's next tick records the same merge.
      if (held === "stray") registry.noteStrayStackedMerge(r.url);
      found.set(t.id, {
        ...r,
        // A stacked pull request that merged off the default branch is the session's pull
        // request, but its work is unfinished: it is recorded unmerged, so the card carries it
        // (the stack's Broken label and Foreman's recovery read it there) and the work episode
        // holds it (which is what keeps the task when the session starts its recovery branch),
        // even when this poller never saw it open.
        ...(held === "stray" ? { state: "open" as const, mergedAt: null } : {}),
        branch: t.branch as string,
        agentSessionId: t.agentSessionId,
        episodeId: t.episodeId,
      });
    }
    // r === null (no matching PR) -> omitted from both -> reconcile clears the chip
  }
  for (const t of repoQueryable) {
    const r = preferredPr(results.get(t.cwd) ?? null);
    if (r === "error") repoSkip.add(t.key);
    else if (r) {
      repoFound.set(t.key, {
        ...r,
        branch: t.branch,
        agentSessionId: t.agentSessionId,
        episodeId: t.episodeId,
      });
    }
  }
  const observed = new Map(
    [...found.values(), ...repoFound.values()].map((match) => [match.url, match]),
  );
  const mergedUrls = new Map<string, number>();
  /** Merged, but held by the stacked-merge gate: nothing records them as a merge. */
  const heldUrls = new Set<string>();
  const closedUrls = new Set<string>();
  const dueUrls = urlState.due(linkedUrls, now);
  for (const url of linkedUrls) {
    const match = observed.get(url);
    if (!match) continue;
    if (match.state === "merged" && match.mergedAt !== null) {
      mergedUrls.set(url, match.mergedAt);
    }
    if (match.state === "closed") closedUrls.add(url);
  }
  await forEachConcurrent(
    dueUrls.filter((url) => !observed.has(url)),
    PR_URL_CONCURRENCY,
    async (url) => {
      const result = await lookupUrl(url);
      const merged = result !== "error" && result?.state === "merged" && result.mergedAt !== null;
      // A held merge keeps its URL on the ordinary backoff rather than being dropped as landed.
      const held = merged && await holdsMerge(url, null, null);
      if (held) heldUrls.add(url);
      urlState.record(url, held ? { state: "open", mergedAt: null } : result, now);
      if (result !== "error" && result?.state === "closed") closedUrls.add(url);
      if (result !== "error" && result?.state === "merged" && result.mergedAt !== null) {
        mergedUrls.set(url, result.mergedAt);
      }
    },
  );
  registry.reconcilePrs(found, skip);
  // After the session pass, and deliberately: `reconcilePrs` can settle a task through the
  // primary's merge, and the per-repo pass then has the task's own row already up to date.
  registry.reconcileRepoPrs(repoFound, repoSkip);
  // FILTERED to the operational harvest. Existing behaviour is byte-identical for every URL
  // that was already eligible, and a telemetry-only URL cannot enter `mergedPrFor`, complete
  // a task or satisfy a dependency edge by having been polled on the same tick. A URL that
  // carries BOTH reasons is in this set, so its operational reconciliation runs exactly as
  // it did before, under its own eligibility and selection-time rules.
  const operationalMerges = new Map(
    [...mergedUrls].filter(([url]) => operationalUrls.has(url) && !heldUrls.has(url)),
  );
  registry.reconcilePrMerges(operationalMerges);
  registry.reconcileClosedDependencyPrs(new Set([...closedUrls].filter(url => operationalUrls.has(url))));
  // Filter candidates by each retained ownership window before GitHub applies its limit.
  // Share identical searches and bound concurrency just as for the durable by-URL harvest.
  const completedByBranch = new Map<string, typeof completedTargets>();
  for (const target of registry.completedDependencyBranchTargets().filter(target => target.binding.branch && !DEFAULT_BRANCHES.has(target.binding.branch))) {
    const key = `${target.cwd}\0${target.binding.branch}\0${target.startedAt}\0${target.endedAt}\0${target.binding.workHeadSha}`;
    const group = completedByBranch.get(key) ?? [];
    group.push(target);
    completedByBranch.set(key, group);
  }
  await forEachConcurrent([...completedByBranch.values()], PR_URL_CONCURRENCY, async (group) => {
    const first = group[0]!;
    const result = await lookup(first.cwd, first.binding.branch!, {
      from: first.startedAt, until: first.endedAt, headSha: first.binding.workHeadSha ?? null,
    });
    if (!result || result === "error") return;
    for (const match of Array.isArray(result) ? result : [result]) {
      if (match.state === "merged") sawMerged.add(match.url);
      for (const target of group) {
        // The completed task's merge evidence passes the same gate: a stacked pull request
        // merged off the default branch is recorded as no merge (`reconcileCompletedDependencyPr`
        // refuses a merge without an instant).
        const held = match.state === "merged" && await holdsMerge(match.url, first.cwd, target.taskId);
        registry.reconcileCompletedDependencyPr(target, {
          ...match, mergedAt: held ? null : match.mergedAt, branch: target.binding.branch!,
          episodeId: target.binding.episodeId, agentSessionId: target.binding.agentSessionId,
        });
      }
    }
  });
  // And the observation-only half, which has authority over nothing. It emits the verified
  // late-delivery fact and stamps the retained row, carrying the attribution frozen when the
  // pull request was first associated rather than whatever the task is bound to today.
  // Delivery is resolved against each observation's current task/session/repository binding.
  // A URL can remain operational for another task or a dependency after this author lost it.
  // A held merge delivered nothing to the default branch, so it is not a delivery either.
  recordTelemetryPrMerges(new Map([...mergedUrls].filter(([url]) => !heldUrls.has(url))), undefined, now);
  // Last, so nothing above waits on it: a parent this tick saw merge has its open stacked
  // children pointed at the default branch now, instead of on the next Inspector tick.
  for (const url of mergedUrls.keys()) sawMerged.add(url);
  for (const match of repoFound.values()) if (match.state === "merged") sawMerged.add(match.url);
  await stackMerges.retargetChildren(sawMerged, stackGitHub, now);
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
