import { after, test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import { gitIn, mkLinkedWorktree, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { fakeEmulator, fakeMultiplexer, fakeTerminals } from "./helpers/terminal-fakes.ts";
import { ORPHANED_WORKTREE_RECLAIM_FLAG_ID, SEVEN_DAY_WORKTREE_CLEANUP_FLAG_ID } from "../src/shared/feature-flag-registry.ts";
import type { Task } from "../src/shared/types.ts";
import type { TaskArchiveGate, TaskManagerStartupDeps } from "../src/server/tasks.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import type { MuxSessions } from "../src/server/terminal/types.ts";
import type { RunResult } from "../src/server/util/exec.ts";
import { archiveKey } from "../src/shared/archives.ts";

// A physical home: macOS's temp directory sits behind the `/var` -> `/private/var` link, and
// the orphan proof refuses any slot with a symbolic link at or above it - which is the point.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-orphan-reclaim-")));
process.env.MISSION_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { worktreeSlotPath } = await import("../src/server/dispatcher.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { bindTaskWorkEpisode, getTaskWorktreeRetention } = await import("../src/server/db.ts");
const { ArchiveManager } = await import("../src/server/archives/manager.ts");
const { ArchiveCaptureStore } = await import("../src/server/archives/capture-store.ts");
const { disposableWorktreeCensus } = await import("../src/server/worktrees/disposable-census.ts");
const { homeAbsenceEstablished } = await import("../src/server/terminal/home.ts");
const { tmuxMultiplexer } = await import("../src/server/terminal/tmux.ts");
const { herdrMultiplexer } = await import("../src/server/terminal/herdr.ts");
const {
  classifyTaskCheckout, orphanedCheckoutEvidence, orphanedCheckoutFingerprint, regenerableIgnoredPath, removeOrphanedTaskCheckout,
} = await import("../src/server/worktrees/orphaned-task-checkout.ts");
const {
  createDaemonRetentionObserver, backgroundWorktreeRetentionStatus, SEVEN_DAY_RETENTION_MS: WEEK,
} = await import("../src/server/task-worktree-retention.ts");
after(() => rmSync(home, { recursive: true, force: true }));

let sequence = 0;

function setFlag(t: TestContext, id: string, enabled: boolean): void {
  assert.equal(applyFeatureFlagIntent({ kind: "flag", id, enabled }).ok, true);
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id, enabled: false }); });
}

function setPreview(t: TestContext, value: string | undefined): void {
  for (const prefix of ["MISSION", "FLEET", "HARNESS"]) {
    const key = `${prefix}_WORKTREE_CLEANUP_PREVIEW`;
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    delete process.env[key];
  }
  if (value !== undefined) process.env.MISSION_WORKTREE_CLEANUP_PREVIEW = value;
}

/** Remove the checkout's administrative directory, exactly what a re-clone of the main checkout leaves. */
function orphan(path: string): void {
  rmSync(gitIn(path, "rev-parse", "--absolute-git-dir"), { recursive: true });
}

interface WorldOptions {
  /** Shape the checkout while Git still knows it, before the admin directory goes. */
  prepare?: (path: string, ids: { clone: string; origin: string; branch: string }) => void;
  /** Leave the checkout registered: the control case. */
  registered?: boolean;
  archives?: TaskArchiveGate | "real";
  deps?: TaskManagerStartupDeps;
  task?: Partial<Task>;
}

