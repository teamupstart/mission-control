import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSourceInstance } from "../src/shared/task-source.ts";
import type { TaskManager } from "../src/server/tasks.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "gh-default-pin-")));
const bin = join(home, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), "#!/bin/sh\nprintf '[]'\n");
chmodSync(join(bin, "gh"), 0o755);
process.env.HARNESS_HOME = join(home, "state");
process.env.MISSION_GH_BIN = join(bin, "gh");

const { parseRemoteConfig, needsGhDefaultPin } = await import("../src/shared/github-repository.mjs");
const { ensureGhDefaultRepository } = await import("../src/server/github/repository.ts");
const { prepareTaskRepositories } = await import("../src/server/task-repository-preparation.ts");
const { sweepOnce } = await import("../src/server/task-sources/sweeper.ts");
const { openDb } = await import("../src/server/db.ts");

openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const FORK = "git@github.com:me/fork.git";
const PARENT = "https://github.com/org/parent.git";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
}

/** `git config --get` that answers null for an unset key instead of throwing. */
function config(dir: string, key: string): string | null {
  try {
    return git(dir, "config", "--get", key);
  } catch {
    return null;
  }
}

/** A fresh clone with the given remotes, each `[name, url]`. */
function checkout(...remotes: [string, string][]): string {
  const dir = mkdtempSync(join(home, "checkout-"));
  execFileSync("git", ["init", "-q", dir]);
  // CI runners have no global identity, and two tests commit.
  git(dir, "config", "user.email", "t@test");
  git(dir, "config", "user.name", "t");
  for (const [name, url] of remotes) git(dir, "remote", "add", name, url);
  return dir;
}

/** Every `console.log` and `console.warn` line the `[github]` prefix marks, for this test. */
function githubLogs(t: TestContext): string[] {
  const lines: string[] = [];
  for (const method of ["log", "warn"] as const) {
    const original = console[method];
    t.mock.method(console, method, (...args: unknown[]) => {
      if (String(args[0]).startsWith("[github]")) lines.push(args.map(String).join(" "));
      else original(...args);
    });
  }
  return lines;
}

const needs = (stdout: string) => needsGhDefaultPin(parseRemoteConfig(stdout));

test("a pin is needed only with no pin, several GitHub remotes, and origin on GitHub", () => {
  const fork = `remote.origin.url ${FORK}\nremote.upstream.url ${PARENT}`;
  assert.equal(needs(fork), true);
  assert.equal(needs(`remote.origin.url ${FORK}`), false, "one GitHub remote leaves gh nothing to choose");
  assert.equal(needs(`${fork}\nremote.upstream.gh-resolved base`), false, "an existing pin is never overwritten");
  assert.equal(needs(`${fork}\nremote.origin.gh-resolved me/fork`), false);
  assert.equal(needs(`remote.origin.url git@gitlab.com:me/x.git\nremote.a.url ${FORK}\nremote.b.url ${PARENT}`), false);
  assert.equal(needs(`remote.a.url ${FORK}\nremote.b.url ${PARENT}`), false, "no origin to pin");
  assert.equal(needs(`remote.origin.url ${FORK}\nremote.mirror.url git@gitlab.com:me/fork.git`), false);
});

