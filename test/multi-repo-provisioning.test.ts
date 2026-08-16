import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Provisioning a task that attaches more than one repository.
//
// The case this file exists for is narrow and was a real defect in the plan as first
// written: the git-fallback worktree destination was keyed on the TASK
// (`WORKTREES_DIR/<taskId>`), so looping it over a task's repos provisioned the first one
// and then ran `git worktree add` against a directory that already existed. Nothing about
// that failure names the cause - the dispatch just fails - so it is pinned here directly.
//
// The other half is the promise that single-repo dispatch is untouched: slot 0's path is
// asserted to be the exact legacy join, character for character.

const home = mkdtempSync(join(tmpdir(), "mission-multirepo-provision-"));
// Set before importing anything that resolves the state dir - WORKTREES_DIR hangs off it.
process.env.HARNESS_HOME = join(home, "state");

const { WORKTREES_DIR } = await import("../src/server/config.ts");
const {
  provisionWorktree,
  worktreeSlotPath,
  teardownWorktree,
  intentWithRepoManifest,
  releasedTaskResources,
  WorktreeTeardownError,
} = await import("../src/server/dispatcher.ts");

after(() => rmSync(home, { recursive: true, force: true }));

// None of these repos opts into treehouse, so every arm here is the git fallback: nothing
// is leased, nothing is held, and a reap has nothing to consider.
const NO_PINS = () => ({ sessionCwds: [], taskWorktrees: [], checkLeasePaths: [] });

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
}

function mkRepo(name: string): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@test");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), `${name}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  return repo;
}

// ---- the slot, which is what makes the loop possible -----------------------------------

test("slot 0 is exactly the path single-repo dispatch has always used", () => {
  // Character for character, not merely "under WORKTREES_DIR". Every task dispatched
  // before this feature recorded this path, and startup reconciliation and teardown both
  // read the recorded value - so a slot scheme that renamed slot 0 would orphan the tree of
  // every task in flight across the upgrade.
  assert.equal(worktreeSlotPath("task-abc", 0), join(WORKTREES_DIR, "task-abc"));
  assert.equal(worktreeSlotPath("task-abc", 1), join(WORKTREES_DIR, "task-abc-1"));
  assert.equal(worktreeSlotPath("task-abc", 2), join(WORKTREES_DIR, "task-abc-2"));
});

test("two non-pool repos on one task provision to distinct paths and both succeed", async () => {
  // The case that fails outright without the slot: same task id, same slug, same short id -
  // which is deliberate, because the BRANCH is meant to be identical across repos - and
  // only the destination may differ.
  const api = mkRepo("api");
  const web = mkRepo("web");

  const primary = await provisionWorktree(api, "two-repos", "slug", "abc123", NO_PINS, null, 0);
  const secondary = await provisionWorktree(web, "two-repos", "slug", "abc123", NO_PINS, null, 1);

  assert.notEqual(primary.path, secondary.path);
  assert.equal(existsSync(primary.path), true);
  assert.equal(existsSync(secondary.path), true);
  // One branch name across the set is what makes the resulting pull requests legible as
  // one task. They live in different repositories, so they cannot collide.
  assert.equal(primary.branch, "harness/slug-abc123");
  assert.equal(secondary.branch, "harness/slug-abc123");
  // Each tree belongs to its OWN repo, which is the thing a shared path would have broken
  // long before anybody noticed the branch names matched.
  assert.equal(git(primary.path, "rev-parse", "HEAD"), git(api, "rev-parse", "HEAD"));
  assert.equal(git(secondary.path, "rev-parse", "HEAD"), git(web, "rev-parse", "HEAD"));
});

test("two repos that share a basename still get distinct trees", async () => {
  // Why the suffix is the slot rather than the repo's name. `~/a/api` and `~/b/api` are
  // different repositories with one basename, and a name-derived path would collide again.
  mkdirSync(join(home, "a"), { recursive: true });
  mkdirSync(join(home, "b"), { recursive: true });
  const first = mkRepo(join("a", "api"));
  const second = mkRepo(join("b", "api"));

  const one = await provisionWorktree(first, "same-name", "slug", "def456", NO_PINS, null, 0);
  const two = await provisionWorktree(second, "same-name", "slug", "def456", NO_PINS, null, 1);
  assert.notEqual(one.path, two.path);
  assert.equal(existsSync(one.path), true);
  assert.equal(existsSync(two.path), true);
});

