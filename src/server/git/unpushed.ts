import { run } from "../util/exec.ts";
import type { UnpushedCommits, UnpushedUnknownReason } from "@shared/unpushed.ts";

// Does this checkout hold commits its configured upstream has never seen?
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
// and never toward a false all-clear.
//
// The comparison is `@{upstream}..HEAD`. It is deliberately NOT the `--remotes` sweep that
// `resetWouldDestroyWork` in `actions.ts` uses, and the two are answering different questions:
// that refusal asks "could this destroy work that exists nowhere else", where any remote will
// do, while this asks "has the branch the Inspector is watching received these commits", where
// only the tracked one counts.

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
 * Commits this checkout holds that its configured upstream does not, or why we cannot say.
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
 *  4. How many commits does `@{upstream}..HEAD` hold?
 *
 * Steps 3 and 4 name the SAME ref, and that is the contract: the upstream is both what
 * licenses a claim and what the claim is measured against. The caller is the parked-run
 * stall, which speaks for an Inspector waiting on one branch - the one the pull request
 * points at, which is the one this branch tracks. Commits that reached some other ref have
 * not reached that one, so a wider comparison would call the wait satisfied while the run
 * stayed parked.
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

  // 4. Commits HEAD holds that its CONFIGURED UPSTREAM does not - `@{upstream}..HEAD`.
  //
  //    Measured against the branch's own upstream rather than against every remote-tracking
  //    ref, and the difference is the whole contract. The question this reader exists to
  //    answer is "has the head the Inspector is waiting for been pushed", and the Inspector
  //    waits on ONE branch: the one the pull request points at, which is the one this branch
  //    tracks. A commit sitting on some other remote ref - a different branch name, a second
  //    remote - has not reached the ref anybody is watching, so counting it as pushed would
  //    report the wait as satisfied while the run stays parked for ever.
  //
  //    `@{upstream}` also resolves to whatever the branch ACTUALLY tracks, so a clone whose
  //    remote is not called `origin` (a fork cloned with `--origin upstream` is the ordinary
  //    case) is compared against its real upstream rather than against refs it does not have.
  //    That is what keeps a fully pushed fork from being accused of its entire history, which
  //    is the failure a hardcoded `--remotes=origin` produced.
  const counted = await git(root, ["rev-list", "--count", `${upstream}..HEAD`]);
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