function world(t: TestContext, options: WorldOptions = {}) {
  const id = `orphan-task-${++sequence}`;
  const { root, clone, origin } = mkOriginAndClone("mission-orphan-checkout-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = worktreeSlotPath(id, 0);
  mkdirSync(dirname(path), { recursive: true });
  const branch = `harness/${id}`;
  mkLinkedWorktree(clone, branch, path);
  const baseSha = gitIn(path, "rev-parse", "HEAD");
  options.prepare?.(path, { clone, origin, branch });
  if (!options.registered && existsSync(join(path, ".git"))) orphan(path);
  t.after(() => rmSync(path, { recursive: true, force: true }));

  const state = {
    now: 1_900_000_000_000,
    occupancy: { status: "known", occupants: [] } as WorktreeOccupancy,
    occupancyCalls: 0,
    preserved: [] as { files: readonly { path: string }[] }[],
    held: [] as { files: readonly { path: string }[] }[],
  };
  const library = join(home, `library-${id}`);
  const archives: TaskArchiveGate = options.archives === "real"
    ? new ArchiveManager({ root: library, intervalMs: null, watch: false, log: () => {} }) as unknown as TaskArchiveGate
    : options.archives ?? {
      ensureReady: async () => ({ ok: true }),
      settleBeforeCleanup: async () => ({ ok: true }),
      preserveCheckoutFiles: async (input) => {
        state.preserved.push(input);
        return { ok: true };
      },
      withCheckoutFilesHeld: async (input, removal) => {
        state.held.push(input);
        return removal();
      },
    };
  const registry = new Registry();
  const supervisor = { requestStop: () => true, stop: async () => {}, handleFor: () => null, taskLiveness: () => null };
  const manager = new TaskManager(registry, undefined, supervisor as never, undefined, archives, {
    occupancy: async (paths) => {
      state.occupancyCalls++;
      return new Map(paths.map((entry) => [entry, state.occupancy]));
    },
    ...options.deps,
  });
  registry.applyDiscovery([]);
  const task = mkTask({
    id, status: "done", repoRoot: clone, worktreePath: path, branch, provider: "git",
    worktreeLeaseId: null, baseSha, sessionId: null, homeName: null, extraRepos: [], ...options.task,
  });
  registry.upsertTask(task);
  const shim = {
    listTasks: () => [registry.getTask(id)!].filter(Boolean),
    refreshTaskAutomaticCleanup: (taskId: string) => registry.refreshTaskAutomaticCleanup(taskId),
  };
  const observer = createDaemonRetentionObserver(shim, manager, () => state.now);
  const row = () => getTaskWorktreeRetention(id);
  const status = async () => (await backgroundWorktreeRetentionStatus(shim.listTasks(), worktreeSlotPath)).entries
    .find((entry) => entry.taskId === id);
  /** Observe, move past the deadline, observe again. */
  const runToDeadline = async () => {
    await observer.runPass();
    const due = row()?.cleanupDueAt;
    assert.ok(due && row()?.unownedSince !== null, `the checkout earned a deadline (blocker: ${row()?.lastError})`);
    state.now = due;
    return observer.runPass();
  };
  return { id, path, clone, origin, branch, baseSha, registry, manager, observer, state, row, status, runToDeadline,
    task: () => registry.getTask(id)!, library };
}

function enable(t: TestContext): void {
  setPreview(t, undefined);
  setFlag(t, SEVEN_DAY_WORKTREE_CLEANUP_FLAG_ID, true);
  setFlag(t, ORPHANED_WORKTREE_RECLAIM_FLAG_ID, true);
}

test("with the flag off an orphan stays held, exactly as before", async (t) => {
  setPreview(t, undefined);
  const w = world(t);
  await w.observer.runPass();
  assert.equal(w.row()?.unownedSince, null);
  assert.match(w.row()?.lastError ?? "", /git rev-parse/);
  assert.equal((await backgroundWorktreeRetentionStatus([w.task()], worktreeSlotPath)).orphanReclaim, "off");
  assert.ok(existsSync(w.path));
});

test("a clean orphan equal to its base commit earns a deadline and is removed", async (t) => {
  enable(t);
  const w = world(t);
  await w.observer.runPass();
  assert.equal((await w.status())?.checkouts[0]?.class, "dangling-link");
  assert.deepEqual((await w.status())?.checkouts, [{ position: 0, provider: "git", class: "dangling-link" }]);
  assert.ok(!JSON.stringify(await backgroundWorktreeRetentionStatus([w.task()], worktreeSlotPath)).includes(w.path),
    "the retention diagnostics carry no checkout path");
  assert.equal(w.row()?.cleanupDueAt, w.state.now + WEEK);
  w.state.now = w.row()!.cleanupDueAt;
  const pass = await w.observer.runPass();
  assert.deepEqual(pass.cleanups, { reclaimed: 1 });
  assert.equal(existsSync(w.path), false, "the exact slot directory is deleted");
  assert.equal(w.task().worktreePath, null);
  assert.equal(w.row(), null, "the ledger row finished through claim and complete");
  assert.deepEqual(w.state.preserved, [], "nothing local-only, so nothing archived");
  assert.ok(existsSync(w.clone), "the recorded repository is untouched");
});

test("a regenerable ignored directory and a deleted tracked file do not hold a proven orphan", async (t) => {
  enable(t);
  let base = "";
  const w = world(t, {
    prepare: (path) => {
      writeFileSync(join(path, ".gitignore"), "node_modules\ndist\n");
      gitIn(path, "add", ".gitignore");
      gitIn(path, "commit", "-qm", "ignore rules");
      base = gitIn(path, "rev-parse", "HEAD");
    },
  });
  w.registry.upsertTask({ ...w.task(), baseSha: base });
  mkdirSync(join(w.path, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(w.path, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(w.path, "dist"));
  writeFileSync(join(w.path, "dist", "bundle.js"), "built\n");
  rmSync(join(w.path, "keep.txt"));
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { reclaimed: 1 });
  assert.equal(existsSync(w.path), false);
});

test("an unknown ignored file holds the orphan", async (t) => {
  enable(t);
  let base = "";
  const w = world(t, {
    prepare: (path) => {
      writeFileSync(join(path, ".gitignore"), ".env\n");
      gitIn(path, "add", ".gitignore");
      gitIn(path, "commit", "-qm", "ignore rules");
      base = gitIn(path, "rev-parse", "HEAD");
    },
  });
  w.registry.upsertTask({ ...w.task(), baseSha: base });
  writeFileSync(join(w.path, ".env"), "TOKEN=local\n");
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { "validation-unknown": 1 });
  assert.match(w.row()?.lastError ?? "", /ignored files outside regenerable directories/);
  assert.equal(readFileSync(join(w.path, ".env"), "utf8"), "TOKEN=local\n");
});

test("an orphan equal to its merged pull request head is removed, fetching the head into scratch", async (t) => {
  enable(t);
  let head = "";
  const w = world(t, {
    prepare: (path, { origin, branch }) => {
      // The pull request was made and merged elsewhere: its commit is on origin only, the way
      // a re-cloned main checkout no longer has the old checkout's objects.
      const other = mkdtempSync(join(home, "pr-author-"));
      t.after(() => rmSync(other, { recursive: true, force: true }));
      gitIn(other, "clone", "-q", origin, "repo");
      const repo = join(other, "repo");
      gitIn(repo, "checkout", "-qb", branch);
      writeFileSync(join(repo, "feature.txt"), "shipped work\n");
      writeFileSync(join(repo, "keep.txt"), "base\nchanged by the pull request\n");
      gitIn(repo, "add", "-A");
      gitIn(repo, "-c", "user.name=t", "-c", "user.email=t@test", "commit", "-qm", "the pull request");
      head = gitIn(repo, "rev-parse", "HEAD");
      gitIn(repo, "push", "-q", "origin", branch);
      gitIn(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
      // The checkout holds exactly what the pull request merged.
      writeFileSync(join(path, "feature.txt"), "shipped work\n");
      writeFileSync(join(path, "keep.txt"), "base\nchanged by the pull request\n");
    },
    deps: {
      orphanEvidence: (input) => orphanedCheckoutEvidence({
        ...input, pullRequest: () => ({ url: "https://github.com/example/repo/pull/7", headSha: head, merged: true }),
      }),
    },
  });
  assert.throws(() => gitIn(w.clone, "cat-file", "-e", `${head}^{commit}`), "the recorded repository lacks the head");
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { reclaimed: 1 });
  assert.equal(existsSync(w.path), false);
  assert.deepEqual(w.state.preserved, [], "an exact match with the merged head archives nothing");
  assert.throws(() => gitIn(w.clone, "cat-file", "-e", `${head}^{commit}`), "the fetch never wrote the user's repository");
});

test("an unavailable pull request host holds an orphan that differs from its base", async (t) => {
  enable(t);
  const w = world(t, {
    prepare: (path, { clone }) => {
      writeFileSync(join(path, "feature.txt"), "work from a merged pull request\n");
      gitIn(clone, "remote", "set-url", "origin", join(home, "no-such-remote"));
    },
    deps: {
      orphanEvidence: (input) => orphanedCheckoutEvidence({
        ...input, pullRequest: () => ({ url: "https://github.com/example/repo/pull/8", headSha: "a".repeat(40), merged: true }),
      }),
    },
  });
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { "validation-unknown": 1 });
  assert.match(w.row()?.lastError ?? "", /merged pull request head could not be fetched/);
  assert.ok(existsSync(join(w.path, "feature.txt")));
  assert.deepEqual(w.state.preserved, []);
});

test("untracked local files are archived into a checkout bundle before the directory is removed", async (t) => {
  enable(t);
  const w = world(t, {
    archives: "real",
    prepare: (path) => {
      writeFileSync(join(path, "report.html"), "<!doctype html><p>local report</p>\n");
      mkdirSync(join(path, "scripts"));
      writeFileSync(join(path, "scripts", "evidence.csv"), "a,b\n1,2\n");
      writeFileSync(join(path, "keep.txt"), "base\nlocal edit\n");
    },
  });
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { reclaimed: 1 });
  assert.equal(existsSync(w.path), false);
  const job = new ArchiveCaptureStore().forTask(w.id).find((entry) => entry.kind === "checkout");
  assert.equal(job?.status, "published");
  assert.equal(job?.captureStatus, "partial");
  const bundle = join(w.library, job!.relativePath!);
  assert.equal(readFileSync(join(bundle, "artifacts", "repo-01", "report.html"), "utf8"), "<!doctype html><p>local report</p>\n");
  assert.equal(readFileSync(join(bundle, "artifacts", "repo-01", "scripts", "evidence.csv"), "utf8"), "a,b\n1,2\n");
  assert.equal(readFileSync(join(bundle, "artifacts", "repo-01", "keep.txt"), "utf8"), "base\nlocal edit\n");
  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as { kind: string };
  assert.equal(manifest.kind, "checkout");
});

