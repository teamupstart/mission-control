import { randomUUID } from "node:crypto";
import { envVar } from "../config.ts";
import {
  adoptInspectorPr,
  getInspectorPr,
  loadInspectorComments,
  loadOpenInspectorPrs,
  updateInspectorPr,
  upsertInspectorComment,
} from "../db.ts";
import { createLimiter, parseModelJson, runClaudeText, runStructured } from "../claude-cli.ts";
import { readStandards } from "../standards.ts";
import { unref } from "../util/timers.ts";
import { repoAllowlisted } from "@shared/allowlist.ts";
import type { PrOpened, Registry } from "../registry.ts";
import type { InspectorComment, InspectorPr, InspectorSource } from "@shared/types.ts";
import type { InspectorConfig } from "@shared/protocol.ts";
import { getInspectorConfig } from "./config.ts";
import { readBrief } from "./brief.ts";
import { changedPaths, commentableLines } from "./diff-lines.ts";
import { buildReplyPrompt, buildReviewPrompt } from "./prompt.ts";
import { formatMarker, parseMarker } from "./marker.ts";
import { scrubSecrets } from "./scrub.ts";
import { InspectorVerdictSchema, planReview } from "./verdict.ts";
import type { InspectorVerdict } from "./verdict.ts";
import {
  fetchDiff,
  fetchPr,
  fetchReviewComments,
  ourThreads,
  parsePrUrl,
  postReview,
  renderComment,
  replyToComment,
  resolveThread,
} from "./github.ts";
import type { PrSnapshot, ThreadSnapshot } from "./github.ts";

// The Inspector's tick: review the pull requests we opened, answer follow-ups in our own
// threads, and close our own threads once a push has fixed what they were about.
//
// A poller in the DAEMON rather than a worker beside the Foreman, for two reasons that
// are worth restating where someone might move it: the Foreman worker is never started
// by the Electron app (so a packaged build would silently not have this feature), and
// every piece of state here has to survive a restart, which would mean inventing a
// route per table for a process that is the only client of any of them.

/** How often to look at the adopted PRs. Slow: a review is expensive and a push is not frequent. */
const POLL_MS = Number(envVar("INSPECTOR_POLL_MS") ?? 90_000);
/** Sized for a whole-diff review WITH tool round-trips inside it. */
const TIMEOUT_MS = Number(envVar("INSPECTOR_TIMEOUT_MS") ?? 180_000);
/** A follow-up reply is a much smaller job than a review. */
const REPLY_TIMEOUT_MS = Number(envVar("INSPECTOR_REPLY_TIMEOUT_MS") ?? 90_000);
const MODEL = envVar("INSPECTOR_MODEL");
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
 * The tools the reviewer gets, and the reason this whole subsystem is defended in depth.
 *
 * Reading is the entire grant: no Bash, no Write/Edit, no WebFetch, no MCP. Reviewing a
 * diff without being able to open a file misses most of what matters (does this break a
 * caller? is there a test?), which is why the grant exists - but the input is a diff
 * anyone can author and the output is a public comment, so it is paid for by the deny
 * rules below, the worktree cwd, the changed-path filter in the planner, and the
 * scrubber on every outbound string.
 */
const REVIEW_TOOLS = "Read,Grep,Glob";

/**
 * Path rules handed to Claude Code itself, so they are enforced by the harness rather
 * than by asking the model nicely.
 *
 * The list is the obvious credential stores plus this app's own state: a reviewer that
 * could read `~/.claude` could read the operator's other projects' transcripts, and a
 * reviewer that could read `.git/config` could read a token embedded in a remote URL.
 */
const DENY_SETTINGS = JSON.stringify({
  permissions: {
    deny: [
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(**/*.pem)",
      "Read(**/*.key)",
      "Read(**/*.p12)",
      "Read(**/id_rsa*)",
      "Read(**/id_ed25519*)",
      "Read(**/.git/config)",
      "Read(**/.npmrc)",
      "Read(**/.netrc)",
      "Read(**/credentials*)",
      "Read(//Users/*/.aws/**)",
      "Read(//Users/*/.ssh/**)",
      "Read(//Users/*/.claude/**)",
      "Read(//Users/*/.mission-control/**)",
    ],
  },
});

/**
 * Whether this PR may be acted on for real.
 *
 * Three independent gates, all of which must pass, and each of which the operator set
 * separately: the feature is on, the mode is live, and this repo is trusted. `dry-run`
 * still reviews - that is the point of it - it just never posts.
 */
