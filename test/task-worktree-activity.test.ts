import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
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
  FILE_TOO_LARGE,
} = await import("../src/server/git/worktree-activity.ts");

// The fingerprint is the only thing standing between "this tree is quiet" and, one phase from
// now, "delete it". So these tests are almost all the same shape: take a digest, make ONE
// Git-visible change, and insist the digest moved - plus the inverse, that a change Git is told
// to ignore moves nothing, and that everything unreadable comes back `unknown` rather than
// clean.

let root: string;
const repos: string[] = [];

/**
 * Run git with an identity and transport policy supplied EXPLICITLY on every call.
 *
 * None of this may come from the machine: a developer has a global `user.email` and a hostname
 * that git can auto-detect an address from, and a CI container has neither - so a commit that
 * relies on ambient config passes here and fails there with "unable to auto-detect email
 * address (got 'root@....(none)')". That is not hypothetical; it is what this file did to CI,
 * and the gap was a repository `git commit` could reach that no test had configured: the
 * submodule CLONE, which `git submodule add` creates and which inherits none of the source
 * repository's local config.
 *
 * `protocol.file.allow` is here for the same reason from the other direction - git refuses a
 * local-path submodule clone without it since 2.38.1, so it is stated rather than left to the
 * version that happens to be installed.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c", "user.email=test@example.com",
      "-c", "user.name=Test",
      "-c", "commit.gpgsign=false",
      "-c", "protocol.file.allow=always",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
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

test("work inside a dirty submodule keeps moving the parent fingerprint", async () => {
  // The hole this closes: once a submodule is dirty, the parent's status stays ` M sub` and its
  // gitlink stays put, so a constant digest for the submodule directory made every LATER edit
  // and every commit inside it invisible to the parent. An agent working steadily in a submodule
  // fingerprinted exactly like an abandoned tree - and a digest that stops moving is what
  // eventually authorizes deletion.
  const sub = mkRepo("sub-origin");
  const parent = mkRepo("sub-parent");
  git(parent, "submodule", "add", "-q", sub, "sub");
  git(parent, "commit", "-qm", "add submodule");

  const clean = await digest(parent);
  writeFileSync(join(parent, "sub", "tracked.txt"), "dirty\n");
  const dirty = await digest(parent);
  assert.notEqual(dirty, clean, "a submodule going dirty is visible to the parent");

  // Each of these three leaves the parent's own status and gitlink completely unchanged, which
  // is exactly why each needs its own assertion.
  writeFileSync(join(parent, "sub", "tracked.txt"), "dirtier\n");
  const edited = await digest(parent);
  assert.notEqual(edited, dirty, "a second edit inside a dirty submodule is still activity");

  git(join(parent, "sub"), "commit", "-qam", "inside");
  const committed = await digest(parent);
  assert.notEqual(committed, edited, "a commit inside a submodule is still activity");

  writeFileSync(join(parent, "sub", "untracked.txt"), "scratch\n");
  const untracked = await digest(parent);
  assert.notEqual(untracked, committed, "an untracked file inside a submodule is still activity");

  // And the submodule's own ignore rules still apply at its own level, so a warm cache down
  // there cannot pin the parent open forever either.
  writeFileSync(join(parent, "sub", "build.log"), "noise\n");
  assert.equal(await digest(parent), untracked, "ignored churn inside a submodule changes nothing");
});

test("an untracked nested repository is fingerprinted, not flattened to a constant", async () => {
  // Git reports a nested repo as one `?? nested/` entry and refuses to descend into it even
  // with `-uall`, so it reaches the same directory branch a submodule does.
  const parent = mkRepo("nested-parent");
  const nested = join(parent, "nested");
  mkdirSync(nested, { recursive: true });
  git(nested, "init", "-q", "-b", "main");
  git(nested, "config", "user.email", "test@example.com");
  git(nested, "config", "user.name", "Test");
  writeFileSync(join(nested, "work.txt"), "one\n");
  const first = await digest(parent);
  writeFileSync(join(nested, "work.txt"), "two\n");
  assert.notEqual(await digest(parent), first, "work in an untracked nested repo is activity");
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

test("observing never writes the index, so it cannot contend with a person's git", async () => {
  // `git status` is not inherently read-only: with a stale stat cache it refreshes the index and
  // writes it back, taking `.git/index.lock`. That is the exact lock a `git add` or `git commit`
  // needs, and this probe runs unattended against trees somebody may still be working in.
  const dir = mkRepo("no-locks");
  writeFileSync(join(dir, "extra.txt"), "content\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "second");
  await digest(dir);

  const indexPath = join(dir, ".git", "index");
  const before = statSync(indexPath).mtimeMs;
  // Invalidate the stat cache without changing any content - the state that makes a plain
  // `git status` rewrite the index.
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(dir, "tracked.txt"), future, future);
  utimesSync(join(dir, "extra.txt"), future, future);

  const after = await digest(dir);
  assert.equal(
    statSync(indexPath).mtimeMs,
    before,
    "the probe refreshed the index - it must run with optional locks disabled",
  );
  // And a stat-only change is correctly NOT activity: no Git-visible content moved.
  assert.equal(after, await digest(dir));
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
    ["a died child", { code: null, overflowed: false, died: true }],
    ["an overflow", { code: null, overflowed: true, died: false }],
    ["a non-zero exit", { code: 128, overflowed: false, died: false }],
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
      throw Object.assign(new Error("file exceeds the activity read limit"), {
        code: FILE_TOO_LARGE,
      });
    },
  });
  assert.equal(result.kind, "unknown");
  // Classified as itself: "too big to fingerprint" is a different operational problem from
  // "could not be read", and the ledger should be able to tell them apart.
  assert.equal(result.kind === "unknown" && result.reason.includes(FILE_TOO_LARGE), true);
});

test("a probe failure never carries a filename into what gets persisted", async () => {
  // `last_error` is a persisted column, and `String(err)` on a filesystem error reads
  // "EACCES: permission denied, open '<path>'". An unreadable UNTRACKED file would therefore
  // persist its own name - a detail the ledger otherwise never holds, since the task row
  // carries the worktree path and nothing below it.
  const dir = mkRepo("no-leak");
  const secret = "very-private-filename.txt";
  writeFileSync(join(dir, secret), "content\n");
  const denied = await worktreeActivityFingerprint(dir, {
    ...defaultWorktreeActivityDeps,
    hashFile: async () => {
      throw Object.assign(
        new Error(`EACCES: permission denied, open '${join(dir, secret)}'`),
        { code: "EACCES" },
      );
    },
  });
  assert.equal(denied.kind, "unknown");
  const reason = denied.kind === "unknown" ? denied.reason : "";
  assert.equal(reason.includes(secret), false, "the filename must not survive into the reason");
  assert.equal(reason.includes(dir), false, "nor may the path");
  assert.equal(reason.includes("EACCES"), true, "but the CLASS of failure is still reported");

  // An unrecognised code is reported as `unknown` rather than passed through, so a future
  // error carrying something path-shaped in `code` cannot reach the ledger by default.
  const odd = await worktreeActivityFingerprint(dir, {
    ...defaultWorktreeActivityDeps,
    hashFile: async () => {
      throw Object.assign(new Error("nope"), { code: `/private/${secret}` });
    },
  });
  const oddReason = odd.kind === "unknown" ? odd.reason : "";
  assert.equal(oddReason.includes(secret), false);
  assert.equal(oddReason.includes("unknown"), true);
});

test("git's own stderr never reaches a persisted reason", async () => {
  // git names paths freely ("error: unable to read '<path>'"), so the module drains stderr
  // without reading it - the guarantee is structural rather than a formatting convention.
  const dir = mkRepo("no-stderr");
  const result = await worktreeActivityFingerprint(dir, {
    ...defaultWorktreeActivityDeps,
    gitStream: async (cwd, args, onChunk) =>
      args[0] === "ls-files"
        ? { code: 128, overflowed: false, died: false }
        : defaultWorktreeActivityDeps.gitStream(cwd, args, onChunk),
  });
  assert.equal(result.kind, "unknown");
  const reason = result.kind === "unknown" ? result.reason : "";
  assert.equal(reason.includes("128"), true, "the exit code is still reported");
  assert.equal(reason.includes(dir), false);
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

test("a filename that is not valid UTF-8 is fingerprinted as its own bytes", async (t) => {
  // POSIX filenames are byte strings. Decoding `git status -z` as UTF-8 folds every invalid
  // byte to U+FFFD, so a checkout holding BOTH `x-\xff.txt` and a real `x-<U+FFFD>.txt` decodes
  // to one path twice - the probe then read the second file's bytes for both records, and every
  // later edit to the first left the digest identical. That is the one failure this module may
  // never have: an actively-edited tree reading as quiet is what authorizes deletion a phase
  // from now.
  const dir = mkRepo("non-utf8");
  const raw = Buffer.concat([Buffer.from(join(dir, "x-")), Buffer.from([0xff]), Buffer.from(".txt")]);
  try {
    writeFileSync(raw, "aaa");
  } catch (err) {
    // APFS and NTFS reject a name that is not valid UTF-8 outright (EILSEQ/EINVAL), so on a
    // developer's Mac there is nothing to test. On Linux - CI, and every daemon host that is
    // not a Mac - it creates fine and the assertions below run for real.
    const code = (err as { code?: string }).code;
    if (code !== "EILSEQ" && code !== "EINVAL") throw err;
    t.skip(`this filesystem rejects non-UTF-8 filenames (${code})`);
    return;
  }
  writeFileSync(join(dir, "x-�.txt"), "aaa");

  await assertMoves(dir, "editing a file whose name is not valid UTF-8", () => {
    writeFileSync(raw, "edited by an agent");
  });
  // And the collision runs both ways: editing only the twin must move it too.
  await assertMoves(dir, "editing the replacement-character twin", () => {
    writeFileSync(join(dir, "x-�.txt"), "edited by an agent");
  });
});