test("local-only files hold the orphan until their archive settles", async (t) => {
  enable(t);
  let refuse = true;
  const w = world(t, {
    prepare: (path) => writeFileSync(join(path, "notes.md"), "keep me\n"),
    archives: {
      ensureReady: async () => ({ ok: true }),
      settleBeforeCleanup: async () => ({ ok: true }),
      preserveCheckoutFiles: async () => refuse
        ? { ok: false, error: "local-only files in the orphaned checkout could not be archived" }
        : { ok: true },
      withCheckoutFilesHeld: (_input, removal) => removal(),
    },
  });
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { "archive-refused": 1 });
  assert.match(w.row()?.lastError ?? "", /could not be archived/);
  assert.equal(readFileSync(join(w.path, "notes.md"), "utf8"), "keep me\n");
  refuse = false;
  w.state.now = w.row()!.retryAt!;
  assert.deepEqual((await w.observer.runPass()).cleanups, { reclaimed: 1 });
  assert.equal(existsSync(w.path), false);
});

test("an archive gate that cannot preserve files holds every orphan with local-only work", async (t) => {
  enable(t);
  const w = world(t, {
    prepare: (path) => writeFileSync(join(path, "notes.md"), "keep me\n"),
    archives: { ensureReady: async () => ({ ok: true }), settleBeforeCleanup: async () => ({ ok: true }) },
  });
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { "archive-refused": 1 });
  assert.match(w.row()?.lastError ?? "", /need the archive library/);
  assert.ok(existsSync(join(w.path, "notes.md")));
});

test("a symbolic link at the slot is never an orphan", async (t) => {
  enable(t);
  const real = join(home, `real-orphan-${sequence + 1}`);
  const w = world(t, {
    prepare: (path) => {
      // Move the orphan aside and leave a link where the slot should be.
      orphan(path);
      renameSync(path, real);
      symlinkSync(real, path);
    },
    registered: true,
  });
  t.after(() => rmSync(real, { recursive: true, force: true }));
  await w.observer.runPass();
  assert.equal(w.row()?.unownedSince, null, "no deadline for a link");
  assert.ok(existsSync(join(real, "keep.txt")), "the link target is untouched");
});

test("a symbolic link above the slot proves nothing", async () => {
  const realParent = mkdtempSync(join(home, "real-parent-"));
  const linkedParent = join(home, `linked-parent-${sequence}`);
  symlinkSync(realParent, linkedParent);
  const slot = join(linkedParent, "task");
  mkdirSync(slot);
  writeFileSync(join(slot, ".git"), `gitdir: ${join(home, "gone", ".git", "worktrees", "task")}\n`);
  const ref = { repoRoot: home, worktreePath: slot, branch: "b", provider: "git" as const, worktreeLeaseId: null,
    baseSha: null, role: "primary" as const, position: 0 };
  assert.deepEqual(await classifyTaskCheckout(ref, slot), { kind: "registered" });
});

test("process occupancy holds an orphan and is re-checked immediately before the delete", async (t) => {
  enable(t);
  const w = world(t);
  w.state.occupancy = { status: "known", occupants: [{} as never] };
  await w.observer.runPass();
  assert.equal(w.row()?.unownedSince, null);
  assert.match(w.row()?.lastError ?? "", /process still uses a checkout/);
  w.state.occupancy = { status: "known", occupants: [] };
  await w.observer.runPass();
  w.state.now = w.row()!.cleanupDueAt;
  w.state.occupancy = { status: "unknown", reason: "no process probe" };
  assert.deepEqual((await w.observer.runPass()).cleanups, { "validation-unknown": 1 });
  assert.ok(existsSync(w.path));

  // The removal itself awaits occupancy last, after re-proving identity.
  const ref = { repoRoot: w.clone, worktreePath: w.path, branch: w.branch, provider: "git" as const,
    worktreeLeaseId: null, baseSha: w.baseSha, role: "primary" as const, position: 0 };
  const claimed = await orphanedCheckoutFingerprint(ref, w.path);
  assert.equal(claimed?.kind, "known");
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, claimed?.kind === "known" ? claimed.digest : undefined,
    async () => "a process still uses a checkout"),
    /a process still uses a checkout/);
  assert.ok(existsSync(w.path));
});

test("an unknown read never authorizes deletion", async (t) => {
  enable(t);
  // A link into some other repository's worktrees directory is not this repository's orphan.
  const elsewhere = world(t, {
    prepare: (path) => writeFileSync(join(path, ".git"), `gitdir: ${join(home, "other", ".git", "worktrees", "x")}\n`),
    registered: true,
  });
  await elsewhere.observer.runPass();
  assert.equal(elsewhere.row()?.unownedSince, null);
  assert.match(elsewhere.row()?.lastError ?? "", /links to a different repository/);
  // On disk it looks like any orphan; the blocker above says the proof refused it.
  assert.equal((await elsewhere.status())?.checkouts[0]?.class, "dangling-link");

  // No recorded base commit: nothing to prove equality against.
  const baseless = world(t, { task: { baseSha: null } });
  await baseless.observer.runPass();
  assert.equal(baseless.row()?.unownedSince, null);
  assert.match(baseless.row()?.lastError ?? "", /no recorded base commit/);

  // A base commit the repository does not have.
  const missing = world(t, { task: { baseSha: "b".repeat(40) } });
  await missing.observer.runPass();
  assert.equal(missing.row()?.unownedSince, null);
  assert.match(missing.row()?.lastError ?? "", /commit is unavailable/);
  for (const w of [elsewhere, baseless, missing]) assert.ok(existsSync(w.path));
});

test("report-only evaluates both new classes from read-only evidence and deletes nothing", async (t) => {
  setPreview(t, "report-only");
  const w = world(t, { prepare: (path) => writeFileSync(join(path, "report.html"), "local\n") });
  assert.equal((await backgroundWorktreeRetentionStatus([w.task()], worktreeSlotPath)).orphanReclaim, "report-only");
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, {});
  assert.match(w.row()?.lastError ?? "", /report only: orphaned checkout would be removed after archiving 1 local-only file/);
  assert.equal(w.row()?.claimToken, null);
  assert.deepEqual(w.state.preserved, []);
  assert.equal(readFileSync(join(w.path, "report.html"), "utf8"), "local\n");

  const gone = world(t, { prepare: (path) => rmSync(path, { recursive: true, force: true }) });
  await gone.runToDeadline();
  assert.match(gone.row()?.lastError ?? "", /report only: the checkout is already gone/);
  assert.equal(gone.task().worktreePath, gone.path);
});

test("a checkout already removed by hand completes cleanly", async (t) => {
  enable(t);
  const w = world(t, { prepare: (path) => rmSync(path, { recursive: true, force: true }), registered: true });
  await w.observer.runPass();
  assert.equal((await w.status())?.checkouts[0]?.class, "absent");
  w.state.now = w.row()!.cleanupDueAt;
  assert.deepEqual((await w.observer.runPass()).cleanups, { reclaimed: 1 });
  assert.equal(w.task().worktreePath, null);
  assert.equal(w.row(), null);
});

test("the disposable census names a dangling link without authorizing anything", async (t) => {
  setPreview(t, undefined);
  const w = world(t);
  const census = await disposableWorktreeCensus([w.task()]);
  const entry = census.entries.find((row) => row.taskId === w.id);
  assert.equal(entry?.gitMetadata, "unverified");
  assert.equal(entry?.orphanEvidence, "dangling-link");
  assert.ok(existsSync(w.path));
});

