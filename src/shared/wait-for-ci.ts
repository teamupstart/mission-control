import { z } from "zod";
import { CI_STRICTNESS, classifyCheckEntry, requiredChecksRollup, type CiStrictness } from "./ci-checks.ts";

// The Wait for CI node: what it reads, what it records, and how it decides.
//
// Browser-safe (no `node:` imports). The daemon decides with `decideWaitForCi`, and the run
// views read the same `WaitForCiState` the attempt carries in `output_json`, so the two cannot
// describe one wait differently.
//
// The node never talks to GitHub. The GitHub Inspector's one PR query reads the head commit's
// check runs beside the head sha, and the node is re-observed when that snapshot changes and
// on the workflow manager's fifteen-second timer. See docs/workflows.md#wait-for-ci.

/** The timeout a new node gets, and the range an author may choose, in minutes. */
export const WAIT_FOR_CI_TIMEOUT_MINUTES = { default: 45, min: 5, max: 240 } as const;

/** The quiet period a new node gets, and the range an author may choose, in minutes. */
export const WAIT_FOR_CI_QUIET_MINUTES = { default: 3, min: 0, max: 30 } as const;

/**
 * How many expected check names a node may list, and how long one may be. `max` is enforced at
 * Publish, so the editor can show it on the node; `schemaMax` only bounds what can be stored.
 */
export const WAIT_FOR_CI_EXPECTED_CHECKS = { max: 20, nameMax: 500, schemaMax: 100 } as const;

/** The three settings a Wait for CI node judges under. */
export interface WaitForCiSettings {
  strictness: CiStrictness;
  quietMinutes: number;
  expectedChecks: readonly string[];
}

/** The settings as a node or an attempt stores them: each one absent until it is written. */
export interface WaitForCiStoredSettings {
  strictness?: CiStrictness;
  quietMinutes?: number;
  expectedChecks?: string[];
}

/**
 * What a node or attempt that names no setting judges under: all checks count, a 3-minute quiet
 * period, and no expected checks. Literals, frozen for ever: absence means exactly this, never
 * whatever a later default becomes, so they deliberately do not read the defaults above.
 */
export const WAIT_FOR_CI_LEGACY_SETTINGS = {
  strictness: "all",
  quietMinutes: 3,
  expectedChecks: [],
} as const satisfies WaitForCiSettings;

/** What a node added in the editor writes, built from the defaults. */
export const WAIT_FOR_CI_NEW_NODE_SETTINGS: Readonly<WaitForCiSettings> = {
  strictness: CI_STRICTNESS[0],
  quietMinutes: WAIT_FOR_CI_QUIET_MINUTES.default,
  expectedChecks: [],
};

/** `WAIT_FOR_CI_NEW_NODE_SETTINGS` as fields a new node owns, its list a fresh array. */
export function newWaitForCiNodeSettings(): Required<WaitForCiStoredSettings> {
  return { ...WAIT_FOR_CI_NEW_NODE_SETTINGS, expectedChecks: [...WAIT_FOR_CI_NEW_NODE_SETTINGS.expectedChecks] };
}

/** The strictness as every surface names it: "All checks" or "Required checks". */
export function ciStrictnessLabel(strictness: CiStrictness): string {
  return strictness === "required" ? "Required checks" : "All checks";
}

/**
 * The one resolver for a node's or an attempt's settings: a stored field wins, and an absent
 * one takes `WAIT_FOR_CI_LEGACY_SETTINGS`. Every reader goes through it.
 */
export function waitForCiSettings(stored: Partial<WaitForCiSettings>): WaitForCiSettings {
  return {
    strictness: stored.strictness ?? WAIT_FOR_CI_LEGACY_SETTINGS.strictness,
    quietMinutes: stored.quietMinutes ?? WAIT_FOR_CI_LEGACY_SETTINGS.quietMinutes,
    expectedChecks: stored.expectedChecks ?? WAIT_FOR_CI_LEGACY_SETTINGS.expectedChecks,
  };
}

/**
 * The settings exactly as stored: each present field, and nothing for an absent one, so a legacy
 * node round-trips through the editor, and a legacy attempt through "Wait for CI again", still
 * reading as legacy.
 */
export function storedWaitForCiSettings(stored: Partial<WaitForCiSettings>): WaitForCiStoredSettings {
  return {
    ...(stored.strictness !== undefined ? { strictness: stored.strictness } : {}),
    ...(stored.quietMinutes !== undefined ? { quietMinutes: stored.quietMinutes } : {}),
    ...(stored.expectedChecks !== undefined ? { expectedChecks: [...stored.expectedChecks] } : {}),
  };
}

