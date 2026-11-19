import type { PrChecks } from "@shared/types.ts";

// One answer to "is CI failing on this commit", for both places that ask: the branch poller's
// PR chip (`src/server/pr.ts`) and the Inspector's merge gate (`src/server/inspector/github.ts`).
//
// GitHub keeps every check run a commit ever had. When a workflow runs again on the same head -
// the PR title check after the title is edited, a run cancelled by a concurrency group and
// started over, a job dispatched again by hand - the earlier run stays in `statusCheckRollup`
// beside the later one. GitHub's own aggregate `state` still counts it, and so did the chip, so
// one failure that a later run had already re-checked held the "a CI check failed" alert and
// the merge gate's "CI is failing" for the rest of the pull request's life. `gh pr checks` and
// GitHub's checks list show the latest run of each check, and that is the reading here.
//
// A run stops counting only when a later run of the SAME check started after it had finished.
// The same check means a GitHub Actions run of the same workflow file, triggering event and check
// name: a `push` run and a `pull_request` run of one job are two checks, whatever their timing,
// and a pass in one says nothing about a failure in the other. Two runs of one check that
// overlapped are independent verdicts too, and so are two jobs of one workflow run that share a
// display name: a re-run is always a different check suite. Only Actions runs say all of that
// (see `runKey`), so another app's failed check, and a failed commit status, is never retired
// here. Leaving a stale failure up is a false alarm; letting an unrelated pass hide a real
// failure would be a merge the gate should have refused.
//
// `gh pr list --json statusCheckRollup`, which the branch poller reads, does not carry the app or
// the event, so its runs never have a full identity and never retire one another here. What it
// can say is that a failure LOOKS re-checked (`unconfirmedRetry`), and the poller then reads the
// same commit's checks through GraphQL (`CHECK_CONTEXTS`), which does carry them.

/** One page of a commit's checks, with everything `rollUpChecks` needs to tell checks apart. */
export const CHECK_CONTEXTS = `contexts(first:100){
        pageInfo{ hasNextPage }
        nodes{
          __typename
          ... on CheckRun{ name status conclusion startedAt completedAt
            checkSuite{ id app{ slug } workflowRun{ event workflow{ id name } } } }
          ... on StatusContext{ context state createdAt }
        }
      }`;

// CheckRun conclusions and StatusContext states that count as a failed check.
const FAIL_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);
const PASS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAIL_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

/** `unknown` is a finished result this file does not recognise. The chip reads it as a pass. */
type CheckState = "fail" | "pending" | "pass" | "unknown";

interface CheckEntry {
  /** Which check this is a run of, or null when the answer cannot say in full. */
  key: string | null;
  /** The same, by workflow and name alone: enough to suspect a re-run, never to act on one. */
  looseKey: string | null;
  /**
   * The check suite this run reported in, or null for a commit status. A run never retires
   * another from its own suite: two jobs of one workflow run can share a display name, and a
   * `needs` job with `if: always()` passing after its sibling failed is not a re-run of it.
   */
  suite: string | null;
  state: CheckState;
  startedAt: number | null;
  /** When its verdict was in. Null while it is still running: a running check is never stale. */
  finishedAt: number | null;
}

export interface CheckRollup {
  /**
   * The rollup over the runs that still count: any failure dominates, else pending while any is
   * still running, else passing. Null when nothing recognisable was reported. An unrecognised
   * result reads as passing, so an unknown value never raises a false alarm.
   */
  checks: PrChecks | null;
  /** A failing run was set aside because a later run of the same check re-checked it. */
  retriedFailure: boolean;
  /**
   * The failing runs set aside, and the failing runs that still count, each as `failureId`: its
   * workflow name, check name and start - what both of GitHub's answers report about a run, so a
   * failure `gh pr list` reported can be found again in the GraphQL read that confirms it.
   */
  retiredFailures: string[];
  failures: string[];
  /**
   * A failing run still counts, but a later run with the same workflow and name started after
   * it finished, and this answer cannot say whether that run was the same check. Read the
   * commit's checks with `CHECK_CONTEXTS` to find out.
   */
  unconfirmedRetry: boolean;
  /**
   * Every entry could be read, and every run that still counts had a result this file
   * recognises. An entry dropped as unreadable - GraphQL allows a null node - could have been
   * the failure that keeps a check failing, so it makes the whole answer unrecognised.
   */
  recognized: boolean;
}

/**
 * A timestamp, or null. `gh`'s JSON export writes Go's zero time for a run that has not started
 * or finished, which parses to a real (very old) instant, so anything at or before the epoch is
 * treated as absent rather than as an instant that precedes every other run.
 */
function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type CheckSuite = {
  id?: unknown;
  app?: { slug?: unknown } | null;
  workflowRun?: { event?: unknown; workflow?: { id?: unknown; name?: unknown } | null } | null;
} | null;

/** The app GitHub Actions reports its check runs as. */
const ACTIONS_APP = "github-actions";

/**
 * The full identity of a GraphQL check run - workflow, event and name - or null when there is
 * none to be had, and a run with no identity never retires another.
 *
 * Only a GitHub Actions run has one. Its suite names the workflow it belongs to and the event
 * that triggered it, and both must be there: a blank is not a value two runs can share, or two
 * jobs named `build` in different workflows would become one check and a pass in one would
 * clear the other. The workflow is its node id, not its display name: two workflow files can
 * both be called `CI`, and a name they share is the same blank by another spelling. The suite's
 * own id must be there too, because a run never retires one from its own suite.
 *
 * Every other app's check carries only the app and the name, and an app can report two
 * independent checks under one name - a CI service's `build` job in two of its own workflows -
 * that nothing in GitHub's answer tells apart from a re-run. So another app's failure stands
 * until the next push, exactly as GitHub's own aggregate reads it. Null too for `gh`'s JSON
 * export, which flattens the suite to `workflowName` and drops the rest.
 */
