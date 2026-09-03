import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePinnedRefDiff, computeSessionDiff } from "../src/server/diff.ts";
import { parsePatch } from "../src/web/lib/diff.ts";

function mkRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "harness-diff-")));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("branch", "-M", "main");
  git("config", "user.email", "t@test");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "keep.txt"), "line1\nline2\nline3\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return repo;
}

test("computeSessionDiff captures committed, uncommitted, and untracked changes vs main", async () => {
  const repo = mkRepo();
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });

  // Branch off main and diverge: a committed edit + a committed new file...
  git("checkout", "-qb", "feature/work");
  writeFileSync(join(repo, "keep.txt"), "line1\nCHANGED\nline3\n");
  writeFileSync(join(repo, "added.txt"), "brand new\n");
  git("add", "-A");
  git("commit", "-qm", "work");
  // ...plus an uncommitted edit and an untracked file in the worktree.
  writeFileSync(join(repo, "keep.txt"), "line1\nCHANGED\nline3\nUNCOMMITTED\n");
  writeFileSync(join(repo, "scratch.txt"), "not tracked yet\n");

  const d = await computeSessionDiff(repo);

  assert.equal(d.ok, true);
  assert.equal(d.error, null);
  assert.equal(d.base, "main");
  assert.equal(d.branch, "feature/work");
  assert.ok(d.baseSha, "diff has a merge-base sha");
  // keep.txt (modified) + added.txt (committed new) + scratch.txt (untracked) = 3.
  assert.equal(d.filesChanged, 3);
  assert.ok(d.insertions >= 3, `expected insertions, got ${d.insertions}`);

  // The patch must include all three sources of change.
  assert.match(d.patch, /CHANGED/); // committed edit
  assert.match(d.patch, /UNCOMMITTED/); // unstaged edit
  assert.match(d.patch, /b\/added\.txt/); // committed new file
  assert.match(d.patch, /b\/scratch\.txt/); // untracked file
  assert.match(d.patch, /not tracked yet/);
});

test("computePinnedRefDiff stays on the stored commit after its branch and worktree move", async () => {
  const repo = mkRepo();
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  git("checkout", "-qb", "spec/durable");
  writeFileSync(join(repo, "phase-one.txt"), "pinned evidence\n");
  git("add", "-A");
  git("commit", "-qm", "phase one");
  const pinned = git("rev-parse", "HEAD");

  writeFileSync(join(repo, "later.txt"), "moving branch state\n");
  git("add", "-A");
  git("commit", "-qm", "later branch commit");
  writeFileSync(join(repo, "dirty.txt"), "uncommitted host state\n");

  const diff = await computePinnedRefDiff(repo, pinned, "spec/durable");
  assert.equal(diff.ok, true);
  assert.equal(diff.base, "main");
  assert.equal(diff.branch, "spec/durable");
  assert.equal(diff.headSha, pinned.slice(0, 12));
  assert.ok(diff.baseSha);
  assert.match(diff.patch, /phase-one\.txt/);
  assert.doesNotMatch(diff.patch, /later\.txt|dirty\.txt/);
});

test("computePinnedRefDiff fails closed for missing and unrelated commit evidence", async () => {
  const repo = mkRepo();
  const missing = await computePinnedRefDiff(repo, "0".repeat(40), "spec/gone");
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /evidence commit is unavailable/);
  assert.equal(missing.patch, "");

  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  git("checkout", "-q", "--orphan", "spec/unrelated");
  git("rm", "-rqf", ".");
  writeFileSync(join(repo, "orphan.txt"), "unrelated\n");
  git("add", "-A");
  git("commit", "-qm", "unrelated");
  const unrelatedSha = git("rev-parse", "HEAD");
  const unrelated = await computePinnedRefDiff(repo, unrelatedSha, "spec/unrelated");
  assert.equal(unrelated.ok, false);
  assert.match(unrelated.error ?? "", /no shared history/);
  assert.equal(unrelated.patch, "");
});

