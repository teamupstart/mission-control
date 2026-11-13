import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import type { Session, Task } from "../src/shared/types.ts";
import type { PrRefs, PrSnapshot } from "../src/server/inspector/github.ts";
import type { StackGitHub } from "../src/server/stacking/github.ts";
import type { MergeInput } from "../src/shared/shipping.ts";

// A two-pull-request stack landing bottom-up under YOLO mode, through the real lifecycle
// observation, prompt candidate, release check and merge gate: the parent merges, the child
// is retargeted to the default branch and asked to merge the new base in and push (no
// force-push), it stays held until the restack is verified, and then merges as an ordinary
// pull request. Every GitHub call is recorded, so the daemon's only write - a base edit - is
// asserted, and the lifecycle modules are checked to spawn nothing (no git in any worktree).

const home = mkdtempSync(join(tmpdir(), "mission-stacking-landing-"));
process.env.HARNESS_HOME = home;
const db = await import("../src/server/db.ts");
const { observeStackLifecycle } = await import("../src/server/stacking/state.ts");
const { stackPromptCandidate, stackStandingFor } = await import("../src/server/stacking/delivery.ts");
const { adoptStackLineage, refreshStackRelease } = await import("../src/server/stacking/lineage.ts");
const { mergeVerdict } = await import("../src/shared/shipping.ts");
const { ShippingConfigSchema } = await import("../src/shared/protocol.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const PARENT = "https://github.com/acme/repo/pull/7";
const CHILD = "https://github.com/acme/repo/pull/8";
const CUT = "c".repeat(40);
const PARENT_HEAD = "d".repeat(40);
const MERGE = "e".repeat(40);
const CHILD_HEAD = "f".repeat(40);
const RESTACKED = "a".repeat(40);

const calls: string[] = [];
const refs = new Map<string, PrRefs>();
const ancestry = new Map<string, boolean>();
const seam: StackGitHub = {
  prRefs: async (_cwd, url) => {
    calls.push(`read ${url}`);
    const value = refs.get(url);
    return value ? { ok: true, value } : { ok: false, error: "unreadable" };
  },
  isAncestor: async (_c, _o, _r, base, head) => {
    calls.push(`compare ${base}..${head}`);
    const value = ancestry.get(`${base}..${head}`);
    return value === undefined ? { ok: false, error: "unknown" } : { ok: true, value };
  },
  compare: async (_c, _o, _r, base, head) => {
    calls.push(`compare ${base}..${head}`);
    const value = ancestry.get(`${base}..${head}`);
    return value === undefined ? { ok: false, error: "unknown" } : { ok: true, value: { contains: value, behindBy: value ? 0 : 1 } };
  },
  mergeBase: async () => ({ ok: false, error: "unused" }),
  branchSha: async () => ({ ok: false, reason: "unused", outcomeUnknown: false }),
  repositories: async () => [{ owner: "acme", repo: "repo" }],
  primaryRepository: async () => ({ owner: "acme", repo: "repo" }),
  retarget: async (_c, _o, _r, number, base) => {
    calls.push(`WRITE retarget #${number} -> ${base}`);
    return { ok: true };
  },
};

const childTask: Task = mkTask({ id: "child", status: "running", repoRoot: "/repo", stackParentTaskId: "parent",
  stackBaseBranch: "feat/parent", stackBaseSha: CUT, stackPrUrl: PARENT });
const ctx = {
  getTask: (id: string) => (id === "child" ? childTask : mkTask({ id, status: "running", repoRoot: "/repo" })),
  workEpisodeForTask: () => ({ episodeId: "ep-parent", prUrl: PARENT }),
  workEpisodeForSession: () => ({ episodeId: "ep-parent" }),
  taskForSession: () => undefined,
};

function snapshot(over: Partial<PrSnapshot>): PrSnapshot {
  return {
    state: "OPEN", headSha: CHILD_HEAD, headRefName: "feat/child", baseRefName: "feat/parent", defaultBranch: "main",
    mergeCommitSha: null, title: "child", body: "", isDraft: false, threads: [], reviews: [],
    reviewsPageInfo: { hasPreviousPage: false, startCursor: null }, createdAt: 0, mergeable: "MERGEABLE",
    reviewDecision: null, checks: "passing", ci: null, ...over,
  };
}

/** The YOLO gate for a pull request reviewed clean, live, on this head and this base. */
function verdict(over: { headSha: string; base: string; lineage: boolean; released: boolean }) {
  const input: MergeInput = {
    cfg: ShippingConfigSchema.parse({ autoMerge: true, soakMinutes: 0, repoAllowlist: ["/repo"] }),
    cwd: "/repo", repoRoot: "/repo",
    pr: { state: "OPEN", isDraft: false, headSha: over.headSha, createdAt: 0, mergeable: "MERGEABLE", reviewDecision: null,
      checks: "passing", unresolvedThreads: 0, baseRefName: over.base, defaultBranch: "main" },
    stack: { lineage: over.lineage, releasedForHead: over.released },
    reviewedBase: over.base, inspector: "live", reviewedSha: over.headSha, reviewPosture: "live", rounds: 1,
    openFindings: 0, workflowGate: "none", now: 1_000_000,
  };
  return mergeVerdict(input);
}

test("a two-PR stack lands bottom-up: parent merges, child is retargeted, prompted to restack, released, then merges", async () => {
  db.adoptInspectorPr({
    key: "acme/repo#8", url: CHILD, owner: "acme", repo: "repo", number: 8, repoRoot: "/repo", cwd: "/repo",
    sessionId: "child-session", source: "hook", state: "open", headSha: null, reviewPosture: null, round: 0,
    lastReviewedAt: null, lastError: null, failCount: 0, lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null,
    mergedAt: null, mergeBlock: null, observedHeadSha: null, observedState: null, observedAt: null,
    headRefName: "feat/child", title: null, adoptedAt: 1, updatedAt: 1,
  });
  assert.ok(adoptStackLineage("acme/repo#8", { task: childTask, episodeId: "ep-child" }, 1));
  const row = () => db.getInspectorPr("acme/repo#8")!;
  const session: Session = mkSession({
    id: "child-session", agentSessionId: "conv", runtime: "sdk", terminals: [], state: "idle", hooksSeen: true,
    stateConfirmed: true, lastActivity: 0, cwd: "/repo", repoRoot: "/repo", gitBranch: "feat/child", prState: "open",
    prNumber: 8, prUrl: CHILD, queue: null, note: null, pendingReviews: 0, task: { id: "child" } as Session["task"],
    inspector: { prKey: "acme/repo#8", url: CHILD, mode: "live", open: 0, postedOpen: 0, round: 1, lastReviewedAt: null, failed: false },
  });
  const registry = { liveSessions: () => [session], getSession: () => session, workflowRunSummaries: () => [] };
  const foreman = { enabled: true, mode: "live", repoAllowlist: ["/repo"] } as unknown as Parameters<typeof stackStandingFor>[2];

  // While the parent is open the child is on its branch: the bottom of the stack goes first.
  refs.set(PARENT, { state: "OPEN", isDraft: false, headSha: PARENT_HEAD, headRefName: "feat/parent", baseRefName: "main", defaultBranch: "main", mergeCommitSha: null });
  ancestry.set(`${PARENT_HEAD}..${CHILD_HEAD}`, true);
  await observeStackLifecycle(row(), snapshot({}), "/repo", seam, ctx, 10);
  assert.equal(verdict({ headSha: PARENT_HEAD, base: "main", lineage: false, released: false }).merge, true, "the parent merges first");
  assert.equal(verdict({ headSha: CHILD_HEAD, base: "feat/parent", lineage: true, released: false }).block, "stacked-base");

  // The parent merges (squash). The next tick retargets the child to the default branch.
  refs.set(PARENT, { ...refs.get(PARENT)!, state: "MERGED", mergeCommitSha: MERGE });
  await observeStackLifecycle(row(), snapshot({}), "/repo", seam, ctx, 20);
  assert.ok(calls.includes("WRITE retarget #8 -> main"));
  const standing = stackStandingFor(row(), [session], foreman)!;
  assert.equal(standing.state, "restack-needed");
  assert.deepEqual(standing.prompt, { kind: "restack", tip: MERGE, status: "pending" });
  // ...and the child's session is asked to merge the new base in and push, never force-push.
  const candidate = stackPromptCandidate(registry, "child-session", { prKey: "acme/repo#8", kind: "restack", tip: MERGE }, "foreman", row(), foreman);
  assert.equal(candidate.error, undefined);
  const payload = (candidate as { payload: string }).payload;
  assert.match(payload, /merge `origin\/main` into `feat\/child`/);
  assert.match(payload, /Push to `feat\/child`\. Do NOT force-push and do NOT rebase/);
  // On main, but not restacked yet: held.
  assert.equal(await refreshStackRelease(row(), snapshot({ baseRefName: "main" }), "/repo", seam, 30), false);
  assert.equal(verdict({ headSha: CHILD_HEAD, base: "main", lineage: true, released: false }).block, "stack-hold");

  // The session merged origin/main in and pushed: the parent's merge commit is in its history.
  ancestry.set(`${MERGE}..${RESTACKED}`, true);
  const restacked = snapshot({ headSha: RESTACKED, baseRefName: "main" });
  assert.equal(await refreshStackRelease(row(), restacked, "/repo", seam, 40), true);
  await observeStackLifecycle(row(), restacked, "/repo", seam, ctx, 40);
  assert.equal(stackStandingFor(row(), [session], foreman)!.state, "released");
  // Reviewed clean against main on its new head, it now merges through the ordinary gates.
  const released = row().stack!.releasedHeadSha === RESTACKED;
  assert.equal(verdict({ headSha: RESTACKED, base: "main", lineage: true, released }).merge, true, "the child lands after its parent");

  // The only GitHub write the lifecycle made was that one base edit.
  assert.deepEqual(calls.filter((call) => call.startsWith("WRITE")), ["WRITE retarget #8 -> main"]);
});

test("the lifecycle modules run no git and spawn nothing: GitHub reads and a base edit only", () => {
  for (const file of ["src/server/stacking/state.ts", "src/server/stacking/delivery.ts"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import[^;]+from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    for (const spec of imports) {
      assert.doesNotMatch(spec, /child_process|util\/exec|\/git\//, `${file} imports ${spec}`);
    }
    assert.doesNotMatch(source, /\b(run|spawn|execFile|exec)\(\s*["']git["']/, `${file} runs git`);
    assert.doesNotMatch(source, /--force|push -f|force-with-lease/, `${file} force-pushes`);
  }
});
