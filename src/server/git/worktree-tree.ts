import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../util/exec.ts";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof run> {
  return run("git", ["-C", cwd, ...args], { timeoutMs: 60_000, env });
}

function requireOk(step: string, result: Awaited<ReturnType<typeof run>>): string {
  if (result.code !== 0) {
    throw new Error(`${step} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout.trim();
}

function requireObjectId(step: string, value: string): string {
  if (!OBJECT_ID.test(value)) throw new Error(`${step} returned an invalid git object id`);
  return value;
}

/** Remove inherited repository selectors before running git against an explicit checkout. */
export function isolatedGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const inherited of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[inherited];
  }
  return { ...env, ...extra };
}

export interface CapturedWorktreeTree {
  /** Complete tracked and nonignored worktree content, independent of commit identity. */
  treeOid: string;
  /** HEAD at the start of capture, or null for an unborn branch. */
  headOid: string | null;
}

export interface CaptureWorktreeTreeOptions {
  /** Persist newly hashed objects in the repository when a later Git operation needs the tree. */
  objectStorage?: "temporary" | "repository";
}

/**
 * Hash the complete worktree through a temporary index without changing its branch, files,
 * or real index. The returned tree id is the content-semantic identity used by snapshots
 * and workflow shipping proofs.
 */
export async function captureWorktreeTree(
  worktreePath: string,
  options: CaptureWorktreeTreeOptions = {},
): Promise<CapturedWorktreeTree> {
  const indexDir = mkdtempSync(join(tmpdir(), "mission-worktree-tree-"));
  const baseEnv = isolatedGitEnvironment();
  try {
    const objectStore = requireOk(
      "git object store discovery",
      await git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], baseEnv),
    );
    const extraEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: join(indexDir, "index") };
    if (options.objectStorage !== "repository") {
      const temporaryObjects = join(indexDir, "objects");
      mkdirSync(temporaryObjects);
      extraEnv.GIT_OBJECT_DIRECTORY = temporaryObjects;
      extraEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES = objectStore;
    }
    const env = isolatedGitEnvironment(extraEnv);
    const head = await git(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], env);
    const headOid = head.code === 0 && OBJECT_ID.test(head.stdout.trim())
      ? head.stdout.trim()
      : null;
    requireOk(
      "git read-tree",
      await git(worktreePath, headOid ? ["read-tree", headOid] : ["read-tree", "--empty"], env),
    );
    requireOk("git add -A", await git(worktreePath, ["add", "-A"], env));
    const treeOid = requireObjectId(
      "git write-tree",
      requireOk("git write-tree", await git(worktreePath, ["write-tree"], env)),
    );
    return { treeOid, headOid };
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}