// ---- the baseline every later phase reads ----------------------------------------------

test("every provisioned tree records the full oid it was cut at", async () => {
  // Phases 2 and 3 decide whether a repo CHANGED by comparing its head against this, so a
  // short id or a null on the ordinary path would make the changed-set rule unusable.
  const repo = mkRepo("baseline");
  const head = git(repo, "rev-parse", "HEAD");

  const single = await provisionWorktree(repo, "baseline-single", "slug", "aaa111", NO_PINS);
  assert.equal(single.baseSha, head);
  assert.match(single.baseSha ?? "", /^[0-9a-f]{40}$/);

  // Recorded on a single-repo dispatch too - one code path, and phase 3 gets a baseline for
  // the ordinary case rather than only for the exotic one.
  const other = mkRepo("baseline-two");
  const secondary = await provisionWorktree(other, "baseline-single", "slug", "aaa111", NO_PINS, null, 1);
  assert.equal(secondary.baseSha, git(other, "rev-parse", "HEAD"));
});

// ---- teardown loops the collection -----------------------------------------------------

test("teardown returns every tree the task holds, primary and secondaries alike", async () => {
  const api = mkRepo("teardown-api");
  const web = mkRepo("teardown-web");
  const primary = await provisionWorktree(api, "teardown-task", "slug", "bbb222", NO_PINS, null, 0);
  const secondary = await provisionWorktree(web, "teardown-task", "slug", "bbb222", NO_PINS, null, 1);

  await teardownWorktree({
    repoRoot: api,
    worktreePath: primary.path,
    branch: primary.branch,
    provider: primary.provider,
    worktreeLeaseId: primary.leaseId,
    homeName: null,
    extraRepos: [
      {
        repoRoot: web,
        worktreePath: secondary.path,
        branch: secondary.branch,
        provider: secondary.provider,
        worktreeLeaseId: secondary.leaseId,
      },
    ],
  });

  assert.equal(existsSync(primary.path), false, "the primary tree is gone");
  assert.equal(existsSync(secondary.path), false, "the secondary tree is gone too");
  // Throwaway `harness/` branches are dropped in BOTH repos, so re-dispatching the same
  // task can cut them again.
  assert.equal(git(api, "branch", "--list", "harness/slug-bbb222"), "");
  assert.equal(git(web, "branch", "--list", "harness/slug-bbb222"), "");
});

test("one tree failing to come back does not strand the others", async () => {
  // Reported together rather than at the first failure. Stopping early would leave the
  // remaining trees on disk with nothing that will ever come back for them - the caller
  // nulls the whole collection on the row either way.
  const api = mkRepo("partial-api");
  const web = mkRepo("partial-web");
  const primary = await provisionWorktree(api, "partial-task", "slug", "ccc333", NO_PINS, null, 0);
  const secondary = await provisionWorktree(web, "partial-task", "slug", "ccc333", NO_PINS, null, 1);

  // The error reports what it DID reclaim, which is what lets a caller clear exactly those
  // trees. A partial failure read as a total one leaves the row naming worktrees that are
  // already gone - `poolPins` goes on sparing them, and a retry re-issues a lease return
  // against a tree the pool has already taken back.
  const failure = await teardownWorktree({
    // A repo root that is not a git repository at all: its removal cannot succeed.
    repoRoot: join(home, "not-a-repo"),
    worktreePath: join(home, "not-a-repo", "tree"),
    branch: "harness/slug-ccc333",
    provider: "git",
    homeName: null,
    extraRepos: [
      { repoRoot: api, worktreePath: primary.path, branch: primary.branch, provider: "git" },
      { repoRoot: web, worktreePath: secondary.path, branch: secondary.branch, provider: "git" },
    ],
  }).then(() => null, (err: unknown) => err);

  assert.ok(failure instanceof WorktreeTeardownError, "a partial teardown reports which trees came back");
  assert.match((failure as Error).message, /worktree remove failed/);
  assert.deepEqual(
    [...(failure as InstanceType<typeof WorktreeTeardownError>).reclaimed].sort(),
    [primary.path, secondary.path].sort(),
    "the two reachable trees are named as reclaimed; the broken one is not",
  );
  assert.equal(existsSync(primary.path), false, "the reachable trees still came back");
  assert.equal(existsSync(secondary.path), false);
});