test("computeSessionDiff degrades gracefully outside a repo / with no cwd", async () => {
  const nogit = realpathSync(mkdtempSync(join(tmpdir(), "harness-nogit-")));
  const a = await computeSessionDiff(nogit);
  assert.equal(a.ok, false);
  assert.equal(a.error, "not a git repository");

  const b = await computeSessionDiff(null);
  assert.equal(b.ok, false);
  assert.match(b.error ?? "", /no working directory/);
});

// Regression: an explicitly requested base that git can't resolve used to fall
// back to a working-tree-vs-HEAD diff and report ok:true - hiding the very
// committed work the caller asked about, so the answer read as "nothing was done"
// rather than "the base is gone".
test("computeSessionDiff fails closed when an explicitly requested base is unreachable", async () => {
  const repo = mkRepo();
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("checkout", "-qb", "feature/work");
  writeFileSync(join(repo, "feature.txt"), "the work we asked about\n");
  git("add", "-A");
  git("commit", "-qm", "the work");
  writeFileSync(join(repo, "dirty.txt"), "an in-flight edit\n"); // what the old fallback would show

  const gone = "0".repeat(40); // well-formed, but no such object here
  const r = await computeSessionDiff(repo, gone);

  assert.equal(r.ok, false);
  assert.equal(r.baseSha, null);
  assert.match(r.error ?? "", /not reachable/);
  assert.match(r.error ?? "", new RegExp(gone));
  // It must not answer with the HEAD fallback's diff.
  assert.equal(r.filesChanged, 0);
  assert.equal(r.patch, "");
});

test("computeSessionDiff still falls back to HEAD for an auto-detected ref with no shared history", async () => {
  // The fallback is deliberate for a ref we picked ourselves: an orphan branch has
  // no merge-base with main, and you should still see your uncommitted work. Only an
  // explicitly *requested* base fails closed.
  const repo = mkRepo();
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("checkout", "-q", "--orphan", "orphan/work");
  git("rm", "-rqf", ".");
  writeFileSync(join(repo, "fresh.txt"), "no shared history\n");

  const r = await computeSessionDiff(repo); // no explicit source
  assert.equal(r.ok, true);
  assert.equal(r.baseSha, null); // no merge-base was resolvable
  assert.ok(r.patch.includes("fresh.txt"), "uncommitted work is still visible");
});

test("parsePatch numbers lines and classifies adds/dels/context per file", () => {
  const patch = [
    "diff --git a/keep.txt b/keep.txt",
    "index 1111111..2222222 100644",
    "--- a/keep.txt",
    "+++ b/keep.txt",
    "@@ -1,3 +1,3 @@",
    " line1",
    "-line2",
    "+CHANGED",
    " line3",
  ].join("\n");

  const [f] = parsePatch(patch);
  assert.ok(f);
  assert.equal(f.path, "keep.txt");
  assert.equal(f.status, "modified");
  assert.equal(f.added, 1);
  assert.equal(f.removed, 1);

  const body = f.lines.filter((l) => l.type !== "hunk");
  // context line1 (old1/new1), del line2 (old2/-), add CHANGED (-/new2), context line3 (old3/new3)
  assert.deepEqual(
    body.map((l) => [l.type, l.oldNo, l.newNo, l.text]),
    [
      ["ctx", 1, 1, "line1"],
      ["del", 2, null, "line2"],
      ["add", null, 2, "CHANGED"],
      ["ctx", 3, 3, "line3"],
    ],
  );
});

test("parsePatch handles new files, deletions, and multiple files", () => {
  const patch = [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+first",
    "+second",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-bye",
  ].join("\n");

  const files = parsePatch(patch);
  assert.equal(files.length, 2);

  assert.equal(files[0]!.path, "new.txt");
  assert.equal(files[0]!.status, "added");
  assert.equal(files[0]!.added, 2);
  assert.deepEqual(
    files[0]!.lines.filter((l) => l.type === "add").map((l) => l.newNo),
    [1, 2],
  );

  assert.equal(files[1]!.path, "gone.txt");
  assert.equal(files[1]!.status, "deleted");
  assert.equal(files[1]!.removed, 1);
});

