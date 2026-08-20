import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-activity-home-"));
process.env.HARNESS_HOME = home;
const {
  worktreeActivityFingerprint,
  taskActivityFingerprint,
  defaultWorktreeActivityDeps,
} = await import("../src/server/git/worktree-activity.ts");

// The fingerprint is the only thing standing between "this tree is quiet" and, one phase from
// now, "delete it". So these tests are almost all the same shape: take a digest, make ONE
// Git-visible change, and insist the digest moved - plus the inverse, that a change Git is told
// to ignore moves nothing, and that everything unreadable comes back `unknown` rather than
// clean.

let root: string;
const repos: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A real repository with one commit, which is the state every case below starts from. */
function mkRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "ignored/\n*.log\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  repos.push(dir);
  return dir;
}

async function digest(dir: string): Promise<string> {
  const result = await worktreeActivityFingerprint(dir, defaultWorktreeActivityDeps);
  assert.equal(result.kind, "known", `expected a known fingerprint, got ${JSON.stringify(result)}`);
  return result.kind === "known" ? result.digest : "";
}

/** Assert that `mutate` is Git-visible: the digest before and after must differ. */
async function assertMoves(dir: string, what: string, mutate: () => void): Promise<void> {
  const before = await digest(dir);
  mutate();
  const after = await digest(dir);
  assert.notEqual(after, before, `${what} must change the fingerprint`);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "mission-activity-"));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("an untouched checkout fingerprints identically twice", async () => {
  const dir = mkRepo("stable");
  assert.equal(await digest(dir), await digest(dir));
});

test("a new commit moves the fingerprint", async () => {
  const dir = mkRepo("commit");
  await assertMoves(dir, "a local commit", () => {
    writeFileSync(join(dir, "tracked.txt"), "two\n");
    git(dir, "commit", "-qam", "second");
  });
});

test("staging alone moves the fingerprint, with HEAD and the file both unchanged", async () => {
  const dir = mkRepo("staged");
  writeFileSync(join(dir, "tracked.txt"), "edited\n");
  const beforeStage = await digest(dir);
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "add", "tracked.txt");
  const afterStage = await digest(dir);
  assert.equal(git(dir, "rev-parse", "HEAD"), head, "HEAD did not move");
  assert.notEqual(afterStage, beforeStage, "the index digest carries `git add` on its own");
});

test("an unstaged edit moves the fingerprint, and editing again moves it again", async () => {
  const dir = mkRepo("unstaged");
  const clean = await digest(dir);
  writeFileSync(join(dir, "tracked.txt"), "edit one\n");
  const first = await digest(dir);
  writeFileSync(join(dir, "tracked.txt"), "edit two\n");
  const second = await digest(dir);
  assert.notEqual(first, clean);
  // The case `git status` alone cannot see: both edits report " M". Only hashing the bytes
  // distinguishes an agent still working from one that stopped a week ago.
  assert.notEqual(second, first, "a second edit to an already-modified file is still activity");
});

test("deleting a tracked file moves the fingerprint", async () => {
  const dir = mkRepo("deleted");
  await assertMoves(dir, "a deletion", () => rmSync(join(dir, "tracked.txt")));
});

test("chmod +x with no content change moves the fingerprint", async () => {
  const dir = mkRepo("mode");
  await assertMoves(dir, "a mode change", () => chmodSync(join(dir, "tracked.txt"), 0o755));
});

test("a symlink is hashed as its target, and retargeting it is a change", async () => {
  const dir = mkRepo("symlink");
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  symlinkSync("a.txt", join(dir, "link"));
  const first = await digest(dir);
  rmSync(join(dir, "link"));
  symlinkSync("b.txt", join(dir, "link"));
  assert.notEqual(await digest(dir), first, "retargeting a symlink is Git-visible work");
});

test("an untracked file counts, and its later edits keep counting", async () => {
  const dir = mkRepo("untracked");
  const clean = await digest(dir);
  writeFileSync(join(dir, "scratch.txt"), "draft\n");
  const created = await digest(dir);
  writeFileSync(join(dir, "scratch.txt"), "draft two\n");
  const edited = await digest(dir);
  assert.notEqual(created, clean);
  assert.notEqual(edited, created);
});

