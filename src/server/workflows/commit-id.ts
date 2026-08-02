import { run } from "../util/exec.ts";

/**
 * Turning a captured commit identifier into one this repository can be held to.
 *
 * Its own module because two callers now need the same answer and must not be able to give
 * different ones: a Check pins its worktree to the commit a submission captured, and the
 * `pull_request` session action refuses to advance unless the commit its pull request adopted
 * is the commit the continuation captured. Both compare an ABBREVIATION written by evidence
 * capture against a FULL id that came from somewhere else - git's object database in the first
 * case, GitHub's `headRefOid` in the second - and a prefix comparison is not that comparison.
 */

/**
 * A FULL object id, in either width git produces: 40 hex for SHA-1, 64 for SHA-256.
 *
 * Both widths, because a repository created with `--object-format=sha256` reports 64-character
 * ids everywhere and this is the one place that decides whether an id is "full" at all. Pinned
 * at 40 alone, every such repository failed in the same silent direction: a captured head was
 * rejected as "not a commit id", and a `pull_request` action waited for proof it could never
 * accept even while GitHub named the exact commit.
 *
 * The short-circuit for a full id stays safe at either width. Git ignores a ref whose name is a
 * full object id FOR THAT REPOSITORY's hash, so the ref-shadowing hazard `resolveCapturedCommit`
 * exists to close cannot apply to one - and a 64-character string in a SHA-1 repository is not
 * an object id at all, so it simply fails to resolve rather than resolving to the wrong thing.
 *
 * Exported because three callers used to spell this rule three different ways: this resolver at
 * 40, `readWorkflowRepositoryHead` at 40, and the persisted expectation schema at 40-or-64. A
 * producer narrower than the schema it feeds is a contract that lies about what it can carry.
 */
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/**
 * An abbreviated object id and nothing else. Four is git's own floor for an abbreviation, and
 * lowercase-only keeps ONE spelling rule across this file and `verifyPinnedBase`. The ceiling
 * is the longer full width for `FULL_SHA`'s reason.
 */
const ABBREVIATED_SHA = /^[0-9a-f]{4,64}$/;

/**
 * Turn the capture's commit identifier into the full object id a pin requires.
 *
 * **Found by running this end to end, and invisible from the code alone.** Evidence capture
 * records `git rev-parse --short HEAD` (`src/server/diff.ts`), so `headSha` on a real
 * submission is an ABBREVIATION - while `verifyPinnedBase` refuses anything that is not a full
 * 40-hex id, deliberately, because `requireSha` will not hard-reset a worktree onto a name it
 * cannot pin exactly. Wired without this step, every check on every real submission failed as
 * infrastructure before it ever leased a tree: the gate still never ran, which is the headline
 * defect wearing a different hat.
 *
 * Resolved through git rather than by relaxing the pin's rule, and that direction is the point.
 * An abbreviation only names a commit if this repository says which one, and `rev-parse
 * --verify` refuses an ambiguous abbreviation outright - so this narrows to exactly one commit
 * or it fails, and what reaches the pin is still a full id held to its own standard. Relaxing
 * `requireSha` instead would have let an ambiguous prefix decide which commit a build ran
 * against.
 *
 * A full id short-circuits, which is the shape `submission.prHeadSha` already arrives in.
 *
 * ## Why this does not use `rev-parse <prefix>`, which is the obvious way
 *
 * `rev-parse` resolves REVISION EXPRESSIONS, and every extra thing it can resolve is wrong here
 * in the same way: it returns a real commit that is not the one the submission captured, so the
 * check runs against the wrong tree and reports the answer as if it were about this submission.
 * Two distinct hazards, both measured rather than assumed:
 *
 *  - **An expression resolves.** `HEAD~1^{commit}` is a valid argument and answers with whatever
 *    HEAD's parent is *at check time*. So is a branch name, a tag, `@{yesterday}`. Closed by
 *    requiring the input to be a hex object-id prefix before git is asked anything at all.
 *  - **A ref SHADOWS an abbreviated object id.** A branch literally named `04a6ee7` beats the
 *    object whose id starts with `04a6ee7`: git prefers the refname, warns on stderr, and
 *    answers with the branch's commit. Requiring the answer to merely START WITH the prefix is
 *    NOT enough to close this - it only catches the case where the ref points somewhere that
 *    does not share the prefix, and a ref pointing at a *different commit with the same prefix*
 *    would sail through. That was this function's first fix and it was too weak.
 *
 * So refs are taken out of the decision entirely. `rev-parse --disambiguate=<prefix>` enumerates
 * the OBJECT DATABASE by prefix and consults no ref at any point, which is what "proven unique
 * independently of ref resolution" actually requires. Exactly one commit among the candidates is
 * the captured commit; zero is a commit this repository does not have; more than one is an
 * ambiguous abbreviation that nothing here is entitled to guess at.
 *
 * A full id short-circuits, which is the shape `submission.prHeadSha` already arrives in - and
 * it is safe to short-circuit because git ignores a ref whose name is a full object id, by
 * construction and by its own warning. That asymmetry is why the two lengths are treated
 * differently, and it is pinned by test.
 *
 * "Full" means full FOR THIS REPOSITORY, which is why `fullIdWidth` asks git rather than
 * reading the id's length. Accepting either width on the string alone would let a
 * 64-character value short-circuit in a SHA-1 repository - returned as a resolved commit
 * having been verified by nothing, which is precisely the invalid id this function exists to
 * keep away from a pin.
 *
 * Every refusal here is infrastructure, never a verdict: a commit we cannot identify is a gate
 * we could not run, not a statement about the change under review.
 */