test("pins origin in the clone's shared config, from a worktree, and logs it once", async (t) => {
  const logs = githubLogs(t);
  const main = checkout(["origin", FORK], ["upstream", PARENT]);
  git(main, "commit", "-q", "--allow-empty", "-m", "base");
  const worktree = join(home, `wt-${Date.now()}`);
  git(main, "worktree", "add", "-q", "--detach", worktree);

  await Promise.all([ensureGhDefaultRepository(worktree), ensureGhDefaultRepository(main)]);
  assert.equal(git(main, "config", "--file", join(main, ".git", "config"), "--get", "remote.origin.gh-resolved"), "base");
  assert.equal(config(worktree, "remote.origin.gh-resolved"), "base");
  assert.equal(config(main, "remote.upstream.gh-resolved"), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /pinned gh's default repository to origin in .*\.git.*gh repo set-default --unset/);

  // Memoized: removed by hand in this run, the pin is not written again, and nothing is logged.
  git(main, "config", "--unset", "remote.origin.gh-resolved");
  git(main, "config", "--unset", "mission.ghDefaultPinned");
  await ensureGhDefaultRepository(worktree);
  assert.equal(config(main, "remote.origin.gh-resolved"), null);
  assert.equal(logs.length, 1);
});

test("never overwrites an existing pin, and leaves unambiguous checkouts alone", async (t) => {
  const logs = githubLogs(t);
  const pinned = checkout(["origin", FORK], ["upstream", PARENT]);
  git(pinned, "config", "remote.upstream.gh-resolved", "base");
  const single = checkout(["origin", FORK]);
  const gitlab = checkout(["origin", "git@gitlab.com:me/fork.git"], ["a", FORK], ["b", PARENT]);
  for (const dir of [pinned, single, gitlab]) await ensureGhDefaultRepository(dir);

  assert.equal(config(pinned, "remote.upstream.gh-resolved"), "base");
  for (const dir of [pinned, single, gitlab]) assert.equal(config(dir, "remote.origin.gh-resolved"), null);
  assert.deepEqual(logs, []);

  // Not settled by doing nothing: the single-remote checkout gains an upstream, and is pinned.
  git(single, "remote", "add", "upstream", PARENT);
  await ensureGhDefaultRepository(single);
  assert.equal(config(single, "remote.origin.gh-resolved"), "base");
});

test("an undo with `gh repo set-default --unset` sticks: the marker stops a later run", async (t) => {
  const logs = githubLogs(t);
  // What a clone looks like after an earlier daemon pinned it and the operator unset the pin.
  const undone = checkout(["origin", FORK], ["upstream", PARENT]);
  git(undone, "config", "mission.ghDefaultPinned", "true");
  await ensureGhDefaultRepository(undone);
  assert.equal(config(undone, "remote.origin.gh-resolved"), null);
  assert.deepEqual(logs, []);
});

test("a failed write is logged and never throws", async (t) => {
  const logs = githubLogs(t);
  const dir = checkout(["origin", FORK], ["upstream", PARENT]);
  // A directory where the config's lock file must go makes every `git config` write fail.
  mkdirSync(join(dir, ".git", "config.lock"));
  t.after(() => rmSync(join(dir, ".git", "config.lock"), { recursive: true, force: true }));
  await ensureGhDefaultRepository(dir);
  assert.equal(config(dir, "remote.origin.gh-resolved"), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /could not pin gh's default repository to origin/);

  await ensureGhDefaultRepository(join(home, "not-a-checkout"));
  assert.equal(logs.length, 1, "a path that is no checkout is skipped quietly");
});

test("task repository preparation pins every repository in the set", async () => {
  const primary = checkout(["origin", FORK], ["upstream", PARENT]);
  const extra = checkout(["origin", "https://github.com/me/other.git"], ["upstream", "https://github.com/org/other.git"]);
  for (const dir of [primary, extra]) git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  const prepared = await prepareTaskRepositories({
    primary,
    extras: [extra],
    kind: "ship",
    agent: "claude",
    shortNameSelectors: "none",
  });
  assert.equal(prepared.ok, true);
  for (const dir of [primary, extra]) assert.equal(config(dir, "remote.origin.gh-resolved"), "base");
});

test("a task source's first sweep pins its checkout", async () => {
  const repoRoot = checkout(["origin", FORK], ["upstream", PARENT]);
  const source: TaskSourceInstance = {
    id: "first-sweep-pin",
    kind: "github-issues",
    label: "issues",
    enabled: true,
    repoRoot,
    keepUpdated: false,
    intervalMs: 900_000,
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [], enabled: true },
    maxPerSweep: 25,
    writeback: { onPrOpened: false, onCompleted: false, resolve: false },
    config: { repo: "" },
  };
  const report = await sweepOnce(source, { list: () => [] } as unknown as TaskManager);
  assert.equal(report.error, null);
  assert.equal(config(repoRoot, "remote.origin.gh-resolved"), "base");
});