test("computeSessionDiff reports the repo TOPLEVEL, even when run from a subdirectory", async () => {
  // `patch`'s paths are toplevel-relative (git emits them that way wherever it's
  // invoked from), so anything resolving them needs the toplevel - and the standards
  // reader is exactly that. It used to be computed here and thrown away, which left
  // the reader trusting a session's cwd instead.
  const repo = mkRepo();
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  mkdirSync(join(repo, "packages", "app"), { recursive: true });
  writeFileSync(join(repo, "packages", "app", "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "nested");
  writeFileSync(join(repo, "packages", "app", "a.txt"), "hello\nagain\n");

  const d = await computeSessionDiff(join(repo, "packages", "app"));

  assert.equal(d.ok, true);
  assert.equal(d.repoRoot, repo, "the toplevel, not the cwd it was invoked from");
  assert.match(d.patch, /\+\+\+ b\/packages\/app\/a\.txt/, "and the patch's paths are relative to it");
});

test("computeSessionDiff reports no repoRoot outside a git repo", async () => {
  const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "harness-norepo-")));
  const d = await computeSessionDiff(notRepo);
  assert.equal(d.ok, false);
  assert.equal(d.repoRoot, null);
});

test("computeSessionDiff fails closed when an explicit base was AMENDED away", async () => {
  // merge-base exits non-zero only when there is no common ancestor at all. After an
  // amend the old commit is still alive in the reflog, so merge-base SUCCEEDS and
  // returns an older ancestor - and the diff then silently widens to span the
  // PREVIOUS item's committed work. `diffMayIncludeOtherWork` cannot catch that: it
  // compares recorded base shas, and these differ. So the base must be an ancestor
  // of HEAD, not merely share one with it.
  const repo = mkRepo();
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("checkout", "-qb", "feature/work");

  // Item 1's work, committed. Item 2 is then scoped against THIS commit.
  writeFileSync(join(repo, "item1.txt"), "the first item's work\n");
  git("add", "-A");
  git("commit", "-qm", "item 1");
  const itemTwoBase = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();

  // The agent does item 2's work and amends it onto item 1's commit, which rewrites
  // the commit item 2 recorded as its base.
  writeFileSync(join(repo, "item2.txt"), "the second item's work\n");
  git("add", "-A");
  git("commit", "-q", "--amend", "--no-edit");

  const r = await computeSessionDiff(repo, itemTwoBase);

  assert.equal(r.ok, false, "an amended-away base must escalate, not answer");
  assert.match(r.error ?? "", /not reachable/);
  // The whole point: it must NOT hand back a diff containing item 1's work.
  assert.equal(r.patch, "");
  assert.ok(!r.patch.includes("item1.txt"));
});

test("computeSessionDiff reports an explicit base that IS an ancestor normally", async () => {
  // The other half of the check above: the ordinary case must still answer. Without
  // this, "fail closed" could pass by failing always.
  const repo = mkRepo();
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("checkout", "-qb", "feature/work");
  writeFileSync(join(repo, "item1.txt"), "the first item's work\n");
  git("add", "-A");
  git("commit", "-qm", "item 1");
  const base = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();

  writeFileSync(join(repo, "item2.txt"), "the second item's work\n");

  const r = await computeSessionDiff(repo, base);

  assert.equal(r.ok, true);
  assert.ok(r.patch.includes("item2.txt"), "this item's work is visible");
  assert.ok(!r.patch.includes("item1.txt"), "the earlier item's committed work is not");
});