test("only regenerable ignored directories are tolerated", () => {
  for (const path of ["node_modules/", "packages/app/node_modules/", "dist/", "dist/app.js", "test-results/",
    ".evidence/", ".pipeline/", ".tmp/", ".tmp-build/", "web/.tmpcache/file"]) {
    assert.equal(regenerableIgnoredPath(path), true, path);
  }
  for (const path of [".env", "dist", "secrets/.env", "notes.local.md", "distribution/x", "my-node_modules/"]) {
    assert.equal(regenerableIgnoredPath(path), false, path);
  }
});

// --- terminal homes ------------------------------------------------------------------------

function muxSessions(over: Partial<MuxSessions>): MuxSessions {
  return {
    spawnDetached: async () => ({ ok: true, outcomeUnknown: false }),
    attachArgv: (name) => ["fake", "attach", name],
    rename: async () => ({ ok: true, outcomeUnknown: false }),
    kill: async () => ({ ok: true, outcomeUnknown: false }),
    alive: null,
    closeIfOnlyPane: null,
    ...over,
  } as MuxSessions;
}

function machine(stopped: () => Promise<boolean | null>, list: () => Promise<never[] | null> = async () => null) {
  return { ...fakeTerminals(fakeMultiplexer({ sessions: muxSessions({ serverStopped: stopped }), list }), fakeEmulator()),
    installed: () => true };
}

test("terminal home absence is positive only when the recording backend has no server at all", async () => {
  const stopped = machine(async () => true);
  // A legacy home with no identity, recorded by this backend.
  assert.equal(await homeAbsenceEstablished("legacy", stopped, "tmux", null), true);
  // A resource id whose inventory cannot be read, on a stopped server.
  assert.equal(await homeAbsenceEstablished("home", stopped, null, "multiplexer:tmux:plain-name"), true);
  // A running server, an unanswerable one, and a throwing one all keep the home.
  assert.equal(await homeAbsenceEstablished("legacy", machine(async () => false), "tmux", null), false);
  assert.equal(await homeAbsenceEstablished("legacy", machine(async () => null), "tmux", null), false);
  assert.equal(await homeAbsenceEstablished("legacy", machine(async () => { throw new Error("boom"); }), "tmux", null), false);
  // No recorded backend, or the emulator axis: identity cannot be established at all.
  assert.equal(await homeAbsenceEstablished("legacy", stopped, null, null), false);
  assert.equal(await homeAbsenceEstablished("tab", stopped, null, "emulator:wezterm:7"), false);
  // A live inventory naming the resource wins over everything.
  const live = machine(async () => true, async () => [{ session: "plain-name" } as never]);
  assert.equal(await homeAbsenceEstablished("home", live, null, "multiplexer:tmux:plain-name"), false);
});

function fakeExec(answers: (bin: string, args: string[]) => Partial<RunResult>) {
  return async (bin: string, args: string[]): Promise<RunResult> => ({
    stdout: "", stderr: "", code: 0, outcomeUnknown: false, overflowed: false, ...answers(bin, args),
  });
}

const uid = process.getuid!();

test("tmux proves its server stopped only when it says so and no tmux process runs", async () => {
  const ps = (names: string[]) => ({ stdout: names.map((name) => `${uid} ${name}`).join("\n") + `\n${uid + 1} /usr/bin/tmux\n` });
  const answer = (stderr: string, processes: string[]) => tmuxMultiplexer(fakeExec((bin, args) =>
    bin.endsWith("/ps") ? ps(processes)
      : args.includes("list-sessions") ? { code: 1, stderr } : {}));
  assert.equal(await answer("no server running on /tmp/tmux-501/default", ["/bin/zsh"]).sessions?.serverStopped?.(), true);
  assert.equal(await answer("error connecting to /tmp/tmux-501/default (No such file or directory)", []).sessions?.serverStopped?.(), true,
    "another user's tmux cannot carry this user's home");
  const silent = tmuxMultiplexer(fakeExec((bin, args) => bin.endsWith("/ps") ? { stdout: "" }
    : args.includes("list-sessions") ? { code: 1, stderr: "no server running on /tmp/tmux-501/default" } : {}));
  assert.equal(await silent.sessions?.serverStopped?.(), null, "an empty process listing proves nothing");
  assert.equal(await answer("no server running on /tmp/tmux-501/default", ["/opt/homebrew/bin/tmux"]).sessions?.serverStopped?.(), false,
    "a tmux server on another socket keeps the home");
  assert.equal(await answer("permission denied", ["/bin/zsh"]).sessions?.serverStopped?.(), null);
  const running = tmuxMultiplexer(fakeExec(() => ({ stdout: "$1\n" })));
  assert.equal(await running.sessions?.serverStopped?.(), false);
});

test("herdr proves its server stopped from its own status and the process table", async () => {
  const status = (running: boolean) => JSON.stringify({ status: running ? "running" : "stopped", running,
    version: running ? "0.8.2" : null, protocol: running ? 20 : null, compatible: running ? true : null,
    socket: "/tmp/herdr.sock", restart_needed: false });
  const herdr = (running: boolean, processes: string) => herdrMultiplexer(fakeExec((bin, args) =>
    bin.endsWith("/ps") ? { stdout: processes } : args[0] === "status" ? { stdout: status(running) } : {}));
  assert.equal(await herdr(false, `${uid} /bin/zsh\n`).sessions?.serverStopped?.(), true);
  assert.equal(await herdr(false, `${uid} /usr/local/bin/herdr\n`).sessions?.serverStopped?.(), false);
});

test("the occupancy blocker clears a provably absent terminal home only while the flag is on", async (t) => {
  setPreview(t, undefined);
  const w = world(t, {
    registered: true,
    task: { homeName: "legacy-home", homeBackend: "herdr", terminalResourceId: null },
    deps: { homeAbsent: async () => true },
  });
  assert.match(await w.manager.backgroundWorktreeOccupancyBlocker(w.task()) ?? "", /terminal home/);
  setFlag(t, ORPHANED_WORKTREE_RECLAIM_FLAG_ID, true);
  assert.equal(await w.manager.backgroundWorktreeOccupancyBlocker(w.task()), null);
  const unknown = world(t, {
    registered: true,
    task: { homeName: "legacy-home", homeBackend: "herdr", terminalResourceId: null },
    deps: { homeAbsent: async () => false },
  });
  assert.match(await unknown.manager.backgroundWorktreeOccupancyBlocker(unknown.task()) ?? "", /terminal home/);
});

test("a legacy terminal home proved absent no longer holds a clean checkout's return", async (t) => {
  for (const enabled of [false, true]) {
    setPreview(t, undefined);
    setFlag(t, SEVEN_DAY_WORKTREE_CLEANUP_FLAG_ID, true);
    if (enabled) setFlag(t, ORPHANED_WORKTREE_RECLAIM_FLAG_ID, true);
    const w = world(t, {
      registered: true,
      task: { homeName: "legacy-home", homeBackend: "herdr", terminalResourceId: null },
      deps: { homeAbsent: async () => true },
    });
    await w.observer.runPass();
    if (!enabled) {
      assert.equal(w.row()?.unownedSince, null);
      assert.match(w.row()?.lastError ?? "", /terminal home/);
      assert.ok(existsSync(w.path));
      applyFeatureFlagIntent({ kind: "flag", id: SEVEN_DAY_WORKTREE_CLEANUP_FLAG_ID, enabled: false });
      continue;
    }
    w.state.now = w.row()!.cleanupDueAt;
    assert.deepEqual((await w.observer.runPass()).cleanups, { reclaimed: 1 });
    assert.equal(existsSync(w.path), false);
    assert.equal(w.task().homeName, null, "the home record is released with the checkout");
  }
});

