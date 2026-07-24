import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENSEMBLE_ARTIFACT_KINDS } from "../src/shared/ensemble.ts";
import { ARTIFACT_ADAPTERS, artifactAdapterFor } from "../src/server/ensembles/artifacts/index.ts";
import { gitSnapshotAdapter } from "../src/server/ensembles/artifacts/git-snapshot.ts";
import { gitRepo } from "./ensemble-fixture.ts";

/**
 * What is at stake: an artifact is the ONLY thing a later comparison, a promotion and a restore ever
 * see - a member's live worktree is never read again. So an artifact must be immutable, restorable,
 * and honest: its observed evidence has to be git fact, its private ref has to still resolve to the
 * exact commit it recorded, and putting it back has to reproduce the tree byte-for-byte. The adapter
 * registry also has to stay exhaustive so appending a new artifact kind cannot silently no-op.
 */

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}

test("the adapter registry is exhaustive and only commit is implemented this phase", () => {
  for (const kind of ENSEMBLE_ARTIFACT_KINDS) {
    assert.ok(kind in ARTIFACT_ADAPTERS, `${kind} has a registry slot`);
  }
  assert.equal(artifactAdapterFor("commit"), gitSnapshotAdapter);
  for (const kind of ENSEMBLE_ARTIFACT_KINDS) {
    if (kind !== "commit") assert.equal(artifactAdapterFor(kind), null, `${kind} has no adapter yet`);
  }
});

test("capture records honest observed evidence and a ref that resolves to the snapshot", async () => {
  const { path, baseSha } = gitRepo();
  // Dirty the worktree: a tracked edit and a new untracked file.
  writeFileSync(join(path, "README.md"), "base\nmore\n");
  writeFileSync(join(path, "new.txt"), "added\n");

  const captured = await gitSnapshotAdapter.capture({ runId: UUID_A, artifactId: UUID_B, worktreePath: path, baseSha });
  const locator = captured.locator as { ref: string; snapshotSha: string; baseSha: string; treeSha: string };
  assert.match(locator.snapshotSha, /^[0-9a-f]{40}$/);
  assert.equal(locator.baseSha, baseSha);
  assert.equal(captured.fingerprint, locator.treeSha, "the fingerprint is the content tree");

  const observed = captured.observed as { dirty: boolean; filesChanged: number };
  assert.equal(observed.dirty, true, "an edited-and-untracked worktree is dirty");
  assert.ok(observed.filesChanged >= 2, "both files are in the exact diff");

  // The ref resolves to exactly the snapshot commit, and the member's real HEAD is untouched.
  assert.equal(git(path, "rev-parse", `${locator.ref}^{commit}`), locator.snapshotSha);
  assert.equal(git(path, "rev-parse", "HEAD"), baseSha, "capture did not move HEAD");
  assert.equal(await gitSnapshotAdapter.verify(captured.locator, { repoPath: path }), true);
});

test("verify fails once the private ref no longer resolves to its commit", async () => {
  const { path, baseSha } = gitRepo();
  writeFileSync(join(path, "x.txt"), "x\n");
  const captured = await gitSnapshotAdapter.capture({ runId: UUID_A, artifactId: UUID_B, worktreePath: path, baseSha });
  const locator = captured.locator as { ref: string };
  git(path, "update-ref", "-d", locator.ref);
  assert.equal(await gitSnapshotAdapter.verify(captured.locator, { repoPath: path }), false);
});

test("materialize re-derives the exact diff on demand from the immutable commit", async () => {
  const { path, baseSha } = gitRepo();
  writeFileSync(join(path, "README.md"), "base\nchanged\n");
  const captured = await gitSnapshotAdapter.capture({ runId: UUID_A, artifactId: UUID_B, worktreePath: path, baseSha });
  const material = await gitSnapshotAdapter.materialize(captured.locator, { repoPath: path });
  assert.ok(material.filesChanged >= 1);
  assert.match(material.patch, /README\.md/);
  assert.equal(material.truncated, false);
});

test("restore reproduces the captured tree exactly, without switching a branch", async () => {
  const { path, baseSha } = gitRepo();
  writeFileSync(join(path, "README.md"), "base\nsubmitted\n");
  const branchBefore = git(path, "rev-parse", "--abbrev-ref", "HEAD");
  const captured = await gitSnapshotAdapter.capture({ runId: UUID_A, artifactId: UUID_B, worktreePath: path, baseSha });

  // Move on: the worktree changes to something else entirely.
  writeFileSync(join(path, "README.md"), "base\nsomething else\n");
  writeFileSync(join(path, "stray.txt"), "stray\n");

  await gitSnapshotAdapter.restore(captured.locator, { worktreePath: path });
  assert.equal(readFileSync(join(path, "README.md"), "utf8"), "base\nsubmitted\n", "the submitted content is back");
  assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), branchBefore, "restore did not switch a branch");
});
