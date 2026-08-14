import { run } from "./util/exec.ts";
import { clipUtf8Bytes, utf8Bytes } from "./util/utf8.ts";
import type { SessionDiff } from "@shared/types.ts";

// Computes a session's changes against its source branch (typically main) by
// shelling out to git in the session's worktree. "All changes" means everything
// since the branch diverged: commits on top of the merge-base, plus staged,
// unstaged, and untracked worktree edits - so you see the work done in that
// checkout without the mainline's own newer commits bleeding in. Read-only.

/**
 * Cap on the returned patch text; the numeric stats stay complete past this. Applied in
 * BYTES via `clipUtf8Bytes` - `patch.slice` counted UTF-16 code units, so a patch of CJK or
 * box-drawing content ran to 3x this before being handed to the UI. See `util/utf8.ts`.
 */
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
    ok: false, error: null, base: null, baseSha: null, headSha: null, repoRoot: null, branch: null,
    filesChanged: 0, insertions: 0, deletions: 0, patch: "", truncated: false,
  };
  if (!cwd) return { ...base0, error: "session has no working directory" };

  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ...base0, error: "not a git repository" };
  // Paths in the patch are toplevel-relative, so the viewer needs the root they
  // hang off - same contract computeSessionDiff makes.
  const repoRoot = top.stdout.trim() || null;

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

  const baseSha = parent === EMPTY_TREE ? null : parent.slice(0, 12);
  const failed = (error: string): SessionDiff => ({
    ...base0, branch, headSha, repoRoot, baseSha, error,
  });

  // Both exit codes are checked, for the reason computeSessionDiff spells out at
  // length below: `run` reports a timeout or a crash as a plain non-zero exit with
  // whatever stdout was flushed, so an unchecked failure returns `ok: true` with
  // no files and an empty patch. That is exactly what an empty fix commit looks
  // like - a real, tested state the viewer renders as "No changes in this commit."
  // So a diff we couldn't read would claim the fix changed nothing.
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  const numstat = await git(cwd, ["diff", "--numstat", parent, full]);
  if (numstat.code !== 0) return failed("could not read the diff stats");
  for (const line of numstat.stdout.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    filesChanged++;
    if (m[1] !== "-") insertions += Number(m[1]);
    if (m[2] !== "-") deletions += Number(m[2]);
  }

  const patchRes = await git(cwd, ["diff", parent, full]);
  if (patchRes.code !== 0) return failed("could not read the diff");
  let patch = patchRes.stdout;
  let truncated = false;
  if (utf8Bytes(patch) > MAX_PATCH_BYTES) {
    patch = clipUtf8Bytes(patch, MAX_PATCH_BYTES);
    truncated = true;
  }

  return {
    ok: true, error: null,
    // `base` is a branch name ("main"), and a commit isn't diffed against one -
    // it's diffed against its parent, which is what `baseSha` is for. Putting the
    // parent's sha in `base` reads as a branch to every consumer of the field.
    base: null,
    baseSha,
    headSha, branch, repoRoot, filesChanged, insertions, deletions, patch, truncated,
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

/** Every repo-relative path a checkout changed since its source branch, or why not. */
export type ChangedPathsResult =
  | { ok: true; repoRoot: string; paths: string[] }
  | { ok: false; reason: string };

/**
 * The PATHS a checkout changed since its source branch - the same question
 * `computeSessionDiff` answers, without building the patch to answer it.
 *
 * Same base selection, deliberately: `merge-base(HEAD, sourceRef)` so the mainline's own
 * newer commits stay out, the same fall back to `HEAD` for a branch with no shared history,
 * and untracked files counted as changes too. What differs is only the cost and the honesty
 * of the answer. `computeSessionDiff` renders every untracked file through its own
 * `--no-index` diff and then clips the result at 1.2 MB, so a caller that wanted file names
 * pays for a patch it throws away and gets a `truncated` flag that means "this list is not
 * the whole list". Two `git` calls produce the complete list at any size, which is what a
 * caller deciding WHICH FILES TO ARCHIVE needs: a partial list there is not a smaller
 * archive, it is a plan that silently went missing.
 *
 * Deletions are excluded (`--diff-filter=d`), matching `changedPaths`, which reads new-side
 * paths off `+++` and so drops a file the diff only removed. A path that no longer exists
 * cannot be captured and must not be reported as though it could.
 *
 * Fails CLOSED. Every exit code is checked, because `run` reports a timeout as a plain
 * non-zero exit with whatever stdout was flushed - so an unchecked failure would answer
 * "this checkout changed nothing", which is indistinguishable from a real empty result and
 * is the one answer a caller must never act on.
 */
export async function changedPathsSince(cwd: string | null): Promise<ChangedPathsResult> {
  if (!cwd) return { ok: false, reason: "there is no working directory to read" };
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) return { ok: false, reason: "not a git repository" };
  const repoRoot = top.stdout.trim();

  const ref = await sourceRef(cwd);
  let diffBase = "HEAD";
  if (ref) {
    const mb = await git(cwd, ["merge-base", "HEAD", ref]);
    const merged = mb.code === 0 ? mb.stdout.trim() : "";
    if (merged) diffBase = merged;
  }

  const paths = new Set<string>();
  // An unborn HEAD has nothing tracked to diff against and `git diff HEAD` says so. Confirmed
  // positively through `symbolic-ref`, exactly as `computeSessionDiff` does it: inferring it
  // from a failed `rev-parse` would let a timing-out call skip the tracked half and answer
  // with the untracked one alone, which is the fail-open this function exists to avoid.
  const headRes = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  const unborn =
    !(headRes.code === 0 && headRes.stdout.trim()) && (await git(cwd, ["symbolic-ref", "-q", "HEAD"])).code === 0;
  if (!unborn) {
    const tracked = await git(cwd, ["diff", "--name-only", "--diff-filter=d", diffBase]);
    if (tracked.code !== 0) return { ok: false, reason: "could not read the changed paths" };
    for (const line of tracked.stdout.split("\n")) {
      const path = line.trim();
      if (path) paths.add(path);
    }
  }

  // Run from the TOPLEVEL: `ls-files --others` emits paths relative to where it runs and
  // lists only what sits beneath it, while `git diff` above ignores cwd and reports against
  // the toplevel. Both halves have to share one path base or a session cwd'd in a
  // subdirectory mixes two of them into one list.
  const untracked = await git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.code !== 0) return { ok: false, reason: "could not enumerate untracked files" };
  for (const line of untracked.stdout.split("\n")) {
    const path = line.trim();
    if (path) paths.add(path);
  }

  return { ok: true, repoRoot, paths: [...paths].sort() };
}