test("ignored churn never moves the fingerprint", async () => {
  const dir = mkRepo("ignored");
  const clean = await digest(dir);
  mkdirSync(join(dir, "ignored", "deep"), { recursive: true });
  writeFileSync(join(dir, "ignored", "deep", "cache.bin"), "x".repeat(4096));
  writeFileSync(join(dir, "build.log"), "noise\n");
  assert.equal(
    await digest(dir),
    clean,
    "a warm dependency cache must never keep a stale tree alive forever",
  );
});

test("odd filenames - newline, quote, unicode - are handled without merging paths", async () => {
  const dir = mkRepo("odd");
  const clean = await digest(dir);
  // A newline in a filename is exactly what defeats a line-splitting parser: two paths merge
  // into one nonsense entry, and real edits then go unnoticed.
  writeFileSync(join(dir, "line\nbreak.txt"), "one\n");
  const withNewline = await digest(dir);
  assert.notEqual(withNewline, clean);
  writeFileSync(join(dir, 'quo"te.txt'), "two\n");
  writeFileSync(join(dir, "ünïcode-\u{1F600}.txt"), "three\n");
  const withAll = await digest(dir);
  assert.notEqual(withAll, withNewline);
  // And editing only the newline-named file still registers, which is the proof the entry was
  // parsed as its own record rather than glued to its neighbour.
  writeFileSync(join(dir, "line\nbreak.txt"), "one changed\n");
  assert.notEqual(await digest(dir), withAll);
});

test("a large untracked file is streamed whole, not sampled", async () => {
  const dir = mkRepo("large");
  const big = join(dir, "big.bin");
  // 8MB - past this daemon's default subprocess buffer, so a fingerprint built by shelling out
  // to `git hash-object` through the buffered runner would have failed here.
  const buf = Buffer.alloc(8 * 1024 * 1024, 7);
  writeFileSync(big, buf);
  const first = await digest(dir);
  // Change the LAST byte only. A digest that sampled a prefix would not notice.
  buf[buf.length - 1] = 9;
  writeFileSync(big, buf);
  assert.notEqual(await digest(dir), first, "the tail of a large file is part of its identity");
});

test("a conflicted merge fingerprints stably, with all three index stages", async () => {
  // An abandoned task very often stopped BECAUSE a merge conflicted, so this is not an exotic
  // state - it is one of the likeliest shapes a stale tree is actually found in. The index
  // holds three entries for the same path (base, ours, theirs) and status reports `UU`, and
  // both have to fingerprint as an ordinary readable tree rather than as `unknown`.
  const dir = mkRepo("conflict");
  git(dir, "checkout", "-qb", "other");
  writeFileSync(join(dir, "tracked.txt"), "theirs\n");
  git(dir, "commit", "-qam", "theirs");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "tracked.txt"), "ours\n");
  git(dir, "commit", "-qam", "ours");
  try {
    git(dir, "merge", "other");
  } catch {
    // A conflicting merge exits non-zero. That is the state under test.
  }
  const stages = git(dir, "ls-files", "--stage").split("\n")
    .filter((line) => line.includes("tracked.txt"));
  assert.equal(stages.length, 3, "the fixture really is a conflicted merge");
  const conflicted = await digest(dir);
  assert.equal(await digest(dir), conflicted, "a conflicted tree is stable, not unknown");
  // And resolving it is activity, which is what keeps a half-finished merge from expiring on
  // the clock it was already running when the agent left.
  writeFileSync(join(dir, "tracked.txt"), "resolved\n");
  git(dir, "add", "tracked.txt");
  assert.notEqual(await digest(dir), conflicted);
});

test("an unborn HEAD fingerprints stably instead of pinning the tree on unknown", async () => {
  const dir = join(root, "unborn");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  const first = await digest(dir);
  assert.equal(await digest(dir), first);
  writeFileSync(join(dir, "new.txt"), "hello\n");
  assert.notEqual(await digest(dir), first, "work in an unborn checkout is still activity");
});