/**
 * The full object-id width THIS repository uses: 64 for SHA-256, 40 for SHA-1.
 *
 * Asked rather than inferred from the id's own length, and that is the whole point. The
 * short-circuit below returns a "full" id without consulting git at all, so deciding fullness
 * from the string means a 64-character value in a SHA-1 repository is handed downstream as a
 * resolved commit having been verified by nothing - which is exactly the invalid id a pin must
 * never receive. Width is a property of the repository, so the repository is what is asked.
 *
 * An unreadable answer falls back to SHA-1's 40, which is the conservative direction: it makes
 * a 64-character id take the disambiguation path, where a value naming no object is refused
 * rather than trusted.
 */
async function fullIdWidth(repoRoot: string): Promise<number> {
  const result = await run("git", ["-C", repoRoot, "rev-parse", "--show-object-format"]);
  return result.code === 0 && result.stdout.trim() === "sha256" ? 64 : 40;
}

export async function resolveCapturedCommit(repoRoot: string, headSha: string): Promise<string> {
  // Full for THIS repository, not merely full-looking. See `fullIdWidth`.
  if (FULL_SHA.test(headSha) && headSha.length === await fullIdWidth(repoRoot)) return headSha;
  if (!ABBREVIATED_SHA.test(headSha)) {
    throw new Error(
      `the captured commit ${JSON.stringify(headSha)} is not a commit id - a check is pinned to `
        + "the exact commit a submission captured, and a revision expression would resolve to "
        + "whatever it happens to name when the check runs",
    );
  }
  const listed = await run("git", ["-C", repoRoot, "rev-parse", `--disambiguate=${headSha}`]);
  const candidates = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => FULL_SHA.test(line));
  // Which candidates are COMMITS. Asked per full id, which cannot be shadowed by a ref, and
  // required to answer with the id itself - that keeps commits while dropping blobs, trees, and
  // an annotated tag that would peel to some other commit.
  const commits: string[] = [];
  for (const id of candidates) {
    const r = await run("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${id}^{commit}`]);
    if (r.code === 0 && r.stdout.trim() === id) commits.push(id);
  }
  if (commits.length === 1) return commits[0]!;
  if (commits.length === 0) {
    throw new Error(
      `the captured commit ${headSha} names no commit in ${repoRoot}` +
        (listed.stderr.trim() ? ` - git said: ${listed.stderr.trim()}` : ""),
    );
  }
  throw new Error(
    `the captured commit ${headSha} is ambiguous in ${repoRoot}: it names ${commits.length} `
      + `commits (${commits.map((id) => id.slice(0, 12)).join(", ")}), so which one this `
      + "submission captured cannot be established",
  );
}