test("computeSessionDiff reports untracked paths relative to the TOPLEVEL, not the cwd", async () => {
  // `SessionDiff.repoRoot` documents that `patch`'s paths are relative to the
  // toplevel, and the tracked half already is (`git diff` ignores cwd). Untracked
  // paths were emitted relative to the session's cwd, so one patch mixed two bases -
  // and the standards reader then resolved `src/x.ts` against the toplevel, missing
  // the package's own CLAUDE.md in exactly the monorepo case repoRoot exists for.
  const repo = mkRepo();
  const pkg = join(repo, "packages", "app", "src");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "untracked.ts"), "export const x = 1;\n");

  const r = await computeSessionDiff(join(repo, "packages", "app"));

  assert.equal(r.ok, true);
  assert.ok(
    r.patch.includes("packages/app/src/untracked.ts"),
    `expected a toplevel-relative path, got:\n${r.patch}`,
  );
});

test("computeSessionDiff marks omitted untracked files as truncated", async () => {
  const repo = mkRepo();
  for (let index = 0; index < 101; index++) {
    writeFileSync(join(repo, `untracked-${String(index).padStart(3, "0")}.txt`), `${index}\n`);
  }

  const result = await computeSessionDiff(repo);

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.filesChanged, 100);
});

test("computeSessionDiff fails closed when the diff command itself fails", async () => {
  // The fail-open the evidence-first design exists to eliminate: `run` reports a
  // timeout or a crash as a non-zero code with whatever stdout was flushed, so an
  // unchecked `git diff` returned ok:true with an EMPTY patch - which the verify
  // prompt renders as "(no changes were made)". The verifier then reports blocking
  // gaps for work that was finished and they get typed back into the agent.
  //
  // Reproduced the way it actually happens rather than by mocking: a missing object
  // makes `git diff` exit non-zero while `merge-base` and `rev-parse` (which read
  // only commits) still succeed, so the function reaches the diff and the diff is
  // what breaks - the same shape as the 15s timeout on a large worktree.
  const repo = mkRepo();
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("checkout", "-qb", "feature/work");
  writeFileSync(join(repo, "keep.txt"), "line1\nCHANGED\nline3\n");
  git("add", "-A");
  git("commit", "-qm", "work");

  const blob = execFileSync("git", ["-C", repo, "rev-parse", "main:keep.txt"], {
    encoding: "utf8",
  }).trim();
  rmSync(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

  const r = await computeSessionDiff(repo);

  assert.equal(r.ok, false, "a broken diff must never read as 'no changes were made'");
  assert.equal(r.patch, "");
  assert.match(r.error ?? "", /could not read the diff/);
});

test("an unborn HEAD is confirmed positively, not inferred from a failed rev-parse", () => {
  // `run` reports a timeout as the same non-zero exit as any other failure, so
  // "HEAD didn't resolve" cannot by itself mean "this branch has no commits". Only a
  // branch that EXISTS while HEAD resolves to nothing is unborn - and that is what
  // `symbolic-ref -q HEAD` answers, failing (like everything else) under a timeout,
  // so the tracked diff still runs and still fails closed.
  const repo = mkRepo();
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });

  git("checkout", "-q", "--orphan", "orphan/work");
  const sym = execFileSync("git", ["-C", repo, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8" });
  assert.match(sym.trim(), /^refs\/heads\/orphan\/work$/, "the branch exists...");
  assert.throws(
    () => execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "HEAD"], { stdio: "pipe" }),
    "...while HEAD resolves to nothing - which is exactly what unborn means",
  );

  // A DETACHED HEAD is the counterexample the check has to keep apart: HEAD resolves
  // fine, and `symbolic-ref` fails - so a repo in this state is never read as unborn
  // and its tracked diff is never skipped.
  git("checkout", "-q", "main");
  git("checkout", "-q", "--detach");
  assert.throws(
    () => execFileSync("git", ["-C", repo, "symbolic-ref", "-q", "HEAD"], { stdio: "pipe" }),
    "a detached HEAD has no symbolic ref",
  );
});