/**
 * Whether a quiet period fits inside the node's timeout. The one predicate behind the Publish
 * diagnostic and the editor's inline message, so the two cannot disagree.
 */
export function waitForCiQuietFits(settings: Pick<WaitForCiSettings, "quietMinutes">, timeoutMinutes: number): boolean {
  return settings.quietMinutes < timeoutMinutes;
}

/** What Publish and the editor say when the quiet period does not fit inside the timeout. */
export const WAIT_FOR_CI_QUIET_PERIOD_MESSAGE = "The quiet period must be shorter than the timeout.";

/** What Publish and the editor say when an expected-checks list would be refused. */
export const WAIT_FOR_CI_EXPECTED_CHECKS_MESSAGE =
  `Expected checks must be unique, and there can be at most ${WAIT_FOR_CI_EXPECTED_CHECKS.max}.`;

/** Whether an expected-checks list would pass Publish: unique trimmed names, at most `max`. */
export function waitForCiExpectedChecksValid(expectedChecks: readonly string[]): boolean {
  const names = expectedChecks.map((name) => name.trim());
  return names.length <= WAIT_FOR_CI_EXPECTED_CHECKS.max && new Set(names).size === names.length;
}

/**
 * How long a quiet period still running at the timeout may wait for the observation that
 * decides it, counted from the moment the period would end.
 *
 * Past the timeout a quiet period may finish but never start again, and it is decided on the
 * first new observation at or after its end. The Inspector reviews pull requests one at a
 * time, and a review can take ten minutes before the next 90-second poll, so that observation
 * can come minutes late; fifteen minutes covers one review, one poll and the CodeRabbit read
 * in the same turn. A literal, because this module cannot import the Inspector worker.
 */
export const WAIT_FOR_CI_QUIET_GRACE_MS = 15 * 60_000;

/** A check run summary is cut to this many characters when it is stored. */
export const CI_CHECK_SUMMARY_CHARS = 1_500;
/** A check run title is cut to this many characters when it is stored. */
export const CI_CHECK_TITLE_CHARS = 300;
/** At most this many check runs are stored for one head. GitHub's query reads 100. */
export const CI_CHECK_RUNS_MAX = 100;

export const CI_CHECK_RUN_STATES = ["pending", "passing", "failing"] as const;
export type CiCheckRunState = (typeof CI_CHECK_RUN_STATES)[number];

/** One check on the pull request's head commit: a GitHub check run or a legacy status. */
export const CiCheckRunSchema = z.object({
  name: z.string().max(500),
  state: z.enum(CI_CHECK_RUN_STATES),
  /** GitHub's conclusion (`FAILURE`, `TIMED_OUT`, ...) or status state; null while pending. */
  conclusion: z.string().max(100).nullable(),
  detailsUrl: z.string().max(2_000).nullable(),
  title: z.string().max(CI_CHECK_TITLE_CHARS).nullable(),
  summary: z.string().max(CI_CHECK_SUMMARY_CHARS).nullable(),
  /**
   * True when GitHub marks the check required on this pull request (`isRequired`). Absent
   * means not marked, which is how every snapshot stored before the field existed reads.
   */
  required: z.boolean().optional(),
});
export type CiCheckRun = z.infer<typeof CiCheckRunSchema>;

/** What the Inspector last read about CI on one pull request, keyed to the commit it read. */
export const CiObservationSchema = z.object({
  headSha: z.string().max(100),
  observedAt: z.number(),
  checkRuns: z.array(CiCheckRunSchema).max(CI_CHECK_RUNS_MAX),
  /**
   * How many checks GitHub reports on the head (`contexts.totalCount`), which can exceed the
   * `CI_CHECK_RUNS_MAX` stored. Null when GitHub did not say; absent on older snapshots.
   */
  totalCount: z.number().int().nullable().optional(),
});
export type CiObservation = z.infer<typeof CiObservationSchema>;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/**
 * The head commit's `statusCheckRollup.contexts` nodes as stored check runs, plus GitHub's
 * `contexts.totalCount` (null unless it is a non-negative integer). Unknown node shapes are
 * skipped. A node's `isRequired: true` is stored as `required`; anything else leaves it absent.
 */
