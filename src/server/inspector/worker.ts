import { codeRabbitEnabled } from "../shipping/config.ts";
import { observeCodeRabbit } from "./code-rabbit.ts";
import { recordCodeRabbit, failCodeRabbit } from "../db.ts";
import { recordAutomationTransition } from "../telemetry/experience.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { envVar } from "../config.ts";
import {
  adoptInspectorPr,
  getInspectorPr,
  inTransaction,
  loadInspectorComments,
  loadOpenInspectorPrs,
  revokeInspectorPrStack,
  updateInspectorPr,
  recordInspectorCiObservation,
  upsertInspectorComment,
} from "../db.ts";
import { createLimiter, parseModelJson, runStructured } from "../llm/structured.ts";
import { llmRunner } from "../llm/index.ts";
import { providerJsonSchema } from "../llm/json-schema.ts";
import type { LlmSpendRole } from "@shared/llm-spend.ts";
import type { WorkflowGateStanding } from "@shared/shipping.ts";
import { readStandards } from "../standards.ts";
import { unref } from "../util/timers.ts";
import {
  INSPECTOR_LIMITS,
  inspectorPosture,
  reviewNeedsLiveRerun,
} from "@shared/inspector.ts";
import type { PrOpened, Registry } from "../registry.ts";
import type {
  InspectorComment,
  InspectorFailKind,
  InspectorPr,
  InspectorSource,
} from "@shared/types.ts";
import type { PipelineRun } from "@shared/pipeline.ts";
import type { InspectorConfig } from "@shared/protocol.ts";
import { getInspectorConfig, inspectorModel, inspectorRunner } from "./config.ts";
import { readBrief } from "./brief.ts";
import { changedPaths, commentableLines } from "./diff-lines.ts";
import { buildReplyPrompt, buildReviewPrompt, promptedOpenRows } from "./prompt.ts";
import {
  CLEAN_REVIEW_FINGERPRINT,
  formatMarker,
  isOurs,
  parseMarker,
  reviewHeader,
} from "./marker.ts";
import { scrubSecrets } from "./scrub.ts";
import { maybeMerge } from "../shipping/merge.ts";
import { reviewBaseChanged } from "@shared/shipping.ts";
import { activeStackGitHub, useStackGitHub, type StackGitHub } from "../stacking/github.ts";
import { adoptStackLineage, correctStackBase, refreshStackRelease, reviewedStackBase } from "../stacking/lineage.ts";
import { observeClosedStackChildren, observeStackLifecycle, type StackLifecycleContext } from "../stacking/state.ts";
import { InspectorReplySchema, InspectorVerdictSchema, planReview } from "./verdict.ts";
import type { InspectorReply, InspectorVerdict, OurThread } from "./verdict.ts";
import {
  authenticatedLogin,
  classifyReviewRefusal,
  cleanReviewExists,
  configuredGitHubRepositories,
  hasBodyOnlyFindings,
  fetchDiff,
  fetchHeadSha,
  fetchPr,
  fetchReviewPage,
  fetchThreadPage,
  findingUrls,
  ourThreads,
  ownedThreadsResolved,
  parsePrUrl,
  postReview,
  refusalReason,
  renderCleanReview,
  renderComment,
  replyToComment,
  resolveThread,
  snapshotLinkSources,
  wasRefused,
} from "./github.ts";
import type {
  GhResult,
  GitHubRepositoryIdentity,
  LinkSources,
  PrSnapshot,
  ThreadSnapshot,
} from "./github.ts";

const INSPECTOR_VERDICT_JSON_SCHEMA = providerJsonSchema(InspectorVerdictSchema);
const INSPECTOR_REPLY_JSON_SCHEMA = providerJsonSchema(InspectorReplySchema);

// The Inspector's tick: review the pull requests we opened, answer follow-ups in our own
// threads, and close our own threads once a push has fixed what they were about.
//
// It is also where YOLO mode lands the ones that came out clean - see
// `../shipping/merge.ts` for why that rides this loop rather than owning one.
//
// A poller in the DAEMON rather than a worker beside the Foreman, for two reasons that
// are worth restating where someone might move it: the Foreman worker is never started
// by the Electron app (so a packaged build would silently not have this feature), and
// every piece of state here has to survive a restart, which would mean inventing a
// route per table for a process that is the only client of any of them.

/** How often to look at the adopted PRs. Slow: a review is expensive and a push is not frequent. */
const POLL_MS = Number(envVar("INSPECTOR_POLL_MS") ?? 90_000);

function notifyInspection(
  registry: Registry,
  prKey: string,
  observedHeadSha: string | null,
  observedState: PrSnapshot["state"] | null,
  observedAt = Date.now(),
): void {
  // Production Registry always owns this signal. The guard keeps focused worker test
  // doubles from having to implement a callback unrelated to the behavior they exercise.
  (registry as Partial<Registry>).inspectionUpdated?.(
    prKey,
    observedHeadSha,
    observedState,
    observedAt,
  );
}
/**
 * Sized for a whole-diff review WITH tool round-trips inside it, from measurement.
 *
 * It was 180s, which is BELOW the floor of the job it was wrapping, and that is a
 * uniquely bad way for this to fail: the run is killed at the wire, `noteFailure` books
 * a `persistent` failure, the head never advances, and the PR climbs the backoff ladder
 * toward the six-hour ceiling - having produced nothing while paying full price for a
 * review that was nearly finished. Every open PR on this repo was in that state, and the
 * ledger said only "claude -p timed out".
 *
 * Measured on one 10.7KB, five-file diff (44.6KB prompt): 225s / 13 turns on Opus, 272s
 * / 23 turns on Sonnet. So the floor is ~4-5 MINUTES for a small PR on a repo with a
 * standards bundle, and a bigger diff is worse. 600s leaves real headroom above that
 * while still bounding a run that has genuinely hung.
 *
 * The reason a generous ceiling is affordable: nothing waits on this. One PR is reviewed
 * at a time (`createLimiter(1)`), the sweep is 90s, and a slow round delays the next
 * poll rather than a person. A timeout here should mean "something is wrong", not
 * "review of an ordinary pull request".
 */
export const TIMEOUT_MS = Number(envVar("INSPECTOR_TIMEOUT_MS") ?? 600_000);
/**
 * A follow-up reply is a smaller job than a review - one thread to answer rather than a
 * whole diff to judge - so it keeps its own, tighter wire. Half the review's, and moved
 * with it: the 90s here came from the same guess as the 180s above, and it carries the
 * SAME shape (the diff in the prompt, the same three tools, the same repo to read), so
 * whatever made the review overrun applies to it too. Unmeasured, unlike the review, and
 * marked as such rather than dressed up.
 */
export const REPLY_TIMEOUT_MS = Number(envVar("INSPECTOR_REPLY_TIMEOUT_MS") ?? 300_000);
/**
 * Cap on the diff we put in a prompt. A 2MB refactor is not reviewable in one pass anyway.
 *
 * BYTES, and `fetchDiff` applies it as such - it read as UTF-16 code units, which let a
 * diff of CJK or box-drawing content through at ~3x this.
 *
 * `INSPECTOR_MAX_DIFF_BYTES` is the documented override and is read BARE, with the
 * `MISSION_` / `FLEET_` / `HARNESS_` spellings `envVar` resolves still winning ahead of
 * it so no existing setting stops working. The bare alias is granted HERE, on this one
 * setting, and deliberately NOT added to `envVar`'s chain: that chain also serves
 * `envVar("HOME")` and `envVar("PORT")`, so a bare tier in it would let the `HOME` every
 * shell exports relocate the state directory and a stray `PORT` move the daemon off
 * 7317. This name is specific enough to carry no such collision.
 */
export function resolveMaxDiffBytes(): number {
  return Number(
    envVar("INSPECTOR_MAX_DIFF_BYTES") ?? process.env.INSPECTOR_MAX_DIFF_BYTES ?? 400_000,
  );
}
const MAX_DIFF_BYTES = resolveMaxDiffBytes();
/**
 * Replies we will write in one thread before we stop.
 *
 * Not a cost control - a loop guard. Another bot answering our answer would otherwise
 * ping-pong on a public pull request until someone noticed.
 */
const MAX_REPLIES_PER_THREAD = 6;
/**
 * Rounds we will review one PR for. A long-lived PR is normal; a thousand rounds on one
 * is a bug somewhere, and this is what stops that bug being expensive and public.
 */
/**
 * The model both the review and the follow-up replies run on: config, then
 * `MISSION_INSPECTOR_MODEL`, then the spec's shipped default.
 *
 * One resolver, in `config.ts`, because the settings panel prints this same answer
 * through `/api/inspector/status` and the two must not be able to disagree about it. See
 * `INSPECTOR_MODEL_SPEC` for why the default is named at all rather than left to the CLI.
 */
function reviewModel(cfg: InspectorConfig): string {
  return inspectorModel(cfg).id;
}

/**
 * `role` rides alongside `timeoutMs` rather than being derived here, because the two calls
 * this builds for are different jobs with different prices - a full review carries the
 * largest prompt in the system, a follow-up reply a third of it - and folding them into one
 * `inspector` bucket would answer none of the questions worth asking about either.
 */
