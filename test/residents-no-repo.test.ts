import { after, test } from "node:test";
import assert from "node:assert/strict";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { TASK_KINDS } from "../src/shared/types.ts";
import { taskHasRepository, TASK_KIND_BEHAVIOR } from "../src/shared/task.ts";
import { taskRepoRefs, taskRepoPrSummaries, taskHasWorktrees } from "../src/shared/task-repos.ts";
import { mkTask, mkSession } from "./helpers/session-fixture.ts";
import { orderSessions } from "../src/web/lib/fleet-order.ts";
import { LaunchResidentSchema } from "../src/shared/residents.ts";

ensureNativeStateLockAddon();

const home = realpathSync(mkdtempSync(join(tmpdir(), "resident-owned-workspace-")));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const { residentWorkspaceDir, createResidentWorkspace, removeResidentWorkspace } = await import("../src/server/residents/workspace.ts");

test("only residents can opt out of repository behavior, and old tasks still have repositories", () => {
  for (const kind of TASK_KINDS) {
    assert.equal(taskHasRepository({ kind }), true);
    assert.equal(taskHasRepository({ kind, workspaceKind: null }), true);
    assert.equal(taskHasRepository({ kind, workspaceKind: "resident-workspace" }), kind !== "resident");
    assert.equal(TASK_KIND_BEHAVIOR[kind].repoAvailability === "optional", kind === "resident");
  }
  const task = mkTask({ kind: "resident", workspaceKind: "resident-workspace", worktreePath: "/stale/path" });
  assert.deepEqual(taskRepoRefs(task), []);
  assert.equal(taskHasWorktrees(task), false);
  assert.deepEqual(taskRepoPrSummaries(task, { prUrl: null, prState: null, mergedAt: null }, () => assert.fail("no PR lookup")), []);
  assert.equal(LaunchResidentSchema.parse({ requestId: "omitted-repository" }).repoRoot, null);
});

test("repository grouping leaves a repo-less resident loose even with stale repository metadata", () => {
  const session = mkSession({ id: "resident", repoRoot: "/stale/repo" });
  session.task = { ...session.task!, kind: "resident", workspaceKind: "resident-workspace" };
  const order = orderSessions([session], new Set(), true);
  assert.deepEqual(order.groups.flatMap((group) => group.repos), []);
  assert.equal(order.sessions.length, 1);
});

test("workspace creation and cleanup refuse every symlink boundary without modifying its target", async (t) => {
  const parts = ["residents", "runs", "boundary-run", "workspace"];
  for (let index = 0; index < parts.length; index += 1) {
    for (const dangling of [false, true]) {
      await t.test(`${parts[index]} boundary, ${dangling ? "dangling" : "existing"} target`, async () => {
        const boundary = join(home, ...parts.slice(0, index + 1));
        const foreign = mkdtempSync(join(home, "foreign-boundary-"));
        writeFileSync(join(foreign, "keep.txt"), "untouched");
        mkdirSync(dirname(boundary), { recursive: true });
        symlinkSync(dangling ? join(foreign, "missing") : foreign, boundary);
        try {
          const directory = residentWorkspaceDir("boundary-run");
          assert.throws(() => createResidentWorkspace("boundary-run", directory), /owned directory/);
          await assert.rejects(() => removeResidentWorkspace("boundary-run", directory), /owned directory/);
          assert.ok(lstatSync(boundary).isSymbolicLink());
          assert.deepEqual(readdirSync(foreign), ["keep.txt"], "no descendants were created through the link");
          assert.equal(readFileSync(join(foreign, "keep.txt"), "utf8"), "untouched");
        } finally {
          rmSync(join(home, "residents"), { recursive: true, force: true });
        }
      });
    }
  }
});

test("workspace cleanup stays anchored when an ancestor is swapped for a symlink and can retry", async (t) => {
  const parts = ["residents", "runs", "swap-run", "workspace"];
  for (let index = 0; index < parts.length - 1; index += 1) {
    await t.test(parts[index]!, async () => {
      const directory = residentWorkspaceDir("swap-run");
      createResidentWorkspace("swap-run", directory);
      writeFileSync(join(directory, "owned.txt"), "temporary");
      const boundary = join(home, ...parts.slice(0, index + 1));
      const saved = `${boundary}-saved`;
      const foreign = mkdtempSync(join(home, "foreign-swap-"));
      const foreignWorkspace = join(foreign, ...parts.slice(index + 1));
      mkdirSync(foreignWorkspace, { recursive: true });
      const sentinel = join(foreignWorkspace, "keep.txt");
      writeFileSync(sentinel, "foreign data");
      // Removal has validated and opened its boundaries, but its asynchronous work
      // has not returned to JavaScript. Replace an ancestor before that continuation.
      const removing = removeResidentWorkspace("swap-run", directory).catch((error: unknown) => error);
      renameSync(boundary, saved);
      symlinkSync(foreign, boundary);
      try {
        await removing;
        assert.equal(readFileSync(sentinel, "utf8"), "foreign data");
        assert.ok(lstatSync(boundary).isSymbolicLink(), "the replacement boundary is not consumed");
      } finally {
        rmSync(boundary);
        renameSync(saved, boundary);
      }
      await removeResidentWorkspace("swap-run", directory);
      assert.equal(existsSync(dirname(directory)), false, "retry removes the owned run directory");
      rmSync(join(home, "residents"), { recursive: true, force: true });
    });
  }
});

