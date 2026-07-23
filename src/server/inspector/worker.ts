import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { envVar } from "../config.ts";
import {
  adoptInspectorPr,
  getInspectorPr,
  loadInspectorComments,
  loadOpenInspectorPrs,
  updateInspectorPr,
  upsertInspectorComment,
} from "../db.ts";
import { createLimiter, parseModelJson, runStructured } from "../llm/structured.ts";
import { llmRunner } from "../llm/index.ts";
import { readStandards } from "../standards.ts";
import { unref } from "../util/timers.ts";
import { inspectorPosture, reviewNeedsLiveRerun } from "@shared/inspector.ts";
import type { PrOpened, Registry } from "../registry.ts";
import type {
  InspectorComment,
  InspectorFailKind,
  InspectorPr,
  InspectorSource,
} from "@shared/types.ts";
import type { InspectorConfig } from "@shared/protocol.ts";
import { getInspectorConfig, inspectorModel } from "./config.ts";
import { readBrief } from "./brief.ts";
import { changedPaths, commentableLines } from "./diff-lines.ts";
import { buildReplyPrompt, buildReviewPrompt } from "./prompt.ts";
import {
  CLEAN_REVIEW_FINGERPRINT,
  formatMarker,
  isCleanReview,
  isOurs,
  parseMarker,
} from "./marker.ts";
import { scrubSecrets } from "./scrub.ts";
import { maybeMerge } from "../shipping/merge.ts";
import { InspectorVerdictSchema, planReview } from "./verdict.ts";
import type { InspectorVerdict, OurThread } from "./verdict.ts";
import {
  authenticatedLogin,
  fetchDiff,
  fetchPr,
  ourThreads,
  parsePrUrl,
  postReview,
  renderCleanReview,
  renderComment,
  replyToComment,
  resolveThread,
  wasRefused,
} from "./github.ts";
import type { PrSnapshot, ThreadSnapshot } from "./github.ts";

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
/** Cap on the diff we put in a prompt. A 2MB refactor is not reviewable in one pass anyway. */
const MAX_DIFF_BYTES = Number(envVar("INSPECTOR_MAX_DIFF_BYTES") ?? 400_000);
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
const MAX_ROUNDS = 100;

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

function inspectorRunOptions(cfg: InspectorConfig, timeoutMs: number, cwd: string) {
  const runner = llmRunner(cfg.runner ?? "claude");
  return {
    runner,
    options: {
      model: reviewModel(cfg),
      timeoutMs,
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
 * `MAX_ROUNDS` counts SUCCESSES, so on its own it can never stop a PR that fails
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
 * The adopted `cwd` is a session worktree, and sessions run in POOLED worktrees under
 * `~/.treehouse` that get reaped and reused. A row pinned to a reaped directory spawns
 * every `gh` call and every `claude -p` into a path that isn't there, and nothing ever
 * healed it - `adoptInspectorPr` is `DO NOTHING`, so re-adoption cannot rewrite it.
 *
 * `repoRoot` is the fallback because it is git's common dir: it outlives any worktree
 * of the repo. Every `gh` call here is owner/repo-explicit, so the directory only ever
 * supplies credentials and the reviewer's read scope, never the identity of the PR.
 */
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
 * Record a PR as ours to review. Idempotent - the DB's `DO NOTHING` is the dedup, so
 * both adoption signals can call this freely.
 */
export function adoptPr(
  url: string,
  ctx: { sessionId: string | null; cwd: string | null; repoRoot: string | null },
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
    adoptedAt: now,
    updatedAt: now,
  });
}

/**
 * Adopt any PR a no-mistakes run reports having opened.
 *
 * A PULL, where the hook's signal is a push, and the asymmetry is real rather than
 * sloppiness: the hook event is transient (nothing persists it, so it must be caught as
 * it happens), while this is durable state on the session, re-read on every nm poll.
 * Both land in `adoptPr`, which is idempotent, so neither has to know about the other.
 */
function adoptFromSessions(registry: Registry, now: number): void {
  for (const s of registry.snapshot().sessions) {
    const url = s.nomistakes?.prUrl;
    if (!url) continue;
    adoptPr(url, { sessionId: s.id, cwd: s.cwd, repoRoot: s.repoRoot }, "no-mistakes", now);
  }
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
    if (t.isResolved) continue;
    const first = t.comments[0];
    if (!first) continue;
    if (!isOurs(first, login)) continue; // not our thread
    const marker = parseMarker(first.body)!;
    const row = rows.get(marker.fingerprint);
    if (!row) continue;
    if (row.replies >= MAX_REPLIES_PER_THREAD) continue;

    const newest = t.comments[t.comments.length - 1]!;
    if (isOurs(newest, login)) continue; // we spoke last - nobody is waiting
    if (newest.databaseId !== null && row.answeredCommentId === newest.databaseId) continue;
    out.push({ thread: t, row, newest });
  }
  return out;
}

