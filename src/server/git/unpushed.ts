import { run } from "../util/exec.ts";
import type { UnpushedCommits, UnpushedUnknownReason } from "@shared/unpushed.ts";

// Does this checkout hold commits origin has never seen?
//
// Read-only and local, in the strongest sense both words have here. It NEVER fetches, and it
// never writes: no push, no ref update, no index touch, no stdin. That is a hard requirement
// rather than a preference. The one caller this was written for is the parked-run stall, and
// the run it describes is parked precisely BECAUSE the Inspector poller has not yet observed
// a pushed head. A reader that pushed would clear the very condition it was asked to explain,
// and a reader that fetched would put a network round trip on a 5-second poll for an answer
// that only ever gets more conservative without one.
//
// Not fetching is what makes the answer safe to say out loud. A remote-tracking ref we have
// not fetched cannot vouch for a commit, so every staleness in the local refs pushes the
// count UP, toward "you still have work here" - which the caller may then decline to say -
// and never toward a false all-clear. `resetWouldDestroyWork` in `actions.ts` reasons the
// same way for the same reason, and this deliberately reuses its comparison.

/** The dominant timeout for a local git read in this daemon (diff, actions, pool all use it). */
const GIT_READ_TIMEOUT_MS = 15_000;

/**
 * The exec seam, so a test can count invocations or refuse one without a PATH shim.
 *
 * Shaped as `{ run }` rather than as a bag of higher-level stubs on purpose: the thing worth
 * testing here IS the git conversation - which questions get asked, in what order, and what
 * each refusal turns into - so the seam belongs at the subprocess boundary where a test can
 * wrap the REAL `run` and still assert the argv. See `SnapshotDiffDeps` for the precedent.
 */
export interface UnpushedDeps {
  run: typeof run;
}

export const defaultUnpushedDeps: UnpushedDeps = { run };

function unknown(why: UnpushedUnknownReason): UnpushedCommits {
  return { state: "unknown", why };
}

/**
 * Commits in this checkout that no origin ref holds, or why we cannot say.
 *
 * Four questions, each of which can only end in an answer or a named silence:
 *
 *  1. Is this a git repository? Its answer is also the checkout ROOT, so the rest of the
 *     conversation runs at the top of the worktree rather than in whatever subdirectory a
 *     session happens to be sitting in.
 *  2. Is HEAD on a branch? A detached HEAD has no branch to have forgotten to push.
 *  3. Does that branch TRACK something? This is the gate, and it is the one refusal that
 *     matters most. A branch with no upstream is the ordinary state of work that was never
 *     meant to be pushed yet, and calling that "unpushed commits" would accuse a person of
 *     forgetting a step they never owed.
 *  4. How many commits does HEAD hold that no `origin/*` ref does?
 *
 * Step 4 compares against EVERY origin remote-tracking ref rather than against `@{upstream}`
 * alone, while step 3 still insists an upstream exists. That split is deliberate and it is
 * the difference between a useful sentence and a wrong one. The gate has to be `@{upstream}`
 * because "this branch tracks nothing" is exactly the case that must stay silent. The COUNT
 * must not be, because a session that pushed its work to a differently-named branch has
 * genuinely pushed it, and `@{upstream}..HEAD` would still report those commits as missing
 * and tell a person to push something that is already on the remote.
 *
 * Every failure mode returns `unknown`, never a zero and never a count. "We could not look"
 * and "there is nothing there" are different facts, and only one of them may be spoken.
 */
export async function readUnpushedCommits(
  cwd: string | null,
  deps: UnpushedDeps = defaultUnpushedDeps,
): Promise<UnpushedCommits> {
  if (!cwd) return unknown("no_checkout");

  const git = (dir: string, args: string[]): ReturnType<typeof run> =>
    deps.run("git", ["-C", dir, ...args], { timeoutMs: GIT_READ_TIMEOUT_MS });

  // 1. A repository, and where its top is.
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  // `outcomeUnknown` before `code`, every time. A child that was killed reports a non-zero
  // exit that is indistinguishable from git's own refusal, and collapsing the two is the
  // mistake `test/dispatch-git-preflight.test.ts` exists to pin. Here it only picks the name
  // in a log line, because both readings end in silence - but the day this function grows an
  // arm that acts, the distinction has to already be in the code.
  if (top.outcomeUnknown) return unknown("git_failed");
  if (top.code !== 0 || !top.stdout.trim()) return unknown("not_a_repo");
  const root = top.stdout.trim();

  // 2. On a branch, or detached. `symbolic-ref` is the idiom the rest of the daemon uses for
  //    this question because it FAILS on a detached HEAD, where `rev-parse --abbrev-ref`
  //    cheerfully answers the literal string "HEAD".
  const head = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.outcomeUnknown) return unknown("git_failed");
  if (head.code !== 0 || !head.stdout.trim()) return unknown("detached_head");
  const branch = head.stdout.trim();

  // 3. The gate: does it track anything at all?
  const tracking = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (tracking.outcomeUnknown) return unknown("git_failed");
  if (tracking.code !== 0 || !tracking.stdout.trim()) return unknown("no_upstream");
  const upstream = tracking.stdout.trim();

  // 4. Commits no origin ref holds. A branch that was pushed reads 0 here whether its pull
  //    request is open or merged, because its commits stay reachable from `origin/<branch>`.
  const counted = await git(root, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
  if (counted.outcomeUnknown) return unknown("git_failed");
  if (counted.code !== 0) return unknown("git_failed");

  // Parsed strictly rather than through `Number(x) || 0`, which reads every unparsable
  // answer as a confident zero - the one direction this function is not allowed to be wrong
  // in, because zero is a positive claim that nothing is missing.
  const raw = counted.stdout.trim();
  if (!/^\d+$/.test(raw)) return unknown("unreadable");
  const commits = Number(raw);

  return commits > 0
    ? { state: "ahead", commits, branch, upstream }
    : { state: "pushed", branch, upstream };
}