test("a missing path, a non-repository, and a nested path are unknown - never clean", async () => {
  const missing = await worktreeActivityFingerprint(join(root, "does-not-exist"));
  assert.equal(missing.kind, "unknown");

  const plain = join(root, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  assert.equal((await worktreeActivityFingerprint(plain)).kind, "unknown");

  // A path INSIDE a repository is not that repository's root. Recorded worktree paths always
  // are, so this reads as "the tree at this path is not the checkout we recorded".
  const dir = mkRepo("nested");
  mkdirSync(join(dir, "sub"), { recursive: true });
  const nested = await worktreeActivityFingerprint(join(dir, "sub"));
  assert.equal(nested.kind, "unknown");
  assert.equal(nested.kind === "unknown" && nested.reason.length > 0, true);
});

test("a git command that dies, overflows, or fails is unknown rather than a digest", async () => {
  const dir = mkRepo("failures");
  for (const [label, over] of [
    ["a died child", { code: null, stderr: "", overflowed: false, died: true }],
    ["an overflow", { code: null, stderr: "", overflowed: true, died: false }],
    ["a non-zero exit", { code: 128, stderr: "fatal", overflowed: false, died: false }],
  ] as const) {
    const result = await worktreeActivityFingerprint(dir, {
      ...defaultWorktreeActivityDeps,
      // Fail only the INDEX read, so the repository check ahead of it still passes and the
      // failure being asserted is the one this case is about.
      gitStream: async (cwd, args, onChunk) =>
        args[0] === "ls-files"
          ? over
          : defaultWorktreeActivityDeps.gitStream(cwd, args, onChunk),
    });
    assert.equal(result.kind, "unknown", `${label} must not produce a fingerprint`);
  }
});

test("a file too large to read is unknown, not a stable digest", async () => {
  const dir = mkRepo("refusal");
  writeFileSync(join(dir, "scratch.txt"), "draft\n");
  const result = await worktreeActivityFingerprint(dir, {
    ...defaultWorktreeActivityDeps,
    hashFile: async () => {
      throw new Error("file exceeds the activity read limit");
    },
  });
  assert.equal(result.kind, "unknown");
});

test("a task's fingerprint spans every repository and is ordered by position", async () => {
  const primary = mkRepo("multi-primary");
  const attached = mkRepo("multi-attached");
  const task = (over: Partial<Task> = {}): Task =>
    mkTask({
      id: "multi",
      repoRoot: primary,
      worktreePath: primary,
      extraRepos: [{
        repoRoot: attached,
        worktreePath: attached,
        branch: "harness/x",
        provider: "git",
        worktreeLeaseId: null,
        baseSha: null,
        prUrl: null,
        prState: null,
        mergedAt: null,
      }],
      ...over,
    });

  const combined = await taskActivityFingerprint(task());
  assert.equal(combined.kind, "known");

  // A change in the ATTACHED repository alone moves the task's single boundary. That is the
  // approved policy: the newest change in any one tree protects the whole set.
  writeFileSync(join(attached, "tracked.txt"), "attached edit\n");
  const afterAttached = await taskActivityFingerprint(task());
  assert.equal(afterAttached.kind, "known");
  assert.notEqual(
    afterAttached.kind === "known" && afterAttached.digest,
    combined.kind === "known" && combined.digest,
  );

  // One unreadable tree makes the whole task unknown. A digest over the readable half would be
  // stable while somebody worked in the other one.
  const broken = await taskActivityFingerprint(
    task({ worktreePath: join(root, "gone-forever") }),
  );
  assert.equal(broken.kind, "unknown");

  // And a task holding no tree at all is unknown rather than a fixed empty digest, which would
  // otherwise look like a permanently quiet tree.
  assert.equal(
    (await taskActivityFingerprint(mkTask({ worktreePath: null, extraRepos: [] }))).kind,
    "unknown",
  );
});