/** Run one PR through the whole cycle. Returns true when it did something. */
async function processPr(
  cfg: InspectorConfig,
  pr: InspectorPr,
  now: number,
): Promise<boolean> {
  const tick: TickState = { failed: false };
  const backedOff = pr.nextAttemptAt !== null && now < pr.nextAttemptAt;

  const dir = liveDir(pr);
  if (!dir) {
    if (backedOff) return false;
    return noteFailure(pr, "the checkout this PR was opened from is gone", now, tick);
  }

  // Read the PR even while backed off. The backoff is there to stop paying for repeated
  // `claude -p` runs, not to stop LOOKING: one `fetchPr` costs a fraction of a review,
  // and it is the only way a parked PR can notice that its input changed. A failure of
  // this probe does not extend the wait, or the cheap check would inflate a penalty it
  // was not the cause of.
  const snap = await fetchPr(dir, pr.owner, pr.repo, pr.number);
  if (!snap.ok || !snap.value) {
    if (backedOff) return false;
    return noteFailure(pr, snap.error ?? "could not read the pull request", now, tick);
  }
  const s = snap.value;

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

  if (pr.round >= MAX_ROUNDS) {
    return noteFailure(pr, `stopped after ${MAX_ROUNDS} rounds`, now, tick);
  }

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
  const posture = inspectorPosture(cfg, pr.cwd, pr.repoRoot);
  const post = posture === "live";
  let acted = false;

  // 1. Answer anyone waiting on us. Before the re-review, because a question asked three
  //    pushes ago should not queue behind a fresh review of a big diff.
  //    Only when we could actually send the answer: a reply has no `drafted` state, so
  //    running one we cannot post spends a model call to produce nothing.
  const waiting = post ? threadsAwaitingUs(s, rows, login) : [];
  if (waiting.length) {
    const diff = await fetchDiff(dir, pr.owner, pr.repo, pr.number, MAX_DIFF_BYTES);
    for (const w of waiting) {
      const replied = await answerFollowUp(
        cfg,
        pr,
        dir,
        w,
        diff.value?.diff ?? "",
        diff.value?.truncated ?? false,
        post,
        login,
        now,
        tick,
      );
      if (replied) acted = true;
    }
  }

  // 2. Ship it, if YOLO mode says every gate is green.
  //
  // Before the re-review and before the nothing-pushed return, because neither of those
  // is where the answer changes: a PR that merges is one whose head was ALREADY reviewed
  // clean, and what moves it over the line is CI going green or the soak elapsing - both
  // of which happen while nothing here is pushing anything. Gated behind the head match
  // inside `mergeVerdict`, so a PR with an unreviewed push waits for the review below and
  // the next sweep. `rows` is passed rather than re-read: it is this tick's ledger, and
  // the reply step above may already have moved it.
  if (await maybeMerge(cfg, pr, dir, s, rows, now)) return true;

  // 3. Nothing pushed since the last review: there is nothing new to say.
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
    !reviewNeedsLiveRerun(posture, pr.reviewPosture)
  ) {
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
    return acted;
  }

  const reviewed = await reviewRound(cfg, pr, dir, s, rows, post, login, now, tick);
  return acted || reviewed;
}

