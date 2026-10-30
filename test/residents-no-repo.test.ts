import { after, test } from "node:test";
import assert from "node:assert/strict";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { TASK_KINDS } from "../src/shared/types.ts";
import { taskHasRepository, TASK_KIND_BEHAVIOR } from "../src/shared/task.ts";
import { taskRepoRefs, taskRepoPrSummaries, taskHasWorktrees } from "../src/shared/task-repos.ts";
import { mkTask, mkSession } from "./helpers/session-fixture.ts";
import { orderSessions } from "../src/web/lib/fleet-order.ts";
import { LaunchResidentSchema } from "../src/shared/residents.ts";

ensureNativeStateLockAddon();

const home = mkdtempSync(join(tmpdir(), "resident-owned-workspace-"));
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