function runKey(o: Record<string, unknown>, name: string): string | null {
  if (!o.checkSuite || typeof o.checkSuite !== "object") return null;
  const suite = o.checkSuite as CheckSuite;
  if (text(suite?.app?.slug) !== ACTIONS_APP || !text(suite?.id)) return null;
  const workflow = text(suite?.workflowRun?.workflow?.id);
  const event = text(suite?.workflowRun?.event);
  return workflow && event ? `run\0${workflow}\0${event}\0${name}` : null;
}

/** The workflow a check run belongs to, in either shape: `gh` flattens it to `workflowName`. */
function workflowOf(o: Record<string, unknown>): string {
  if (typeof o.workflowName === "string") return o.workflowName;
  return text((o.checkSuite as CheckSuite)?.workflowRun?.workflow?.name);
}

/**
 * Read one `statusCheckRollup` entry, in either shape it arrives in: a GraphQL `CheckRun` (a
 * `status` such as QUEUED/IN_PROGRESS/COMPLETED and, once done, a `conclusion`) or a legacy
 * `StatusContext` (a `state` such as SUCCESS/PENDING/FAILURE). Null for a shape we don't know.
 */
function readEntry(e: unknown): CheckEntry | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  if (typeof o.status === "string") {
    const done = o.status.toUpperCase() === "COMPLETED";
    const conclusion = text(o.conclusion).toUpperCase();
    const name = text(o.name);
    return {
      key: name ? runKey(o, name) : null,
      looseKey: name ? `run\0${workflowOf(o)}\0${name}` : null,
      suite: text((o.checkSuite as CheckSuite)?.id) || null,
      state: !done
        ? "pending"
        : FAIL_CONCLUSIONS.has(conclusion)
          ? "fail"
          : PASS_CONCLUSIONS.has(conclusion)
            ? "pass"
            : "unknown",
      startedAt: instant(o.startedAt),
      finishedAt: done ? instant(o.completedAt) : null,
    };
  }
  if (typeof o.state === "string") {
    const s = o.state.toUpperCase();
    // A commit status names no app, workflow or event - anything that can post to the API can
    // post one under any context - so, like another app's check, it never retires another and is
    // never retired: a failed status stands until the next push. GitHub's rollup already keeps
    // only the latest status per context, so the failure it reports is the current one.
    // `gh` exports the instant as `startedAt`; GraphQL calls it `createdAt`.
    const at = instant(o.startedAt) ?? instant(o.createdAt);
    return {
      key: null,
      looseKey: null,
      suite: null,
      state: FAIL_STATES.has(s) ? "fail" : PENDING_STATES.has(s) ? "pending" : s === "SUCCESS" ? "pass" : "unknown",
      startedAt: at,
      finishedAt: at,
    };
  }
  return null;
}

/** A failing run's `failureId`: see `CheckRollup.retiredFailures`. */
function failureId(entry: CheckEntry): string {
  return `${entry.looseKey ?? ""}\0${entry.startedAt ?? ""}`;
}

/**
 * True when `later` started in a second after the one `earlier` finished in, and after `earlier`
 * started. GitHub reports whole seconds, so a start in the same second as the finish may still
 * have overlapped it, and overlapping runs are independent verdicts. Strictly later on both
 * counts is also what keeps two runs reported in the same second from each retiring the other.
 */
function startedAfter(later: CheckEntry, earlier: CheckEntry): boolean {
  return (
    earlier.finishedAt !== null &&
    earlier.startedAt !== null &&
    later.startedAt !== null &&
    later.startedAt > earlier.finishedAt &&
    later.startedAt > earlier.startedAt
  );
}

/** Roll a commit's `statusCheckRollup` entries up to one state. See the header for which count. */
export function rollUpChecks(entries: readonly unknown[]): CheckRollup {
  const parsed = entries.map(readEntry);
  const read = parsed.filter((e): e is CheckEntry => e !== null);
  const rerun = (entry: CheckEntry, key: "key" | "looseKey"): boolean =>
    entry[key] !== null &&
    read.some((other) => other !== entry && other[key] === entry[key] && startedAfter(other, entry) &&
      (entry.suite === null || other.suite !== entry.suite));
  let retriedFailure = false;
  const retiredFailures: string[] = [];
  const failures: string[] = [];
  let unconfirmedRetry = false;
  let recognized = read.length === parsed.length;
  let sawFail = false;
  let sawPending = false;
  let sawPass = false;
  for (const entry of read) {
    if (rerun(entry, "key")) {
      if (entry.state === "fail") {
        retriedFailure = true;
        retiredFailures.push(failureId(entry));
      }
      continue;
    }
    if (entry.state === "fail") {
      sawFail = true;
      failures.push(failureId(entry));
      if (rerun(entry, "looseKey")) unconfirmedRetry = true;
    } else if (entry.state === "pending") sawPending = true;
    else {
      sawPass = true;
      if (entry.state === "unknown") recognized = false;
    }
  }
  const checks: PrChecks | null = sawFail ? "failing" : sawPending ? "pending" : sawPass ? "passing" : null;
  return { checks, retriedFailure, retiredFailures, failures, unconfirmedRetry, recognized };
}