function mayPost(cfg: InspectorConfig, pr: InspectorPr): boolean {
  if (!cfg.enabled || cfg.mode !== "live") return false;
  return repoAllowlisted(pr.cwd, pr.repoRoot, cfg.repoAllowlist);
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
    round: 0,
    lastReviewedAt: null,
    lastError: null,
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
 * "Somebody else" is decided by the marker, never by the author name: every comment here
 * has the same author, because they are all posted with the operator's credential.
 */
function threadsAwaitingUs(
  snapshot: PrSnapshot,
  rows: Map<string, InspectorComment>,
): { thread: ThreadSnapshot; row: InspectorComment; newest: { databaseId: number | null; body: string; author: string } }[] {
  const out = [];
  for (const t of snapshot.threads) {
    if (t.isResolved) continue;
    const first = t.comments[0];
    if (!first) continue;
    const marker = parseMarker(first.body);
    if (!marker) continue; // not our thread
    const row = rows.get(marker.fingerprint);
    if (!row) continue;
    if (row.replies >= MAX_REPLIES_PER_THREAD) continue;

    const newest = t.comments[t.comments.length - 1]!;
    if (parseMarker(newest.body)) continue; // we spoke last - nobody is waiting
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
  const snap = await fetchPr(pr.cwd, pr.owner, pr.repo, pr.number);
  if (!snap.ok || !snap.value) {
    updateInspectorPr(pr.key, { lastError: snap.error ?? "could not read the pull request" }, now);
    return false;
  }
  const s = snap.value;

  // Merged and closed-unmerged are both "done". Retiring the row rather than deleting it
  // keeps the audit trail of what was said on a PR that has since landed.
  if (s.state !== "OPEN") {
    updateInspectorPr(pr.key, { state: "closed", lastError: null }, now);
    return true;
  }
  if (pr.round >= MAX_ROUNDS) {
    updateInspectorPr(pr.key, { lastError: `stopped after ${MAX_ROUNDS} rounds` }, now);
    return false;
  }

  const rows = existingByFingerprint(pr.key);
  const post = mayPost(cfg, pr);
  let acted = false;

  // 1. Answer anyone waiting on us. Before the re-review, because a question asked three
  //    pushes ago should not queue behind a fresh review of a big diff.
  const waiting = threadsAwaitingUs(s, rows);
  if (waiting.length) {
    const diff = await fetchDiff(pr.cwd, pr.owner, pr.repo, pr.number, MAX_DIFF_BYTES);
    for (const w of waiting) {
      const replied = await answerFollowUp(pr, w, diff.value?.diff ?? "", diff.value?.truncated ?? false, post, now);
      if (replied) acted = true;
    }
  }

  // 2. Nothing pushed since the last review: there is nothing new to say.
  if (s.headSha && s.headSha === pr.headSha) {
    if (pr.lastError) updateInspectorPr(pr.key, { lastError: null }, now);
    return acted;
  }

  const reviewed = await reviewRound(cfg, pr, s, rows, post, now);
  return acted || reviewed;
}

async function answerFollowUp(
  pr: InspectorPr,
  w: ReturnType<typeof threadsAwaitingUs>[number],
  diff: string,
  diffTruncated: boolean,
  post: boolean,
  now: number,
): Promise<boolean> {
  const brief = readBrief(pr.repoRoot);
  const first = w.thread.comments[0]!;
  const prompt = buildReplyPrompt({
    brief,
    original: { path: w.row.path, title: w.row.title, body: first.body },
    thread: w.thread.comments.map((c) => ({
      author: c.author,
      ours: parseMarker(c.body) !== null,
      body: c.body,
    })),
    diff,
    diffTruncated,
  });

  let text: string;
  try {
    text = await runClaudeText(prompt, {
      model: MODEL,
      timeoutMs: REPLY_TIMEOUT_MS,
      tools: REVIEW_TOOLS,
      cwd: pr.cwd ?? undefined,
      settings: DENY_SETTINGS,
    });
  } catch (err) {
    updateInspectorPr(pr.key, { lastError: `reply failed: ${String(err)}` }, now);
    return false;
  }

  const reply = scrubSecrets(unwrapResult(text).trim());
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

  if (post && w.newest.databaseId !== null) {
    const res = await replyToComment(pr.cwd, pr.owner, pr.repo, pr.number, w.newest.databaseId, body);
    if (!res.ok) {
      updateInspectorPr(pr.key, { lastError: res.error ?? "reply failed" }, now);
      return false;
    }
  }
  // Stamp AFTER the send, never before: a failed post that had already recorded the
  // answer would leave someone's question permanently unanswered and invisible.
  upsertInspectorComment({
    ...w.row,
    replies: w.row.replies + 1,
    answeredCommentId: w.newest.databaseId,
    threadId: w.thread.id,
    updatedAt: now,
  });
  return true;
}

async function reviewRound(
  cfg: InspectorConfig,
  pr: InspectorPr,
  s: PrSnapshot,
  rows: Map<string, InspectorComment>,
  post: boolean,
  now: number,
): Promise<boolean> {
  const diffRes = await fetchDiff(pr.cwd, pr.owner, pr.repo, pr.number, MAX_DIFF_BYTES);
  if (!diffRes.ok || !diffRes.value) {
    updateInspectorPr(pr.key, { lastError: diffRes.error ?? "could not read the diff" }, now);
    return false;
  }
  const { diff, truncated } = diffRes.value;
  const paths = changedPaths(diff);
  if (paths.length === 0) {
    // Nothing reviewable (an empty or purely-binary diff). Still advance the head, or
    // every tick forever would re-fetch and re-decide the same nothing.
    updateInspectorPr(pr.key, { headSha: s.headSha, lastReviewedAt: now, lastError: null }, now);
    return true;
  }

  const open = [...rows.values()].filter((c) => c.status === "open" || c.status === "drafted");
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

  const result = await runStructured<typeof InspectorVerdictSchema>(
    prompt,
    (raw) => parseModelJson(raw, InspectorVerdictSchema),
    "The inspector",
    {
      model: MODEL,
      timeoutMs: TIMEOUT_MS,
      tools: REVIEW_TOOLS,
      cwd: pr.cwd ?? undefined,
      settings: DENY_SETTINGS,
    },
  );
  if (result.kind !== "ok") {
    // A transient failure must NEVER advance the head sha: doing so would record this
    // push as reviewed and the PR would never be looked at again.
    updateInspectorPr(pr.key, { lastError: result.reason }, now);
    return false;
  }

  const round = pr.round + 1;
  const plan = planReview({
    mode: cfg.mode,
    maxComments: cfg.maxCommentsPerRound,
    round,
    verdict: result.value as InspectorVerdict,
    lines: commentableLines(diff),
    existing: rows,
    threads: ourThreads(s),
    newId: () => randomUUID(),
  });

  // Resolve BEFORE posting: the other order raises a fresh comment about an issue and
  // only then closes the old thread for the same issue, which reads as churn.
  for (const r of plan.resolve) {
    if (post) {
      const res = await resolveThread(pr.cwd, r.threadId);
      if (!res.ok) continue; // leave the row open; we'll try again next round
    }
    const row = rows.get(r.fingerprint);
    if (row) upsertInspectorComment({ ...row, status: "resolved", updatedAt: now });
  }

  const inline = plan.inline.map((c) => ({
    path: c.path,
    line: c.line!,
    body: renderComment(
      formatMarker({ id: c.id, fingerprint: c.fingerprint, round }),
      c,
    ),
  }));

  if (post && (inline.length > 0 || plan.demoted.length > 0)) {
    const res = await postReview(
      pr.cwd,
      pr.owner,
      pr.repo,
      pr.number,
      plan.body,
      inline,
      s.headSha,
    );
    if (!res.ok) {
      updateInspectorPr(pr.key, { lastError: res.error ?? "could not post the review" }, now);
      return false;
    }
  }

  // Learn the ids GitHub minted, by re-reading and matching on our own marker rather
  // than trusting response ordering. Best-effort: a row without an id simply can't be
  // replied to until the next tick reads it back.
  const ids = post ? await fetchReviewComments(pr.cwd, pr.owner, pr.repo, pr.number) : null;
  for (const c of [...plan.inline, ...plan.demoted]) {
    const prior = rows.get(c.fingerprint);
    upsertInspectorComment({
      id: c.id,
      prKey: pr.key,
      fingerprint: c.fingerprint,
      path: c.path,
      line: c.line,
      title: c.title,
      severity: c.severity,
      commentId: ids?.value?.get(c.fingerprint) ?? null,
      threadId: null,
      round,
      status: post ? "open" : "drafted",
      // A regression re-uses its original row, so the reply budget it already spent
      // stays spent - a thread that has been argued about six times is not made fresh
      // by the issue coming back.
      replies: prior?.replies ?? 0,
      answeredCommentId: prior?.answeredCommentId ?? null,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    });
  }

  updateInspectorPr(
    pr.key,
    { headSha: s.headSha, round, lastReviewedAt: now, lastError: null },
    now,
  );
  return true;
}

/** Unwrap the `--output-format json` envelope for a free-text run. */
function unwrapResult(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { result?: unknown };
    if (typeof parsed.result === "string") return parsed.result;
  } catch {
    // not the envelope - fall through and use it as-is
  }
  return raw;
}

/**
 * Start the Inspector.
 *
 * Costs NOTHING while disabled: the tick reads one config row and returns before it
 * touches the network, spawns a subprocess, or even loads the ledger.
 */
export function startInspector(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // One PR at a time. A review is an Opus run with tool round-trips inside it; a
  // dashboard with six open PRs must not fork six of them.
  const limit = createLimiter(1);

  // The hook's signal is transient - nothing persists it - so it has to be caught as it
  // happens rather than found later. See `adoptFromSessions` for the other half.
  const offPrOpened = registry.onPrOpened((e: PrOpened) => {
    if (!getInspectorConfig().enabled) return;
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