// --- the daemon's own recorded pull request, read through `TaskManager` -----------------------

/** A pull request merged elsewhere: its commit is on origin only, never in the user's clone. */
function mergedOnOrigin(t: TestContext, origin: string, branch: string, files: Record<string, string>): string {
  const other = mkdtempSync(join(home, "pr-author-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  gitIn(other, "clone", "-q", origin, "repo");
  const repo = join(other, "repo");
  gitIn(repo, "checkout", "-qb", branch);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  gitIn(repo, "add", "-A");
  gitIn(repo, "-c", "user.name=t", "-c", "user.email=t@test", "commit", "-qm", "the pull request");
  gitIn(repo, "push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`);
  gitIn(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  return gitIn(repo, "rev-parse", "HEAD");
}

/** Record a task's work episode the way the daemon does, with its pull request and merge. */
function recordEpisode(taskId: string, episode: string, branch: string | null, pr: { url: string; head: string | null; mergedAt: number | null }) {
  bindTaskWorkEpisode({
    taskId, episodeId: `${taskId}-${episode}`, sessionId: `session-${taskId}-${episode}`,
    agentSessionId: `agent-${taskId}-${episode}`, branch, prUrl: pr.url, prHeadSha: pr.head,
    mergedAt: pr.mergedAt, boundAt: 1_000 + episode.length, updatedAt: 1_000 + episode.length,
  });
}

const PR_FILES = { "feature.txt": "shipped work\n", "keep.txt": "base\nchanged by the pull request\n" };

test("a merged pull request the daemon recorded for the task's branch proves an orphan disposable", async (t) => {
  enable(t);
  let head = "";
  const w = world(t, {
    prepare: (path, { origin, branch }) => {
      head = mergedOnOrigin(t, origin, branch, PR_FILES);
      for (const [file, content] of Object.entries(PR_FILES)) writeFileSync(join(path, file), content);
    },
  });
  recordEpisode(w.id, "a", w.branch, { url: "https://github.com/example/repo/pull/11", head, mergedAt: 1_500 });
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { reclaimed: 1 });
  assert.equal(existsSync(w.path), false);
  assert.deepEqual(w.state.preserved, [], "the recorded merged head matched, so nothing was archived");
});

test("a recorded merged pull request on another branch is not this checkout's proof", async (t) => {
  enable(t);
  let head = "";
  const w = world(t, {
    prepare: (path, { origin }) => {
      head = mergedOnOrigin(t, origin, "harness/some-other-task", PR_FILES);
      for (const [file, content] of Object.entries(PR_FILES)) writeFileSync(join(path, file), content);
    },
  });
  recordEpisode(w.id, "a", "harness/some-other-task", { url: "https://github.com/example/repo/pull/12", head, mergedAt: 1_500 });
  const pass = await w.runToDeadline();
  // Without a merged pull request for its own branch the differences are local-only work, and
  // they are archived against the base before anything is removed.
  assert.deepEqual(pass.cleanups, { reclaimed: 1 });
  // Archived once, then re-verified at each provider boundary: every call names the same files.
  assert.ok(w.state.preserved.length > 0);
  for (const entry of w.state.preserved) assert.deepEqual(entry.files.map((file) => file.path), ["feature.txt", "keep.txt"]);
});

test("two recorded merged heads for the branch are ambiguous and hold the orphan", async (t) => {
  enable(t);
  let first = "";
  let second = "";
  const w = world(t, {
    prepare: (path, { origin, branch }) => {
      first = mergedOnOrigin(t, origin, branch, PR_FILES);
      second = mergedOnOrigin(t, origin, branch, { ...PR_FILES, "feature.txt": "a second, different merge\n" });
      for (const [file, content] of Object.entries(PR_FILES)) writeFileSync(join(path, file), content);
    },
  });
  // The second binding rolls the first episode into history; both carry a merge.
  recordEpisode(w.id, "a", w.branch, { url: "https://github.com/example/repo/pull/13", head: first, mergedAt: 1_500 });
  recordEpisode(w.id, "bb", w.branch, { url: "https://github.com/example/repo/pull/14", head: second, mergedAt: 1_600 });
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { "validation-unknown": 1 });
  assert.match(w.row()?.lastError ?? "", /pull request record is ambiguous/);
  assert.equal(readFileSync(join(w.path, "feature.txt"), "utf8"), "shipped work\n");
  assert.deepEqual(w.state.preserved, []);
});

// --- report-only and terminal homes -----------------------------------------------------------

test("report-only evaluates a terminal home from read-only evidence and releases nothing", async (t) => {
  setPreview(t, "report-only");
  const absent = world(t, {
    registered: true,
    task: { homeName: "legacy-home", homeBackend: "herdr", terminalResourceId: null },
    deps: { homeAbsent: async () => true },
  });
  const pass = await absent.runToDeadline();
  assert.deepEqual(pass.cleanups, {});
  assert.match(absent.row()?.lastError ?? "", /report only: checkout passed read-only eligibility checks/);
  assert.equal(absent.row()?.claimToken, null);
  assert.ok(existsSync(absent.path));
  assert.equal(absent.task().homeName, "legacy-home", "the home record is kept");

  const unknowable = world(t, {
    registered: true,
    task: { homeName: "legacy-home", homeBackend: "herdr", terminalResourceId: null },
    deps: { homeAbsent: async () => false },
  });
  await unknowable.observer.runPass();
  assert.equal(unknowable.row()?.unownedSince, null);
  assert.match(unknowable.row()?.lastError ?? "", /terminal home is present or its absence could not be verified/);
  assert.ok(existsSync(unknowable.path));
});

// --- a real archive refusal -------------------------------------------------------------------

test("a local-only file that changes after selection is refused by the real archive and stays", async (t) => {
  enable(t);
  const library = join(home, `library-refusal-${sequence + 1}`);
  const real = new ArchiveManager({ root: library, intervalMs: null, watch: false, log: () => {} });
  let notes = "";
  const gate: TaskArchiveGate = {
    ensureReady: (id) => real.ensureReady(id),
    settleBeforeCleanup: (id) => real.settleBeforeCleanup(id),
    withCheckoutFilesHeld: (input, removal) => real.withCheckoutFilesHeld(input, removal),
    // The real capture, after the file grew between the retention decision and the copy.
    preserveCheckoutFiles: async (input) => {
      writeFileSync(notes, "keep me, and the line written after selection\n");
      return real.preserveCheckoutFiles(input);
    },
  };
  const w = world(t, { archives: gate, prepare: (path) => writeFileSync(join(path, "notes.md"), "keep me\n") });
  notes = join(w.path, "notes.md");
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { "archive-refused": 1 });
  assert.match(w.row()?.lastError ?? "", /local-only files in the orphaned checkout could not be archived/);
  assert.notEqual(w.row()?.retryAt, null, "held and retried with backoff");
  assert.equal(readFileSync(notes, "utf8"), "keep me, and the line written after selection\n");
  assert.equal(w.task().worktreePath, w.path);
  const job = new ArchiveCaptureStore().forTask(w.id).find((entry) => entry.kind === "checkout");
  assert.equal(job?.status, "failed");
  assert.match(job?.error ?? "", /notes\.md changed after it was selected/);
});

test("a published checkout archive the operator deleted is never recreated, and the files stay", async (t) => {
  enable(t);
  const library = join(home, `library-deleted-${sequence + 1}`);
  const real = new ArchiveManager({ root: library, intervalMs: null, watch: false, log: () => {} });
  let taskId = "";
  let deletedKey = "";
  const gate: TaskArchiveGate = {
    ensureReady: (id) => real.ensureReady(id),
    settleBeforeCleanup: (id) => real.settleBeforeCleanup(id),
    withCheckoutFilesHeld: (input, removal) => real.withCheckoutFilesHeld(input, removal),
    preserveCheckoutFiles: async (input) => {
      const result = await real.preserveCheckoutFiles(input);
      if (!deletedKey && result.ok) {
        // Published, then deleted from the library before the checkout reached its removal.
        const job = new ArchiveCaptureStore().forTask(taskId).find((entry) => entry.kind === "checkout")!;
        assert.equal(job.status, "published");
        deletedKey = archiveKey(job.producerId, job.archiveId);
        await real.delete(deletedKey, deletedKey);
      }
      return result;
    },
  };
  const w = world(t, { archives: gate, prepare: (path) => writeFileSync(join(path, "notes.md"), "keep me\n") });
  taskId = w.id;
  // The provider boundary re-verifies the archive and finds it deleted.
  const first = await w.runToDeadline();
  assert.deepEqual(first.cleanups, { failed: 1 });
  assert.ok(deletedKey, "the archive was published before it was deleted");
  assert.match(w.row()?.lastError ?? "", /the archive of this checkout's local-only files was deleted/);
  assert.equal(readFileSync(join(w.path, "notes.md"), "utf8"), "keep me\n");
  assert.equal(new ArchiveCaptureStore().forTask(w.id).find((entry) => entry.kind === "checkout")?.status, "deleted");

  // The retry stops at the archive step: a deleted bundle is never recreated.
  w.state.now = w.row()!.retryAt!;
  assert.deepEqual((await w.observer.runPass()).cleanups, { "archive-refused": 1 });
  assert.match(w.row()?.lastError ?? "", /the archive of this checkout's local-only files was deleted/);
  assert.equal(readFileSync(join(w.path, "notes.md"), "utf8"), "keep me\n");
  assert.equal(w.task().worktreePath, w.path);
  assert.equal(new ArchiveCaptureStore().forTask(w.id).filter((entry) => entry.kind === "checkout").length, 1,
    "no second bundle was published");
});

test("a local-only file changed after its archive settled is caught at the provider boundary", async (t) => {
  enable(t);
  const library = join(home, `library-boundary-${sequence + 1}`);
  const real = new ArchiveManager({ root: library, intervalMs: null, watch: false, log: () => {} });
  let notes = "";
  let calls = 0;
  const gate: TaskArchiveGate = {
    ensureReady: (id) => real.ensureReady(id),
    settleBeforeCleanup: (id) => real.settleBeforeCleanup(id),
    withCheckoutFilesHeld: (input, removal) => real.withCheckoutFilesHeld(input, removal),
    preserveCheckoutFiles: async (input) => {
      const result = await real.preserveCheckoutFiles(input);
      // Call 1 is the archive step before guard 2; call 2 is the provider boundary's own
      // re-verification of that bundle. The file changes right after it, before the boundary's
      // final activity read and the delete.
      if (++calls === 2) writeFileSync(notes, "keep me, edited after the archive settled\n");
      return result;
    },
  };
  const w = world(t, { archives: gate, prepare: (path) => writeFileSync(join(path, "notes.md"), "keep me\n") });
  notes = join(w.path, "notes.md");
  const pass = await w.runToDeadline();
  assert.ok(calls >= 2, "the archive was re-verified at the provider boundary");
  assert.deepEqual(pass.cleanups, { failed: 1 });
  assert.match(w.row()?.lastError ?? "", /Git activity changed during cleanup/);
  assert.equal(readFileSync(notes, "utf8"), "keep me, edited after the archive settled\n");
  assert.equal(w.task().worktreePath, w.path);
  // The bundle published before the edit still holds the bytes the decision was made on.
  const first = new ArchiveCaptureStore().forTask(w.id).find((entry) =>
    entry.kind === "checkout" && entry.scope?.files?.[0]?.bytes === "keep me\n".length)!;
  assert.equal(first.status, "published");
  assert.equal(readFileSync(join(library, first.relativePath!, "artifacts", "repo-01", "notes.md"), "utf8"), "keep me\n");
});

test("an orphan recorded outside the task's exact slot earns no deadline and stays untouched", async (t) => {
  enable(t);
  let elsewhere = "";
  const w = world(t, {
    prepare: (_path, { clone, branch }) => {
      // A real orphan in every other respect, one directory over from where this task's slot is.
      elsewhere = join(dirname(_path), `${basename(_path)}-elsewhere`);
      mkLinkedWorktree(clone, `${branch}-elsewhere`, elsewhere);
      writeFileSync(join(elsewhere, "notes.md"), "not this task's slot\n");
      orphan(elsewhere);
    },
  });
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  w.registry.upsertTask({ ...w.task(), worktreePath: elsewhere });
  await w.observer.runPass();
  assert.equal(w.row()?.unownedSince, null, "no deadline for a checkout outside the exact slot");
  assert.ok(w.row()?.lastError, "held with a blocker");
  assert.equal((await w.status())?.checkouts[0]?.class, "registered", "outside the slot it is not this class at all");
  w.state.now += 10 * WEEK;
  assert.deepEqual((await w.observer.runPass()).cleanups, {});
  assert.equal(w.row()?.unownedSince, null);
  assert.equal(readFileSync(join(elsewhere, "notes.md"), "utf8"), "not this task's slot\n");
  assert.equal(w.task().worktreePath, elsewhere);
  assert.deepEqual(w.state.preserved, []);
});

// --- the deletion boundary itself -------------------------------------------------------------

/** A proven orphan, its ref, and the digest a cleanup claim would have been taken against. */
async function boundary(t: TestContext) {
  const w = world(t, { prepare: (path) => writeFileSync(join(path, "notes.md"), "archived work\n") });
  const ref = { repoRoot: w.clone, worktreePath: w.path, branch: w.branch, provider: "git" as const,
    worktreeLeaseId: null, baseSha: w.baseSha, role: "primary" as const, position: 0 };
  const claimed = await orphanedCheckoutFingerprint(ref, w.path);
  assert.equal(claimed?.kind, "known");
  return { w, ref, digest: claimed?.kind === "known" ? claimed.digest : "" };
}

test("a file written during the first occupancy check refuses the delete and survives", async (t) => {
  const { w, ref, digest } = await boundary(t);
  const seen: string[] = [];
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, digest, async (at) => {
    seen.push(at);
    if (seen.length === 1) writeFileSync(join(at, "late.md"), "written during the boundary\n");
    return null;
  }), /orphaned checkout changed before its removal/);
  assert.equal(seen[0], w.path, "occupancy is checked at the slot first");
  assert.notEqual(seen[1], w.path, "then on the directory set aside for removal");
  assert.equal(readFileSync(join(w.path, "late.md"), "utf8"), "written during the boundary\n", "restored to its slot");
  assert.equal(readFileSync(join(w.path, "notes.md"), "utf8"), "archived work\n");
});

test("a file written during the occupancy check on the set-aside directory is re-read and refuses the delete", async (t) => {
  const { w, ref, digest } = await boundary(t);
  let calls = 0;
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, digest, async (at) => {
    // The second call runs on the set-aside directory; content is re-read after it returns.
    if (++calls === 2) writeFileSync(join(at, "late.md"), "written during the last check\n");
    return null;
  }), /orphaned checkout changed before its removal/);
  assert.equal(calls, 2, "refused before the final occupancy check");
  assert.equal(readFileSync(join(w.path, "late.md"), "utf8"), "written during the last check\n", "restored to its slot");
  assert.equal(readFileSync(join(w.path, "notes.md"), "utf8"), "archived work\n");
});