test("workspace cleanup is idempotent and refuses symlinks and foreign paths", async () => {
  const directory = residentWorkspaceDir("owned");
  createResidentWorkspace("owned", directory);
  writeFileSync(join(directory, "notes.txt"), "temporary");
  await removeResidentWorkspace("owned", directory);
  await removeResidentWorkspace("owned", directory);
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(dirname(directory)), false, "cleanup removes the empty per-run directory");
  assert.ok(existsSync(dirname(dirname(directory))), "the shared runs directory remains");
  const foreign = join(home, "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "keep.txt"), "operator data");
  await assert.rejects(() => removeResidentWorkspace("owned", foreign), /ownership/);
  mkdirSync(dirname(directory), { recursive: true });
  symlinkSync(foreign, directory);
  await assert.rejects(() => removeResidentWorkspace("owned", directory), /owned directory/);
  assert.ok(existsSync(join(foreign, "keep.txt")));
});

test("workspace cleanup removes nested files and link entries without following their targets", async () => {
  const directory = residentWorkspaceDir("nested");
  createResidentWorkspace("nested", directory);
  const nested = join(directory, "a", "b");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "notes.txt"), "temporary");
  const foreign = mkdtempSync(join(home, "foreign-nested-"));
  writeFileSync(join(foreign, "keep.txt"), "foreign data");
  symlinkSync(foreign, join(nested, "link"));
  symlinkSync(join(foreign, "missing"), join(nested, "dangling"));
  await removeResidentWorkspace("nested", directory);
  assert.equal(existsSync(dirname(directory)), false);
  assert.equal(readFileSync(join(foreign, "keep.txt"), "utf8"), "foreign data");
});

test("workspace cleanup restores owner access on held read-only directories without changing link targets", async () => {
  const directory = residentWorkspaceDir("read-only");
  createResidentWorkspace("read-only", directory);
  const nested = join(directory, "cache");
  mkdirSync(nested);
  writeFileSync(join(nested, "entry.txt"), "cache");
  const foreign = mkdtempSync(join(home, "read-only-foreign-"));
  writeFileSync(join(foreign, "keep.txt"), "foreign");
  symlinkSync(foreign, join(nested, "link"));
  for (const entry of [nested, directory, dirname(directory), foreign]) chmodSync(entry, 0o555);
  try {
    await removeResidentWorkspace("read-only", directory);
    assert.equal(existsSync(dirname(directory)), false);
    assert.equal(readFileSync(join(foreign, "keep.txt"), "utf8"), "foreign");
    assert.equal(statSync(foreign).mode & 0o777, 0o555, "permission repair never follows a link");
  } finally {
    for (const entry of [nested, directory, dirname(directory), foreign]) if (existsSync(entry)) chmodSync(entry, 0o700);
  }
});

test("workflow repository capture has no checkout for a repo-less resident", async () => {
  const { scoutRepoSlots } = await import("../src/server/scouts/repos.ts");
  assert.deepEqual(scoutRepoSlots(mkTask({ kind: "resident", workspaceKind: "resident-workspace" }), "/resident/workspace"), []);
  const { workflowCheckoutPath } = await import("../src/server/workflows/context.ts");
  const session = mkSession({ cwd: "/resident/workspace" });
  session.task = { ...session.task!, kind: "resident", workspaceKind: "resident-workspace" };
  assert.equal(workflowCheckoutPath({ repoRoot: "", sessionCwd: session.cwd }, session), null);
});

test("resident Files lists its plain directory without Git and excludes symlink entries", async () => {
  const { listSessionFiles } = await import("../src/server/session-files.ts");
  const directory = residentWorkspaceDir("files");
  createResidentWorkspace("files", directory);
  mkdirSync(join(directory, "nested"));
  writeFileSync(join(directory, "notes.txt"), "notes");
  writeFileSync(join(directory, "nested", "detail.md"), "detail");
  symlinkSync(join(home, "foreign"), join(directory, "outside"));
  symlinkSync(join(directory, "notes.txt"), join(directory, "link.txt"));
  assert.deepEqual(await listSessionFiles(directory, { kind: "resident", workspaceKind: "resident-workspace" }), [
    { path: "nested/detail.md" }, { path: "notes.txt" },
  ]);
});

