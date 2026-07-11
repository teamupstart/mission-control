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

function git(cwd: string, args: string[]): ReturnType<typeof run> {
  return run("git", ["-C", cwd, ...args], { timeoutMs: 15000 });
}

/** The repo's source/default branch: origin's HEAD, else main, else master. */
async function defaultBranch(cwd: string): Promise<string | null> {
  const head = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    const r = await git(cwd, ["rev-parse", "--verify", "--quiet", b]);
    if (r.code === 0 && r.stdout.trim()) return b;
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
 * back to a working-tree-vs-HEAD diff when there's no source branch or no shared
 * history (a brand-new branch), so you always see uncommitted work.
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

  const base = source || (await defaultBranch(cwd));
  // Diff from the merge-base so the mainline's own newer commits don't appear -
  // only what this branch/worktree changed since it diverged.
  let diffBase = "HEAD";
  let baseSha: string | null = null;
  if (base) {
    const mb = await git(cwd, ["merge-base", "HEAD", base]);
    if (mb.code === 0 && mb.stdout.trim()) {
      diffBase = mb.stdout.trim();
      baseSha = diffBase.slice(0, 12);
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