function inspectorRunOptions(
  cfg: InspectorConfig,
  timeoutMs: number,
  cwd: string,
  role: LlmSpendRole,
  schema?: Record<string, unknown>,
) {
  // `inspectorRunner`, not `cfg.runner ?? "claude"`: an unset provider inherits the app-wide
  // ladder, and resolving it here a second way is how the worker and the panel come to print
  // different providers for the same call.
  const runner = llmRunner(inspectorRunner(cfg).id);
  return {
    runner,
    options: {
      model: reviewModel(cfg),
      timeoutMs,
      role,
      ...(schema ? { schema } : {}),
      // Claude can enforce Inspector's exact read-tool deny list. Codex currently
      // cannot, so it reviews the supplied diff without repository tools instead of
      // silently accepting a weaker grant.
      ...(runner.sandbox
        ? { grant: { tools: REVIEW_TOOLS.split(","), cwd, denyPaths: DENY_PATHS } }
        : {}),
    },
  } as const;
}

/**
 * Backoff for a PR that keeps failing.
 *
 * `INSPECTOR_LIMITS.maxRounds` counts SUCCESSES, so on its own it can never stop a PR that fails
 * permanently - a reaped worktree, revoked `gh` access, a diff the model cannot answer
 * for inside `TIMEOUT_MS`. Such a PR was re-attempted every `POLL_MS` for its whole
 * life, and `runStructured` retries once internally, so one tick of it costs up to two
 * full `claude -p` runs. Doubling from one poll interval up to a six-hour ceiling keeps
 * a transient failure cheap to recover from and makes a permanent one nearly free.
 */
const BACKOFF_CEILING_MS = 6 * 60 * 60 * 1000;

function backoffMs(failCount: number): number {
  return Math.min(POLL_MS * 2 ** Math.max(0, failCount - 1), BACKOFF_CEILING_MS);
}

/**
 * How many `persistent` failures a PR may have before a new push STOPS cutting the wait
 * short. Read only by `pushEndsTheWait`, which is where the whole rule lives.
 *
 * The rule arrived in three corrections that pull against each other, so all three are
 * stated here rather than only the last one:
 *
 *  1. A push must be able to cut the wait short at all. The case that matters is an
 *     author whose review failed on a huge diff and who force-pushes it down to three
 *     lines: making them sit out a doubling wait for a diff that no longer exists is the
 *     wrong answer, so a push is otherwise attempted on the very next tick.
 *  2. But not on every push, forever. Some failures have nothing to do with the head -
 *     revoked `gh` write access, a diff the model reliably cannot answer for inside
 *     `TIMEOUT_MS` - and there an unlimited escape means an afternoon of iteration costs
 *     up to two `claude -p` runs per push while the ladder never bites. Three caps the
 *     wasted work at roughly three rounds per PR, after which the backoff governs pushes
 *     as well as polls.
 *  3. And the cap must not apply to a failure a push is the REMEDY for. Those are capped
 *     by `InspectorFailKind`, not by this number: an oversize diff sits at the flat
 *     six-hour ceiling and can only ever be cleared by a smaller push, so counting its
 *     parks against the escape would strand the very push that fixes it - four pushes
 *     in, the one that finally drops the vendored directory would wait six hours. That
 *     is the case (1) exists for, so throttling it inverts the whole rule; and it buys
 *     almost nothing, since a parked round costs one `gh api` call rather than two
 *     model runs.
 */
const PUSH_UNPARK_MAX_FAILURES = 3;

/**
 * May a new head skip the wait this PR has earned?
 *
 * Unlimited for the class of failure a push is the remedy for, capped for the class it
 * cannot touch - see `PUSH_UNPARK_MAX_FAILURES` for why it is split that way. Reads the
 * LAST failure because that is the one that set the wait now in force. A null kind
 * cannot escape: either nothing has failed, in which case there is no wait to escape,
 * or a row predates the column and an unnamed class falls under the cap.
 */
export function pushEndsTheWait(pr: Pick<InspectorPr, "failCount" | "lastFailKind">): boolean {
  if (pr.lastFailKind === "push-fixable") return true;
  return pr.failCount < PUSH_UNPARK_MAX_FAILURES;
}

/**
 * The tools the reviewer gets, and the reason this whole subsystem is defended in depth.
 *
 * Reading is the entire grant: no Bash, no Write/Edit, no WebFetch, no MCP. Reviewing a
 * diff without being able to open a file misses most of what matters (does this break a
 * caller? is there a test?), which is why the grant exists - but the input is a diff
 * anyone can author and the output is a public comment, so it is paid for by the deny
 * rules below, the worktree cwd, the changed-path filter in the planner, and the
 * scrubber on every outbound string.
 */
export const REVIEW_TOOLS = "Read,Grep,Glob";

/**
 * Path rules handed to Claude Code itself, so they are enforced by the harness rather
 * than by asking the model nicely.
 *
 * The list is the obvious credential stores plus this app's own state: a reviewer that
 * could read `~/.claude` could read the operator's other projects' transcripts, and a
 * reviewer that could read `.git/config` could read a token embedded in a remote URL.
 *
 * Every path is denied for all THREE tools the reviewer holds, not just `Read`. `Grep`
 * takes an absolute path and prints the matching lines, so a `Read(...)`-only list
 * protects nothing it names; `Glob` confirms the files exist. The grant is what pays
 * for the tool access, so it has to cover the whole grant.
 */
export const DENY_PATHS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.git/config",
  "**/.npmrc",
  "**/.netrc",
  "**/credentials*",
  "//Users/*/.aws/**",
  "//Users/*/.ssh/**",
  "//Users/*/.claude/**",
  "//Users/*/.mission-control/**",
];

/**
 * Exported alongside `REVIEW_TOOLS` and `DENY_PATHS` so `llm-runner-contract.test.ts` can
 * assert that the `LlmRunner` tool grant renders this EXACT string. The Inspector is the
 * only caller that holds tools, so it is the one that decides whether that interface fits;
 * pinning the equality now is what makes the item that migrates this call site a provable
 * no-op rather than a hopeful one.
 */
export const DENY_SETTINGS = JSON.stringify({
  permissions: {
    deny: DENY_PATHS.flatMap((p) => [`Read(${p})`, `Grep(${p})`, `Glob(${p})`]),
  },
});

/**
 * A directory that still exists to run things from, or null.
 *
 * The adopted `cwd` may be a transient session worktree that gets released and reused.
 * A row pinned to a released directory spawns every `gh` call and every `claude -p` into a
 * path that isn't there, and nothing ever healed it. `adoptInspectorPr` is `DO NOTHING`, so
 * re-adoption cannot rewrite it.
 *
 * `repoRoot` is the fallback because it is git's common dir: it outlives any worktree
 * of the repo. Every `gh` call here is owner/repo-explicit, so the directory only ever
 * supplies credentials and the reviewer's read scope, never the identity of the PR.
 */
/** The GitHub seam stacking reads through. Replaced only by tests. */
export function useInspectorStackGitHub(github: StackGitHub): () => void {
  return useStackGitHub(github);
}

/**
 * What the stack lifecycle reads from the Registry (tasks and work episodes). Set when the
 * Inspector starts; a test sets its own. Without one, no lifecycle observation runs.
 */
let stackLifecycle: StackLifecycleContext | null = null;
export function useInspectorStackLifecycle(context: StackLifecycleContext | null): () => void {
  const previous = stackLifecycle;
  stackLifecycle = context;
  return () => {
    stackLifecycle = previous;
  };
}

function liveDir(pr: InspectorPr): string | null {
  if (pr.cwd && existsSync(pr.cwd)) return pr.cwd;
  if (pr.repoRoot && existsSync(pr.repoRoot)) return pr.repoRoot;
  return null;
}

/**
 * What one PR's pass through the tick has already done to its row.
 *
 * The tick reads `InspectorPr` once and then writes to it from several places, so the
 * pre-tick snapshot goes stale the first time anything fails. Two things went wrong
 * without this: a second failure in the same pass re-derived `failCount` from the stale
 * snapshot and so never got past 1, and the "nothing pushed" branch cleared a failure
 * that had been recorded seconds earlier in the same pass - which made the backoff
 * oscillate between one interval and an immediate retry on the exact case it exists
 * for, a PR whose head never moves and whose replies keep failing.
 */
interface TickState {
  /** Set by `noteFailure`. Nothing may clear the failure state while this is true. */
  failed: boolean;
}

/**
 * Record a failed attempt: the reason, and when to try again.
 *
 * Never advances `headSha` - a transient failure has to be retried against the same
 * push - but it does move the row out of the way for a while, which is what stops a
 * permanently broken PR from costing two model runs every poll interval forever.
 *
 * `push-fixable` does two things at once, and they are one idea rather than two: the
 * failure is a property of the HEAD, so climbing the ladder would pay the same cost
 * repeatedly to learn the same thing (hence straight to the ceiling), and the only
 * thing that can change the answer is a new head (hence the uncapped escape in
 * `pushEndsTheWait`). Anything whose cause is outside the diff is `persistent`.
 */
