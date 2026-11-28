import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PrMatch } from "../src/server/registry.ts";
import type { BranchSnapshot } from "../src/server/github/branch-update.ts";
import { tempDir } from "./temp-root.mjs";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = tempDir("harness-pr-");
const { Registry, prNumberFromUrl } = await import("../src/server/registry.ts");
const { pollBranchUpdates } = await import("../src/server/github/branch-update.ts");

function disco(over: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    syntheticId: "s",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/wt",
    gitBranch: "feat/x",
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: null,
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

const PR = "https://github.com/o/r/pull/42";

function match(over: Partial<PrMatch> = {}): PrMatch {
  const result: PrMatch = {
    url: PR,
    number: 42,
    state: "open",
    checks: null,
    branch: "feat/x",
    agentSessionId: null,
    episodeId: null,
    createdAt: null,
    mergedAt: null,
    headSha: null,
    worktreeHeadSha: null,
    ...over,
  };
  if (result.state === "merged" && result.mergedAt === null) result.mergedAt = Date.now();
  return result;
}

test("reconcilePrs sets the open PR on the matching session", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);

  reg.reconcilePrs(new Map([["feat", match()]]), new Set());

  assert.equal(reg.getSession("feat")!.prUrl, PR);
  assert.equal(reg.getSession("feat")!.prNumber, 42);
  assert.equal(reg.getSession("feat")!.prState, "open");
  assert.equal(reg.getSession("feat")!.prChecks, null);
});

