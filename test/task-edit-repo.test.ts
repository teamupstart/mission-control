import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { Task } from "../src/shared/types.ts";

// Throwaway state dir, set before anything opens the DB - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-task-edit-repo-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");

const repos = mkdtempSync(join(tmpdir(), "mission-task-edit-repos-"));
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});

/**
 * A task edit is judged on what it CHANGES, and the repo is the field where that
 * distinction has teeth.
 *
 * The editor restates the repo it was seeded with on any save it sends, and a shelved
 * task very often names a directory that has since gone: a reclaimed agent worktree, a
 * pooled lease, a project moved. Re-resolving a root nobody asked to change turns that
 * task permanently uneditable - a priority change refused, under a message about git
 * that mentions neither the priority nor the task - which is indistinguishable, from the
 * board, from a save that did nothing. Resolving a root the operator DID change is the
 * whole point of the check and stays.
 */

/** A real git repo, since the check runs `git rev-parse` rather than trusting a path. */
function gitRepo(name: string): string {
  const dir = join(repos, name);
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return realpathSync(dir);
}

function setup(over: Partial<Task> = {}) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(mkTask({ id: "t1", status: "backlog", ...over }));
  const app = buildApp(registry, {} as unknown as ReviewManager, tasks, {} as unknown as QueueManager);
  const patch = async (body: unknown): Promise<Response> =>
    app.request("/api/tasks/t1/update", {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { registry, patch };
}

test("a task whose repo has vanished is still editable", async () => {
  const { registry, patch } = setup({ repoRoot: join(repos, "reclaimed-worktree"), priority: null });
  // The repo is restated, unchanged, exactly as the editor sends it.
  const res = await patch({ repoRoot: join(repos, "reclaimed-worktree"), priority: "blocker" });
  assert.equal(res.status, 200);
  assert.equal(registry.getTask("t1")?.priority, "blocker");
});

test("moving a task onto something that is not a repo is still refused, and writes nothing", async () => {
  const { registry, patch } = setup({ repoRoot: gitRepo("home"), priority: "low" });
  const res = await patch({ repoRoot: join(repos, "not-a-repo"), priority: "blocker" });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /not a git repository/);
  // The refusal is the whole patch, so the priority in the same body is not applied.
  assert.equal(registry.getTask("t1")?.priority, "low");
});

test("moving a task onto a real repo resolves and stores the canonical root", async () => {
  const home = gitRepo("from");
  const moved = gitRepo("to");
  const { registry, patch } = setup({ repoRoot: home });
  const res = await patch({ repoRoot: `${moved}/` });
  assert.equal(res.status, 200);
  assert.equal(registry.getTask("t1")?.repoRoot, moved);
});