function noteFailure(
  pr: InspectorPr,
  reason: string,
  now: number,
  tick: TickState,
  kind: InspectorFailKind = "persistent",
): false {
  recordAutomationTransition(`${pr.key}:${now}`, { feature: "inspector", action: "review", outcome: "failed", coverage: "owner_transition" },
    { kind: "system", origin: "daemon", basis: "owner" }, now);
  tick.failed = true;
  // Re-read rather than trusting the snapshot: an earlier failure in this same pass has
  // already written a higher count, and incrementing the stale one would discard it.
  const failCount = (getInspectorPr(pr.key)?.failCount ?? pr.failCount) + 1;
  const wait = kind === "push-fixable" ? BACKOFF_CEILING_MS : backoffMs(failCount);
  updateInspectorPr(
    pr.key,
    { lastError: reason, failCount, lastFailKind: kind, nextAttemptAt: now + wait },
    now,
  );
  return false;
}

/**
 * Adopt a pull request a session just opened, and - in the SAME synchronous turn - record its
 * stack lineage when that session runs a stacked task. Nothing can inspect the row between
 * the two writes, so the merge gate never sees a stacked child without its lineage.
 */
export function adoptOpenedPr(
  registry: Pick<Registry, "taskForSession" | "workEpisodeForSession">,
  e: Pick<PrOpened, "url" | "sessionId" | "cwd" | "repoRoot"> & Partial<Pick<PrOpened, "noteKey">>,
  now: number,
): boolean {
  const source = {
    task: registry.taskForSession(e.sessionId, e.cwd),
    episodeId: registry.workEpisodeForSession(e.sessionId)?.episodeId ?? null,
  };
  // One transaction: a lineage write that fails takes the adoption with it. The pull request
  // is then simply not ours to review or merge, which fails closed, rather than adopted as an
  // ordinary pull request that the stacking gates would never evaluate.
  try {
    return inTransaction(() => {
      const adopted = adoptPr(
        e.url,
        { sessionId: e.sessionId, noteKey: e.noteKey, cwd: e.cwd, repoRoot: e.repoRoot },
        "hook",
        now,
      );
      const parsed = adopted ? parsePrUrl(e.url) : null;
      if (parsed) adoptStackLineage(parsed.key, source, now);
      return adopted;
    });
  } catch (error) {
    console.error("[inspector] could not adopt the pull request:", e.url, error);
    return false;
  }
}

/**
 * Record a PR as ours to review. Idempotent - the DB's `DO NOTHING` is the dedup, so
 * both adoption signals can call this freely.
 */
export function adoptPr(
  url: string,
  ctx: { sessionId: string | null; noteKey?: string | null; cwd: string | null; repoRoot: string | null },
  source: InspectorSource,
  now: number,
): boolean {
  const parsed = parsePrUrl(url);
  if (!parsed) return false;
  return adoptInspectorPr({
    key: parsed.key,
    url,
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
    repoRoot: ctx.repoRoot,
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    noteKey: ctx.noteKey ?? null,
    source,
    state: "open",
    headSha: null,
    reviewPosture: null,
    round: 0,
    lastReviewedAt: null,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    // Nothing has been polled yet, and adoption is not an observation. The first tick fills
    // all five; until then every reader treats them as "unknown" rather than "unchanged".
    //
    // `title` in particular is not knowable here even though a title certainly exists: the
    // signal that reaches this function is a hook that matched `gh pr create` and the URL it
    // printed, and finding out what the author called it is a network round trip - which is
    // exactly what the adoption path is kept free of. The tick already fetches it.
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: null,
    title: null,
    adoptedAt: now,
    updatedAt: now,
  });
}

/**
 * Adopt the pull request a projected engine run first reports, if its repository proves it.
 *
 * A provider-owned state file is evidence that the pipeline OPENED a PR, but it is not
 * authority to name an unrelated repository. The checkout's configured remotes supply that
 * second half. No remote, an unreadable config, and a different owner/repository all abstain
 * before the durable adoption row grants Inspector permission to write publicly.
 */
export async function adoptPipelinePr(
  run: PipelineRun,
  now = Date.now(),
  resolveRepositories: (
    repoRoot: string,
  ) => Promise<readonly GitHubRepositoryIdentity[]> = configuredGitHubRepositories,
): Promise<boolean> {
  if (!run.prUrl) return false;
  const parsed = parsePrUrl(run.prUrl);
  if (!parsed) return false;
  const repositories = await resolveRepositories(run.repoRoot);
  if (
    !repositories.some(
      (repository) =>
        repository.owner.toLowerCase() === parsed.owner.toLowerCase()
        && repository.repo.toLowerCase() === parsed.repo.toLowerCase(),
    )
  ) {
    return false;
  }
  return adoptPr(
    run.prUrl,
    { sessionId: null, cwd: run.worktree, repoRoot: run.repoRoot },
    "pipeline",
    now,
  );
}

/** Our open findings on a PR, keyed by fingerprint. */
function existingByFingerprint(prKey: string): Map<string, InspectorComment> {
  const out = new Map<string, InspectorComment>();
  for (const c of loadInspectorComments(prKey)) out.set(c.fingerprint, c);
  return out;
}

/**
 * Threads of ours where somebody else has spoken last.
 *
 * "Ours" and "somebody else" both go through the two-part `isOurs` rule - our login AND
 * our marker at column 0. The marker alone would let anyone who can comment on the pull
 * request open a forged thread we then treat as our own, or post a forged reply we read
 * as "we spoke last" and so never answer.
 *
 * Takes a known login, never a nullable one. Fail-closed is enforced once, in
 * `processPr`, which abstains from the whole PR before reaching here - see the login
 * check there. A second nullable guard on this path would only invite a reader to
 * believe abstention is decided per-helper, which is how one of them ends up acting on
 * local state while the others sit out.
 */
function threadsAwaitingUs(
  snapshot: PrSnapshot,
  rows: Map<string, InspectorComment>,
  login: string,
): { thread: ThreadSnapshot; row: InspectorComment; newest: { databaseId: number | null; body: string; author: string } }[] {
  const out: {
    thread: ThreadSnapshot;
    row: InspectorComment;
    newest: { databaseId: number | null; body: string; author: string };
  }[] = [];
  for (const t of snapshot.threads) {
    const first = t.comments[0];
    if (!first) continue;
    if (!isOurs(first, login)) continue; // not our thread
    const marker = parseMarker(first.body)!;
    const row = rows.get(marker.fingerprint);
    if (!row) continue;
    // Authors often reply and resolve together. Their resolution is not Inspector's
    // verdict: still evaluate the new reply while our finding remains open. Once both
    // sides are resolved, leave the closed conversation alone.
    if (t.isResolved && row.status === "resolved") continue;
    if (row.replies >= MAX_REPLIES_PER_THREAD) continue;

    const newest = t.comments[t.comments.length - 1]!;
    if (isOurs(newest, login)) continue; // we spoke last - nobody is waiting
    if (newest.databaseId !== null && row.answeredCommentId === newest.databaseId) continue;
    out.push({ thread: t, row, newest });
  }
  return out;
}

/**
 * The tick's diff, fetched AT MOST once.
 *
 * Two steps of `processPr` want the same bytes: the reply pass and `reviewRound` both
 * reason about the head sha read once at the top of the tick, so a second `gh api`
 * subprocess - each buffering up to 16MB of pipe - can only re-buy the same answer, and
 * it costs the most on exactly the large-diff PRs closest to that ceiling. Lazy rather
 * than hoisted, because the common steady-state tick (nothing waiting, nothing pushed)
 * returns before either consumer runs and must keep fetching ZERO diffs.
 *
 * The memo shares the raw result, FAILURES INCLUDED. The two consumers disagree about
 * what a failed fetch means and each is right: a reply is answering a person, so it
 * degrades to an empty diff rather than leaving them unanswered, while a review with no
 * diff has nothing to judge, so it books the failure - `tooLarge` into the push-fixable
 * park, everything else onto the ordinary ladder. Only the fetch is shared; the
 * interpretation stays at each call site.
 */
type TickDiff = () => Promise<GhResult<{ diff: string; truncated: boolean }>>;

function diffOncePerTick(dir: string, pr: InspectorPr): TickDiff {
  let fetched: ReturnType<TickDiff> | null = null;
  return () => (fetched ??= fetchDiff(dir, pr.owner, pr.repo, pr.number, MAX_DIFF_BYTES));
}

