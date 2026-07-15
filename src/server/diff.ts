import { run } from "./util/exec.ts";
import type { SessionDiff } from "@shared/types.ts";

// Computes a session's changes against its source branch (typically main) by
// shelling out to git in the session's worktree. "All changes" means everything
// since the branch diverged: commits on top of the merge-base, plus staged,
// unstaged, and untracked worktree edits - so you see the work done in that
// checkout without the mainline's own newer commits bleeding in. Read-only.

/** Cap on the returned patch text; the numeric stats stay complete past this. */
const MAX_PATCH_BYTES = 1_200_000;
/** Don't generate new-file diffs for an unbounded pile of untracked files. */
const MAX_UNTRACKED = 100;
/** git's empty tree, so a root commit (no parent) still diffs as "all added". */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function git(cwd: string, args: string[]): ReturnType<typeof run> {
  return run("git", ["-C", cwd, ...args], { timeoutMs: 15000 });
}

/**
 * The diff of ONE commit - what that commit alone changed, `<sha>^..<sha>`.
 *
 * Deliberately not a mode of `computeSessionDiff`: that one diffs from
 * `merge-base(HEAD, ref)`, so handing it a sha answers with everything *since*
 * that commit, which for a fix log would silently show the wrong (much larger)
 * diff under the right label. A root commit has no `^`, so it diffs against the
 * empty tree and reads as all-added rather than erroring.
 */
export async function computeCommitDiff(cwd: string | null, sha: string): Promise<SessionDiff> {
  const base0: SessionDiff = {
    ok: false, error: null, base: null, baseSha: null, headSha: null, branch: null,
    filesChanged: 0, insertions: 0, deletions: 0, patch: "", truncated: false,
  };
  if (!cwd) return { ...base0, error: "session has no working directory" };

  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ...base0, error: "not a git repository" };

  // Resolve and type-check in one step: `^{commit}` fails for a tag/tree/missing
  // object, so a caller can't get a confusing empty diff out of a valid-looking ref.
  const resolved = await git(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  if (resolved.code !== 0 || !resolved.stdout.trim()) {
    return { ...base0, error: `commit ${sha} is not reachable (rebased, amended, or garbage-collected?)` };
  }
  const full = resolved.stdout.trim();
  const headSha = full.slice(0, 12);

  const branchRes = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.code === 0 && branchRes.stdout.trim() ? branchRes.stdout.trim() : null;

  const parentRes = await git(cwd, ["rev-parse", "--verify", "--quiet", `${full}^`]);
  const parent = parentRes.code === 0 && parentRes.stdout.trim() ? parentRes.stdout.trim() : EMPTY_TREE;

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  const numstat = await git(cwd, ["diff", "--numstat", parent, full]);
  for (const line of numstat.stdout.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    filesChanged++;
    if (m[1] !== "-") insertions += Number(m[1]);
    if (m[2] !== "-") deletions += Number(m[2]);
  }

  let patch = (await git(cwd, ["diff", parent, full])).stdout;
  let truncated = false;
  if (patch.length > MAX_PATCH_BYTES) {
    patch = patch.slice(0, MAX_PATCH_BYTES);
    truncated = true;
  }

  return {
    ok: true, error: null,
    base: parent === EMPTY_TREE ? null : parent.slice(0, 12),
    baseSha: parent === EMPTY_TREE ? null : parent.slice(0, 12),
    headSha, branch, filesChanged, insertions, deletions, patch, truncated,
  };
}

/**
 * The ref to diff against: the upstream default branch (origin's HEAD, else a
 * remote-tracking origin/main|master), falling back to a local main|master. The
 * remote-tracking ref is preferred so the diff reflects what this branch changed
 * against the *current* mainline, not a possibly-stale local branch.
 */
export async function sourceRef(cwd: string): Promise<string | null> {
  const head = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim(); // e.g. "origin/main"
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const r = await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    if (r.code === 0 && r.stdout.trim()) return ref;
  }
  return null;
}

/** Count added lines in a unified diff body (`+` lines, excluding the `+++` header). */
function countAdded(patch: string): number {
  let n = 0;
  for (const line of patch.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) n++;
  return n;
}

/**
 * Compute the diff of `cwd`'s worktree/branch against its source branch. Falls
 * back to a working-tree-vs-HEAD diff when there's no *auto-detected* source
 * branch or no shared history (a brand-new branch), so you always see uncommitted
 * work. An explicitly requested `source` gets no such fallback: see below.
 */
export async function computeSessionDiff(cwd: string | null, source?: string): Promise<SessionDiff> {
  const base0: SessionDiff = {
    ok: false, error: null, base: null, baseSha: null, headSha: null, branch: null,
    filesChanged: 0, insertions: 0, deletions: 0, patch: "", truncated: false,
  };
  if (!cwd) return { ...base0, error: "session has no working directory" };

  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ...base0, error: "not a git repository" };

  const branchRes = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.code === 0 && branchRes.stdout.trim() ? branchRes.stdout.trim() : null;
  const headRes = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  const headSha = headRes.code === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : null;

  const ref = source || (await sourceRef(cwd));
  const base = ref ? ref.replace(/^origin\//, "") : null; // display name (strip remote prefix)
  // Diff from the merge-base so the mainline's own newer commits don't appear -
  // only what this branch/worktree changed since it diverged.
  let diffBase = "HEAD";
  let baseSha: string | null = null;
  if (ref) {
    const mb = await git(cwd, ["merge-base", "HEAD", ref]);
    if (mb.code === 0 && mb.stdout.trim()) {
      diffBase = mb.stdout.trim();
      baseSha = diffBase.slice(0, 12);
    } else if (source) {
      // Falling back to HEAD is right for an *auto-detected* ref (a brand-new
      // branch with no shared history) but wrong for one the caller explicitly
      // asked for: a caller naming a base wants the diff since THAT commit, and
      // silently answering with a working-tree-vs-HEAD diff instead hides the
      // committed work it asked about. That reads as "nothing was done" rather
      // than "the base is gone" - so fail closed and say which sha we couldn't
      // resolve. Reachability, not `ok`, is the signal callers need here.
      return {
        ...base0,
        branch,
        headSha,
        error: `base commit ${source} is not reachable (rebased, amended, or garbage-collected?)`,
      };
    }
  }

  // Tracked changes: numstat for accurate stats, then the patch itself.
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  const numstat = await git(cwd, ["diff", "--numstat", diffBase]);
  for (const line of numstat.stdout.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    filesChanged++;
    if (m[1] !== "-") insertions += Number(m[1]);
    if (m[2] !== "-") deletions += Number(m[2]);
  }
  let patch = (await git(cwd, ["diff", diffBase])).stdout;

  // Untracked files are worktree changes too - render them as new files. `--no-index`
  // is read-only (exit 1 just signals "differs"), so it never touches the index.
  const untrackedRes = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const untracked = untrackedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const path of untracked.slice(0, MAX_UNTRACKED)) {
    const d = await git(cwd, ["diff", "--no-index", "--", "/dev/null", path]);
    if (!d.stdout) continue;
    patch += d.stdout;
    filesChanged++;
    insertions += countAdded(d.stdout);
  }

  let truncated = false;
  if (patch.length > MAX_PATCH_BYTES) {
    patch = patch.slice(0, MAX_PATCH_BYTES);
    truncated = true;
  }

  return {
    ok: true, error: null, base: base ?? null, baseSha, headSha, branch,
    filesChanged, insertions, deletions, patch, truncated,
  };
}