async function answerFollowUp(
  cfg: InspectorConfig,
  pr: InspectorPr,
  dir: string,
  w: ReturnType<typeof threadsAwaitingUs>[number],
  diff: string,
  diffTruncated: boolean,
  post: boolean,
  login: string,
  now: number,
  tick: TickState,
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

  let text: string;
  try {
    const run = inspectorRunOptions(cfg, REPLY_TIMEOUT_MS, dir);
    text = await run.runner.run(prompt, run.options);
  } catch (err) {
    return noteFailure(pr, `reply failed: ${String(err)}`, now, tick);
  }

  const reply = scrubSecrets(text.trim());
  if (!reply) return false;

  // Same marker fingerprint as the thread it belongs to, so a reply of ours is
  // recognisable as ours on the next read - which is what stops us answering our own
  // answer forever.
  const body = [
    formatMarker({ id: randomUUID(), fingerprint: w.row.fingerprint, round: pr.round }),
    "**⌕ Inspector**",
    "",
    reply,
  ].join("\n");

  const res = await replyToComment(dir, pr.owner, pr.repo, pr.number, w.newest.databaseId, body);
  if (!res.ok) return noteFailure(pr, res.error ?? "reply failed", now, tick);

  // Stamp AFTER the send, never before: a failed post that had already recorded the
  // answer would leave someone's question permanently unanswered and invisible.
  upsertInspectorComment({
    ...w.row,
    replies: w.row.replies + 1,
    answeredCommentId: w.newest.databaseId,
    updatedAt: now,
  });
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
): Promise<boolean> {
  const threads = ourThreads(s, login);
  reconcilePosting(rows, threads, now);

  const diffRes = await fetchDiff(dir, pr.owner, pr.repo, pr.number, MAX_DIFF_BYTES);
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
    // Nothing reviewable (an empty or purely-binary diff). Still advance the head, or
    // every tick forever would re-fetch and re-decide the same nothing.
    updateInspectorPr(
      pr.key,
      {
        headSha: s.headSha,
        reviewPosture: inspectorPosture(cfg, pr.cwd, pr.repoRoot),
        lastReviewedAt: now,
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

  const run = inspectorRunOptions(cfg, TIMEOUT_MS, dir);
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
  for (const r of plan.resolve) {
    if (post) {
      const res = await resolveThread(dir, r.threadId);
      if (!res.ok) continue; // leave the row open; we'll try again next round
    }
    closeRow(rows, r.fingerprint, now);
  }
  // Findings with no thread to close - everything drafted in dry run, and anything
  // demoted into the review body. Nothing to ask GitHub for, so nothing can refuse.
  for (const fp of plan.resolveLocal) closeRow(rows, fp, now);

  // A clean verdict is only safe when every earlier finding is resolved too. A model
  // omitting an old finding is not evidence that it was fixed, and a failed GitHub
  // resolve above must not be followed by a contradictory "safe to merge" review.
  const clean = plan.clean && [...rows.values()].every((row) => row.status === "resolved");
  const cleanAlreadyPosted = (s.reviews ?? []).some((review) => isCleanReview(review, login, round));

  const inline = plan.inline.map((c) => ({
    path: c.path,
    line: c.line!,
    body: renderComment(
      formatMarker({ id: c.id, fingerprint: c.fingerprint, round }),
      c,
    ),
  }));

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
      severity: c.severity,
      round,
      status: post ? "posting" : "drafted",
      // A regression re-uses its original row, so the reply budget it already spent
      // stays spent - a thread that has been argued about six times is not made fresh
      // by the issue coming back.
      replies: prior?.replies ?? 0,
      answeredCommentId: prior?.answeredCommentId ?? null,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
  });
  for (const row of planned) upsertInspectorComment(row);

  if (post && (inline.length > 0 || plan.demoted.length > 0 || (clean && !cleanAlreadyPosted))) {
    const body = clean
      ? renderCleanReview(
          formatMarker({ id: randomUUID(), fingerprint: CLEAN_REVIEW_FINGERPRINT, round }),
          round,
        )
      : plan.body;
    const res = await postReview(
      dir,
      pr.owner,
      pr.repo,
      pr.number,
      body,
      inline,
      s.headSha,
    );
    if (!res.ok) {
      // The head sha stays where it is, so this push is reviewed again.
      //
      // What happens to the rows turns on WHY the post failed, and `wasRefused` is the
      // one place that decides it. Only a refusal frees the round to be re-planned,
      // which matters most for the demoted findings: they live in the review body and
      // leave no thread for the next round's reconciliation to find, so left in
      // `posting` they would be promoted to `open` and never actually said. Everything
      // else stays in `posting` for the live thread read to adjudicate.
      if (wasRefused(res)) {
        for (const row of planned) {
          const reverted: InspectorComment = { ...row, status: "drafted" };
          rows.set(row.fingerprint, reverted);
          upsertInspectorComment(reverted);
        }
      }
      return noteFailure(pr, res.error ?? "could not post the review", now, tick);
    }
    // Published. Promote every row this review carried out of `posting`.
    for (const row of planned) upsertInspectorComment({ ...row, status: "open" });
  }

  updateInspectorPr(
    pr.key,
    {
      headSha: s.headSha,
      reviewPosture: inspectorPosture(cfg, pr.cwd, pr.repoRoot),
      round,
      lastReviewedAt: now,
      lastError: null,
      failCount: 0,
      nextAttemptAt: null,
    },
    now,
  );
  return true;
}