test("nothing can be added through the slot path once it is set aside", async (t) => {
  const { w, ref, digest } = await boundary(t);
  let calls = 0;
  let writeThroughSlot: unknown = null;
  assert.equal(await removeOrphanedTaskCheckout(ref, w.path, digest, async () => {
    if (++calls === 2) {
      try {
        writeFileSync(join(w.path, "late.md"), "too late\n");
      } catch (error) {
        writeThroughSlot = (error as NodeJS.ErrnoException).code;
      }
    }
    return null;
  }), "removed");
  assert.equal(writeThroughSlot, "ENOENT", "the slot path no longer reaches the checkout");
  assert.equal(existsSync(w.path), false);
});

test("a link naming another task's worktree is not this task's orphan", async (t) => {
  enable(t);
  const w = world(t, {
    // Same repository, same missing-admin shape - but the administrative directory named is a
    // sibling task's, not this slot's.
    prepare: (path, { clone }) => writeFileSync(join(path, ".git"),
      `gitdir: ${join(realpathSync(join(clone, ".git")), "worktrees", "some-other-task")}\n`),
    registered: true,
  });
  await w.observer.runPass();
  assert.equal(w.row()?.unownedSince, null);
  assert.match(w.row()?.lastError ?? "", /links to another task's worktree/);
  assert.ok(existsSync(join(w.path, "keep.txt")));
});

test("a different orphan swapped into the slot is never deleted in its place", async (t) => {
  const { w, ref, digest } = await boundary(t);
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, digest, async (at) => {
    // Same content, same kind of dangling link - but to a different administrative directory.
    writeFileSync(join(at, ".git"), `gitdir: ${join(w.clone, ".git", "worktrees", "someone-else")}\n`);
    return null;
  }), /orphaned checkout changed before its removal/);
  assert.ok(existsSync(join(w.path, "notes.md")), "restored to its slot");
});