// ---- the manifest ----------------------------------------------------------------------

const BASE_TASK = {
  id: "t1",
  title: "Ship it",
  intent: "Rename the field everywhere.",
  kind: "ship" as const,
  agent: "claude" as const,
  priority: null,
  labels: [],
  dependencies: [],
  enabled: true,
  model: null,
  effort: null,
  workflowId: null,
  source: null,
  pipelineRun: null,
  repoRoot: "/repo/api",
  worktreePath: "/wt/t1",
  branch: "harness/ship-it-abc123",
  provider: "git" as const,
  worktreeLeaseId: null,
  baseSha: "a".repeat(40),
  extraRepos: [],
  homeName: null,
  terminalResourceId: null,
  sessionId: null,
  scheduleId: null,
  scheduleOccurrenceId: null,
  scheduledFor: null,
  status: "running" as const,
  outcome: null,
  outcomeUrl: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  dispatchedAt: null,
  completedAt: null,
};

test("a single-repo task's intent is delivered untouched", () => {
  // Byte-identical, which is the whole claim this phase makes about existing behaviour.
  assert.equal(intentWithRepoManifest(BASE_TASK), "Rename the field everywhere.");
});

test("a multi-repo task's intent is prefixed with where each repo lives and what to open", () => {
  const manifest = intentWithRepoManifest({
    ...BASE_TASK,
    extraRepos: [
      {
        repoRoot: "/repo/web",
        worktreePath: "/wt/t1-1",
        branch: "harness/ship-it-abc123",
        provider: "git",
        worktreeLeaseId: null,
        baseSha: "b".repeat(40),
        prUrl: null,
        prState: null,
        mergedAt: null,
      },
    ],
  });

  // Where each repo actually is - nothing in the primary worktree names the others.
  assert.match(manifest, /\/wt\/t1 - PRIMARY/);
  assert.match(manifest, /\/wt\/t1-1 - from \/repo\/web/);
  // The branch, because it is the same in every repo here and an agent that invented its
  // own would break the one thing that makes the pull requests legible as a single task.
  // Asserted as the SHARED-branch sentence rather than a bare substring, so the case below -
  // where the names genuinely differ - cannot pass this one by accident.
  assert.match(manifest, /Every one of them is on the branch harness\/ship-it-abc123\./);
  // The two standing instructions the agent cannot infer from inside its cwd.
  assert.match(manifest, /AGENTS\.md \/ CLAUDE\.md/);
  assert.match(manifest, /ONE pull request per repository/);
  // The operator's own words still arrive, and arrive last.
  assert.ok(manifest.endsWith("Rename the field everywhere."));
});

test("a repo with no worktree is left out of the manifest", () => {
  // The manifest is composed after provisioning, so an entry without a tree is a bug being
  // reported to the wrong audience - the agent cannot act on it.
  const manifest = intentWithRepoManifest({
    ...BASE_TASK,
    extraRepos: [
      {
        repoRoot: "/repo/web",
        worktreePath: null,
        branch: null,
        provider: null,
        worktreeLeaseId: null,
        baseSha: null,
        prUrl: null,
        prState: null,
        mergedAt: null,
      },
    ],
  });
  assert.equal(manifest, "Rename the field everywhere.");
});

// ---- resolving the repo set ------------------------------------------------------------