/** Run one PR through the whole cycle. Returns true when it did something. */
async function processPr(
  cfg: InspectorConfig,
  pr: InspectorPr,
  now: number,
  onObserved: ((snapshot: PrSnapshot, observedAt: number) => void) | null = null,
  workflowGate: (prKey: string) => WorkflowGateStanding = () => "none",
): Promise<boolean> {
  const tick: TickState = { failed: false };
  const backedOff = pr.nextAttemptAt !== null && now < pr.nextAttemptAt;

  const dir = liveDir(pr);
  if (!dir) {
    if (codeRabbitEnabled()) failCodeRabbit(pr.key, "The owning checkout is unavailable", now);
    if (!cfg.enabled) return false;
    if (backedOff) return false;
    return noteFailure(pr, "the checkout this PR was opened from is gone", now, tick);
  }

  // Read the PR even while backed off. The backoff is there to stop paying for repeated
  // `claude -p` runs, not to stop LOOKING: one `fetchPr` costs a fraction of a review,
  // and it is the only way a parked PR can notice that its input changed. A failure of
  // this probe does not extend the wait, or the cheap check would inflate a penalty it
  // was not the cause of.
  const snap = await fetchPr(dir, pr.owner, pr.repo, pr.number, codeRabbitEnabled());
  if (!snap.ok || !snap.value) {
    if (codeRabbitEnabled()) failCodeRabbit(pr.key, snap.error ?? "Could not read PR", now);
    if (!cfg.enabled) return false;
    if (backedOff) return false;
    return noteFailure(pr, snap.error ?? "could not read the pull request", now, tick);
  }
  const s = snap.value;
  if (codeRabbitEnabled()) {
    const observation = await observeCodeRabbit({ cwd: dir, owner: pr.owner, repo: pr.repo, number: pr.number, snapshot: s, startedAt: now });
    if (observation.ok && observation.value) recordCodeRabbit(pr.key, {
      headSha: s.headSha, state: s.state, draft: s.isDraft, findings: observation.value,
    }, Date.now());
    else failCodeRabbit(pr.key, observation.error ?? "Incomplete CodeRabbit observation", Date.now());
  }
  // Write the sighting down BEFORE anything decides what to do about it.
  //
  // `onObserved` is a wakeup - transient, and only for whoever happens to be subscribed when
  // this tick runs. The ledger is what survives a restart, and it is what a `pull_request`
  // session action reads to prove its commit reached the pull request. Recording it here,
  // beside the fetch that produced it, means every path below - retire the row, take the
  // backoff, run a review, sit the tick out - has already told the truth about what GitHub
  // said, rather than only the paths that happen to run to completion.
  updateInspectorPr(
    pr.key,
    {
      observedHeadSha: s.headSha || null,
      observedState: s.state,
      observedAt: now,
      headRefName: s.headRefName || null,
      baseRefName: s.baseRefName || null,
      mergeCommitSha: s.mergeCommitSha ?? null,
      // Re-recorded on every tick rather than written once, because a pull request gets
      // renamed - most often from the placeholder its author opened it with. The empty
      // string `normalizePr` yields for a missing title collapses to null so the ledger
      // has one reading of "we do not know what this is called", and the renderers'
      // branch fallback covers it either way.
      title: s.title || null,
    },
    now,
  );
  // CI on the head commit, from the same query and the same instant. Keyed to the commit it
  // was read for, so a Wait for CI node never mistakes one head's checks for another's.
  if (s.ci) recordInspectorCiObservation(pr.key, { ...s.ci, observedAt: now });
  onObserved?.(s, now);

  // Stacked pull requests: observe the child and its current parent, reconcile the child's
  // base with the branch it belongs on, and run the replacement-parent transition the operator
  // asked for - before the row is retired, so a child GitHub closed is recorded as a broken
  // stack, and whatever the Inspector's own switches say, because a stacked child keeps its
  // lifecycle with the Inspector, the Shipping setting and its session all gone. Re-read
  // afterwards: a transition changes the current parent and withdraws the release.
  if (pr.stack && stackLifecycle) {
    try {
      await observeStackLifecycle(pr, s, dir, activeStackGitHub(), stackLifecycle, now);
    } catch (error) {
      console.error("[inspector] stack lifecycle observation failed:", pr.key, error);
    }
    pr = getInspectorPr(pr.key) ?? pr;
  }

  // Merged and closed-unmerged are both "done". Retiring the row rather than deleting it
  // keeps the audit trail of what was said on a PR that has since landed.
  if (s.state !== "OPEN") {
    updateInspectorPr(
      pr.key,
      {
        state: "closed",
        lastError: null,
        failCount: 0,
        lastFailKind: null,
        nextAttemptAt: null,
      },
      now,
    );
    return true;
  }

  // Observation consent never grants Inspector review, posting, or merge authority.
  // Both the config this sweep started with AND the one true now: a sweep that started with
  // the Inspector off ran only to observe stacked rows, and its snapshot predates whatever the
  // operator did since, so it must not go on to review or merge if the Inspector is switched
  // on mid-sweep. The next sweep reads afresh.
  if (!cfg.enabled || !getInspectorConfig().enabled) return true;

  // A push is new evidence, and `pushEndsTheWait` decides whether it is the kind of
  // evidence that ends the wait its predecessor earned - always, for the six-hour park
  // a diff too large to buffer buys, since a smaller push is the only way out of it.
  // Compared against the last head we ATTEMPTED rather than the last one we reviewed: a
  // failed round never advances `headSha`, so comparing with that would read every tick
  // as a fresh push and the backoff would never hold at all.
  //
  // `failCount` is never cleared here either way - it is what the ladder is climbing,
  // and a push is not an attempt completing. Only a round that actually completes
  // resets it.
  //
  // A NULL `lastAttemptSha` is "we cannot name what we last tried", not "the head
  // changed" - `liveDir` and `fetchPr` both fail before it is ever written, so a PR
  // whose worktree was reaped climbs to a long wait with it still null, and crediting
  // that as a push would drop the whole penalty the moment the directory reappears. We
  // record the head so the next tick can compare, and leave the wait in force.
  const pushed = pr.lastAttemptSha !== null && !!s.headSha && s.headSha !== pr.lastAttemptSha;
  const unpark = pushed && pushEndsTheWait(pr);
  if (s.headSha && s.headSha !== pr.lastAttemptSha) {
    const patch: { lastAttemptSha: string; nextAttemptAt?: number | null } = {
      lastAttemptSha: s.headSha,
    };
    if (unpark) patch.nextAttemptAt = null;
    updateInspectorPr(pr.key, patch, now);
  }
  if (!unpark && backedOff) return false;

  // Who we are, for every ownership decision below.
  //
  // FAIL CLOSED means ABSTAIN, not "fall back to local state". Without the login we
  // cannot tell our own threads from anyone else's, so we are not entitled to conclude
  // anything about them - including the negative "that finding has no thread, so close
  // its row", which would leave the ledger saying resolved while the real thread stayed
  // open on GitHub. So the whole PR sits this tick out, and it counts as a failure so
  // the backoff applies rather than us re-asking every poll.
  const login = await authenticatedLogin(dir, now);
  if (!login) {
    return noteFailure(pr, "could not confirm which GitHub account gh speaks for", now, tick);
  }

  const rows = existingByFingerprint(pr.key);
  recordFindingUrls(rows, snapshotLinkSources(s), login);
  const posture = inspectorPosture(cfg, pr.cwd, pr.repoRoot);
  const post = posture === "live";
  const readDiff = diffOncePerTick(dir, pr);
  let acted = false;
  const resolvedThreadIds = new Set<string>();
  // A review or reply may have succeeded before resolving its thread failed. Its durable marker
  // authorizes retrying that mutation, without treating an operator's ledger override
  // as permission to close GitHub threads.
  for (const [fingerprint, thread] of ourThreads(s, login)) {
    if (!post) break;
    if (!rows.get(fingerprint)?.resolutionPending) continue;
    const resolved = thread.isResolved ? { ok: true } : await resolveThread(dir, thread.threadId);
    if (!resolved.ok) return noteFailure(pr, "could not resolve the answered thread", now, tick);
    resolvedThreadIds.add(thread.threadId);
    closeRow(rows, fingerprint, now);
    acted = true;
  }

  // 1. Answer anyone waiting on us. Before the re-review, because a question asked three
  //    pushes ago should not queue behind a fresh review of a big diff.
  //    Only when we could actually send the answer: a reply has no `drafted` state, so
  //    running one we cannot post spends a model call to produce nothing.
  const waiting = post ? threadsAwaitingUs(s, rows, login) : [];
  if (waiting.length) {
    const diff = await readDiff();
    for (const w of waiting) {
      const replied = await answerFollowUp(
        cfg,
        pr,
        dir,
        w,
        rows,
        diff.value?.diff ?? "",
        diff.value?.truncated ?? false,
        post,
        login,
        now,
        tick,
        resolvedThreadIds,
      );
      if (replied) acted = true;
    }
  }

  if (tick.failed) return acted;

  // 2. Ship it, if YOLO mode says every gate is green.
  //
  // Before the re-review and before the nothing-pushed return, because neither of those
  // is where the answer changes: a PR that merges is one whose head was ALREADY reviewed
  // clean, and what moves it over the line is CI going green or the soak elapsing - both
  // of which happen while nothing here is pushing anything. Gated behind the head match
  // inside `mergeVerdict`, so a PR with an unreviewed push waits for the review below and
  // the next sweep. `rows` is passed rather than re-read: it is this tick's ledger, and
  // the reply step above may already have moved it.
  // Stacked pull requests: run the release check for a row with lineage BEFORE the merge
  // gate reads it, so a restack verified on this tick can merge on this tick. Read only from
  // GitHub (the compare API), never by running git here.
  // A release already recorded for this head is checked again too: a parent closed without
  // merging can be reopened, and then the child is stacked on an open prerequisite again.
  let gated = pr;
  if (pr.stack) {
    try {
      await refreshStackRelease(pr, s, dir, activeStackGitHub(), now);
    } catch (error) {
      // A release that could not be checked is not trusted.
      revokeInspectorPrStack(pr.key, now);
      console.error("[inspector] stack release check failed:", pr.key, error);
    }
    // Re-read either way: the check may have recorded a release or withdrawn one.
    gated = getInspectorPr(pr.key) ?? pr;
  }
  // Stacked pull requests: the same head on the same base NAME can still be a different diff,
  // when the parent was rebased underneath it. Judged by GitHub's merge base before the
  // merge gate and the review reuse below may trust the recorded review.
  let baseReview: "current" | "changed" | "unknown" = "current";
  try {
    baseReview = await reviewedStackBase(gated, s, dir, activeStackGitHub(), now);
  } catch (error) {
    baseReview = "unknown";
    console.error("[inspector] stacked review base check failed:", pr.key, error);
  }
  if (baseReview === "unknown") {
    // Neither merge on a review that may describe another diff nor spend a review on a
    // question GitHub did not answer: try again on a later tick.
    return noteFailure(pr, "could not confirm the reviewed diff's merge base with GitHub", now, tick) || acted;
  }
  // Incomplete provenance must recover before it can authorize Shipping too.
  if (
    baseReview === "current" &&
    gated.reviewComplete !== false &&
    await maybeMerge(cfg, gated, dir, s, rows, now, workflowGate)
  ) return true;

  // 3. Nothing pushed: reuse the completed review and finish any pending publication.
  //
  // A dry-run review is current as an analysis result, but not as merge provenance.
  // Once the operator switches to live, deliberately fall through and review this same
  // head again so a live result replaces it. In every non-live posture, keep the cheap
  // no-op behavior: repeatedly reviewing a head we still cannot publish buys nothing.
  //
  // Reaching the no-op branch having failed nothing means the PR is healthy again, so a
  // stale error from an earlier tick is cleared. `tick.failed` rather than the pre-tick
  // snapshot, because a reply that failed moments ago is this tick's news and clearing
  // it would hand the backoff back its own reset button.
  if (
    s.headSha &&
    s.headSha === pr.headSha &&
    // The same head against a different base is a different diff: a stacked pull request
    // retargeted without a restack must be reviewed again, never reuse the old verdict.
    !reviewBaseChanged(pr.reviewedBaseRef ?? null, s.baseRefName || null, s.defaultBranch || null) &&
    // ...and the same base name over a moved merge base is a different diff too.
    baseReview === "current" &&
    !reviewNeedsLiveRerun(posture, pr.reviewPosture)
    // A legacy or incomplete review cannot certify safety. Once its retained findings
    // are resolved, review again on this head; only complete provenance can be reused.
    && (!post || pr.reviewComplete === true || [...rows.values()].some((row) => row.status !== "resolved"))
  ) {
    const published = await publishCleanReview(pr, dir, s, rows, post, login, now, tick, resolvedThreadIds);
    if (!tick.failed) {
      const current = getInspectorPr(pr.key);
      if (current && (current.lastError || current.failCount > 0)) {
        updateInspectorPr(
          pr.key,
          { lastError: null, failCount: 0, lastFailKind: null, nextAttemptAt: null },
          now,
        );
      }
    }
    return acted || published;
  }

  if (pr.round >= INSPECTOR_LIMITS.maxRounds) {
    return noteFailure(pr, `stopped after ${INSPECTOR_LIMITS.maxRounds} rounds`, now, tick);
  }
  const reviewed = await reviewRound(cfg, pr, dir, s, rows, post, login, now, tick, readDiff, resolvedThreadIds);
  return acted || reviewed;
}