export function ciCheckRunsFromRollup(
  contexts: readonly unknown[],
  totalCount?: unknown,
): { checkRuns: CiCheckRun[]; totalCount: number | null } {
  const checkRuns: CiCheckRun[] = [];
  for (const raw of contexts) {
    if (!raw || typeof raw !== "object" || checkRuns.length >= CI_CHECK_RUNS_MAX) continue;
    const node = raw as Record<string, unknown>;
    const state = classifyCheckEntry(node);
    if (state === null) continue;
    const required = node.isRequired === true ? { required: true } : {};
    if (typeof node.status === "string" && typeof node.name === "string") {
      const conclusion = typeof node.conclusion === "string" ? node.conclusion.toUpperCase() : null;
      checkRuns.push({
        name: node.name.slice(0, 500),
        state,
        conclusion: state === "pending" ? null : conclusion,
        detailsUrl: text(node.detailsUrl, 2_000),
        title: text(node.title, CI_CHECK_TITLE_CHARS),
        summary: text(node.summary, CI_CHECK_SUMMARY_CHARS),
        ...required,
      });
      continue;
    }
    if (typeof node.context === "string" && typeof node.state === "string") {
      const upper = node.state.toUpperCase();
      checkRuns.push({
        name: node.context.slice(0, 500),
        state,
        conclusion: state === "pending" ? null : upper,
        detailsUrl: text(node.targetUrl, 2_000),
        title: null,
        summary: text(node.description, CI_CHECK_SUMMARY_CHARS),
        ...required,
      });
    }
  }
  return {
    checkRuns,
    totalCount: Number.isInteger(totalCount) && (totalCount as number) >= 0 ? (totalCount as number) : null,
  };
}

/**
 * Why a Wait for CI node blocked its run. APPEND-ONLY: each is also a run phase
 * (`WORKFLOW_RUN_PHASES`) and a `Record` key in the run views.
 */
export const WAIT_FOR_CI_BLOCK_CODES = [
  /** No check appeared on the head commit before the timeout. */
  "ci_missing",
  /** Checks were still running, or had not stayed settled for the quiet period, at the timeout. */
  "ci_timeout",
  /** The node has no pull request to watch: the action before it recorded none. */
  "ci_pull_request_unknown",
  /** Every counted check settled, but an expected check never appeared before the timeout. */
  "ci_expected_missing",
  /**
   * CI would have passed on the checks read, but GitHub reported more than the
   * `CI_CHECK_RUNS_MAX` the query reads, so the node cannot confirm the rest passed.
   */
  "ci_checks_truncated",
] as const;
export type WaitForCiBlockCode = (typeof WAIT_FOR_CI_BLOCK_CODES)[number];

/** The state a Wait for CI attempt carries in `output_json`, waiting and after. */
export const WaitForCiStateSchema = z.object({
  kind: z.literal("wait_for_ci"),
  pullRequestKey: z.string().nullable(),
  pullRequestUrl: z.string().nullable(),
  pullRequestNumber: z.number().int().nullable(),
  /**
   * The full head commit the node watches, and judges no other: the commit the Pull Request
   * action's continuation captured, which is what the session pushed. Null until the manager
   * has resolved it.
   */
  expectedHeadOid: z.string().nullable(),
  /**
   * The head GitHub last reported for the pull request when the action completed. Only a
   * fallback for a captured head that cannot be resolved: it can be a poll behind a push.
   */
  reportedHeadOid: z.string().nullable().optional(),
  waitingSince: z.number(),
  timeoutMinutes: z.number().int(),
  /**
   * The node's settings, copied at activation like `timeoutMinutes`. Absent on attempts
   * written before they existed, which read as `WAIT_FOR_CI_LEGACY_SETTINGS`.
   */
  strictness: z.enum(CI_STRICTNESS).optional(),
  quietMinutes: z.number().int().min(0).optional(),
  expectedChecks: z.array(z.string().max(WAIT_FOR_CI_EXPECTED_CHECKS.nameMax))
    .max(WAIT_FOR_CI_EXPECTED_CHECKS.schemaMax).optional(),
  /** When the Inspector last read CI for the expected head; null until it has. */
  observedAt: z.number().nullable(),
  /** The expected head's checks as last read. */
  checkRuns: z.array(CiCheckRunSchema).max(CI_CHECK_RUNS_MAX),
  /**
   * The `observedAt` of the Inspector observation that first saw this settled set of checks:
   * the start of the quiet period. Null while any check is pending or the set has not been
   * seen settled; absent on attempts written before the quiet period existed.
   */
  quietSince: z.number().nullable().optional(),
  /**
   * True on a verdict reached in Required mode with no check marked required, which judged
   * every check instead.
   */
  requiredFallback: z.boolean().optional(),
  /** The expected checks the last observation did not report. */
  missingExpected: z.array(z.string()).optional(),
  /** How many checks GitHub reported on the head at the last observation, when it said. */
  checksTotal: z.number().int().nullable().optional(),
  outcome: z.enum(["pass", "fail", "blocked"]).nullable(),
  blocked: z.object({ code: z.enum(WAIT_FOR_CI_BLOCK_CODES), detail: z.string() }).nullable(),
  /** True when the operator disabled the node and it passed without waiting. */
  disabled: z.boolean().optional(),
});
export type WaitForCiState = z.infer<typeof WaitForCiStateSchema>;

