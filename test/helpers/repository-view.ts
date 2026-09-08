import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryViewDescriptor } from "../../src/shared/repository-access.ts";
import { REPOSITORY_HISTORY_POLICY_V1 } from "../../src/shared/repository-access.ts";

function git(root: string, args: string[], input?: string): string {
  return execFileSync("git", [
    "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${join(root, ".hooks-disabled")}`,
    "-C", root,
    ...args,
  ], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, ".gitconfig-disabled"),
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

export interface RepositoryViewFixture {
  root: string;
  descriptor: RepositoryViewDescriptor;
}

export function repositoryViewFixture(options: { preserveSensitiveObject?: boolean } = {}): RepositoryViewFixture {
  const root = mkdtempSync(join(tmpdir(), "mission-repository-view-test-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "Fixture"]);
  writeFileSync(join(root, "source.txt"), "alpha\nbeta\n", "utf8");
  writeFileSync(join(root, ".env"), "TOKEN=secret-that-must-not-leak\n", "utf8");
  git(root, ["add", "source.txt", ".env"]);
  git(root, ["commit", "-qm", "root"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "source.txt"), "alpha\nbeta staged\n", "utf8");
  git(root, ["add", "source.txt"]);
  const indexTree = git(root, ["write-tree"]);
  const indexBlob = git(root, ["rev-parse", ":source.txt"]);
  writeFileSync(join(root, "source.txt"), "alpha\nbeta staged\ngamma worktree\n", "utf8");
  const worktreeBlob = git(root, ["hash-object", "-w", "source.txt"]);
  const worktreeTree = git(root, ["mktree"], `100644 blob ${worktreeBlob}\tsource.txt\n`);
  const envBlob = git(root, ["rev-parse", "HEAD:.env"]);
  rmSync(join(root, ".env"));
  if (!options.preserveSensitiveObject) {
    rmSync(join(root, ".git", "objects", envBlob.slice(0, 2), envBlob.slice(2)));
  }
  const snapshotDigest = createHash("sha256").update(`${head}:${indexTree}:${worktreeTree}`).digest("hex");
  return {
    root,
    descriptor: {
      schemaVersion: 1,
      snapshotDigest,
      artifactLocator: "fixture-artifact",
      manifestPath: join(root, "manifest.json"),
      repositoryRoot: root,
      objectDirectory: join(root, ".git", "objects"),
      headRevision: head,
      sourceRevision: head,
      indexTree,
      worktreeTree,
      historyPolicy: REPOSITORY_HISTORY_POLICY_V1,
      retainedRevisions: [{ id: head, parents: [], incrementalAllowedBlobBytes: 0 }],
      frontier: [head],
      omittedParents: [],
      retainedCommitCount: 1,
      retainedAllowedBlobBytes: 0,
      entries: [
        { path: "source.txt", kind: "file", addressable: true, mode: 0o100644, sensitive: false, worktreePresent: true, indexObjectId: indexBlob, worktreeObjectId: worktreeBlob, status: "staged_modified+worktree_modified" },
        { path: ".env", kind: "file", addressable: true, mode: 0o100644, sensitive: true, worktreePresent: false, indexObjectId: null, worktreeObjectId: null, status: "clean" },
      ],
    },
  };
}
