import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import { cwdAllowlisted } from "../src/shared/allowlist.ts";

// What a task says its repo IS, and why a worktree is never the answer.
//
// Every agent this app dispatches stands in a pooled worktree, so `create_task` hands
// the daemon a path like `~/.treehouse/<repo>-<hash>/16/<repo>`. Recording that verbatim
// broke the backlog in a way nothing reported: `Task.repoRoot` is what Foreman's
// allowlist is asked about (`cwdAllowlisted`, from `decideBacklogTick`), that path is
// under no repo an operator ever named, and the item was passed over on every tick
// forever. Observed as 17 of a 19-item backlog silently unschedulable - with the status
// popover, which ignores the allowlist by design, still counting them ready.
//
// So the two halves pinned here are: resolution walks a worktree back to its owner, and
// a root that CANNOT be walked back is refused at the door instead of being written.

const home = mkdtempSync(join(tmpdir(), "mission-task-repo-root-home-"));
process.env.HARNESS_HOME = home;

const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { resolveRepoRoot, resolveTaskRepoRoot } = await import("../src/server/repos.ts");

const scratch = mkdtempSync(join(tmpdir(), "mission-task-repo-root-"));

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/**
 * A real repo with a real linked worktree - `git worktree add`, not a hand-built `.git`
 * file - because the whole point is what git itself reports from inside one. This is the
 * treehouse/dispatch shape: the tree lives nowhere near the repo that owns it.
 */
function repoWithWorktree(name: string): { main: string; worktree: string } {
  const main = join(scratch, name);
  mkdirSync(main, { recursive: true });
  git(main, ["init", "-q", "-b", "main"]);
  git(main, ["config", "user.email", "test@example.com"]);
  git(main, ["config", "user.name", "Test"]);
  writeFileSync(join(main, "README.md"), "# repo\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-qm", "init"]);
  const worktree = join(scratch, `${name}-pool`, "16", name);
  git(main, ["worktree", "add", "-q", "-b", "mancej/pooled", worktree]);
  return { main: realpathSync(main), worktree: realpathSync(worktree) };
}

test("resolveRepoRoot walks a linked worktree back to the checkout that owns it", async () => {
  const { main, worktree } = repoWithWorktree("walkback");
  // git's own answer from inside the tree is the tree. That is the value that used to be
  // stored, and it is the defect: it names a directory the pool reclaims and hands to
  // someone else, and it matches no allowlist entry.
  assert.equal(realpathSync(git(worktree, ["rev-parse", "--show-toplevel"])), worktree);
  assert.equal(await resolveRepoRoot(worktree), main);
  // A subdir of the tree resolves the same way - agents do not always sit at the top.
  const sub = join(worktree, "src");
  mkdirSync(sub, { recursive: true });
  assert.equal(await resolveRepoRoot(sub), main);
});

test("resolveRepoRoot is unchanged for a main checkout and a non-repo", async () => {
  const { main } = repoWithWorktree("unchanged");
  assert.equal(await resolveRepoRoot(main), main);
  assert.equal(await resolveRepoRoot(join(main, "src", "deep")), null, "a path that isn't there");
  assert.equal(await resolveRepoRoot(scratch), null, "a real dir that is not a checkout");
});

test("a worktree's resolved root clears the allowlist its own path never could", async () => {
  const { main, worktree } = repoWithWorktree("allowlist");
  // The exact question `decideBacklogTick` asks of `Task.repoRoot`, against an operator
  // who allowlisted their repo. This assertion IS the bug: the left side is what the
  // backlog held for 17 items, the right side is what it holds now.
  assert.equal(cwdAllowlisted(worktree, [main]), false);
  assert.equal(cwdAllowlisted((await resolveRepoRoot(worktree))!, [main]), true);
});

test("resolveTaskRepoRoot admits a main checkout and refuses a non-repo", async () => {
  const { main, worktree } = repoWithWorktree("admit");
  assert.deepEqual(await resolveTaskRepoRoot(main), { ok: true, repoRoot: main });
  assert.deepEqual(await resolveTaskRepoRoot(worktree), { ok: true, repoRoot: main });
  const missing = await resolveTaskRepoRoot(join(scratch, "nope"));
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /not a git repository/);
});

test("resolveTaskRepoRoot refuses a checkout with no reachable main checkout", async () => {
  // `--separate-git-dir` is the shape the walk-back cannot follow: `.git` is a FILE, and
  // the dir it points at carries no `commondir`, so there is no owning repo to name. A
  // submodule and a relocated git dir look the same from here. git resolves a top-level
  // for it happily, which is exactly why the refusal has to be its own check rather than
  // something `resolveRepoRoot` returning null would have covered.
  const tree = join(scratch, "detached-tree");
  mkdirSync(tree, { recursive: true });
  execFileSync("git", ["init", "-q", `--separate-git-dir=${join(scratch, "detached-gitdir")}`, tree]);

  assert.equal(await resolveRepoRoot(tree), realpathSync(tree), "git still calls it a checkout");
  const refusal = await resolveTaskRepoRoot(tree);
  assert.equal(refusal.ok, false);
  assert.match(refusal.ok ? "" : refusal.error, /not a repo's main checkout/);
  // The sentence has to name the path, since the caller is usually an agent passing its
  // own cwd and has no other way to tell which of its arguments was wrong.
  assert.match(refusal.ok ? "" : refusal.error, new RegExp(realpathSync(tree)));
});

test("MCP create_task from inside a pooled worktree files against the repo that owns it", async () => {
  const { main, worktree } = repoWithWorktree("mcp");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp(registry, {} as ReviewManager, tasks, {} as QueueManager);

  // Exactly what `src/mcp/server.ts` sends: `process.cwd()`, twice. The agent cannot know
  // it is standing in a worktree, so the daemon is the only place this can be fixed.
  const res = await app.request("/mcp/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({
      env: {},
      sessionId: "agent-session",
      cwd: worktree,
      repoRoot: worktree,
      title: "Phase 2",
      intent: "Implement phase 2",
      dependsOnTaskIds: [],
      dependsOnCurrentSession: false,
    }),
  });

  assert.equal(res.status, 200);
  const created = (await res.json()) as { repoRoot: string; status: string };
  assert.equal(created.status, "backlog");
  assert.equal(created.repoRoot, main);
  assert.notEqual(created.repoRoot, worktree);
});

test("a task cannot be created or edited into a root with no main checkout", async () => {
  const { main } = repoWithWorktree("refuse-http");
  const tree = join(scratch, "refuse-tree");
  mkdirSync(tree, { recursive: true });
  execFileSync("git", ["init", "-q", `--separate-git-dir=${join(scratch, "refuse-gitdir")}`, tree]);

  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp(registry, {} as ReviewManager, tasks, {} as QueueManager);
  const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

  const dispatch = await app.request("/api/tasks", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ repoRoot: tree, intent: "do a thing", backlog: true }),
  });
  assert.equal(dispatch.status, 400);
  assert.match(((await dispatch.json()) as { error: string }).error, /not a repo's main checkout/);

  // And the edit door, which is the other way a good row becomes a bad one.
  const task = tasks.create({
    repoRoot: main,
    intent: "do a thing",
    title: "A thing",
    kind: "ship",
    agent: "claude",
    backlog: true,
  });
  const edit = await app.request(`/api/tasks/${task.id}/update`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ repoRoot: tree }),
  });
  assert.equal(edit.status, 400);
  assert.equal(tasks.get(task.id)?.repoRoot, main, "the refused edit changed nothing");
});