const { resolveTaskRepoSet } = await import("../src/server/repos.ts");
const { DispatchSchema, UpdateTaskSchema, isAnnotationOnlyUpdate } = await import(
  "@shared/protocol.ts"
);

test("the whole repo set is resolved through one door", async () => {
  const api = mkRepo("resolve-api");
  const web = mkRepo("resolve-web");

  // Every entry comes back CANONICAL - the same walk-back to a main checkout the primary
  // has always had, applied to the secondaries too. That is what makes the refusals below
  // decidable at all: two spellings of one repo are only comparable after this.
  const ok = await resolveTaskRepoSet(api, [web]);
  assert.deepEqual(ok, {
    ok: true,
    repoRoot: realpathSync(api),
    extraRepoRoots: [realpathSync(web)],
  });

  // Order is preserved, because it IS the persisted position and therefore the slot each
  // secondary's worktree path is derived from.
  const docs = mkRepo("resolve-docs");
  const ordered = await resolveTaskRepoSet(api, [docs, web]);
  assert.deepEqual(ordered.ok && ordered.extraRepoRoots, [realpathSync(docs), realpathSync(web)]);
});

test("a secondary that is the primary, or repeated, is refused", async () => {
  const api = mkRepo("dedupe-api");
  const web = mkRepo("dedupe-web");

  // Attaching the primary again would provision two worktrees of one checkout on one
  // branch name - and only a resolver that has walked both sides back to a main checkout
  // can see that two spellings are one repo, which is why this refusal lives here.
  const collision = await resolveTaskRepoSet(api, [`${api}/`]);
  assert.equal(collision.ok, false);
  assert.match(collision.ok === false ? collision.error : "", /already this task's primary repo/);

  const twice = await resolveTaskRepoSet(api, [web, web]);
  assert.equal(twice.ok, false);
  assert.match(twice.ok === false ? twice.error : "", /attached twice/);
});

test("a secondary that is not a repo is refused, naming itself", async () => {
  const api = mkRepo("badentry-api");
  const notARepo = join(home, "badentry-plain");
  mkdirSync(notARepo, { recursive: true });

  const refused = await resolveTaskRepoSet(api, [notARepo]);
  assert.equal(refused.ok, false);
  // The path that was actually rejected, so a caller can fix the entry rather than guess
  // which of several was the problem.
  assert.match(refused.ok === false ? refused.error : "", /not a git repository/);
  assert.match(refused.ok === false ? refused.error : "", new RegExp(notARepo.replace(/\+/g, "\\+")));
});

test("the wire shape defaults to no attached repos, and an edit to them is provisioning", () => {
  // A body from any client that predates this field parses to the single-repo task it
  // always meant.
  const parsed = DispatchSchema.parse({ repoRoot: "/repo", intent: "do it" });
  assert.deepEqual(parsed.extraRepoRoots, []);

  // `isAnnotationOnlyUpdate` counts KEYS, so naming the repo set makes a patch a
  // provisioning change by construction - which is what keeps it refused on a task that has
  // left the backlog, with no arm added to that predicate.
  assert.equal(isAnnotationOnlyUpdate(UpdateTaskSchema.parse({ priority: "high" })), true);
  assert.equal(
    isAnnotationOnlyUpdate(UpdateTaskSchema.parse({ extraRepoRoots: ["/other"] })),
    false,
  );
  assert.equal(
    isAnnotationOnlyUpdate(UpdateTaskSchema.parse({ priority: "high", extraRepoRoots: [] })),
    false,
  );
});

test("a set whose branches differ is told so, per repo, instead of promised one name", () => {
  // The failure this closes. The git fallback cuts one branch name in every repo, but a
  // treehouse-pooled repo arrives on whatever branch its LEASE was already standing on and
  // nothing renames it - so a mixed set really can hold two names. A manifest that repeated
  // the design's intent ("every one of them is on the branch X") would send the agent to
  // push a branch that does not exist in the secondary.
  const manifest = intentWithRepoManifest({
    ...BASE_TASK,
    branch: "harness/ship-it-abc123",
    extraRepos: [
      {
        repoRoot: "/repo/web",
        worktreePath: "/wt/t1-1",
        // What a pool lease hands back: the tree's own branch, not ours.
        branch: "pool/tree-7",
        provider: "treehouse",
        worktreeLeaseId: null,
        baseSha: "b".repeat(40),
        prUrl: null,
        prState: null,
        mergedAt: null,
      },
    ],
  });

  // Each repo's real branch, on its own line.
  assert.match(manifest, /\/wt\/t1 - PRIMARY[^\n]*on branch harness\/ship-it-abc123/);
  assert.match(manifest, /\/wt\/t1-1 - from \/repo\/web, on branch pool\/tree-7/);
  // And no claim of a shared one.
  assert.doesNotMatch(manifest, /Every one of them is on the branch/);
  assert.match(manifest, /NOT all on the same branch/);
});

test("a repo standing on no branch at all is described without inventing one", () => {
  // A detached HEAD reads as null here, and "on branch null" would be worse than silence.
  const manifest = intentWithRepoManifest({
    ...BASE_TASK,
    branch: null,
    extraRepos: [
      {
        repoRoot: "/repo/web",
        worktreePath: "/wt/t1-1",
        branch: null,
        provider: "git",
        worktreeLeaseId: null,
        baseSha: null,
        prUrl: null,
        prState: null,
        mergedAt: null,
      },
    ],
  });
  assert.doesNotMatch(manifest, /on branch null/);
  assert.doesNotMatch(manifest, /Every one of them is on the branch/);
});

// ---- releasing exactly what came back ---------------------------------------------------

test("a task releases the trees that came back and keeps the ones still standing", () => {
  // The rule every teardown site now shares. Before this, a partial failure was read as a
  // total one: the row kept naming all three trees even though two were already gone, so
  // `poolPins` went on sparing them and a retry re-issued a return against a released lease.
  const task = {
    worktreePath: "/wt/t1",
    branch: "harness/x-abc",
    provider: "git" as const,
    worktreeLeaseId: null,
    baseSha: "a".repeat(40),
    extraRepos: [
      {
        repoRoot: "/repo/web",
        worktreePath: "/wt/t1-1",
        branch: "harness/x-abc",
        provider: "git" as const,
        worktreeLeaseId: null,
        baseSha: "b".repeat(40),
        prUrl: null,
        prState: null,
        mergedAt: null,
      },
      {
        repoRoot: "/repo/docs",
        worktreePath: "/wt/t1-2",
        branch: "harness/x-abc",
        provider: "treehouse" as const,
        worktreeLeaseId: null,
        baseSha: "c".repeat(40),
        prUrl: null,
        prState: null,
        mergedAt: null,
      },
    ],
  };

  // Only the primary and the first secondary came back.
  const partial = releasedTaskResources(task, ["/wt/t1", "/wt/t1-1"]);
  assert.equal(partial.worktreePath, null);
  assert.equal(partial.baseSha, null, "the primary's baseline goes with the primary's tree");
  assert.deepEqual(
    partial.extraRepos.map((e) => [e.repoRoot, e.worktreePath, e.baseSha]),
    [
      ["/repo/web", null, null],
      // Still standing, so it keeps its record - a row that stopped naming it could never
      // reclaim it.
      ["/repo/docs", "/wt/t1-2", "c".repeat(40)],
    ],
  );

  // Null means everything came back, which is the ordinary case.
  const full = releasedTaskResources(task, null);
  assert.equal(full.worktreePath, null);
  assert.deepEqual(full.extraRepos.map((e) => e.worktreePath), [null, null]);
  // And the repo SET always survives, so the task can be dispatched again as itself.
  assert.deepEqual(full.extraRepos.map((e) => e.repoRoot), ["/repo/web", "/repo/docs"]);

  // Nothing came back: the row is left exactly as it was.
  const none = releasedTaskResources(task, []);
  assert.equal(none.worktreePath, "/wt/t1");
  assert.deepEqual(none.extraRepos.map((e) => e.worktreePath), ["/wt/t1-1", "/wt/t1-2"]);
});
