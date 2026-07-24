import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../util/exec.ts";

// Turning a live agent's working tree into an artifact you can compare, keep, and put back.
//
// The hard requirement is that capturing an agent's work must not DISTURB it. A member may
// be mid-task with a carefully staged index, an amended commit, or a rebase behind it; a
// capture that ran `git add`/`git commit` through the real index would rewrite the split
// between staged and unstaged, move the branch, and turn "we looked at your work" into "we
// edited your work". So everything here writes through a TEMPORARY index and reads the
// worktree, and the only ref it ever moves is one in our own generated namespace.
//
// The artifact is an ordinary commit, which is what makes it survive: the worktree it came
// from can be torn down, the branch deleted and the pool lease returned, and the tree is
// still exactly reproducible from the ref, because refs (unlike HEAD) live in the shared
// git dir that every linked worktree of a repo has in common.

/** The namespace every captured artifact lives under. */
export const ENSEMBLE_REF_PREFIX = "refs/mission-control/ensembles";

/** How much patch text one materialization returns before it starts telling you it stopped. */
export const DEFAULT_MAX_PATCH_BYTES = 400 * 1024;

/**
 * Buffer for the patch subprocess. Generous rather than tuned: exceeding it is not a
 * truncation we can report honestly (we would not know how much was left), so it is a
 * refusal, and a refusal should only ever happen for a genuinely absurd diff.
 */
const PATCH_MAX_BUFFER = 256 * 1024 * 1024;

/** A full commit id, which is the only form any function here accepts. */
const SHA = /^[0-9a-f]{40}$/;
/** A generated id - what every ref component must be. Never operator or agent text. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireSha(label: string, value: string): string {
  if (!SHA.test(value)) throw new Error(`${label} must be a full 40-character commit id, got "${value}"`);
  return value;
}

function requireGeneratedId(label: string, value: string): string {
  if (!UUID.test(value)) throw new Error(`${label} must be a generated UUID, got "${value}"`);
  return value;
}

/**
 * Where one captured artifact lives.
 *
 * Both components are validated as generated UUIDs before they reach a ref name, and that
 * is a boundary rather than a formality: a ref name is passed to `update-ref`, so anything
 * that could carry `../` or a caller's own text would let one artifact's capture move
 * another's ref - or something outside our namespace entirely.
 */
export function ensembleSnapshotRef(ensembleId: string, artifactId: string): string {
  return `${ENSEMBLE_REF_PREFIX}/${requireGeneratedId("ensembleId", ensembleId)}/${requireGeneratedId("artifactId", artifactId)}`;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): ReturnType<typeof run> {
  return run("git", ["-C", cwd, ...args], { timeoutMs: 60_000, env });
}

