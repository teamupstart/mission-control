import { run } from "../util/exec.ts";
import { FULL_SHA } from "../workflows/commit-id.ts";

/**
 * Probing a repository's remote default branch, fail-closed.
 *
 * Two callers need the same answer for the same reason and must not diverge on how they
 * get it: task dispatch, which freezes the commit a scheduled task starts from, and the
 * native allocator's Return, which resets a warm pool slot back to the remote default. A
 * second parsing rule for one of them is a second set of edge cases, and the edge case
 * that matters here is silent: a repository whose server-side default was renamed still
 * has a stale `refs/remotes/origin/HEAD` locally, and `git fetch` does not refresh it.
 * Reading the cached symref would then start every task on a branch the server stopped
 * publishing, with nothing anywhere reporting a problem.
 *
 * So the current default is asked of the REMOTE (`ls-remote --symref`) rather than of the
 * checkout's cache, and every uncertain answer is an error rather than a fallback. A
 * dispatch that cannot prove where it should start is cheap to refuse and expensive to get
 * wrong: refusing costs an error on a card, guessing costs an agent working from the wrong
 * base and a branch nobody chose.
 */
export type RemoteProbe<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; outcomeUnknown: boolean };

/** Bounded because these run in front of a dispatch a person is waiting on. */
const LOCAL_TIMEOUT_MS = 15_000;
const NETWORK_TIMEOUT_MS = 30_000;
const MAX_FETCH_ATTEMPTS = 3;

type Run = typeof run;

function failed(result: Awaited<ReturnType<Run>>): boolean {
  return result.code !== 0 || result.outcomeUnknown || result.overflowed;
}