/** Close one ledger row, in the map we are working from as well as in the DB. */
function closeRow(rows: Map<string, InspectorComment>, fingerprint: string, now: number): void {
  const row = rows.get(fingerprint);
  if (!row) return;
  const next: InspectorComment = { ...row, status: "resolved", updatedAt: now };
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
      status: published ? "open" : "drafted",
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
export function startInspector(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // One PR at a time. A review is an Opus run with tool round-trips inside it; a
  // dashboard with six open PRs must not fork six of them.
  const limit = createLimiter(1);

  // The hook's signal is transient - nothing persists it - so it has to be caught as it
  // happens rather than found later. See `adoptFromSessions` for the other half.
  //
  // Deliberately NOT gated on `enabled`. Adoption is not consent to post - `mayPost` is,
  // and it is checked separately every round - so the row costs nothing but a local
  // insert. Gating it would mean a user who opens pull requests first and turns the
  // Inspector on afterwards can never review any of them, because the proof they were
  // ours went by while nobody was listening and cannot be recovered.
  const offPrOpened = registry.onPrOpened((e: PrOpened) => {
    const adopted = adoptPr(
      e.url,
      { sessionId: e.sessionId, cwd: e.cwd, repoRoot: e.repoRoot },
      "hook",
      Date.now(),
    );
    // Refresh NOW rather than waiting for the next tick. The chip is how anyone knows the
    // PR was adopted at all, and a card that shows a PR with no inspector chip means
    // something specific - "we didn't open this one" - so leaving it in that state for up
    // to a poll interval is not a delay, it is the wrong answer displayed confidently.
    if (adopted) registry.refreshInspections();
  });

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const cfg = getInspectorConfig();
      if (cfg.enabled) {
        const now = Date.now();
        adoptFromSessions(registry, now);
        for (const pr of loadOpenInspectorPrs()) {
          if (stopped) break;
          // Re-read per PR so turning the feature off mid-sweep is honoured now rather
          // than after everything already queued has posted.
          if (!getInspectorConfig().enabled) break;
          // The row may have been written by an earlier PR in this same sweep.
          const fresh = getInspectorPr(pr.key) ?? pr;
          await limit(() => processPr(getInspectorConfig(), fresh, Date.now()));
        }
        // Once per sweep, unconditionally. An earlier version did this only when a PR
        // "advanced", which quietly excluded the states most worth seeing: a PR whose
        // review FAILED reports no progress, and it is exactly then that the card should
        // stop claiming the last good result. One grouped query per 90s, and it emits
        // only for sessions whose summary actually changed.
        registry.refreshInspections();
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
    if (timer) clearTimeout(timer);
  };
}