/** Count added lines in a unified diff body (`+` lines, excluding the `+++` header). */
function countAdded(patch: string): number {
  let n = 0;
  for (const line of patch.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) n++;
  return n;
}

/**
 * The git toplevel containing `cwd`, or null when it isn't a repo.
 *
 * Resolved here rather than accepted from the caller: this is what the standards
 * reader treats as the root it may read files under, so it has to come from git, not
 * from a request.
 */
export async function repoRootOf(cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return top.code === 0 && top.stdout.trim() ? top.stdout.trim() : null;
}

/**
 * Compute the diff of `cwd`'s worktree/branch against its source branch. Falls
 * back to a working-tree-vs-HEAD diff when there's no *auto-detected* source
 * branch or no shared history (a brand-new branch), so you always see uncommitted
 * work. An explicitly requested `source` gets no such fallback: see below.
 */
export async function computeSessionDiff(cwd: string | null, source?: string): Promise<SessionDiff> {
  const base0: SessionDiff = {
    ok: false, error: null, base: null, baseSha: null, headSha: null, repoRoot: null,
    branch: null, filesChanged: 0, insertions: 0, deletions: 0, patch: "", truncated: false,
  };
  if (!cwd) return { ...base0, error: "session has no working directory" };

  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ...base0, error: "not a git repository" };
  // Reported, not discarded: `patch`'s paths are relative to the toplevel, so a
  // caller resolving them against the session's cwd would be wrong for any session
  // that isn't sitting at the repo root - the ordinary case in a monorepo.
  const repoRoot = top.stdout.trim() || null;

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
    const merged = mb.code === 0 ? mb.stdout.trim() : "";
    // An EXPLICIT base must be an ancestor of HEAD, not merely share one with it.
    //
    // merge-base exits non-zero only when there is no common ancestor at all - the
    // garbage-collected case. After a rebase or an amend the old commit is still
    // alive in the reflog, so merge-base SUCCEEDS and quietly returns an older
    // ancestor, and the diff then spans from there: item 2's diff picks up item 1's
    // committed work, which `diffMayIncludeOtherWork` provably cannot catch (it
    // compares recorded base shas, and these differ). So resolve what was asked for
    // and require the two to be the same commit.
    //
    // Auto-detected refs get no such check, by design: `merge-base(HEAD, origin/main)`
    // is SUPPOSED to be an ancestor of both and equal to neither. Their fall back to
    // HEAD (a brand-new branch with no shared history) is deliberate and stays.
    const wanted = source ? await git(cwd, ["rev-parse", "--verify", "--quiet", `${source}^{commit}`]) : null;
    const ok = source ? Boolean(merged) && merged === wanted?.stdout.trim() : Boolean(merged);
    if (ok) {
      diffBase = merged;
      baseSha = diffBase.slice(0, 12);
    } else if (source) {
      // Falling back to HEAD is right for an *auto-detected* ref but wrong for one
      // the caller explicitly asked for: a caller naming a base wants the diff since
      // THAT commit, and silently answering with a working-tree-vs-HEAD diff instead
      // hides the committed work it asked about. That reads as "nothing was done"
      // rather than "the base is gone" - so fail closed and say which sha we
      // couldn't resolve. Reachability, not `ok`, is the signal callers need here.
      return {
        ...base0,
        branch,
        headSha,
        repoRoot,
        error: `base commit ${source} is not reachable (rebased, amended, or garbage-collected?)`,
      };
    }
  }

  // Tracked changes: numstat for accurate stats, then the patch itself.
  //
  // Both exit codes are checked, unlike the `--no-index` call below (whose exit 1
  // just means "these files differ"). These two are the calls that PRODUCE the
  // answer, and `run` reports a timeout or a crash as `code: 1` with whatever stdout
  // was flushed - so an unchecked failure returns `ok: true` with an empty patch,
  // which every reader renders as "no changes were made". The verifier then invents
  // gaps for work that may well be done and they get typed back into a live agent:
  // fail-open, in the one place the evidence-first design exists to be fail-closed.
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  let patch = "";
  // An UNBORN HEAD - a brand-new or orphan branch with no commit yet - has nothing
  // tracked to diff against, and `git diff HEAD` fails saying so. That is an empty
  // tracked half, not a broken command, so it is skipped rather than failed: the
  // untracked scan below is the whole answer there.
  //
  // Confirmed POSITIVELY rather than inferred from the failed `rev-parse` above,
  // because `run` reports a timeout as the same plain non-zero exit as any other
  // failure (see util/exec.ts). "HEAD didn't resolve" alone would therefore let a
  // timing-out rev-parse skip the tracked diff and answer "no changes were made" -
  // reintroducing, on a quieter path, the exact fail-open the exit checks below
  // exist to close. A branch that exists while HEAD resolves to nothing IS what
  // unborn means, and a timeout fails `symbolic-ref` too, so it falls through to the
  // diff and fails closed there.
  const unborn =
    headSha === null && (await git(cwd, ["symbolic-ref", "-q", "HEAD"])).code === 0;
  if (!unborn) {
    const numstat = await git(cwd, ["diff", "--numstat", diffBase]);
    if (numstat.code !== 0) {
      return { ...base0, branch, headSha, repoRoot, base: base ?? null, baseSha, error: "could not read the diff stats" };
    }
    for (const line of numstat.stdout.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      filesChanged++;
      if (m[1] !== "-") insertions += Number(m[1]);
      if (m[2] !== "-") deletions += Number(m[2]);
    }
    const patchRes = await git(cwd, ["diff", diffBase]);
    if (patchRes.code !== 0) {
      return { ...base0, branch, headSha, repoRoot, base: base ?? null, baseSha, error: "could not read the diff" };
    }
    patch = patchRes.stdout;
  }

  // Untracked files are worktree changes too - render them as new files. `--no-index`
  // is read-only (exit 1 just signals "differs"), so it never touches the index.
  //
  // Run from the TOPLEVEL, not from `cwd`. `ls-files --others` emits paths relative
  // to where it runs and lists only what sits beneath it, while `git diff` above
  // ignores cwd entirely and reports the whole repo against the toplevel - so
  // running these here mixed two path bases into one patch and scoped the untracked
  // half to a subtree. Both halves toplevel-relative is what `repoRoot` promises
  // callers (see SessionDiff), and it's what lets the standards reader resolve these
  // paths at all: for a session cwd'd in a monorepo package, `src/x.ts` resolved
  // against the toplevel is a directory that doesn't exist, so that package's own
  // CLAUDE.md never loaded.
  const untrackedCwd = repoRoot ?? cwd;
  const untrackedRes = await git(untrackedCwd, ["ls-files", "--others", "--exclude-standard"]);
  if (untrackedRes.code !== 0) {
    return {
      ...base0,
      branch,
      headSha,
      repoRoot,
      base: base ?? null,
      baseSha,
      error: "could not enumerate untracked files",
    };
  }
  const untracked = untrackedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const path of untracked.slice(0, MAX_UNTRACKED)) {
    const d = await git(untrackedCwd, ["diff", "--no-index", "--", "/dev/null", path]);
    if (
      d.outcomeUnknown
      || d.overflowed
      || (d.code !== 0 && d.code !== 1)
      || (d.code === 1 && !d.stdout)
    ) {
      return {
        ...base0,
        branch,
        headSha,
        repoRoot,
        base: base ?? null,
        baseSha,
        error: `could not read untracked file ${path}`,
      };
    }
    if (!d.stdout) continue;
    patch += d.stdout;
    filesChanged++;
    insertions += countAdded(d.stdout);
  }

  let truncated = untracked.length > MAX_UNTRACKED;
  if (utf8Bytes(patch) > MAX_PATCH_BYTES) {
    patch = clipUtf8Bytes(patch, MAX_PATCH_BYTES);
    truncated = true;
  }

  return {
    ok: true, error: null, base: base ?? null, baseSha, headSha, repoRoot, branch,
    filesChanged, insertions, deletions, patch, truncated,
  };
}
