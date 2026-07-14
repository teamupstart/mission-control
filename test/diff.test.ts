import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSessionDiff } from "../src/server/diff.ts";
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
