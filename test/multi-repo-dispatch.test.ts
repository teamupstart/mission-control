import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { TaskRepoEntry } from "@shared/types.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";

// Dispatching a task that attaches secondary repositories, and the two rules that make it
// safe rather than merely working:
//
//  - **All or nothing.** A task whose second repo cannot be provisioned has already taken a
//    real tree for its first, and nothing downstream would ever reclaim it: the dispatch
//    throws before any of it reaches the task row, and teardown and startup reconciliation
//    both read the row. Left alone, the pool loses a slot per failed dispatch.
//  - **Pins cover the secondaries.** The reaper spares only what is pinned, so a secondary
//    worktree missing from the pin set is a tree it may `reset --hard` under a live agent.
//    That is the one destructive edge in this feature, which is why the pins ship in the
//    same change as the loop that creates the trees.

const home = mkdtempSync(join(tmpdir(), "mission-multirepo-dispatch-"));
process.env.HARNESS_HOME = home;
// Binaries that exist, so bin resolution cannot be what fails below. Both harnesses that
// these tests dispatch need one: `resolveBinPath` runs at the top of `dispatch`, before any
// of the behaviour under test, and a runner without the real CLI installed would otherwise
// fail every case here for a reason none of them are about.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_PI_BIN = "/bin/echo";

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher, provisionWorktree } = await import("../src/server/dispatcher.ts");
const { WorktreeManager } = await import("../src/server/worktrees/manager.ts");
const { WORKTREES_DIR } = await import("../src/server/config.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
  delete process.env.MISSION_PI_BIN;
});

// These repositories use the default-on native allocator. Direct provisioning cases that do
// not inject the daemon manager remain on the disposable Git compatibility seam.
function mkRepo(name: string): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), `${name}\n`);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "first"]);
  const origin = join(home, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
  execFileSync("git", ["-C", repo, "push", "-qu", "origin", "main"]);
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return repo;
}

function entry(repoRoot: string): TaskRepoEntry {
  return {
    repoRoot,
    worktreePath: null,
    branch: null,
    provider: null,
    worktreeLeaseId: null,
    baseSha: null,
    prUrl: null,
    prState: null,
    mergedAt: null,
  };
}

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
}

/**
 * Base resolution stubbed to each repository's own local HEAD.
 *
 * Ordinary dispatch now freezes every repository's base - a freshly fetched remote default -
 * BEFORE it takes the first tree, which means a repository that is not a git repository at
 * all is refused one step earlier than these two cases are about. That earlier refusal is
 * itself covered (multi-repo-provisioning.test.ts), and it is strictly better: nothing is
 * taken, so nothing has to be handed back.
 *
 * The unwind it front-runs is still real, though. A native acquisition can fail, a
 * `git worktree add` can fail, and a repository can disappear between the fetch and the
 * lease - and in every one of those the first repository's tree already exists. So these
 * cases keep driving the unwind by letting base resolution succeed and failing where they
 * always did: inside provisioning.
 */
const localBases = async (
  roots: { primary: string; extras: readonly string[] },
  pinned: string | null,
): Promise<{ primary: string; extras: string[] }> => ({
  primary: pinned ?? headOf(roots.primary),
  extras: roots.extras.map(headOf),
});

/** A repository's exact HEAD, or a syntactically valid id for a path that has no git dir. */
function headOf(repo: string): string {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { stdio: "pipe" }).toString().trim();
  } catch {
    return "0".repeat(40);
  }
}

// ---- all-or-nothing --------------------------------------------------------------------

test("a secondary that cannot be provisioned unwinds the primary's tree", async () => {
  const api = mkRepo("rollback-api");
  // Not a git repository at all, so `provisionWorktree` refuses it in its preflight - the
  // most faithful stand-in for the real cases (a repo deleted since it was attached, a
  // path that stopped resolving) and the only one that needs no injection.
  const broken = join(home, "rollback-not-a-repo");
  mkdirSync(broken, { recursive: true });

  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "rollback-task",
      status: "dispatching",
      repoRoot: api,
      extraRepos: [entry(broken)],
    }),
  );
  // This case proves the all-or-nothing provisioning unwind. Process-snapshot uncertainty
  // has its own fail-closed coverage and would make a disappearing runner PID an unrelated
  // reason for this test to retain the lease it expects to return.
  const worktrees = new WorktreeManager(undefined, { occupancy: emptyOccupancy });
  const dispatcher = new Dispatcher(registry, undefined, { worktrees, resolveBases: localBases });

  await dispatcher.dispatch("rollback-task");

  const failed = registry.getTask("rollback-task");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /is not a git repository/);
  // The primary's native lease was really returned. Its warm directory remains while its
  // exact slot becomes available, which is the resource fact this row never got to record.
  const slots = worktrees.store.slots().filter((slot) => slot.path.includes("rollback-api"));
  assert.equal(slots.length, 1);
  assert.equal(slots[0]?.state, "available");
  assert.equal(slots[0]?.activeLeaseId, null);
  assert.ok(slots[0] && existsSync(slots[0].path));
  // Nothing half-recorded: a task that provisioned nothing names nothing.
  assert.equal(failed?.worktreePath, null);
  assert.deepEqual(
    failed?.extraRepos.map((e) => e.worktreePath),
    [null],
    "the repo set survives the failure; only its provisioning facts are absent",
  );
});