test("resident Files does not follow a queued directory swapped for a symlink", async (t) => {
  const { listSessionFiles } = await import("../src/server/session-files.ts");
  for (const swapAt of [3, 4, 5]) {
    await t.test(`swap at traversal checkpoint ${swapAt}`, async (t) => {
      const directory = mkdtempSync(join(home, "listing-swap-"));
      const queued = join(directory, "queued");
      mkdirSync(queued);
      writeFileSync(join(queued, "owned.txt"), "owned");
      const foreign = mkdtempSync(join(home, "listing-foreign-"));
      writeFileSync(join(foreign, "outside-secret-name.txt"), "foreign");
      let checkpoints = 0;
      t.mock.method(performance, "now", () => {
        if (++checkpoints === swapAt) {
          renameSync(queued, `${queued}-saved`);
          symlinkSync(foreign, queued);
        }
        return 0;
      });
      const files = await listSessionFiles(directory, { kind: "resident", workspaceKind: "resident-workspace" });
      assert.ok(checkpoints >= swapAt, "the adversarial swap happened during traversal");
      assert.ok(files.every(({ path }) => !path.includes("outside-secret-name")), JSON.stringify(files));
      assert.equal(readFileSync(join(foreign, "outside-secret-name.txt"), "utf8"), "foreign");
    });
  }
});

test("resident Files refuses a substituted root or root ancestor", async (t) => {
  const { listSessionFiles, SessionFileError } = await import("../src/server/session-files.ts");
  for (const ancestor of [false, true]) {
    await t.test(ancestor ? "ancestor" : "root", async () => {
      const parent = mkdtempSync(join(home, "listing-root-"));
      const directory = join(parent, "workspace");
      mkdirSync(directory);
      const foreign = mkdtempSync(join(home, "listing-outside-"));
      mkdirSync(join(foreign, "workspace"));
      writeFileSync(join(foreign, "outside-secret-name.txt"), "foreign");
      writeFileSync(join(foreign, "workspace", "outside-secret-name.txt"), "foreign");
      const boundary = ancestor ? parent : directory;
      renameSync(boundary, `${boundary}-saved`);
      symlinkSync(foreign, boundary);
      await assert.rejects(() => listSessionFiles(directory, { kind: "resident", workspaceKind: "resident-workspace" }),
        (error: unknown) => error instanceof SessionFileError && error.status === 403);
    });
  }
});

test("resident Files lists an ordinary replacement at the run path without traversing its former parent", async () => {
  const { listSessionFiles } = await import("../src/server/session-files.ts");
  const directory = residentWorkspaceDir("ordinary-replacement");
  createResidentWorkspace("ordinary-replacement", directory);
  writeFileSync(join(directory, "original.txt"), "original run content");
  const original = statSync(directory, { bigint: true });
  const outside = mkdtempSync(join(home, "replacement-source-"));
  const replacement = join(outside, "moved-directory");
  mkdirSync(replacement);
  writeFileSync(join(replacement, "moved.txt"), "content moved into the run");
  writeFileSync(join(outside, "outside-only.txt"), "stays outside");
  const moved = statSync(replacement, { bigint: true });
  renameSync(directory, `${directory}-saved`);
  renameSync(replacement, directory);
  assert.notEqual(moved.ino, original.ino);
  assert.equal(statSync(directory, { bigint: true }).ino, moved.ino);
  assert.equal(existsSync(replacement), false, "rename moves the directory; it creates no outside alias");
  assert.deepEqual(await listSessionFiles(directory, { kind: "resident", workspaceKind: "resident-workspace" }), [
    { path: "moved.txt" },
  ]);
  assert.equal(readFileSync(join(outside, "outside-only.txt"), "utf8"), "stays outside");
});

test("resident Files keeps its opened root when an ordinary replacement is moved over the pathname", async (t) => {
  const { listSessionFiles } = await import("../src/server/session-files.ts");
  const directory = residentWorkspaceDir("ordinary-root-race");
  createResidentWorkspace("ordinary-root-race", directory);
  mkdirSync(join(directory, "nested"));
  writeFileSync(join(directory, "nested", "original.txt"), "original run content");
  const replacement = mkdtempSync(join(home, "replacement-race-"));
  writeFileSync(join(replacement, "replacement-only.txt"), "replacement content");
  let checkpoints = 0;
  t.mock.method(performance, "now", () => {
    if (++checkpoints === 2) {
      // The root is open, immediately before its first asynchronous enumeration.
      renameSync(directory, `${directory}-saved`);
      renameSync(replacement, directory);
    }
    return 0;
  });
  assert.deepEqual(await listSessionFiles(directory, { kind: "resident", workspaceKind: "resident-workspace" }), [
    { path: "nested/original.txt" },
  ]);
  assert.ok(checkpoints >= 2);
  assert.equal(readFileSync(join(directory, "replacement-only.txt"), "utf8"), "replacement content");
});