test("reconcilePrs tracks the PR's CI check status as it changes", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);

  // Checks start pending, then one fails: the card keys its alert off "failing".
  reg.reconcilePrs(new Map([["feat", match({ checks: "pending" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prChecks, "pending");

  reg.reconcilePrs(new Map([["feat", match({ checks: "failing" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prChecks, "failing");

  // A re-run turns them green again -> the alert clears.
  reg.reconcilePrs(new Map([["feat", match({ checks: "passing" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prChecks, "passing");
});

test("discovery sweeps retain PR branch-update progress and conflict recovery", () => {
  const reg = new Registry();
  const discovered = disco({ syntheticId: "branch-update" });
  reg.applyDiscovery([discovered]);
  reg.reconcilePrs(new Map([[discovered.syntheticId, match()]]), new Set());
  for (const status of ["updating", "checks", "conflict"] as const) {
    const update = { status, reason: status === "conflict" ? "Merge conflict" : null };
    reg.setPrBranchUpdate(discovered.syntheticId, PR, update);
    reg.applyDiscovery([discovered]);
    assert.deepEqual(reg.getSession(discovered.syntheticId)?.prBranchUpdates?.[PR], update);
  }
});

test("branch snapshots use four workers and reconcile each shared PR URL once", async () => {
  const reg = new Registry();
  const sessions = Array.from({ length: 9 }, (_, i) => disco({ syntheticId: `pr-worker-${i}`, cwd: `/wt/${i}` }));
  const urls = Array.from({ length: 8 }, (_, i) => `https://github.com/o/r/pull/${i + 1}`);
  reg.applyDiscovery(sessions);
  reg.reconcilePrs(new Map(sessions.map((s, i) => [s.syntheticId, match({ url: urls[i % 8]! })])), new Set());
  const reads: string[] = [];
  let running = 0;
  let peak = 0;
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const poll = pollBranchUpdates(reg, () => true, {
    enabled: () => true,
    read: async url => {
      reads.push(url); peak = Math.max(peak, ++running);
      await stalled;
      running--;
      return null;
    },
    update: async () => { assert.fail("unknown snapshots must not update a branch"); },
  });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reads.length, 4, "slow snapshots occupy a bounded pool instead of serializing all PRs");
  } finally {
    release();
    await poll;
  }
  assert.equal(peak, 4, "GitHub and subprocess load stays bounded");
  assert.deepEqual(reads.sort(), urls.sort(), "two sessions sharing a PR cause only one snapshot read");
});

test("a work-episode reset during either snapshot prevents a stale branch update", async () => {
  for (const resetDuringRead of [0, 1, 2]) {
    const reg = new Registry();
    const id = `episode-update-${resetDuringRead}`;
    const url = `https://github.com/o/r/pull/${100 + resetDuringRead}`;
    reg.applyDiscovery([disco({ syntheticId: id, agentSessionId: `agent-${id}` })]);
    const episode = reg.workEpisodeForSession(id)!;
    reg.reconcilePrs(new Map([[id, match({ url, episodeId: episode.episodeId, agentSessionId: `agent-${id}`,
      createdAt: Date.now(), headSha: "a".repeat(40), worktreeHeadSha: "a".repeat(40) })]]), new Set());
    const before = reg.getSession(id)!;
    const ready: BranchSnapshot = {
      state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40),
      baseRefName: "main", mergeStateStatus: "BEHIND", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
      commits: { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { contexts: {
        pageInfo: { hasNextPage: false }, nodes: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
      } } } }] },
    };
    const writes: string[] = [];
    let reads = 0;
    await pollBranchUpdates(reg, () => true, {
      enabled: () => true,
      read: async () => {
        if (++reads === resetDuringRead) reg.resetWorkEpisode(id);
        return ready;
      },
      update: async (_url, _cwd, head) => { writes.push(head); return null; },
    });
    assert.equal(reads, resetDuringRead === 1 ? 1 : 2);
    assert.deepEqual(writes, resetDuringRead ? [] : [ready.headRefOid]);
    if (resetDuringRead) {
      assert.notEqual(reg.recordedWorkEpisodeForSession(id)?.episodeId, episode.episodeId);
      const after = reg.getSession(id)!;
      for (const field of ["agentSessionId", "cwd", "gitBranch", "prUrl"] as const) {
        assert.equal(after[field], before[field], `${field} alone cannot detect the episode reset`);
      }
      assert.equal(after.prBranchUpdates?.[url]?.status, undefined, "the old episode cannot publish Updating branch");
    }
  }
});

test("a merged PR flips the chip to merged and lingers while on the branch", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["feat", match()]]), new Set());

  // The PR merges: the poller still finds it (state=all) and reports it merged.
  reg.reconcilePrs(new Map([["feat", match({ state: "merged" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prUrl, PR);
  assert.equal(reg.getSession("feat")!.prState, "merged");

  // A later sweep still reporting it merged keeps the chip (no branch change yet).
  reg.reconcilePrs(new Map([["feat", match({ state: "merged" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prState, "merged");
});

test("reconcilePrs clears the chip once the branch has no matching PR", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["feat", match()]]), new Set());
  assert.equal(reg.getSession("feat")!.prUrl, PR);

  // Next sweep: gh finds no matching PR for the branch after it moved
  // -> absent from `found` -> cleared.
  reg.reconcilePrs(new Map(), new Set());

  assert.equal(reg.getSession("feat")!.prUrl, null);
  assert.equal(reg.getSession("feat")!.prNumber, null);
  assert.equal(reg.getSession("feat")!.prState, null);
});

test("reconcilePrs leaves the chip untouched when gh errored (session in skip)", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["feat", match({ state: "merged" })]]), new Set());

  // gh missing/unauthenticated this tick -> skip -> a transient failure must not
  // wipe a real chip (even a merged one).
  reg.reconcilePrs(new Map(), new Set(["feat"]));

  assert.equal(reg.getSession("feat")!.prUrl, PR);
  assert.equal(reg.getSession("feat")!.prState, "merged");
});

test("a reset-and-reused session drops the old chip, then shows the new PR", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "s1", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["s1", match({ state: "merged" })]]), new Set());
  assert.equal(reg.getSession("s1")!.prUrl, PR);

  // The session is reset onto a fresh branch: discovery updates the branch, and
  // the next reconcile (branch's PR not in `found`) retracts the merged chip.
  reg.applyDiscovery([disco({ syntheticId: "s1", gitBranch: "feat/y" })]);
  reg.reconcilePrs(new Map(), new Set());
  assert.equal(reg.getSession("s1")!.prUrl, null);
  assert.equal(reg.getSession("s1")!.prState, null);

  // A PR is opened on the new branch -> the chip repopulates.
  const pr2 = "https://github.com/o/r/pull/43";
  reg.reconcilePrs(
    new Map([["s1", match({ url: pr2, number: 43, branch: "feat/y" })]]),
    new Set(),
  );
  assert.equal(reg.getSession("s1")!.prUrl, pr2);
  assert.equal(reg.getSession("s1")!.prNumber, 43);
  assert.equal(reg.getSession("s1")!.prState, "open");
});

test("prPollTargets drops sessions without a cwd and exited sessions", () => {
  const reg = new Registry();
  reg.applyDiscovery([
    disco({ syntheticId: "ok", cwd: "/wt", gitBranch: "feat/x" }),
    disco({ syntheticId: "nocwd", cwd: null, gitBranch: "feat/x" }),
  ]);
  // Drop "ok" from discovery so it transitions to the exited state.
  reg.applyDiscovery([disco({ syntheticId: "nocwd", cwd: null, gitBranch: "feat/x" })]);

  const targets = reg.prPollTargets();
  assert.equal(
    targets.find((t) => t.id === "ok"),
    undefined,
  );
  assert.equal(
    targets.find((t) => t.id === "nocwd"),
    undefined,
  );
});

test("prNumberFromUrl parses the PR number, else null", () => {
  assert.equal(prNumberFromUrl("https://github.com/o/r/pull/123"), 123);
  assert.equal(prNumberFromUrl("https://github.com/o/r/tree/main"), null);
});


test("reconcilePrs retains closed PRs and follows reopening", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  for (const state of ["open", "closed", "open"] as const) {
    reg.reconcilePrs(new Map([["feat", match({ state })]]), new Set());
    assert.equal(reg.getSession("feat")!.prUrl, PR);
    assert.equal(reg.getSession("feat")!.prState, state);
  }
});

test("check detail changes publish independently of rollup and survive discovery, then clear with the PR", () => {
  const reg = new Registry();
  const discovered = disco({ syntheticId: "ci-details" });
  reg.applyDiscovery([discovered]);
  const first = { complete: true, results: [{ name: "build", conclusion: "CANCELLED", url: null }] };
  reg.reconcilePrs(new Map([[discovered.syntheticId, match({ checks: "failing", checkDetails: first })]]), new Set());
  reg.applyDiscovery([discovered]);
  assert.deepEqual(reg.getSession(discovered.syntheticId)?.prCheckDetails, first);
  const second = { complete: true, results: [{ name: "build", conclusion: "FAILURE", url: "https://ci.example/job" }] };
  reg.reconcilePrs(new Map([[discovered.syntheticId, match({ checks: "failing", checkDetails: second })]]), new Set());
  assert.deepEqual(reg.getSession(discovered.syntheticId)?.prCheckDetails, second);
  reg.reconcilePrs(new Map(), new Set());
  assert.equal(reg.getSession(discovered.syntheticId)?.prCheckDetails, null);
});