/** The state a freshly activated node starts with. */
export function initialWaitForCiState(input: {
  pullRequestKey: string | null;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  expectedHeadOid: string | null;
  reportedHeadOid?: string | null;
  timeoutMinutes: number;
  now: number;
} & Partial<WaitForCiSettings>): WaitForCiState {
  return {
    kind: "wait_for_ci",
    pullRequestKey: input.pullRequestKey,
    pullRequestUrl: input.pullRequestUrl,
    pullRequestNumber: input.pullRequestNumber,
    expectedHeadOid: input.expectedHeadOid,
    reportedHeadOid: input.reportedHeadOid ?? null,
    waitingSince: input.now,
    timeoutMinutes: input.timeoutMinutes,
    ...storedWaitForCiSettings(input),
    observedAt: null,
    checkRuns: [],
    quietSince: null,
    outcome: null,
    blocked: null,
  };
}

/** The attempt output as a Wait for CI state, or null when it is something else. */
export function readWaitForCiState(output: unknown): WaitForCiState | null {
  const parsed = WaitForCiStateSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

export type WaitForCiDecision =
  | { kind: "wait"; state: WaitForCiState }
  | { kind: "pass"; state: WaitForCiState }
  | { kind: "fail"; state: WaitForCiState; failing: CiCheckRun[] }
  | { kind: "block"; state: WaitForCiState; code: WaitForCiBlockCode; detail: string };

function sameHead(expected: string, observed: string): boolean {
  return expected.toLowerCase() === observed.toLowerCase();
}

/**
 * A check as the quiet period compares it: what it is called, what it concluded, and whether
 * GitHub marks it required, so marking or unmarking a check changes the set.
 */
function checkKey(run: CiCheckRun): string {
  return JSON.stringify([run.name, run.state, run.conclusion, run.required === true]);
}

/** Whether two observations saw the same checks, in any order. */
function sameChecks(a: readonly CiCheckRun[], b: readonly CiCheckRun[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(checkKey).sort();
  const right = b.map(checkKey).sort();
  return left.every((key, index) => key === right[index]);
}

/** Whether a head's total says GitHub reported more checks than were read. */
function truncatedTotal(checksTotal: number | null | undefined): boolean {
  return checksTotal != null && checksTotal > CI_CHECK_RUNS_MAX;
}

/**
 * The checks a node counts on one observation, under its settings. `checksTotal` is what
 * GitHub reported on the head, which can exceed the checks read.
 *
 * - All: every check.
 * - Required, with checks marked: the marked checks, plus every check whose name is expected.
 * - Required, with nothing marked: every check, and `fallback` says so. A verdict reached this
 *   way records it. Never on a truncated head: the unread checks may be the required ones, so
 *   it counts only what is marked or expected among those read, possibly nothing.
 */
export function countedChecks(
  runs: readonly CiCheckRun[],
  settings: WaitForCiSettings,
  checksTotal?: number | null,
): { counted: CiCheckRun[]; fallback: boolean } {
  if (settings.strictness === "all") return { counted: [...runs], fallback: false };
  if (requiredChecksRollup(runs) === null && !truncatedTotal(checksTotal)) {
    return { counted: [...runs], fallback: true };
  }
  const expected = new Set(settings.expectedChecks);
  return { counted: runs.filter((run) => run.required === true || expected.has(run.name)), fallback: false };
}

/**
 * The expected names no check on this observation carries, in the order the node lists them.
 * None on a truncated head: an absent name may be among the checks that were not read.
 */
export function missingExpectedChecks(
  runs: readonly CiCheckRun[],
  settings: WaitForCiSettings,
  checksTotal?: number | null,
): string[] {
  if (truncatedTotal(checksTotal)) return [];
  const present = new Set(runs.map((run) => run.name));
  return [...new Set(settings.expectedChecks)].filter((name) => !present.has(name));
}

/**
 * What decides whether CI has settled: the counted checks, or, on a truncated head where nothing
 * read is counted, every check read, so the node blocks `ci_checks_truncated` once CI has quieted
 * rather than wait for marks it can never read.
 */
function settlingChecks(
  runs: readonly CiCheckRun[],
  settings: WaitForCiSettings,
  checksTotal: number | null | undefined,
): { counted: CiCheckRun[]; fallback: boolean; settling: CiCheckRun[] } {
  const { counted, fallback } = countedChecks(runs, settings, checksTotal);
  return { counted, fallback, settling: counted.length === 0 && truncatedTotal(checksTotal) ? [...runs] : counted };
}

/**
 * How many checks GitHub reported against how many were read, as the block detail and the run
 * panel say it: `GitHub reported 140 checks; only the first 100 were read`, with no end mark.
 */
export function waitForCiTruncationText(checksTotal: number | null | undefined): string {
  const total = checksTotal != null ? String(checksTotal) : `more than ${CI_CHECK_RUNS_MAX}`;
  return `GitHub reported ${total} checks; only the first ${CI_CHECK_RUNS_MAX} were read`;
}

/** The line a fail carries for expected checks CI never reported, or "" when there are none. */
export function notReportedWhenFailed(missing: readonly string[]): string {
  return missing.length > 0 ? `Not reported when CI failed: ${quotedNames(missing)}.` : "";
}

/** Whether GitHub reported more checks on the head than the node read. */
export function waitForCiTruncated(state: Pick<WaitForCiState, "checksTotal">): boolean {
  return truncatedTotal(state.checksTotal);
}

/** Names as the block details and summaries quote them: `"e2e", "build"`. */
export function quotedNames(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/**
 * One observation of a waiting node, decided. Pure: the caller supplies the stored
 * observation and the time. The node judges under its own settings (`waitForCiSettings`), and
 * the checks it counts are `countedChecks`'.
 *
 * - Another head, or no observation yet: wait. The node never judges a head it was not given.
 * - Any counted check still pending: wait, and clear the quiet period.
 * - Every counted check settled, one failing: fail, naming every counted failure and any
 *   expected check not reported. In Required mode with nothing marked, the failure waits out
 *   the quiet period first, like a pass would.
 * - Every counted check passed, an expected check not reported yet: wait for it.
 * - Every counted check passed, every expected check reported: pass at once. Otherwise pass at
 *   once with a quiet period of 0, or run the quiet period. Its clock starts at the
 *   `observedAt` of the observation that first saw this counted set, and the node passes on an
 *   observation at least the quiet period later that saw the same set. A changed set restarts
 *   it. The clock reads observations, never `now`, so the manager's fifteen-second sweep
 *   re-deciding one observation cannot pass the node on its own.
 * - A pass on a head where GitHub reported more checks than were read blocks
 *   `ci_checks_truncated` instead: the node never passes on a partial list.
 * - At the timeout: a quiet period already running may still finish on its first new
 *   observation, unchanged, but never starts or restarts. It blocks `ci_timeout` when the set
 *   changes, or when no new observation arrives within `WAIT_FOR_CI_QUIET_GRACE_MS` of the
 *   period's end. Otherwise it blocks, in order: `ci_missing` when no check ever appeared,
 *   `ci_timeout` naming the counted checks still running, `ci_expected_missing` naming the
 *   expected checks never reported, and `ci_timeout` when the set kept changing.
 */
export function decideWaitForCi(
  state: WaitForCiState,
  observation: CiObservation | null,
  now: number,
): WaitForCiDecision {
  let next: WaitForCiState = state;
  if (!next.expectedHeadOid) {
    const blocked = {
      code: "ci_pull_request_unknown" as const,
      detail: next.pullRequestKey
        ? "The pull request's head commit could not be identified: GitHub had not reported it, "
          + "and the checkout's own head could not be resolved."
        : "The step before this node recorded no pull request to watch.",
    };
    return { kind: "block", ...blocked, state: { ...next, outcome: "blocked", blocked } };
  }
  const settings = waitForCiSettings(next);
  const quietMs = settings.quietMinutes * 60_000;
  if (observation && sameHead(next.expectedHeadOid, observation.headSha)) {
    const runs = observation.checkRuns;
    const total = observation.totalCount ?? null;
    const truncated = truncatedTotal(total);
    const missing = missingExpectedChecks(runs, settings, total);
    const previous = settlingChecks(next.checkRuns, settings, next.checksTotal).settling;
    const { counted, fallback, settling } = settlingChecks(runs, settings, total);
    next = {
      ...next,
      observedAt: observation.observedAt,
      checkRuns: runs,
      missingExpected: missing,
      checksTotal: total,
    };
    const settled = settling.length > 0 && settling.every((run) => run.state !== "pending");
    const failing = counted.filter((run) => run.state === "failing");
    if (!settled || (failing.length === 0 && missing.length > 0)) {
      next = { ...next, quietSince: null };
    } else {
      const verdict = (): WaitForCiDecision => {
        const decided = { ...next, ...(fallback ? { requiredFallback: true } : {}) };
        if (failing.length > 0) {
          return { kind: "fail", failing, state: { ...decided, outcome: "fail", quietSince: null } };
        }
        if (waitForCiTruncated(decided)) {
          const blocked = {
            code: "ci_checks_truncated" as const,
            detail: `${waitForCiTruncationText(decided.checksTotal)}.`,
          };
          return { kind: "block", ...blocked, state: { ...decided, outcome: "blocked", blocked } };
        }
        return { kind: "pass", state: { ...decided, outcome: "pass" } };
      };
      // A counted failure is decided at once, unless nothing is marked required: then the
      // quiet period runs first, in case GitHub marks the required checks late.
      if (failing.length > 0 && !fallback) return verdict();
      // Every expected check reported and settled: nothing more to wait for. A pass only: a
      // fallback failure still waits out the quiet period above, whatever was expected.
      // Not on a truncated head, where an expected name not read is unknown rather than absent.
      if (failing.length === 0 && !truncated && settings.expectedChecks.length > 0 && missing.length === 0) {
        return verdict();
      }
      if (quietMs === 0) return verdict();
      const since = next.quietSince ?? null;
      if (since !== null && sameChecks(previous, settling)) {
        if (observation.observedAt - since >= quietMs) return verdict();
        if (timedOut(next, now) && now - since >= quietMs + WAIT_FOR_CI_QUIET_GRACE_MS) {
          return timeoutBlock(next, "No new CI observation arrived to finish the quiet period "
            + `within ${WAIT_FOR_CI_QUIET_GRACE_MS / 60_000} minutes of its end.`);
        }
        return { kind: "wait", state: next };
      }
      if (timedOut(next, now)) {
        return timeoutBlock(next, `CI had not stayed settled for the ${settings.quietMinutes}-minute quiet `
          + `period after ${next.timeoutMinutes} minutes.`);
      }
      return { kind: "wait", state: { ...next, quietSince: observation.observedAt } };
    }
  }
  if (timedOut(next, now)) {
    if (next.checkRuns.length === 0) {
      const blocked = {
        code: "ci_missing" as const,
        detail: `No CI check appeared on the head commit within ${next.timeoutMinutes} minutes.`,
      };
      return { kind: "block", ...blocked, state: { ...next, outcome: "blocked", blocked } };
    }
    const pending = settlingChecks(next.checkRuns, settings, next.checksTotal).settling
      .filter((run) => run.state === "pending")
      .map((run) => run.name);
    if (pending.length > 0) {
      return timeoutBlock(next, `Still running after ${next.timeoutMinutes} minutes: ${quotedNames(pending)}.`);
    }
    const missing = missingExpectedChecks(next.checkRuns, settings, next.checksTotal);
    if (missing.length > 0) {
      const blocked = {
        code: "ci_expected_missing" as const,
        detail: `Never reported within ${next.timeoutMinutes} minutes: ${quotedNames(missing)}.`,
      };
      return {
        kind: "block",
        ...blocked,
        state: { ...next, missingExpected: missing, outcome: "blocked", blocked },
      };
    }
    return timeoutBlock(next, `CI had not stayed settled for the ${settings.quietMinutes}-minute quiet period `
      + `after ${next.timeoutMinutes} minutes.`);
  }
  return { kind: "wait", state: next };
}

function timeoutBlock(state: WaitForCiState, detail: string): WaitForCiDecision {
  const blocked = { code: "ci_timeout" as const, detail };
  return { kind: "block", ...blocked, state: { ...state, outcome: "blocked", blocked } };
}

function timedOut(state: WaitForCiState, now: number): boolean {
  return now - state.waitingSince >= state.timeoutMinutes * 60_000;
}