test("moving an outside directory to a resident root requires write access to its source parent", {
  skip: process.getuid?.() === 0 ? "root bypasses directory permissions" : false,
}, () => {
  const directory = residentWorkspaceDir("replacement-permissions");
  createResidentWorkspace("replacement-permissions", directory);
  rmSync(directory, { recursive: true });
  const outside = mkdtempSync(join(home, "replacement-denied-"));
  const source = join(outside, "private-directory");
  mkdirSync(source);
  writeFileSync(join(source, "outside-only.txt"), "stays outside");
  chmodSync(outside, 0o555);
  try {
    assert.throws(() => renameSync(source, directory), (error: unknown) =>
      ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""));
    assert.equal(existsSync(directory), false);
    assert.equal(readFileSync(join(source, "outside-only.txt"), "utf8"), "stays outside");
  } finally {
    chmodSync(outside, 0o700);
  }
});

test("resident Files caps regular entries returned by the asynchronous directory scan", async () => {
  const { listSessionFiles, MAX_SESSION_FILE_ENTRIES } = await import("../src/server/session-files.ts");
  const directory = mkdtempSync(join(home, "listing-file-cap-"));
  for (let i = 0; i <= MAX_SESSION_FILE_ENTRIES; i += 1) writeFileSync(join(directory, `file-${i}.txt`), "");
  const files = await listSessionFiles(directory, { kind: "resident", workspaceKind: "resident-workspace" });
  assert.equal(files.length, MAX_SESSION_FILE_ENTRIES);
  assert.equal(new Set(files.map(({ path }) => path)).size, MAX_SESSION_FILE_ENTRIES);
});

test("resident Files bounds empty-directory breadth and nesting depth", async (t) => {
  const { listSessionFiles, SessionFileError } = await import("../src/server/session-files.ts");
  const resident = { kind: "resident", workspaceKind: "resident-workspace" } as const;
  await t.test("empty-directory breadth", async () => {
    const directory = mkdtempSync(join(home, "wide-files-"));
    for (let i = 0; i < 9_999; i += 1) mkdirSync(join(directory, `empty-${i}`));
    assert.deepEqual(await listSessionFiles(directory, resident), [], "10,000 directories including the root are allowed");
    mkdirSync(join(directory, "one-too-many"));
    await assert.rejects(() => listSessionFiles(directory, resident), (error: unknown) =>
      error instanceof SessionFileError && error.status === 413 && /directory count/.test(error.message));
  });
  await t.test("deep nesting", async () => {
    const directory = mkdtempSync(join(home, "deep-files-"));
    let nested = directory;
    for (let depth = 0; depth < 64; depth += 1) {
      nested = join(nested, "d");
      mkdirSync(nested);
    }
    assert.deepEqual(await listSessionFiles(directory, resident), [], "64 nested directories are allowed");
    mkdirSync(join(nested, "one-too-deep"));
    await assert.rejects(() => listSessionFiles(directory, resident), (error: unknown) =>
      error instanceof SessionFileError && error.status === 413 && /depth/.test(error.message));
  });
});

test("resident Files stops traversal when its elapsed-time budget is exhausted", async (t) => {
  const { listSessionFiles, SessionFileError } = await import("../src/server/session-files.ts");
  const directory = mkdtempSync(join(home, "slow-files-"));
  let reads = 0;
  t.mock.method(performance, "now", () => reads++ === 0 ? 0 : 15_001);
  await assert.rejects(() => listSessionFiles(directory, { kind: "resident", workspaceKind: "resident-workspace" }),
    (error: unknown) => error instanceof SessionFileError && error.status === 503 && /time budget/.test(error.message));
});

test("repository reset operations refuse a repo-less resident before consulting Git", async () => {
  const { resetWouldDestroyWork, branchReleasedByReset, resetPreview, resetToOrigin, resetToCommit } = await import("../src/server/actions.ts");
  const session = mkSession({ cwd: "/must-not-probe" });
  session.task = { ...session.task!, kind: "resident", workspaceKind: "resident-workspace" };
  const error = "the session has no repository to reset";
  assert.equal(await resetWouldDestroyWork(session), error);
  assert.equal(await branchReleasedByReset(session), null);
  assert.equal((await resetPreview(session)).error, error);
  assert.equal((await resetToOrigin(session, false)).error, error);
  assert.equal((await resetToCommit(session, "a".repeat(40), false)).error, error);
});