async function answerFollowUp(
  cfg: InspectorConfig,
  pr: InspectorPr,
  dir: string,
  w: ReturnType<typeof threadsAwaitingUs>[number],
  /** This tick's ledger. Mutated in place when the reply drops its own finding. */
  rows: Map<string, InspectorComment>,
  diff: string,
  diffTruncated: boolean,
  post: boolean,
  login: string,
  now: number,
  tick: TickState,
  resolvedThreadIds: Set<string>,
): Promise<boolean> {
  // A reply we cannot actually send must not be drafted, spent or stamped. Comments
  // have `drafted` for exactly this and replies have no equivalent: burning a
  // `REPLY_TIMEOUT_MS` model run and then marking the question answered means switching
  // back to live never answers it, and six such rounds retire the thread outright.
  if (!post || w.newest.databaseId === null) return false;

  const brief = readBrief(pr.repoRoot);
  const first = w.thread.comments[0]!;
  const prompt = buildReplyPrompt({
    brief,
    original: { path: w.row.path, title: w.row.title, body: first.body },
    thread: w.thread.comments.map((c) => ({
      author: c.author,
      ours: isOurs(c, login),
      body: c.body,
    })),
    diff,
    diffTruncated,
  });

  const run = inspectorRunOptions(
    cfg,
    REPLY_TIMEOUT_MS,
    dir,
    "inspector:reply",
    INSPECTOR_REPLY_JSON_SCHEMA,
  );
  const result = await runStructured<typeof InspectorReplySchema>(
    (p) => run.runner.run(p, run.options),
    prompt,
    (raw) => parseModelJson(raw, InspectorReplySchema),
    "The inspector",
  );
  if (result.kind !== "ok") return noteFailure(pr, `reply failed: ${result.reason}`, now, tick);
  const answer = result.value as InspectorReply;

  const reply = scrubSecrets(answer.reply.trim());
  if (!reply) return false;

  // Same marker fingerprint as the thread it belongs to, so a reply of ours is
  // recognisable as ours on the next read - which is what stops us answering our own
  // answer forever.
  const body = [
    formatMarker({ id: randomUUID(), fingerprint: w.row.fingerprint, round: pr.round }),
    "**⌕ GitHub Inspector**",
    "",
    reply,
  ].join("\n");

  const res = await replyToComment(dir, pr.owner, pr.repo, pr.number, w.newest.databaseId, body);
  if (!res.ok) return noteFailure(pr, res.error ?? "reply failed", now, tick);

  // Stamp AFTER the send, never before: a failed post that had already recorded the
  // answer would leave someone's question permanently unanswered and invisible.
  const answered: InspectorComment = {
    ...w.row,
    replies: w.row.replies + 1,
    answeredCommentId: w.newest.databaseId,
    resolutionPending: answer.resolved,
    updatedAt: now,
  };
  rows.set(w.row.fingerprint, answered);
  upsertInspectorComment(answered);

  // The Inspector dropped its own finding. Close the thread and the ledger row, in that
  // order, so the reply explaining the drop is already on the pull request when the thread
  // it belongs to closes - the reverse reads as a thread closed without an answer.
  //
  // AFTER the reply is stamped, so a failure here cannot cost a duplicate public comment.
  if (answer.resolved) {
    const resolved = w.thread.isResolved ? { ok: true } : await resolveThread(dir, w.thread.id);
    if (resolved.ok) {
      closeRow(rows, w.row.fingerprint, now);
      resolvedThreadIds.add(w.thread.id);
    } else {
      noteFailure(pr, resolved.error ?? "could not resolve the answered thread", now, tick);
    }
  }
  return true;
}

/** Retry the public conclusion independently of the expensive model review. */
async function publishCleanReview(
  pr: InspectorPr,
  dir: string,
  snapshot: PrSnapshot,
  rows: Map<string, InspectorComment>,
  post: boolean,
  login: string,
  now: number,
  tick: TickState,
  resolvedThreadIds: Set<string>,
): Promise<boolean> {
  if (!post || tick.failed || pr.headSha !== snapshot.headSha || pr.reviewPosture !== "live"
    || pr.reviewComplete !== true || [...rows.values()].some((row) => row.status !== "resolved")) return false;
  if (pr.cleanReviewHeadSha === snapshot.headSha) return false;
  const consent = getInspectorConfig();
  if (!consent.enabled || inspectorPosture(consent, pr.cwd, pr.repoRoot) !== "live") return false;

  const fresh = await fetchPr(dir, pr.owner, pr.repo, pr.number);
  if (!fresh.ok || !fresh.value) return noteFailure(pr, fresh.error ?? "could not confirm current PR head", now, tick);
  if (fresh.value.state !== "OPEN" || fresh.value.headSha !== snapshot.headSha) return false;
  const input = { cwd: dir, owner: pr.owner, repo: pr.repo, number: pr.number, snapshot: fresh.value, login,
    headSha: snapshot.headSha, resolvedThreadIds };
  const pages = linkCapturingLoaders(dir, pr, fresh.value, rows, login);
  const threads = await ownedThreadsResolved(input, pages.threads);
  if (!threads.ok) return noteFailure(pr, threads.error ?? "could not inspect review threads", now, tick);
  if (!threads.value) return false;
  const bodyOnly = await hasBodyOnlyFindings(input, pages.reviews);
  if (!bodyOnly.ok) return noteFailure(pr, bodyOnly.error ?? "could not inspect body-only findings", now, tick);
  if (bodyOnly.value) return false;
  const existing = await cleanReviewExists(input, pages.reviews);
  if (!existing.ok) return noteFailure(pr, existing.error ?? "could not inspect clean reviews", now, tick);
  if (!existing.value) {
    const body = renderCleanReview(formatMarker({ id: randomUUID(), fingerprint: CLEAN_REVIEW_FINGERPRINT, round: pr.round }), pr.round);
    const sent = await postReview(dir, pr.owner, pr.repo, pr.number, body, [], snapshot.headSha);
    if (!sent.ok) return noteFailure(pr, sent.error ?? "could not post the clean review", now, tick);
  }
  updateInspectorPr(pr.key, { cleanReviewHeadSha: snapshot.headSha, lastError: null,
    failCount: 0, nextAttemptAt: null, lastFailKind: null }, now);
  return true;
}

