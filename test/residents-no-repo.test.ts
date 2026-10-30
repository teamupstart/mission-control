import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TASK_KINDS } from "../src/shared/types.ts";
import { taskHasRepository, TASK_KIND_BEHAVIOR } from "../src/shared/task.ts";
import { taskRepoRefs, taskRepoPrSummaries, taskHasWorktrees } from "../src/shared/task-repos.ts";
import { mkTask, mkSession } from "./helpers/session-fixture.ts";
import { orderSessions } from "../src/web/lib/fleet-order.ts";
import { LaunchResidentSchema } from "../src/shared/residents.ts";

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

test("workspace cleanup is idempotent and refuses symlinks and foreign paths", () => {
  const directory = residentWorkspaceDir("owned");
  createResidentWorkspace("owned", directory);
  writeFileSync(join(directory, "notes.txt"), "temporary");
  removeResidentWorkspace("owned", directory);
  removeResidentWorkspace("owned", directory);
  assert.equal(existsSync(directory), false);
  const foreign = join(home, "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "keep.txt"), "operator data");
  assert.throws(() => removeResidentWorkspace("owned", foreign), /ownership/);
  symlinkSync(foreign, directory);
  assert.throws(() => removeResidentWorkspace("owned", directory), /owned directory/);
  assert.ok(existsSync(join(foreign, "keep.txt")));
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
