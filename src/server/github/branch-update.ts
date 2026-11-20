import { z } from "zod";
import { ghBin } from "../config.ts";
import { openDb } from "../db.ts";
import { featureEnabled } from "../feature-flags/index.ts";
import { run } from "../util/exec.ts";
import { parsePrUrl, refusalReason } from "../inspector/github.ts";
import { CHECK_CONTEXTS, rollUpChecks } from "./check-rollup.ts";
import type { PrBranchUpdate } from "@shared/pr-branch-update.ts";
import type { Registry } from "../registry.ts";

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const UNKNOWN_UPDATE_REASON = "Branch update outcome unknown. GitHub may have accepted the update; check the PR before retrying.";
const BRANCH_UPDATE_CONCURRENCY = 4;
const SnapshotSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(),
  headRefOid: Sha, baseRefOid: Sha, baseRefName: z.string().min(1),
  mergeStateStatus: z.string(), mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  reviewDecision: z.enum(["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"]).nullable(),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: Sha,
    statusCheckRollup: z.object({ contexts: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(z.unknown()),
    }) }).nullable(),
  }) })).length(1) }),
});
export type BranchSnapshot = z.infer<typeof SnapshotSchema>;
const QUERY = `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){
  pullRequest(number:$number){ state isDraft headRefOid baseRefOid baseRefName mergeStateStatus mergeable reviewDecision
    commits(last:1){ nodes{ commit{ oid statusCheckRollup{ ${CHECK_CONTEXTS} } } } }
  }
} }`;
export async function readBranchSnapshot(url: string, cwd: string): Promise<BranchSnapshot | null> {
  const pr = parsePrUrl(url);
  if (!pr) return null;
  const result = await run(ghBin(), ["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${pr.owner}`,
    "-F", `name=${pr.repo}`, "-F", `number=${pr.number}`], { cwd, timeoutMs: 8000 });
  if (result.code !== 0) return null;
  try {
    const json = JSON.parse(result.stdout);
    if (json.errors?.length) return null;
    const parsed = SnapshotSchema.safeParse(json.data?.repository?.pullRequest);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
function checksReady(pr: BranchSnapshot): boolean {
  const commit = pr.commits.nodes[0]!.commit;
  if (commit.oid !== pr.headRefOid) return false;
  const contexts = commit.statusCheckRollup?.contexts;
  if (!contexts) return pr.mergeStateStatus === "CLEAN"; // No green evidence yet on a behind head.
  if (contexts.pageInfo.hasNextPage) return false; // incomplete evidence never authorizes a write
  const checks = rollUpChecks(contexts.nodes);
  return checks.recognized && (checks.checks === "passing" || contexts.nodes.length === 0);
}
export function branchUpdateEligible(pr: BranchSnapshot): boolean {
  return pr.state === "OPEN" && !pr.isDraft && pr.mergeStateStatus === "BEHIND" &&
    pr.mergeable === "MERGEABLE" && checksReady(pr) &&
    (pr.reviewDecision === null || pr.reviewDecision === "APPROVED");
}
function sameRevision(a: BranchSnapshot, b: BranchSnapshot): boolean {
  return a.headRefOid === b.headRefOid && a.baseRefOid === b.baseRefOid && a.baseRefName === b.baseRefName;
}
type Attempt = { head_sha: string; base_sha: string; status: string; reason: string | null; attempted_at: number };
export interface BranchUpdateDeps {
  read: typeof readBranchSnapshot;
  update: (url: string, cwd: string, head: string) => Promise<PrBranchUpdate | null>;
  enabled: () => boolean;
}
const defaults: BranchUpdateDeps = {
  read: readBranchSnapshot,
  enabled: () => featureEnabled("automatic-pr-branch-update"),
  async update(url, cwd, head) {
    const pr = parsePrUrl(url)!;
    const result = await run(ghBin(), ["api", "--method", "PUT",
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/update-branch`, "-f", `expected_head_sha=${head}`],
    { cwd, timeoutMs: 20_000 });
    if (result.outcomeUnknown) return { status: "blocked", reason: UNKNOWN_UPDATE_REASON };
    // 202 means accepted, not completed. Only a later read of the head confirms it.
    if (result.code === 0) return null;
    const reason = refusalReason({ ok: false, stderr: result.stderr, error: result.stdout });
    return { status: /conflict/i.test(reason) ? "conflict" : "blocked", reason: reason || "GitHub did not confirm the update." };
  },
};

/** Durable claim before the PUT: a timeout or restart cannot repeat a possibly accepted write. */
export async function reconcileBranchUpdate(
  url: string, cwd: string, publish: (update: PrBranchUpdate | null) => void,
  stillOwned: () => boolean, deps: BranchUpdateDeps = defaults,
): Promise<void> {
  if (!deps.enabled() || !stillOwned()) { publish(null); return; }
  const pr = await deps.read(url, cwd);
  if (!pr) return; // unknown does not erase a refusal or make an old check green
  if (!stillOwned() || !deps.enabled()) return;
  if (pr.state !== "OPEN") { publish(null); return; }
  const db = openDb();
  const args = [url, pr.headRefOid, pr.baseRefOid];
  const known = db.prepare(`SELECT * FROM pr_branch_update_attempts
    WHERE pr_url = ? AND head_sha = ? AND base_sha = ?`).get(...args) as Attempt | undefined;
  if (known) {
    // GitHub's current answer supersedes stale feedback, but the claim still prevents retries.
    if (pr.mergeStateStatus === "CLEAN") { publish(null); return; }
    if (known.status === "updating" && (pr.mergeable === "CONFLICTING" || Date.now() - known.attempted_at > 120_000)) {
      known.status = pr.mergeable === "CONFLICTING" ? "conflict" : "blocked";
      known.reason = pr.mergeable === "CONFLICTING" ? "GitHub reports conflicts with the target branch." :
        "GitHub has not confirmed a new commit after the update request. Check the PR on GitHub.";
      db.prepare(`UPDATE pr_branch_update_attempts SET status = ?, reason = ?
        WHERE pr_url = ? AND head_sha = ? AND base_sha = ?`).run(known.status, known.reason, ...args);
    }
    publish({ status: known.status as PrBranchUpdate["status"], reason: known.reason });
    return;
  }
  const latest = db.prepare(`SELECT * FROM pr_branch_update_attempts WHERE pr_url = ?
    ORDER BY attempted_at DESC, rowid DESC LIMIT 1`).get(url) as Attempt | undefined;
  if (latest && latest.head_sha !== pr.headRefOid) {
    // Never reuse old checks/reviews: this answer came with this exact commit's oid.
    const status = !checksReady(pr)
      ? "checks" : pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED" ? "review" : null;
    publish(status ? { status, reason: null } : null);
  } else publish(null);
  if (!branchUpdateEligible(pr)) return;
  const fresh = await deps.read(url, cwd);
  if (!fresh || !sameRevision(pr, fresh) || !branchUpdateEligible(fresh) || !deps.enabled() || !stillOwned()) return;
  const claim = db.prepare(`INSERT OR IGNORE INTO pr_branch_update_attempts
    (pr_url, head_sha, base_sha, status, reason, attempted_at) VALUES (?, ?, ?, 'updating', NULL, ?)`)
    .run(...args, Date.now());
  if (!claim.changes) return;
  publish({ status: "updating", reason: null });
  let failure: PrBranchUpdate | null;
  try { failure = await deps.update(url, cwd, pr.headRefOid); }
  catch { failure = { status: "blocked", reason: UNKNOWN_UPDATE_REASON }; }
  if (failure) {
    db.prepare(`UPDATE pr_branch_update_attempts SET status = ?, reason = ?
      WHERE pr_url = ? AND head_sha = ? AND base_sha = ?`)
      .run(failure.status, failure.reason, ...args);
    if (stillOwned() && deps.enabled()) publish(failure);
  }
}

/** Runs with the existing PR poller, independent of Inspector and merge permission. */
export async function pollBranchUpdates(registry: Registry, active: () => boolean, deps: BranchUpdateDeps = defaults): Promise<void> {
  const targets = registry.prPollTargets().filter(t => t.prUrl).map(t => ({ id: t.id, url: t.prUrl!, cwd: t.cwd }));
  for (const t of registry.extraRepoPrPollTargets()) {
    const url = registry.getSession(t.sessionId)?.task?.repoPrs.find(pr => pr.repoRoot === t.repoRoot)?.prUrl;
    if (url) targets.push({ id: t.sessionId, url, cwd: t.cwd });
  }
  const identities = new Map(targets.map(t => {
    const session = registry.getSession(t.id);
    return [t.id, { agentSessionId: session?.agentSessionId, cwd: session?.cwd, branch: session?.gitBranch,
      episodeId: registry.recordedWorkEpisodeForSession(t.id)?.episodeId }];
  }));
  const grouped = new Map<string, typeof targets>();
  for (const target of targets) grouped.set(target.url, [...(grouped.get(target.url) ?? []), target]);
  const groups = [...grouped];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(BRANCH_UPDATE_CONCURRENCY, groups.length) }, async () => {
    while (next < groups.length && active()) {
      const [url, owners] = groups[next++]!;
      const owned = (id: string): boolean => {
        const s = registry.getSession(id);
        const identity = identities.get(id);
        return !!s && s.state !== "exited" && s.agentSessionId === identity?.agentSessionId &&
          registry.recordedWorkEpisodeForSession(id)?.episodeId === identity?.episodeId &&
          s.cwd === identity?.cwd && s.gitBranch === identity?.branch && (s.prUrl === url || !!s.task?.repoPrs.some(pr => pr.prUrl === url));
      };
      try { await reconcileBranchUpdate(url, owners[0]!.cwd,
        update => { for (const owner of owners) if (owned(owner.id)) registry.setPrBranchUpdate(owner.id, url, update); },
        () => active() && owners.some(owner => owned(owner.id)), deps); }
      catch (error) { console.error("[pr] branch update failed:", url, error); }
    }
  }));
}