async function reviewRound(
  cfg: InspectorConfig,
  pr: InspectorPr,
  dir: string,
  s: PrSnapshot,
  rows: Map<string, InspectorComment>,
  post: boolean,
  login: string,
  now: number,
  tick: TickState,
  readDiff: TickDiff,
  resolvedThreadIds: Set<string>,
): Promise<boolean> {
  const threads = ourThreads(s, login);
  reconcilePosting(rows, threads, now);

  const diffRes = await readDiff();
  if (!diffRes.ok || !diffRes.value) {
    // A diff too large to buffer is not a transient failure - the same request returns
    // the same bytes forever - so it goes straight to the backoff ceiling instead of
    // paying to rediscover that every poll, and a later smaller push cuts that wait
    // short however many times it has already been parked. Any other read failure is
    // about the network or `gh`, not about this head, so it climbs the ladder normally.
    return noteFailure(
      pr,
      diffRes.error ?? "could not read the diff",
      now,
      tick,
      diffRes.tooLarge ? "push-fixable" : "persistent",
    );
  }
  const { diff, truncated } = diffRes.value;
  const paths = changedPaths(diff);
  if (paths.length === 0) {
    // Retrying an incomplete Live review must not spin on an unchanged empty diff.
    // Surface the reason and use the existing push-fixable backoff until work changes.
    if (post) return noteFailure(pr, "no reviewable files in the PR diff", now, tick, "push-fixable");
    // Nothing reviewable (an empty or purely-binary diff). Still advance the head, or
    // every tick forever would re-fetch and re-decide the same nothing.
    updateInspectorPr(
      pr.key,
      {
        headSha: s.headSha,
        reviewedBaseRef: s.baseRefName || null,
        reviewedBaseSha: s.baseSha || null,
        reviewPosture: inspectorPosture(cfg, pr.cwd, pr.repoRoot),
        lastReviewedAt: now,
        reviewComplete: false,
        cleanReviewHeadSha: null,
        lastError: null,
        failCount: 0,
        lastFailKind: null,
        nextAttemptAt: null,
      },
      now,
    );
    return true;
  }

  const open = [...rows.values()].filter((c) => c.status !== "resolved");
  const prompt = buildReviewPrompt({
    brief: readBrief(pr.repoRoot),
    standards: readStandards(pr.repoRoot, paths),
    prTitle: s.title,
    prBody: s.body,
    diff,
    diffTruncated: truncated,
    changedPaths: paths,
    open,
    round: pr.round + 1,
  });

  const run = inspectorRunOptions(
    cfg,
    TIMEOUT_MS,
    dir,
    "inspector:review",
    INSPECTOR_VERDICT_JSON_SCHEMA,
  );
  const result = await runStructured<typeof InspectorVerdictSchema>(
    (p) => run.runner.run(p, run.options),
    prompt,
    (raw) => parseModelJson(raw, InspectorVerdictSchema),
    "The inspector",
  );
  if (result.kind !== "ok") {
    // A transient failure must NEVER advance the head sha: doing so would record this
    // push as reviewed and the PR would never be looked at again.
    return noteFailure(pr, result.reason, now, tick);
  }

  const round = pr.round + 1;
  const plan = planReview({
    mode: cfg.mode,
    live: post,
    prompted: new Set(promptedOpenRows(open).map((c) => c.fingerprint)),
    maxComments: cfg.maxCommentsPerRound,
    round,
    verdict: result.value as InspectorVerdict,
    lines: commentableLines(diff),
    existing: rows,
    threads,
    newId: () => randomUUID(),
  });

  // Resolve BEFORE posting: the other order raises a fresh comment about an issue and
  // only then closes the old thread for the same issue, which reads as churn.
  let resolutionError: string | null = null;
  for (const r of plan.resolve) {
    if (post) {
      const row = rows.get(r.fingerprint);
      if (row) {
        const pending = { ...row, resolutionPending: true };
        rows.set(r.fingerprint, pending);
        upsertInspectorComment(pending);
      }
      const res = await resolveThread(dir, r.threadId);
      if (!res.ok) {
        resolutionError = res.error ?? "could not resolve the reviewed thread";
        continue;
      }
    }
    resolvedThreadIds.add(r.threadId);
    closeRow(rows, r.fingerprint, now);
  }
  // Findings with no thread to close - everything drafted in dry run, and anything
  // demoted into the review body. Nothing to ask GitHub for, so nothing can refuse.
  for (const fp of plan.resolveLocal) closeRow(rows, fp, now);

  const comments = new Map(plan.inline.map((c) => [c.fingerprint, {
    path: c.path,
    line: c.line!,
    body: renderComment(
      formatMarker({ id: c.id, fingerprint: c.fingerprint, round }),
      c,
    ),
  }]));

  // Write the ledger BEFORE the POST, not after.
  //
  // The POST is the irreversible half: it publishes under the operator's name. If it
  // reaches GitHub and its response is lost - a timeout on a review carrying eight
  // comments, or the daemon exiting in that window - a ledger written afterwards is
  // never written at all. `headSha` does not advance either, so the next tick re-reviews
  // the same push against an empty ledger and posts every one of those comments a second
  // time. `UNIQUE(pr_key, fingerprint)` cannot help, because there are no rows.
  //
  // So the rows go down first in `posting`, which the planner reads as already-raised.
  // A round interrupted anywhere is then recognisable rather than invisible, and the
  // reconciliation at the top of the next round decides what actually happened.
  const planned: InspectorComment[] = [...plan.inline, ...plan.demoted].map((c) => {
    const prior = rows.get(c.fingerprint);
    return {
      id: c.id,
      prKey: pr.key,
      fingerprint: c.fingerprint,
      path: c.path,
      line: c.line,
      title: c.title,
      body: c.body,
      severity: c.severity,
      round,
      status: post ? "posting" : "drafted",
      // A regression re-uses its original row, so the reply budget it already spent
      // stays spent - a thread that has been argued about six times is not made fresh
      // by the issue coming back.
      replies: prior?.replies ?? 0,
      answeredCommentId: prior?.answeredCommentId ?? null,
      // Carried, never reset: a finding raised again keeps the record of its earlier post
      // until this post is confirmed and re-stamps it.
      postedAt: prior?.postedAt ?? null,
      githubUrl: prior?.githubUrl ?? null,
      // Carried like `replies`: a draft offered again keeps the refusals already pinned on
      // it, which is what lets the cap stop offering it.
      postRefusals: prior?.postRefusals ?? 0,
      lastPostError: prior?.lastPostError ?? null,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
  });
  for (const row of planned) upsertInspectorComment(row);

  if (post && (comments.size > 0 || plan.demoted.length > 0)) {
    const published = await publishRound({
      pr,
      dir,
      headSha: s.headSha,
      round,
      body: plan.body,
      planned,
      comments,
      carried: new Set(plan.inline.filter((c) => c.carried).map((c) => c.fingerprint)),
      rows,
      now,
      tick,
    });
    if (!published) return false;
  }

  updateInspectorPr(
    pr.key,
    {
      headSha: s.headSha,
      // The base this diff was taken against. A later base change under the same head is
      // a different diff, so it is reviewed again rather than trusted (`reviewBaseChanged`).
      reviewedBaseRef: s.baseRefName || null,
      reviewedBaseSha: s.baseSha || null,
      reviewPosture: inspectorPosture(cfg, pr.cwd, pr.repoRoot),
      round,
      reviewComplete: plan.droppedOffDiff === 0 && plan.droppedOverCap === 0,
      cleanReviewHeadSha: null,
      lastReviewedAt: now,
      lastError: null,
      failCount: 0,
      nextAttemptAt: null,
    },
    now,
  );
  recordAutomationTransition(`${pr.key}:${s.headSha}:${round}`, { feature: "inspector", action: "review", outcome: "applied", coverage: "owner_transition" },
    { kind: "system", origin: "daemon", basis: "owner" }, now);
  if (resolutionError) return noteFailure(pr, resolutionError, now, tick);
  await publishCleanReview(getInspectorPr(pr.key)!, dir, s, existingByFingerprint(pr.key),
    post, login, now, tick, resolvedThreadIds);
  return true;
}

/** One live round's publication: the review, and what each refusal of it leads to. */
interface RoundPublication {
  pr: InspectorPr;
  dir: string;
  headSha: string;
  round: number;
  /** The review's top-level body, from the plan. */
  body: string;
  /** Every row this review carries, already written in `posting`. */
  planned: InspectorComment[];
  /** The rendered inline comment for each planned row that has one, by fingerprint. */
  comments: Map<string, { path: string; line: number; body: string }>;
  /** Fingerprints of the drafts the planner carried, as against new findings. */
  carried: Set<string>;
  /** This tick's ledger, kept in step with every row written here. */
  rows: Map<string, InspectorComment>;
  now: number;
  tick: TickState;
}

/**
 * Post a live round, and decide what a refusal of it means for each row it carried.
 *
 * Returns true when the round may finish: the head advances and `reviewPosture` is
 * recorded. Returns false after `noteFailure`, when the head must be reviewed again.
 *
 * The cases, in the order they are checked:
 *
 *  - **Accepted.** Every row goes to `open`, stamped posted.
 *  - **Response lost** (`wasRefused` is false). Today's path: the rows stay in `posting` for
 *    the next round's reconciliation, and nothing counts as a refusal.
 *  - **Whole-review refusal**, or any refusal of a review that carried no draft. Today's
 *    path: every row back to `drafted`, the head not advanced, backoff. No retry is sent, so
 *    a rate limit never triggers one, and no row records a refusal.
 *  - **Validation refusal of a review that also carried new findings.** One retry
 *    straight away, without the carried drafts. Refused again, nothing is counted and the
 *    round fails as above. Accepted, the new findings are `open` and the drafts are pinned.
 *  - **Validation refusal of a drafts-only review.** The drafts are pinned; there is no
 *    review without them to send.
 *
 * Pinning is in `pinRefusal`, and once it is done the round finishes, so a draft
 * GitHub refused does not make the model review the same head again on every backoff. It
 * stays `drafted`, and is next offered on the next push's round.
 *
 * Every retry and isolated review reuses this round's verdict and plan. None calls the model.
 */
async function publishRound(p: RoundPublication): Promise<boolean> {
  const { pr, dir, headSha, now, tick } = p;
  const first = await postReview(dir, pr.owner, pr.repo, pr.number, p.body, [...p.comments.values()], headSha);
  if (first.ok) {
    writeRows(p, p.planned, confirmedPost(now));
    return true;
  }
  // The head sha stays where it is, so this push is reviewed again.
  //
  // What happens to the rows turns on WHY the post failed, and `wasRefused` is the one place
  // that decides it. Only a refusal frees the round to be re-planned, which matters most for
  // the demoted findings: they live in the review body and leave no thread for the next
  // round's reconciliation to find, so left in `posting` they would be promoted to `open` and
  // never actually said. Everything else stays in `posting` for the live thread read to
  // adjudicate.
  if (!wasRefused(first)) return noteFailure(pr, first.error ?? "could not post the review", now, tick);

  const carried = p.planned.filter((row) => p.carried.has(row.fingerprint));
  const fresh = p.planned.filter((row) => !p.carried.has(row.fingerprint));
  if (carried.length === 0 || (await classifyReviewRefusal(first, headUnmoved(p))) === "whole-review") {
    writeRows(p, p.planned, { status: "drafted" });
    return noteFailure(pr, first.error ?? "could not post the review", now, tick);
  }

  if (fresh.length > 0) {
    const freshComments = fresh.flatMap((row) => p.comments.get(row.fingerprint) ?? []);
    const retry = await postReview(dir, pr.owner, pr.repo, pr.number, p.body, freshComments, headSha);
    if (!retry.ok) {
      // The first review was refused, so nothing it carried landed: the drafts are drafts
      // again either way. The new findings follow `wasRefused`, exactly as above.
      writeRows(p, carried, { status: "drafted" });
      if (wasRefused(retry)) writeRows(p, fresh, { status: "drafted" });
      return noteFailure(pr, retry.error ?? "could not post the review", now, tick);
    }
    writeRows(p, fresh, confirmedPost(now));
  }
  return pinRefusal(p, carried, first);
}

/**
 * Attribute a validation refusal to the exact draft that caused it.
 *
 * Exactly one carried draft: it is the cause, since the refusal named a comment that could
 * not be anchored and it was the only comment the refused review carried with a location
 * GitHub could not place. It records one refusal with GitHub's reason.
 *
 * Several: each is posted in its own review, so a valid draft never counts toward the cap
 * because of a bad sibling. Accepted, it is `open`. A validation refusal is charged to that
 * draft alone, but only once some isolated post was accepted. When every one is refused,
 * nothing is counted, since a refusal they all share cannot be pinned on one of them, but the
 * round still finishes: each refusal named a comment GitHub could not anchor on an unmoved
 * head, so reviewing the same head again would only repeat it. The drafts are offered again on
 * the next push. A whole-review refusal or a lost response stops isolation and fails the round
 * the usual way, with nothing counted for the drafts not yet tried. The cost is one
 * review, and so one notification, per carried draft, at most `maxCommentsPerRound`; it
 * happens only after a validation refusal, which a snapped line makes rare.
 */
async function pinRefusal(
  p: RoundPublication,
  carried: InspectorComment[],
  refused: GhResult<void>,
): Promise<boolean> {
  const { pr, dir, headSha, now, tick } = p;
  if (carried.length === 1) {
    recordRefusal(p, carried[0]!, refused);
    return true;
  }
  const body = [
    reviewHeader(p.round),
    "",
    "GitHub refused this finding in a review with others, so it is posted on its own.",
  ].join("\n");
  const charged: Array<[InspectorComment, GhResult<void>]> = [];
  let accepted = 0;
  const settleCharges = (): void => {
    if (accepted > 0) {
      for (const [row, res] of charged) recordRefusal(p, row, res);
    } else {
      writeRows(p, charged.map(([row]) => row), { status: "drafted" });
    }
  };
  for (const [i, row] of carried.entries()) {
    const comment = p.comments.get(row.fingerprint)!;
    const res = await postReview(dir, pr.owner, pr.repo, pr.number, body, [comment], headSha);
    if (res.ok) {
      writeRows(p, [row], confirmedPost(now));
      accepted += 1;
      continue;
    }
    const untried = carried.slice(i + 1);
    if (!wasRefused(res)) {
      settleCharges();
      // This draft may have landed and stays `posting`, for its thread to answer.
      writeRows(p, untried, { status: "drafted" });
      return noteFailure(pr, res.error ?? "could not post the review", now, tick);
    }
    if ((await classifyReviewRefusal(res, headUnmoved(p))) === "validation") {
      charged.push([row, res]);
      continue;
    }
    settleCharges();
    writeRows(p, [row, ...untried], { status: "drafted" });
    return noteFailure(pr, res.error ?? "could not post the review", now, tick);
  }
  settleCharges();
  return true;
}

/** The moved-head check: one head read, made only after GitHub refused a review with a 422. */
function headUnmoved(p: RoundPublication): () => Promise<boolean> {
  return async () => {
    const head = await fetchHeadSha(p.dir, p.pr.owner, p.pr.repo, p.pr.number);
    return head.ok && head.value === p.headSha;
  };
}

/**
 * A post GitHub confirmed. It clears the refusal pair: those refusals were about a draft
 * GitHub has now accepted, and carried forward they would retire a later version of it early.
 */
function confirmedPost(now: number): Pick<InspectorComment, "status" | "postedAt" | "postRefusals" | "lastPostError"> {
  return { status: "open", postedAt: now, postRefusals: 0, lastPostError: null };
}

/** One counted refusal on one draft: back to `drafted`, with the count and GitHub's reason. */
function recordRefusal(p: RoundPublication, row: InspectorComment, refused: GhResult<void>): void {
  writeRows(p, [row], {
    status: "drafted",
    postRefusals: (row.postRefusals ?? 0) + 1,
    lastPostError: refusalReason(refused),
  });
}

/** Write rows through the one upsert, keeping this tick's ledger map in step. */
function writeRows(p: RoundPublication, rows: InspectorComment[], patch: Partial<InspectorComment>): void {
  for (const row of rows) {
    const next: InspectorComment = { ...row, ...patch };
    p.rows.set(row.fingerprint, next);
    upsertInspectorComment(next);
  }
}

/**
 * Write each finding's GitHub link, read from the snapshot this tick already fetched.
 *
 * Runs on every tick that knows its login, before reconciliation and before any write
 * below, so that the map those writes copy from already holds the link. That matters for
 * a round that raises a finding again: its row is built from `prior.githubUrl`, so the
 * earlier comment's link survives as the "posted earlier" link.
 *
 * A review posted later in this same tick is not in this snapshot, so its links land on
 * the next tick. Until then the finding reads as posted, without a link.
 *
 * `updatedAt` is left alone on purpose. Learning where a finding lives on GitHub does not
 * change the finding, and the Completion pane's "Last change" and the prompt's ordering
 * both read that field.
 */
function recordFindingUrls(rows: Map<string, InspectorComment>, sources: LinkSources, login: string): void {
  for (const [fp, url] of findingUrls(sources, login, rows.values())) {
    const next: InspectorComment = { ...rows.get(fp)!, githubUrl: url };
    rows.set(fp, next);
    upsertInspectorComment(next);
  }
}

/**
 * Page loaders for the clean-review traversals that also take the links on every page.
 *
 * The traversals already read past the snapshot's first page, and each loader calls the
 * same fetcher with the same arguments as the default one, so no call is added. What each
 * page adds is a link for a finding whose thread or review the first page did not hold.
 * Every page read is pooled with the re-read snapshot, so `findingUrls` judges the whole of
 * what this tick has seen, and a page that ends its traversal marks that kind complete.
 */
function linkCapturingLoaders(
  dir: string,
  pr: InspectorPr,
  fresh: PrSnapshot,
  rows: Map<string, InspectorComment>,
  login: string,
): {
  threads: (after: string) => ReturnType<typeof fetchThreadPage>;
  reviews: (before: string) => ReturnType<typeof fetchReviewPage>;
} {
  const seen = snapshotLinkSources(fresh);
  recordFindingUrls(rows, seen, login);
  return {
    threads: async (after) => {
      const page = await fetchThreadPage(dir, pr.owner, pr.repo, pr.number, after);
      if (page.ok && page.value) {
        seen.threads = [...seen.threads, ...page.value.threads];
        if (!page.value.pageInfo.hasNextPage) seen.threadsComplete = true;
        recordFindingUrls(rows, seen, login);
      }
      return page;
    },
    reviews: async (before) => {
      const page = await fetchReviewPage(dir, pr.owner, pr.repo, pr.number, before);
      if (page.ok && page.value) {
        seen.reviews = [...seen.reviews, ...page.value.reviews];
        if (!page.value.pageInfo.hasPreviousPage) seen.reviewsComplete = true;
        recordFindingUrls(rows, seen, login);
      }
      return page;
    },
  };
}

/** Close one ledger row, in the map we are working from as well as in the DB. */
function closeRow(rows: Map<string, InspectorComment>, fingerprint: string, now: number): void {
  const row = rows.get(fingerprint);
  if (!row) return;
  const next: InspectorComment = { ...row, status: "resolved", resolutionPending: false, updatedAt: now };
  rows.set(fingerprint, next);
  upsertInspectorComment(next);
}

/**
 * Decide what happened to rows left in `posting` by an interrupted round.
 *
 * Only genuinely ambiguous rows reach here: a post GitHub REFUSED has already put its
 * rows back to `drafted` at the call site, where the refusal was a fact. What is left is
 * the round whose response we lost - a timeout, or the daemon exiting mid-write.
 *
 * GitHub is the record, so the live threads answer it: an inline finding whose marker
 * is on a thread was published, and one whose marker is not was never published and is
 * free to be raised again. A demoted finding lives in the review body and leaves no
 * thread either way, so it cannot be checked and is assumed published - erring toward
 * one finding said once too few rather than one public comment said twice.
 *
 * `threads` must have been resolved from a KNOWN login. Built without one it is empty,
 * so every row would read as unpublished and be raised again - which is exactly the
 * duplicate this state exists to prevent. `processPr` abstains from the whole PR before
 * that can happen; this function is not the place that decides it.
 */
function reconcilePosting(
  rows: Map<string, InspectorComment>,
  threads: Map<string, OurThread>,
  now: number,
): void {
  for (const [fp, row] of rows) {
    if (row.status !== "posting") continue;
    const published = row.line === null || threads.has(fp);
    const next: InspectorComment = {
      ...row,
      // Confirmed now, so stamped now. An unpublished row keeps whatever an earlier post of
      // the same finding recorded.
      ...(published ? confirmedPost(now) : { status: "drafted" as const }),
      updatedAt: now,
    };
    rows.set(fp, next);
    upsertInspectorComment(next);
  }
}

/**
 * Start the Inspector.
 *
 * While disabled it neither reviews nor posts: the tick reads one config row and
 * returns before it touches the network, spawns a subprocess, or loads the ledger. The
 * ONE thing it still does is write an adoption row when a hook proves we opened a PR -
 * a single local insert, because that proof is transient and gating it would make every
 * PR opened before the feature was switched on permanently unreachable.
 */
export interface InspectorStartOptions {
  workflowGate?: (prKey: string) => WorkflowGateStanding;
}

export function startInspector(registry: Registry, options: InspectorStartOptions = {}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // One PR at a time. A review is an Opus run with tool round-trips inside it; a
  // dashboard with six open PRs must not fork six of them.
  const limit = createLimiter(1);

  // The hook's signal is transient, so it has to be caught as it happens.
  //
  // Deliberately NOT gated on `enabled`. Adoption is not consent to post - `mayPost` is,
  // and it is checked separately every round - so the row costs nothing but a local
  // insert. Gating it would mean a user who opens pull requests first and turns the
  // Inspector on afterwards can never review any of them, because the proof they were
  // ours went by while nobody was listening and cannot be recovered.
  useInspectorStackLifecycle(registry);
  const offPrOpened = registry.onPrOpened((e: PrOpened) => {
    const adopted = adoptOpenedPr(registry, e, Date.now());
    // Refresh NOW rather than waiting for the next tick. The chip is how anyone knows the
    // PR was adopted at all, and a card that shows a PR with no inspector chip means
    // something specific - "we didn't open this one" - so leaving it in that state for up
    // to a poll interval is not a delay, it is the wrong answer displayed confidently.
    if (adopted) {
      registry.refreshInspections();
      const parsed = parsePrUrl(e.url);
      if (parsed) {
        notifyInspection(registry, parsed.key, null, null);
        // Stacked pull requests: the lineage is already on the row (`adoptOpenedPr`). The
        // base check reads GitHub, so it runs off the hook's path.
        if (getInspectorPr(parsed.key)?.stack) {
          void correctStackBase(parsed.key, activeStackGitHub(), Date.now())
            .then(() => registry.refreshInspections())
            .catch((error) => console.error("[inspector] could not check the stacked base:", parsed.key, error));
        }
      }
    }
  });
  const offPipelineRun = registry.onPipelineRun((run) => {
    void (async () => {
      try {
        if (!(await adoptPipelinePr(run))) return;
        registry.refreshInspections();
        const parsed = run.prUrl ? parsePrUrl(run.prUrl) : null;
        if (parsed) notifyInspection(registry, parsed.key, null, null);
      } catch (err) {
        // Projection must stay live even if remote resolution or the local adoption ledger
        // fails. Both are abstentions for this one PR, never failures of the provider loop.
        console.error("[inspector] could not adopt pipeline pull request:", err);
      }
    })();
  });

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const cfg = getInspectorConfig();
      // Stacked children are observed even with both review sources off: a child keeps its
      // lifecycle (base reconciliation, broken-stack detection, the prompts it needs) whatever
      // any setting says. Only rows with lineage, so the Inspector being off still costs
      // nothing for every other pull request.
      const reviewing = (): boolean => getInspectorConfig().enabled || codeRabbitEnabled();
      const sweeping = reviewing();
      const due = sweeping ? loadOpenInspectorPrs() : loadOpenInspectorPrs().filter((row) => row.stack);
      if (sweeping || due.length > 0) {
        for (const pr of due) {
          if (stopped) break;
          // Re-read per PR so turning the feature off mid-sweep is honoured now rather
          // than after everything already queued has posted.
          if (!reviewing() && !pr.stack) break;
          // The row may have been written by an earlier PR in this same sweep.
          const fresh = getInspectorPr(pr.key) ?? pr;
          const observed: {
            value: { headSha: string; state: PrSnapshot["state"]; at: number } | null;
          } = { value: null };
          await limit(() => processPr(
            getInspectorConfig(),
            fresh,
            Date.now(),
            (snapshot, observedAt) => {
              observed.value = { headSha: snapshot.headSha, state: snapshot.state, at: observedAt };
              notifyInspection(registry, fresh.key, snapshot.headSha, snapshot.state, observedAt);
              // CodeRabbit may be delivered while a model review is still running.
              // With this source off, retain Inspector's once-per-sweep refresh.
              if (codeRabbitEnabled()) registry.refreshInspections();
            },
            options.workflowGate ?? (() => "none"),
          ));
          // Re-read after every completed review or failure. The immediate signal above
          // reports the fetched GitHub head; this one carries the resulting durable ledger.
          notifyInspection(
            registry,
            fresh.key,
            observed.value?.headSha ?? null,
            observed.value?.state ?? null,
            observed.value?.at ?? Date.now(),
          );
        }
        // Once per sweep, unconditionally. An earlier version did this only when a PR
        // "advanced", which quietly excluded the states most worth seeing: a PR whose
        // review FAILED reports no progress, and it is exactly then that the card should
        // stop claiming the last good result. One grouped query per 90s, and it emits
        // only for sessions whose summary actually changed.
        registry.refreshInspections();
      }
      // Stacked children already retired as closed: their recovery action depends on a parent
      // that can still merge or close, so its state is read again every sweep (GitHub reads
      // only). Its own guard, so one failure cannot cost the open rows' sweep above.
      if (stackLifecycle && !stopped) {
        try {
          await observeClosedStackChildren(activeStackGitHub(), stackLifecycle, liveDir, Date.now());
          registry.refreshInspections();
        } catch (error) {
          console.error("[inspector] closed stacked children could not be observed:", error);
        }
      }
    } catch (err) {
      console.error("[inspector] tick failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, POLL_MS));
  };

  void tick();
  return () => {
    stopped = true;
    offPrOpened();
    offPipelineRun();
    if (timer) clearTimeout(timer);
  };
}