test("occupancy on the set-aside directory refuses the delete and restores the slot", async (t) => {
  const { w, ref, digest } = await boundary(t);
  const order: string[] = [];
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, digest, async (at) => {
    order.push(at === w.path ? "slot" : "aside");
    return order.length === 2 ? "a process still uses a checkout" : null;
  }), /a process still uses a checkout/);
  assert.deepEqual(order, ["slot", "aside"]);
  assert.ok(existsSync(join(w.path, "notes.md")));
  assert.deepEqual(readdirSync(dirname(w.path)).filter((name) => name.includes(".reclaim-")), [], "nothing left aside");

  // The final occupancy check, after content and identity are re-read, refuses too.
  const final: string[] = [];
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, digest, async (at) => {
    final.push(at === w.path ? "slot" : "aside");
    return final.length === 3 ? "a process still uses a checkout" : null;
  }), /a process still uses a checkout/);
  assert.deepEqual(final, ["slot", "aside", "aside"], "occupancy is the last check before the delete");
  assert.ok(existsSync(join(w.path, "notes.md")));

  // A claim taken against different content is refused outright.
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, "0".repeat(64), async () => null),
    /orphaned checkout changed before its removal/);
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, undefined, async () => null),
    /no claimed fingerprint/);
  assert.ok(existsSync(w.path));

  // With nothing changed and nobody inside, the exact slot is deleted.
  assert.equal(await removeOrphanedTaskCheckout(ref, w.path, digest, async () => null), "removed");
  assert.equal(existsSync(w.path), false);
  assert.deepEqual(readdirSync(dirname(w.path)).filter((name) => name.includes(".reclaim-")), []);
  assert.ok(existsSync(w.clone), "the recorded repository is untouched");
});

test("an unknown ignored file that appears at the boundary refuses the delete", async (t) => {
  let base = "";
  const w = world(t, {
    prepare: (path) => {
      writeFileSync(join(path, ".gitignore"), ".env\n");
      gitIn(path, "add", ".gitignore");
      gitIn(path, "commit", "-qm", "ignore rules");
      base = gitIn(path, "rev-parse", "HEAD");
    },
  });
  const ref = { repoRoot: w.clone, worktreePath: w.path, branch: w.branch, provider: "git" as const,
    worktreeLeaseId: null, baseSha: base, role: "primary" as const, position: 0 };
  const claimed = await orphanedCheckoutFingerprint(ref, w.path);
  assert.equal(claimed?.kind, "known");
  const digest = claimed?.kind === "known" ? claimed.digest : "";
  // Ignored files do not move the digest, so only the ignored-file rule can see this one.
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, digest, async (at) => {
    if (at !== w.path) writeFileSync(join(at, ".env"), "TOKEN=local\n");
    return null;
  }), /ignored files outside regenerable directories/);
  assert.equal(readFileSync(join(w.path, ".env"), "utf8"), "TOKEN=local\n", "restored to its slot");
  // And present before the delete starts, it refuses before anything is moved.
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, digest, async () => null),
    /ignored files outside regenerable directories/);
  assert.ok(existsSync(join(w.path, ".env")));
});

test("a delete that fails part-way restores what is left to the slot", async (t) => {
  const { w, ref, digest } = await boundary(t);
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, digest, async () => null, async (aside) => {
    rmSync(join(aside, "keep.txt"));
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  }), /orphaned checkout removal failed/);
  assert.ok(existsSync(join(w.path, "notes.md")), "the remainder is back at the slot the task records");
  assert.deepEqual(readdirSync(dirname(w.path)).filter((name) => name.includes(".reclaim-")), []);
  // The partial remainder no longer matches the claim, so a retry holds it rather than deleting.
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, digest, async () => null),
    /orphaned checkout changed before its removal/);
});