function failure(step: string, result: Awaited<ReturnType<Run>>): RemoteProbe<never> {
  return {
    ok: false,
    reason: `${step} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    // A killed or overflowed child never reported its own outcome. For a read that only
    // matters as "what is true", that is still an unknown rather than a "no".
    outcomeUnknown: result.outcomeUnknown || result.overflowed,
  };
}

/**
 * Git protects a remote-tracking ref with a compare-and-swap. Two fetches that read the
 * same predecessor can therefore race: the winner advances the ref, and the loser reports
 * that the ref "is at" the winner's value rather than the value it "expected". That is a
 * completed, retry-safe local refusal, not an unknown network outcome or a broken checkout.
 */
function staleRemoteTrackingRef(result: Awaited<ReturnType<Run>>): boolean {
  return (
    result.code !== 0 &&
    !result.outcomeUnknown &&
    !result.overflowed &&
    /\bcannot lock ref '[^']+': is at [0-9a-f]{40,64} but expected [0-9a-f]{40,64}\b/i.test(
      result.stderr,
    )
  );
}

/** The exact remote names `git remote` listed - one per line, no parsing beyond trimming. */
export function parseRemoteNames(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * The branch name behind `ls-remote --symref origin HEAD`'s first symref line.
 *
 * The line is `ref: refs/heads/<branch>\tHEAD`, and the branch is everything after
 * `refs/heads/` up to the tab - taken whole rather than split on "/", so a repository
 * whose default is `release/next` reads as that branch and not as `release`.
 *
 * Null means "this output does not state a branch", which every caller treats as a
 * failure. A remote whose HEAD is itself detached, or an output shape a future Git
 * changes, both land here and both are refused rather than guessed at.
 */
export function parseSymrefHeadBranch(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("ref: ")) continue;
    const [ref, name] = line.slice("ref: ".length).split("\t");
    if (name?.trim() !== "HEAD") continue;
    const branch = ref?.trim() ?? "";
    if (!branch.startsWith("refs/heads/")) return null;
    const short = branch.slice("refs/heads/".length);
    return short.length > 0 ? short : null;
  }
  return null;
}

/**
 * The object id `ls-remote --symref origin HEAD` advertised for HEAD itself.
 *
 * The same output carries two facts, and both matter: a `ref: …\tHEAD` line naming the
 * branch, and a `<oid>\tHEAD` line naming the commit that branch was on at the instant the
 * remote answered. Reading only the first is what leaves a window - the fetch happened
 * earlier, so the local remote-tracking ref may already be a commit behind what this same
 * answer says HEAD is.
 *
 * Null means the output did not state one, which is a refusal rather than a shrug.
 */
export function parseLsRemoteHeadSha(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const [oid, name] = line.split("\t");
    if (name?.trim() !== "HEAD") continue;
    const sha = oid?.trim() ?? "";
    // `FULL_SHA`, never a private 40-hex rule: a repository created with
    // `--object-format=sha256` advertises 64-character ids everywhere, and a narrower
    // spelling here would refuse every unpinned dispatch and every native Return in one as
    // though origin had supplied no commit at all. That module owns the width question for
    // exactly this reason - see its note on the same defect found in the pin path.
    if (FULL_SHA.test(sha)) return sha;
  }
  return null;
}

/**
 * Whether this repository has a remote named exactly `origin`.
 *
 * A `false` is a positive finding, not a shrug: only a listing that SUCCEEDED and did not
 * contain the name establishes an origin-less repository, because that answer is what
 * unlocks the local-HEAD fallback. A timeout, a spawn refusal, an overflow or a nonzero
 * exit all arrive here as `ok: false`, and a caller that treated those as "no origin"
 * would silently take the fallback for a repository that has one - which is the stale-base
 * dispatch this whole path exists to prevent.
 */
export async function originConfigured(
  root: string,
  execute: Run = run,
): Promise<RemoteProbe<boolean>> {
  const listed = await execute("git", ["-C", root, "remote"], { timeoutMs: LOCAL_TIMEOUT_MS });
  if (failed(listed)) return failure("git remote", listed);
  return { ok: true, value: parseRemoteNames(listed.stdout).includes("origin") };
}

/** Bring `origin`'s refs up to date, or refuse. Never falls back to what is already local. */
export async function fetchOrigin(root: string, execute: Run = run): Promise<RemoteProbe<void>> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    const fetched = await execute("git", ["-C", root, "fetch", "origin"], {
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    if (!failed(fetched)) return { ok: true, value: undefined };
    if (!staleRemoteTrackingRef(fetched) || attempt === MAX_FETCH_ATTEMPTS) {
      return failure("git fetch origin", fetched);
    }
    // The conflicting writer already changed the ref before Git emitted this error, so the
    // next fetch can start immediately from that settled value. A delay is unnecessary.
  }
  throw new Error("unreachable fetch attempt state");
}

/**
 * The full commit id `origin` currently advertises as its default branch's tip.
 *
 * The returned SHA is the one the REMOTE stated, not one read off a local ref - and that
 * distinction is the whole point rather than a stylistic one. The fetch happens before this
 * observation, so a remote that advances in between leaves `refs/remotes/origin/<branch>`
 * one commit behind the very answer this call is reading. Taking the branch NAME from the
 * advertisement and the SHA from the local ref would accept exactly that stale commit and
 * report it as a fresh freeze, which is the drift this whole path exists to remove.
 *
 * So both halves of one answer are used together: the advertised branch and the advertised
 * object id. The local remote-tracking ref then has to agree with that object id, which is
 * what proves the fetch actually brought this commit down - a caller is about to check it
 * out, and an id no local object backs would fail later, inside a leased slot. Disagreement
 * is a refusal, not a repair: it means the remote moved mid-observation, and one retry
 * (which costs nothing, since nothing has been provisioned) sees a settled answer.
 */
export async function currentRemoteDefaultSha(
  root: string,
  execute: Run = run,
): Promise<RemoteProbe<string>> {
  const symref = await execute("git", ["-C", root, "ls-remote", "--symref", "origin", "HEAD"], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (failed(symref)) return failure("git ls-remote --symref origin HEAD", symref);
  const branch = parseSymrefHeadBranch(symref.stdout);
  if (!branch) {
    return {
      ok: false,
      reason: "origin did not advertise a branch as its HEAD",
      outcomeUnknown: false,
    };
  }
  const advertised = parseLsRemoteHeadSha(symref.stdout);
  if (!advertised) {
    return {
      ok: false,
      reason: `origin advertised ${branch} as its HEAD without a commit id`,
      outcomeUnknown: false,
    };
  }
  const ref = `refs/remotes/origin/${branch}`;
  const resolved = await execute(
    "git",
    ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { timeoutMs: LOCAL_TIMEOUT_MS },
  );
  // `--quiet` makes a genuine miss an exit 1 with empty stderr, which is byte-identical to
  // a killed child - so the uncertainty flags are read before the exit code.
  if (resolved.outcomeUnknown || resolved.overflowed) {
    return failure(`git rev-parse ${ref}`, resolved);
  }
  const local = resolved.stdout.trim();
  if (resolved.code !== 0 || !FULL_SHA.test(local)) {
    return {
      ok: false,
      reason: `origin's default branch ${branch} is not in this repository's remote-tracking refs`,
      outcomeUnknown: false,
    };
  }
  if (local !== advertised) {
    return {
      ok: false,
      reason:
        `origin advertised ${branch} at ${advertised} but this repository fetched ${local} - ` +
        "the remote moved during the observation",
      outcomeUnknown: false,
    };
  }
  return { ok: true, value: advertised };
}

/**
 * Fetch `origin`, then freeze the commit it currently calls default.
 *
 * The one operation dispatch and native Return share. Both want the same sentence - "the
 * newest commit on whatever branch the server publishes as default" - and both fail rather
 * than settle for an older or differently-named one.
 */
export async function freshRemoteDefaultSha(
  root: string,
  execute: Run = run,
): Promise<RemoteProbe<string>> {
  const fetched = await fetchOrigin(root, execute);
  if (!fetched.ok) return fetched;
  return currentRemoteDefaultSha(root, execute);
}