/** `git` failing is never a partial answer here - say which step, and say what git said. */
function requireOk(step: string, r: Awaited<ReturnType<typeof run>>): string {
  if (r.code !== 0) throw new Error(`${step} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

export interface CapturedSnapshot {
  /** The ref that keeps this commit alive after its worktree is gone. */
  ref: string;
  /** The immutable artifact commit. */
  snapshotSha: string;
  /** Its tree - the complete submitted worktree. */
  treeSha: string;
  /** The member's own HEAD at capture, and the snapshot's parent. Null on an unborn branch. */
  parentSha: string | null;
}

/**
 * Capture a worktree - tracked edits, staged and unstaged alike, deletions, renames and
 * every nonignored untracked file - as one immutable commit under a generated ref.
 *
 * The algorithm is the whole design:
 *
 *   1. a temporary index file, pointed at by `GIT_INDEX_FILE` for these subprocesses ONLY;
 *   2. `read-tree HEAD` seeds it with what the member has committed;
 *   3. `add -A` stages the working tree over that - which is what folds the member's staged
 *      and unstaged edits into one picture, and what includes untracked files while still
 *      honouring `.gitignore`, so a warm `node_modules` is not the artifact;
 *   4. `write-tree` turns that index into a tree object;
 *   5. `commit-tree` parents it on the member's HEAD without moving any branch;
 *   6. `update-ref` names it in our namespace;
 *   7. the ref is read back and re-resolved before this returns.
 *
 * Step 1 is why the member's real `.git/index` is byte-identical afterwards, and steps 5-6
 * are why HEAD, the branch and the working tree are too. Nothing here writes into the
 * worktree at all.
 *
 * Identity is supplied rather than read from config: `commit-tree` refuses to run without
 * a `user.email`, and whether the operator happens to have set one globally is not a
 * reason for a capture to fail.
 */
export async function captureWorktreeSnapshot(input: {
  worktreePath: string;
  ensembleId: string;
  artifactId: string;
}): Promise<CapturedSnapshot> {
  const ref = ensembleSnapshotRef(input.ensembleId, input.artifactId);
  const { worktreePath } = input;

  // Outside the worktree on purpose: a stray index inside it would show up as untracked
  // content in the very snapshot we are taking.
  const indexDir = mkdtempSync(join(tmpdir(), "mission-snapshot-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: join(indexDir, "index"),
    GIT_AUTHOR_NAME: "Mission Control",
    GIT_AUTHOR_EMAIL: "mission-control@localhost",
    GIT_COMMITTER_NAME: "Mission Control",
    GIT_COMMITTER_EMAIL: "mission-control@localhost",
  };
  // An INHERITED repository pointer would beat `-C`, so a daemon that happened to be
  // started from inside a git operation would capture somebody else's tree into our ref -
  // and it would look like it worked. Cheap to rule out, unpleasant to diagnose.
  for (const inherited of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]) {
    delete env[inherited];
  }

  try {
    const head = await git(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], env);
    const parentSha = head.code === 0 && SHA.test(head.stdout.trim()) ? head.stdout.trim() : null;

    // An unborn branch is a real state (a freshly `git init`ed tree), and it snapshots fine -
    // there is simply nothing to seed the index with and no parent to give the commit.
    requireOk(
      "git read-tree",
      await git(worktreePath, parentSha ? ["read-tree", parentSha] : ["read-tree", "--empty"], env),
    );
    requireOk("git add -A", await git(worktreePath, ["add", "-A"], env));
    const treeSha = requireSha(
      "the tree from git write-tree",
      requireOk("git write-tree", await git(worktreePath, ["write-tree"], env)),
    );

    const message = `mission-control ensemble snapshot ${input.ensembleId} ${input.artifactId}`;
    const snapshotSha = requireSha(
      "the commit from git commit-tree",
      requireOk(
        "git commit-tree",
        await git(
          worktreePath,
          ["commit-tree", treeSha, ...(parentSha ? ["-p", parentSha] : []), "-m", message],
          env,
        ),
      ),
    );

    requireOk("git update-ref", await git(worktreePath, ["update-ref", ref, snapshotSha], env));

    // Read it back before claiming it exists. Everything downstream - evaluation, restore,
    // finalization - trusts that this ref resolves to this commit, and the one moment we can
    // cheaply prove it is now.
    const stored = requireOk(
      "git rev-parse (verifying the snapshot ref)",
      await git(worktreePath, ["rev-parse", "--verify", `${ref}^{commit}`], env),
    );
    if (stored !== snapshotSha) {
      throw new Error(`snapshot ref ${ref} resolved to ${stored}, expected ${snapshotSha}`);
    }

    return { ref, snapshotSha, treeSha, parentSha };
  } finally {
    // The index file is scratch, and leaving it behind would leak a tree-sized file per
    // capture into the temp dir. `finally` rather than a success path: a failed capture is
    // exactly when the file is largest and least wanted.
    rmSync(indexDir, { recursive: true, force: true });
  }
}

/** Where a snapshot ref points now, or null when it is gone. */
export async function resolveEnsembleRef(repoPath: string, ref: string): Promise<string | null> {
  if (!ref.startsWith(`${ENSEMBLE_REF_PREFIX}/`)) {
    throw new Error(`${ref} is not a Mission Control ensemble ref`);
  }
  const r = await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : null;
}

export interface SnapshotFileStat {
  path: string;
  /** Where the file came from, when this change is a rename. */
  oldPath: string | null;
  insertions: number;
  deletions: number;
  /** git reported no line counts, because there are none to report. */
  binary: boolean;
}

export interface SnapshotDiff {
  baseSha: string;
  snapshotSha: string;
  files: SnapshotFileStat[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** The patch, up to the caller's budget. */
  patch: string;
  /** The budget was reached and `patch` is not the whole story. */
  truncated: boolean;
  /** Exactly how many bytes of patch were left out. Zero when `truncated` is false. */
  omittedBytes: number;
}

/**
 * The exact difference between the pinned base and one artifact.
 *
 * `baseSha..snapshotSha` DIRECTLY, and never through the merge-base walk `computeSessionDiff`
 * does: a member may amend, rebase or reset before it submits, so the snapshot need not
 * descend from the base at all - and asking for "everything since they diverged" would then
 * answer with a different, larger and wrong diff under the right label. Two exact commits,
 * one exact difference.
 *
 * The statistics are always complete; only the patch is capped. `truncated` and
 * `omittedBytes` are the disclosure that goes with it, because an evaluator that cannot
 * tell a small change from a truncated one will happily call the second one tidy.
 */
export async function materializeSnapshotDiff(input: {
  /** Any working directory inside the repository holding both commits. */
  repoPath: string;
  baseSha: string;
  snapshotSha: string;
  maxPatchBytes?: number;
}): Promise<SnapshotDiff> {
  const baseSha = requireSha("baseSha", input.baseSha);
  const snapshotSha = requireSha("snapshotSha", input.snapshotSha);
  const budget = input.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;

  // `-z` rather than the default: a rename's two paths and any path needing quotes both
  // become unambiguous NUL-separated fields instead of something to un-escape by hand.
  const numstat = await git(input.repoPath, [
    "diff", "--numstat", "-z", "--find-renames", baseSha, snapshotSha,
  ]);
  requireOk("git diff --numstat", numstat);
  const files = parseNumstatZ(numstat.stdout);

  const patchRun = await run(
    "git",
    ["-C", input.repoPath, "diff", "--find-renames", baseSha, snapshotSha],
    { timeoutMs: 60_000, maxBuffer: PATCH_MAX_BUFFER },
  );
  if (patchRun.overflowed) {
    // Refuse rather than report a truncation whose size we would have to invent. A caller
    // that cannot get evidence must find that out, not receive plausible evidence.
    throw new Error(
      `the diff ${baseSha.slice(0, 12)}..${snapshotSha.slice(0, 12)} exceeds ${PATCH_MAX_BUFFER} bytes and cannot be materialized`,
    );
  }
  requireOk("git diff", patchRun);

  const { patch, truncated, omittedBytes } = capPatch(patchRun.stdout, budget);

  return {
    baseSha,
    snapshotSha,
    files,
    filesChanged: files.length,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    patch,
    truncated,
    omittedBytes,
  };
}

/**
 * `--numstat -z` records: `<ins>\t<del>\t<path>\0`, except a rename, which ends its third
 * field early and follows with `<old>\0<new>\0`. A binary file reports `-` for both counts.
 */
function parseNumstatZ(stdout: string): SnapshotFileStat[] {
  const fields = stdout.split("\0");
  const out: SnapshotFileStat[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
    if (!m) continue;
    const binary = m[1] === "-" && m[2] === "-";
    const insertions = m[1] === "-" ? 0 : Number(m[1]);
    const deletions = m[2] === "-" ? 0 : Number(m[2]);
    if (m[3] === "") {
      const oldPath = fields[++i] ?? "";
      const path = fields[++i] ?? "";
      out.push({ path, oldPath, insertions, deletions, binary });
    } else {
      out.push({ path: m[3]!, oldPath: null, insertions, deletions, binary });
    }
  }
  return out;
}

/**
 * Cut the patch to `budget` BYTES, at a line boundary.
 *
 * Bytes rather than characters because the budget exists to bound what reaches a model's
 * context and a token bill, and a line boundary because half a hunk header reads to a
 * reader (human or model) as a malformed diff rather than as a stopped one.
 */
function capPatch(patch: string, budget: number): { patch: string; truncated: boolean; omittedBytes: number } {
  const buf = Buffer.from(patch, "utf8");
  if (buf.length <= budget) return { patch, truncated: false, omittedBytes: 0 };
  const head = buf.subarray(0, Math.max(budget, 0));
  const lastNewline = head.lastIndexOf(0x0a);
  const kept = lastNewline >= 0 ? head.subarray(0, lastNewline + 1) : head;
  return {
    patch: kept.toString("utf8"),
    truncated: true,
    omittedBytes: buf.length - kept.length,
  };
}

/**
 * Return a worktree to one exact commit: hard reset, then drop untracked files that are
 * not ignored.
 *
 * `clean -fd`, NEVER `-fdx`, and that missing letter is the whole point. `-x` would also
 * delete ignored files, which in a pooled worktree means the warm `node_modules` and build
 * caches that the pool exists to keep - turning "start this member from a known commit"
 * into "re-pay every install". Untracked-but-nonignored content is different: it is work
 * that a previous occupant left behind, and leaving it would mean the tree is not the
 * commit we said it was.
 *
 * One owner for both callers - pinned provisioning before a launch, and restoring a
 * selected artifact after one - because the two are the same operation and only one of
 * them can afford to get the flag wrong.
 */
export async function resetWorktreeToCommit(worktreePath: string, commit: string): Promise<void> {
  const sha = requireSha("commit", commit);
  requireOk("git reset --hard", await git(worktreePath, ["reset", "--hard", sha]));
  requireOk("git clean -fd", await git(worktreePath, ["clean", "-fd"]));
  await verifyHeadIs(worktreePath, sha);
}

/**
 * Put a captured artifact back into a worktree, exactly.
 *
 * Takes the ref rather than only the sha so the caller's claim ("this artifact") and the
 * object it resolves to are checked against each other here, at the one moment a mismatch
 * is still cheap - before a hard reset over somebody's checkout.
 */
export async function restoreSnapshotIntoWorktree(input: {
  worktreePath: string;
  ref: string;
  snapshotSha: string;
}): Promise<void> {
  const expected = requireSha("snapshotSha", input.snapshotSha);
  const resolved = await resolveEnsembleRef(input.worktreePath, input.ref);
  if (!resolved) throw new Error(`snapshot ref ${input.ref} no longer resolves`);
  if (resolved !== expected) {
    throw new Error(`snapshot ref ${input.ref} resolves to ${resolved}, expected ${expected}`);
  }
  await resetWorktreeToCommit(input.worktreePath, expected);
}

/**
 * Prove a worktree's HEAD is the commit it was supposed to be left at.
 *
 * Exported because provisioning needs the same assertion: a pinned member that silently
 * started from a different commit is not a member of the comparison it was launched for,
 * and nothing downstream can tell afterwards.
 */
export async function verifyHeadIs(worktreePath: string, commit: string): Promise<void> {
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  const at = head.stdout.trim();
  if (head.code !== 0 || at !== commit) {
    throw new Error(
      `${worktreePath} is at ${at || "an unreadable HEAD"} after provisioning, expected ${commit}`,
    );
  }
}