test("the unwind is provider-aware in every ordering", async () => {
  // Every taken tree must reach teardown carrying its own persisted provider. Native leases
  // are returned through the allocator; disposable Git trees are removed. This case exercises
  // native unwind in both primary and secondary positions.
  const broken = join(home, "mixed-not-a-repo");
  mkdirSync(broken, { recursive: true });

  // The teardown is STUBBED here (that is the whole point - we are watching what it is
  // asked to do), so nothing it is handed is actually reclaimed. Each case therefore gets
  // its own primary repo and an id with its own six-character prefix: the branch name is
  // `harness/<slug>-<taskId.slice(0,6)>`, and two cases sharing either would have the
  // second one fail on a leftover branch instead of on the repo this test is about.
  const cases = [
    { id: "aaa-fails-first", primary: mkRepo("mixed-a"), extras: [entry(broken)], taken: 1 },
    {
      id: "bbb-fails-second",
      primary: mkRepo("mixed-b"),
      extras: [entry(mkRepo("mixed-b-web")), entry(broken)],
      taken: 2,
    },
  ];

  for (const { id, primary, extras, taken } of cases) {
    const seen: Array<{ path: string | null; provider: string | null }> = [];
    const registry = new Registry();
    registry.upsertTask(mkTask({ id, status: "dispatching", repoRoot: primary, extraRepos: extras }));
    const dispatcher = new Dispatcher(
      registry,
      async (task) => {
        seen.push({ path: task.worktreePath, provider: task.provider });
      },
      { resolveBases: localBases },
    );

    await dispatcher.dispatch(id);

    assert.equal(registry.getTask(id)?.status, "failed", id);
    // Filtered to the calls that name a tree. The dispatch's own error path also runs
    // teardown against the task ROW, which by then records nothing - that call is a
    // deliberate no-op and not what this test is about.
    const unwound = seen.filter((call) => call.path !== null);
    assert.equal(unwound.length, taken, `${id}: every tree taken before the failure is offered back`);
    for (const call of unwound) {
      assert.equal(call.provider, "mission", `${id}: unwound as the provider it was taken as`);
    }
  }
});

// ---- the embedded-runtime guard --------------------------------------------------------

test("a driver that cannot carry the grant refuses the dispatch instead of dropping repos", async () => {
  // `MultiRepoDispatchSpec.sdk` enforced rather than merely declared. Both shipped harnesses
  // answer true, so this drives the guard through the injectable runtime resolver against a
  // harness whose spec says false - the state a future driver would arrive in.
  //
  // What must NOT happen is the silent version: an embedded session that starts healthily
  // holding an intent naming repositories it cannot write to. And it must not quietly fall
  // back to the terminal runtime either; the operator chose that runtime.
  const api = mkRepo("sdkguard-api");
  const web = mkRepo("sdkguard-web");
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "sdkguard",
      status: "dispatching",
      // pi is the harness with no `multiRepoDispatch` at all, which is the same refusal for
      // a stricter reason - it cannot carry the grant on EITHER runtime.
      agent: "pi",
      repoRoot: api,
      extraRepos: [entry(web)],
    }),
  );
  const dispatcher = new Dispatcher(registry, undefined, { resolveRuntime: () => "sdk" });

  await dispatcher.dispatch("sdkguard");

  const failed = registry.getTask("sdkguard");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /cannot be given write access/);
  // Refused BEFORE provisioning, which is the whole reason the runtime is resolved early:
  // the guard costs an error message rather than two worktrees that have to be unwound.
  assert.equal(existsSync(join(WORKTREES_DIR, "sdkguard")), false);
  assert.equal(existsSync(join(WORKTREES_DIR, "sdkguard-1")), false);
});

test("the TERMINAL runtime refuses the same task rather than launching without the flags", async () => {
  // The guard is runtime-agnostic, and this is the half that would otherwise fail silently:
  // rendering no flags and launching anyway leaves an agent holding a manifest that says
  // "You have write access to all of them" over worktrees it cannot write to.
  //
  // Enforced in the dispatcher rather than only at the routes because `TaskManager.create`
  // does not check - its contract is that the caller validated - so a future producer of a
  // multi-repo task (an MCP tool, a schedule, an ensemble) would reintroduce the drop.
  const api = mkRepo("terminalguard-api");
  const web = mkRepo("terminalguard-web");
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "terminalguard",
      status: "dispatching",
      agent: "pi",
      repoRoot: api,
      extraRepos: [entry(web)],
    }),
  );
  // The default runtime, i.e. no `resolveRuntime` override at all.
  const dispatcher = new Dispatcher(registry);

  await dispatcher.dispatch("terminalguard");

  const failed = registry.getTask("terminalguard");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /cannot be given write access/);
  assert.equal(existsSync(join(WORKTREES_DIR, "terminalguard")), false, "nothing provisioned");
  assert.equal(existsSync(join(WORKTREES_DIR, "terminalguard-1")), false);
});

