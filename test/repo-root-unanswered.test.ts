import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: `POST /api/tasks` telling an operator their checkout is "not a git
// repository" when git simply did not answer. On a loaded machine the task seed's `rev-parse`
// was stopped at `run`'s 4s default and the route refused a real repository.

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-repo-root-")));
process.env.HARNESS_HOME = join(home, "state");

const { resolveRepoRoot, resolveTaskRepoRoot, REPO_ROOT_TIMEOUT_MS } = await import("../src/server/repos.ts");
const originalGitOverride = process.env.MISSION_GIT_BIN;

after(() => {
  if (originalGitOverride === undefined) delete process.env.MISSION_GIT_BIN;
  else process.env.MISSION_GIT_BIN = originalGitOverride;
  rmSync(home, { recursive: true, force: true });
});

function mkRepo(name: string): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "file.txt"), "first\n");
  return realpathSync(repo);
}

/** Run `fn` with git replaced by a Node script whose body is `script`. */
async function withFakeGit<T>(name: string, script: string, fn: () => Promise<T>): Promise<T> {
  const bin = join(home, name, "git");
  mkdirSync(join(home, name), { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env node\n${script}`);
  chmodSync(bin, 0o755);
  process.env.MISSION_GIT_BIN = bin;
  try {
    return await fn();
  } finally {
    if (originalGitOverride === undefined) delete process.env.MISSION_GIT_BIN;
    else process.env.MISSION_GIT_BIN = originalGitOverride;
  }
}

test("a rev-parse that is stopped is reported as unanswered, not as 'not a git repository'", async () => {
  const repo = mkRepo("stopped");
  // Killed rather than left to time out: the same `outcomeUnknown` without spending the full
  // 15s budget, and the death an OOM killer or an operator's `pkill` produces.
  const dies = 'process.kill(process.pid, "SIGKILL");\n';
  const resolved = await withFakeGit("bin-dies", dies, () => resolveTaskRepoRoot(repo));
  assert.equal(resolved.ok, false);
  assert.ok(!resolved.ok);
  assert.doesNotMatch(resolved.error, /not a git repository/);
  assert.match(resolved.error, /could not tell whether .* is a git repository/);
  assert.match(resolved.error, /`git rev-parse --show-toplevel` was stopped/);
  assert.match(resolved.error, new RegExp(`allowed ${REPO_ROOT_TIMEOUT_MS / 1000}s`));
  // Callers that only want a root still get none: nothing was established.
  assert.equal(await withFakeGit("bin-dies", dies, () => resolveRepoRoot(repo)), null);
});

test("a bare-repository rev-parse that is stopped is also unanswered, and names that command", async () => {
  const repo = mkRepo("bare-stopped");
  // `--show-toplevel` answers "no" the way git does outside a work tree, so the probe moves on
  // to the bare-repository question, and that one is killed.
  const bareDies = [
    'if (process.argv.includes("--show-toplevel")) {',
    '  process.stderr.write("fatal: this operation must be run in a work tree\\n");',
    "  process.exit(128);",
    "}",
    'process.kill(process.pid, "SIGKILL");',
    "",
  ].join("\n");
  const resolved = await withFakeGit("bin-bare-dies", bareDies, () => resolveTaskRepoRoot(repo));
  assert.ok(!resolved.ok);
  assert.doesNotMatch(resolved.error, /not a git repository/);
  assert.match(resolved.error, /could not tell whether .* is a git repository/);
  assert.match(resolved.error, /`git rev-parse --is-bare-repository --absolute-git-dir` was stopped/);
  assert.equal(await withFakeGit("bin-bare-dies", bareDies, () => resolveRepoRoot(repo)), null);
});

test("a rev-parse slower than run's 4s default still resolves the repository", async () => {
  const repo = mkRepo("slow");
  // Answers as `rev-parse --show-toplevel` would, five seconds late.
  const slow = `setTimeout(() => process.stdout.write(${JSON.stringify(`${repo}\n`)}), 5_000);\n`;
  const resolved = await withFakeGit("bin-slow", slow, () => resolveTaskRepoRoot(repo));
  assert.deepEqual(resolved, { ok: true, repoRoot: repo });
});

test("a directory git answers 'no' for is still not a git repository", async () => {
  const plain = join(home, "plain");
  mkdirSync(plain, { recursive: true });
  assert.deepEqual(await resolveTaskRepoRoot(plain), {
    ok: false,
    error: `not a git repository: ${plain}`,
  });
});