test("a set-aside checkout that could not be restored keeps its task and ledger row", async (t) => {
  enable(t);
  const w = world(t, { prepare: (path) => writeFileSync(join(path, "notes.md"), "archived work\n") });
  await w.observer.runPass();
  const ref = { repoRoot: w.clone, worktreePath: w.path, branch: w.branch, provider: "git" as const,
    worktreeLeaseId: null, baseSha: w.baseSha, role: "primary" as const, position: 0 };
  const claimed = await orphanedCheckoutFingerprint(ref, w.path);
  const digest = claimed?.kind === "known" ? claimed.digest : "";
  // The delete fails, and something has taken the slot path, so the rename back fails too.
  await assert.rejects(removeOrphanedTaskCheckout(ref, w.path, digest, async () => null, async () => {
    writeFileSync(w.path, "squatter\n");
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  }), /the checkout was kept beside its slot/);
  rmSync(w.path);
  const aside = readdirSync(dirname(w.path)).filter((name) => name.startsWith(`.${w.id}.reclaim-`));
  assert.equal(aside.length, 1, "the files are beside the slot");
  t.after(() => rmSync(join(dirname(w.path), aside[0]!), { recursive: true, force: true }));

  // The slot is now missing, but it is not "already gone": the row must not complete over it.
  assert.equal((await classifyTaskCheckout(ref, w.path)).kind, "unproven");
  w.state.now += 2 * WEEK;
  assert.deepEqual((await w.observer.runPass()).cleanups, {});
  assert.ok(w.row(), "the ledger row is kept");
  assert.match(w.row()?.lastError ?? "", /an earlier removal left this checkout set aside/);
  assert.equal(w.task().worktreePath, w.path);
  assert.equal(readFileSync(join(dirname(w.path), aside[0]!, "notes.md"), "utf8"), "archived work\n");
});

test("a merged pull request recorded without a branch is not this checkout's proof", async (t) => {
  enable(t);
  let head = "";
  const w = world(t, {
    prepare: (path, { origin, branch }) => {
      head = mergedOnOrigin(t, origin, branch, PR_FILES);
      for (const [file, content] of Object.entries(PR_FILES)) writeFileSync(join(path, file), content);
    },
  });
  // The content equals this merged head, but the record cannot say which branch it was for.
  recordEpisode(w.id, "a", null, { url: "https://github.com/example/repo/pull/15", head, mergedAt: 1_500 });
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { reclaimed: 1 });
  assert.ok(w.state.preserved.length > 0, "the differences were archived as local-only work, not trusted to the record");
  for (const entry of w.state.preserved) assert.deepEqual(entry.files.map((file) => file.path), ["feature.txt", "keep.txt"]);
  assert.ok(w.state.held.length > 0, "and they were deleted only while their archive was held");
});

test("an archive deleted during removal waits for the removal, and one deleted before it refuses it", async (t) => {
  enable(t);
  const library = join(home, `library-held-${sequence + 1}`);
  const real = new ArchiveManager({ root: library, intervalMs: null, watch: false, log: () => {} });
  const events: string[] = [];
  let deletion: Promise<unknown> | null = null;
  let taskId = "";
  const gate: TaskArchiveGate = {
    ensureReady: (id) => real.ensureReady(id),
    settleBeforeCleanup: (id) => real.settleBeforeCleanup(id),
    preserveCheckoutFiles: (input) => real.preserveCheckoutFiles(input),
    withCheckoutFilesHeld: (input, removal) => real.withCheckoutFilesHeld(input, async () => {
      // The operator deletes the archive while the checkout is being removed.
      const job = new ArchiveCaptureStore().forTask(taskId).find((entry) => entry.kind === "checkout")!;
      const key = archiveKey(job.producerId, job.archiveId);
      deletion = real.delete(key, key).then(() => events.push("archive deleted"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const removed = await removal();
      events.push("checkout removed");
      return removed;
    }),
  };
  const w = world(t, { archives: gate, prepare: (path) => writeFileSync(join(path, "notes.md"), "keep me\n") });
  taskId = w.id;
  const pass = await w.runToDeadline();
  await deletion;
  assert.deepEqual(pass.cleanups, { reclaimed: 1 });
  assert.deepEqual(events, ["checkout removed", "archive deleted"], "the delete waited for the removal");

  // Deleted first: the hold refuses and never calls the removal.
  const other = world(t, { archives: "real", prepare: (path) => writeFileSync(join(path, "notes.md"), "keep me\n") });
  const manager = new ArchiveManager({ root: other.library, intervalMs: null, watch: false, log: () => {} });
  const files = [{ path: "notes.md", sha256: createHash("sha256").update("keep me\n").digest("hex"), bytes: 8 }];
  const input = { taskId: other.id, title: "t", repoLabel: null, checkout: other.path, commit: other.baseSha, files };
  assert.deepEqual(await manager.preserveCheckoutFiles(input), { ok: true });
  const published = new ArchiveCaptureStore().forTask(other.id).find((entry) => entry.kind === "checkout")!;
  const publishedKey = archiveKey(published.producerId, published.archiveId);
  await manager.delete(publishedKey, publishedKey);
  let called = false;
  await assert.rejects(manager.withCheckoutFilesHeld(input, async () => { called = true; }), /not archived/);
  assert.equal(called, false, "the removal never ran");
  assert.equal(readFileSync(join(other.path, "notes.md"), "utf8"), "keep me\n");
});

test("report-only names the base commit when the only difference from it is a deleted tracked file", async (t) => {
  setPreview(t, "report-only");
  const w = world(t, { prepare: (path) => rmSync(join(path, "keep.txt")) });
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, {});
  assert.equal(w.row()?.lastError, "report only: orphaned checkout matches its base commit and would be removed");
  assert.ok(existsSync(w.path));
});

test("an open pull request recorded for the checkout's branch is not proof, so its content is archived first", async (t) => {
  enable(t);
  let head = "";
  const w = world(t, {
    prepare: (path, { origin, branch }) => {
      head = mergedOnOrigin(t, origin, branch, PR_FILES);
      for (const [file, content] of Object.entries(PR_FILES)) writeFileSync(join(path, file), content);
    },
  });
  // Exactly this branch, exactly this head - but never merged.
  recordEpisode(w.id, "a", w.branch, { url: "https://github.com/example/repo/pull/16", head, mergedAt: null });
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { reclaimed: 1 });
  assert.ok(w.state.preserved.length > 0, "the matching content was archived as local-only work");
  for (const entry of w.state.preserved) assert.deepEqual(entry.files.map((file) => file.path), ["feature.txt", "keep.txt"]);
  assert.ok(w.state.held.length > 0, "and deleted only while its archive was held");
});

test("a merged pull request with no recorded head commit holds the orphan", async (t) => {
  enable(t);
  const w = world(t, {
    prepare: (path) => {
      for (const [file, content] of Object.entries(PR_FILES)) writeFileSync(join(path, file), content);
    },
  });
  recordEpisode(w.id, "a", w.branch, { url: "https://github.com/example/repo/pull/17", head: null, mergedAt: 1_500 });
  const pass = await w.runToDeadline();
  assert.deepEqual(pass.cleanups, { "validation-unknown": 1 }, "no deletion is authorized");
  assert.match(w.row()?.lastError ?? "", /merged pull request head commit was not recorded/);
  assert.equal(readFileSync(join(w.path, "feature.txt"), "utf8"), PR_FILES["feature.txt"]);
  assert.equal(w.task().worktreePath, w.path);
  assert.deepEqual(w.state.preserved, [], "nothing was archived on an unproven record");
  // Retries keep holding: a later pass at the retry time still refuses.
  w.state.now = w.row()!.retryAt!;
  assert.deepEqual((await w.observer.runPass()).cleanups, { "validation-unknown": 1 });
  assert.ok(existsSync(join(w.path, "feature.txt")));
});