test("a single-repo task on a harness with no capability still dispatches normally", async () => {
  // The guard is scoped to tasks that actually attach repos. Without this, declaring no
  // capability would become a general ban on dispatching that harness at all.
  const api = mkRepo("soloharness-api");
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "soloharness", status: "dispatching", agent: "pi", repoRoot: api }),
  );
  const dispatcher = new Dispatcher(registry);

  await dispatcher.dispatch("soloharness");

  // It gets past the guard and provisions its tree; what happens after that is the ordinary
  // launch path, which has no pane to talk to here. The guard's refusal is what must NOT
  // appear.
  assert.doesNotMatch(registry.getTask("soloharness")?.error ?? "", /write access/);
  assert.equal(capabilitiesFor("pi").multiRepoDispatch, null);
});

test("reclaiming a task's resources clears the primary's baseline with its tree", async () => {
  // `base_sha` is what later phases compare a head against to decide whether a repo changed.
  // A 40-char commit left beside a null `worktreePath` claims we know where a branch was cut
  // for a tree that no longer exists - and the three reclaim sites in `tasks.ts` all clear
  // it, so this one silently disagreeing with them is the drift worth pinning.
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "reclaim-baseline",
      status: "cancelled",
      repoRoot: "/repo/api",
      worktreePath: "/wt/reclaim-baseline",
      branch: "harness/x-abc123",
      provider: "git",
      baseSha: "a".repeat(40),
      extraRepos: [{ ...entry("/repo/web"), worktreePath: "/wt/reclaim-baseline-1", baseSha: "b".repeat(40) }],
    }),
  );
  const dispatcher = new Dispatcher(registry, async () => {});

  const stopped = await (
    dispatcher as unknown as { abortIfSettled(taskId: string): Promise<boolean> }
  ).abortIfSettled("reclaim-baseline");
  assert.equal(stopped, true);

  const cleared = registry.getTask("reclaim-baseline");
  assert.equal(cleared?.worktreePath, null);
  assert.equal(cleared?.baseSha, null, "the primary's baseline goes with its tree");
  assert.deepEqual(
    cleared?.extraRepos.map((e) => [e.worktreePath, e.baseSha]),
    [[null, null]],
    "and each secondary's does too",
  );
  // The repo SET survives, so the task can be dispatched again as the task it was filed as.
  assert.deepEqual(cleared?.extraRepos.map((e) => e.repoRoot), ["/repo/web"]);
});

test("cancelling a multi-repo task stops it pinning the trees it just handed back", async () => {
  // `poolPins` folds every task's worktrees WITHOUT filtering on status, so a cancelled row
  // that still names its secondaries goes on sparing trees that are already back in their
  // pools - capacity the reaper can never see through, for as long as the row survives.
  //
  // Real repos and real worktrees, because `cancel` reaches the module-level
  // `teardownWorktree` rather than an injectable seam: stubbing it is not available here, and
  // using it for real means this also covers the teardown LOOP reclaiming both trees.
  const { TaskManager } = await import("../src/server/tasks.ts");
  const api = mkRepo("cancel-api");
  const web = mkRepo("cancel-web");
  const primary = await provisionWorktree(api, "cancel-multi", "slug", "ccl111", null, 0);
  const secondary = await provisionWorktree(web, "cancel-multi", "slug", "ccl111", null, 1);

  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "cancel-multi",
      status: "running",
      repoRoot: api,
      worktreePath: primary.path,
      branch: primary.branch,
      provider: primary.provider,
      baseSha: primary.baseSha,
      homeName: null,
      sessionId: null,
      extraRepos: [
        {
          ...entry(web),
          worktreePath: secondary.path,
          branch: secondary.branch,
          provider: secondary.provider,
          baseSha: secondary.baseSha,
        },
      ],
    }),
  );
  const manager = Object.create(TaskManager.prototype) as InstanceType<typeof TaskManager>;
  Object.assign(manager, {
    registry,
    autoCompleted: new Set<string>(),
    reschedulingTasks: new Set<string>(),
    // Every destructive path takes this reservation, so a hand-built instance needs it too.
    // See `TaskManager.withCleanupReservation`.
    cleanupReservations: new Set<string>(),
    stopEmbeddedAgentBeforeReclaim: async () => {},
  });

  const outcome = await manager.cancel("cancel-multi");
  assert.equal(outcome.ok, true, outcome.ok === false ? outcome.error : "");

  // Both trees really are gone - the teardown loop, not just the row edit.
  assert.equal(existsSync(primary.path), false);
  assert.equal(existsSync(secondary.path), false);

  const cancelled = registry.getTask("cancel-multi");
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.worktreePath, null);
  assert.equal(cancelled?.baseSha, null);
  assert.deepEqual(
    cancelled?.extraRepos.map((e) => [e.repoRoot, e.worktreePath, e.baseSha]),
    [[web, null, null]],
    "the repo set survives; its provisioning facts do not",
  );
});
