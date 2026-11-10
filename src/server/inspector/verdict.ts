import { z } from "zod";
import { INSPECTOR_LIMITS } from "@shared/inspector.ts";
import type { InspectorComment, InspectorMode, InspectorSeverity } from "@shared/types.ts";
import { nullAsAbsent } from "../llm/json-schema.ts";
import type { CommentableLines } from "./diff-lines.ts";
import { BODY_ONLY_FINDINGS_MARKER, fingerprint, reviewHeader } from "./marker.ts";
import { scrubSecrets } from "./scrub.ts";

// What the reviewer is allowed to say, and what we actually do with it.
//
// Split deliberately into a Zod schema (what a well-formed reply looks like) and a
// PURE planner (what we do about it). Nothing here performs I/O, which is the point:
// the two rules that keep this feature from leaking secrets or spamming a PR are
// decisions, and decisions belong somewhere a test can call directly rather than
// buried in a function that also talks to GitHub.

/** Clamp rather than reject: a verbose sentence must not discard a good review. */
const clampTo =
  (max: number) =>
  (s: string): string =>
    s.length > max ? s.slice(0, max) : s;

const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;

export const InspectorVerdictSchema = z.object({
  summary: z.preprocess((v) => (typeof v === "string" ? clampTo(4000)(v) : v), z.string()),
  // `nullAsAbsent` because the provider schema carries this as a nullable required key:
  // "I found nothing" is a verdict the model must still be able to state, and under strict
  // Structured Outputs it states it with `null` rather than by omitting the key. Reading
  // that back as absence keeps `.default([])` - and so the `clean: true` below - intact.
  findings: nullAsAbsent(
    z
      .array(
        z.object({
          path: z.string().min(1),
          // The model is asked for the NEW-file line. Null is honest and useful ("this
          // is about the file, not a line"); a made-up number is not, so nullable rather
          // than required.
          line: z.number().int().positive().nullable().default(null),
          severity: z.enum(SEVERITIES),
          // Short, because it is half the fingerprint - a title that runs to a paragraph
          // makes the issue's identity unstable across rounds.
          title: z.preprocess(
            (v) => (typeof v === "string" ? clampTo(120)(v) : v),
            z.string().min(1),
          ),
          body: z.preprocess(
            (v) => (typeof v === "string" ? clampTo(4000)(v) : v),
            z.string().min(1),
          ),
        }),
      )
      .max(50)
      .default([]),
  ),
  /**
   * Fingerprints of previously-raised findings this push has addressed.
   *
   * Model-supplied, and the only model-supplied thing that closes a thread - which is
   * why the planner treats it as strictly narrowing: it can close a thread we own and
   * already told the model about, and it can do nothing else.
   *
   * `nullAsAbsent` keeps that narrowing fail-closed under a strict provider schema, where
   * the key is always present: `null` closes nothing, exactly as omitting it did.
   */
  resolved: nullAsAbsent(z.array(z.string()).max(50).default([])),
});
export type InspectorVerdict = z.infer<typeof InspectorVerdictSchema>;

/**
 * A follow-up answer in one of our own threads, and whether writing it settled the issue.
 *
 * `reply` used to be the whole contract - the model returned prose and we posted it. That
 * threw away the one judgment the reply is most likely to contain. The Inspector is told
 * (see `buildReplyPrompt`) to drop a finding when the author shows it was wrong, and it
 * does: on the pull request this schema was written for it answered "Dropping the finding"
 * and the ledger row stayed open forever, because the conversation and the ledger were two
 * independent opinions and only the REVIEW round could write to the second one. The review
 * round cannot correct that either - it returns early once the head has been reviewed - so
 * the finding blocked the merge for the life of the PR.
 *
 * `resolved` is that judgment made machine-readable, and it is strictly NARROWING in the
 * same sense `InspectorVerdict.resolved` is: it carries no fingerprint, so the only thing
 * it can close is the one thread being answered. A model that could name the issue would be
 * a model that could close any of them.
 *
 * Defaults to false. A reply that omits the field is an answer, not a retraction - the same
 * fail-closed reading the review round gives a finding the model merely stopped mentioning.
 * `nullAsAbsent` extends that reading to the `null` a strict provider schema sends in place
 * of an omission, so the fail-closed direction survives the field becoming always-present.
 */
export const InspectorReplySchema = z.object({
  reply: z.preprocess(
    (v) => (typeof v === "string" ? clampTo(4000)(v) : v),
    z.string().min(1),
  ),
  resolved: nullAsAbsent(z.boolean().default(false)),
});
export type InspectorReply = z.infer<typeof InspectorReplySchema>;

/** One of our existing threads on the PR, as read back from GitHub. */
export interface OurThread {
  fingerprint: string;
  threadId: string;
  isResolved: boolean;
}

/** A finding that survived every filter and is ready to become a comment. */
export interface PlannedComment {
  id: string;
  fingerprint: string;
  path: string;
  /** The line to anchor to, or null when the file offers none (see `snapToLine`). */
  line: number | null;
  severity: InspectorSeverity;
  title: string;
  body: string;
  /**
   * A draft from an earlier round that the model neither resolved nor raised again,
   * offered again by the planner rather than by the model. Only a carried comment can
   * have a GitHub refusal pinned on it: a finding the model raised this round is new.
   */
  carried?: true;
}

export interface ReviewPlan {
  /** Comments to attach to the review, in severity order. */
  inline: PlannedComment[];
  /** Findings with nowhere to anchor; folded into the review body instead. */
  demoted: PlannedComment[];
  /** The review's top-level body. Scrubbed, like everything else outbound. */
  body: string;
  /** Threads to resolve, before anything is posted. */
  resolve: { fingerprint: string; threadId: string }[];
  /**
   * Findings to close in the LEDGER with no thread to close on GitHub.
   *
   * Two things land here, and both were previously stuck open forever. A dry-run
   * finding was never posted, so it has no thread - and dry-run is the mode the README
   * tells the operator to evaluate the feature in, where a monotonically growing open
   * count is the only thing they can read. A demoted finding (nowhere to anchor, folded
   * into the review body) has no thread either, in live mode.
   */
  resolveLocal: string[];
  /** Findings discarded because they named a file this PR never touched (layer 4). */
  droppedOffDiff: number;
  /** Findings discarded by the per-round cap. */
  droppedOverCap: number;
  /** The model explicitly reported no findings; prior findings are checked by the caller. */
  clean: boolean;
}

export interface PlanInput {
  mode: InspectorMode;
  /**
   * Whether this round will actually publish: the worker's live posture, which also needs
   * the repository on the allowlist, and not just `mode`. Only a live round carries drafts.
   */
  live: boolean;
  /**
   * Fingerprints of the open rows the review prompt listed (`promptedOpenRows`). A draft is
   * carried only when it is here: the model is asked to resolve a draft the push fixed, and
   * it cannot do that for one the prompt cut for length.
   */
  prompted: ReadonlySet<string>;
  maxComments: number;
  /** The round being planned - stamped into each new row and each marker. */
  round: number;
  verdict: InspectorVerdict;
  /** Commentable right-side lines per path, from this PR's diff. */
  lines: CommentableLines;
  /** Our existing ledger rows for this PR, keyed by fingerprint. */
  existing: Map<string, InspectorComment>;
  /** Our threads as they currently stand on GitHub, keyed by fingerprint. */
  threads: Map<string, OurThread>;
  /** Injected so the planner stays deterministic under test. */
  newId: () => string;
}

/** Shared with the prompt builder, which keeps the most severe rows when it must cut. */
export const SEVERITY_RANK: Record<InspectorSeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/**
 * The commentable line closest to `want` in `path`.
 *
 * A model asked for a line number will sometimes give one that isn't in the diff, and
 * GitHub rejects an entire review over a single such comment. Snapping to the nearest
 * valid line keeps the finding as a real, resolvable thread rather than demoting it
 * into prose - it lands a few lines off, which is a far smaller loss than a finding
 * that can never be tracked or closed.
 */
function snapToLine(lines: Set<number>, want: number | null): number | null {
  if (lines.size === 0) return null;
  if (want !== null && lines.has(want)) return want;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const l of lines) {
    const dist = want === null ? l : Math.abs(l - want);
    if (dist < bestDist) {
      bestDist = dist;
      best = l;
    }
  }
  return best;
}

/**
 * Decide what to post and what to close, given a verdict and everything already on the
 * PR. Pure.
 *
 * Two of the five leak-defence layers live here, and they live here rather than in the
 * poster so that they are reachable from a test without a network:
 *
 *  - **Layer 4**: a finding whose `path` is not a file this PR touched is DROPPED. This
 *    is the structural answer to a diff that tries to talk the reviewer into reading a
 *    secret and repeating it - the resulting comment is about a file the PR never
 *    changed, and there is nowhere for it to land.
 *  - **Layer 5**: every outbound string goes through `scrubSecrets`, including the
 *    summary, which layer 4 does not constrain because it is not path-anchored.
 *
 * Dedup, resolution and the cap are the rest of it:
 *  - An issue already `open` is not posted again, however the model reworded it.
 *  - An issue `resolved` earlier and raised again IS posted - that is a regression, and
 *    the ledger's unique index lets the row come back rather than blocking it.
 *  - A `drafted` row is a dry-run preview: still unposted, so switching to live posts
 *    it - when the model raises it again, as a new finding, and otherwise as a carried
 *    draft (`carriedDrafts`). Without this, dry-run would permanently swallow everything
 *    it previewed.
 *  - Resolution is narrowing only, and never contradicts a live finding: if the model
 *    both closes a fingerprint and raises it again this round, the raise wins. It is
 *    split into the threads to close on GitHub and the rows to close only here
 *    (`resolveLocal`), because a dry-run or demoted finding has no thread and would
 *    otherwise be permanently unclosable.
 */
export function planReview(input: PlanInput): ReviewPlan {
  const { verdict, lines, existing, threads, mode, round } = input;

  const raised = new Set<string>();
  const candidates: PlannedComment[] = [];
  let droppedOffDiff = 0;

  for (const f of verdict.findings) {
    const path = f.path.replace(/^\.?\//, "");
    const fileLines = lines.get(path);
    // Layer 4. Not a warning, not a demotion - a drop.
    if (!fileLines) {
      droppedOffDiff++;
      continue;
    }
    // Layer 5, on the title as well as the body. `renderComment` interpolates the title
    // into every published inline comment, so a credential-shaped string in a 120-char
    // title would go out verbatim while the body beside it was cleaned. Scrubbed BEFORE
    // the fingerprint so the issue's identity is the one that actually gets published.
    const title = scrubSecrets(f.title);
    const fp = fingerprint(path, title);
    if (raised.has(fp)) continue; // the model said the same thing twice
    raised.add(fp);

    const prior = existing.get(fp);
    // Already surfaced and still open: leave it be. Re-posting is how an automated
    // reviewer becomes noise. `posting` counts as surfaced too - it means a review
    // carrying this finding was handed to GitHub and we do not know whether the
    // response was lost, so raising it again risks a duplicate PUBLIC comment.
    if (prior && (prior.status === "open" || prior.status === "posting")) continue;

    candidates.push({
      id: prior?.id ?? input.newId(),
      fingerprint: fp,
      path,
      line: snapToLine(fileLines, f.line),
      severity: f.severity,
      title,
      body: scrubSecrets(f.body),
    });
  }

  if (input.live) candidates.push(...carriedDrafts(input, raised));

  // Most severe first, and at equal severity what the model said THIS round before what it
  // said earlier, so a carried draft never pushes a new finding of its own rank over the cap.
  candidates.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      || Number(a.carried ?? false) - Number(b.carried ?? false),
  );
  const kept = candidates.slice(0, input.maxComments);
  const droppedOverCap = candidates.length - kept.length;

  // A file whose diff is pure deletion has no right-side line to anchor to. Rare, but
  // the finding is still worth saying, so it goes in the body rather than being lost.
  const inline = kept.filter((c) => c.line !== null);
  const demoted = kept.filter((c) => c.line === null);

  const resolve: { fingerprint: string; threadId: string }[] = [];
  const resolveLocal: string[] = [];
  for (const fp of verdict.resolved) {
    if (raised.has(fp)) continue; // it also raised this - the raise wins
    const thread = threads.get(fp);
    if (thread && !thread.isResolved) {
      resolve.push({ fingerprint: fp, threadId: thread.threadId });
      continue;
    }
    // No thread to close, or one already closed. Closing the LEDGER row is still the
    // right answer whenever we have one that is still counted as open - otherwise a
    // finding the next push fixed stays open for the life of the PR, and (because the
    // planner will not re-raise an open row) it is never spoken about again either.
    const row = existing.get(fp);
    if (row && row.status !== "resolved") resolveLocal.push(fp);
  }

  return {
    inline,
    demoted,
    body: scrubSecrets(reviewBody(verdict.summary, demoted, droppedOverCap, mode, round)),
    resolve,
    resolveLocal,
    droppedOffDiff,
    droppedOverCap,
    clean: verdict.findings.length === 0,
  };
}

/**
 * Drafts from earlier rounds to offer again in a live round.
 *
 * A `drafted` row is a finding that never reached GitHub: drafted in dry run, on a
 * repository not on the allowlist, or refused. After a switch to live the review prompt
 * lists it under "Found earlier but never posted" and asks the model only whether this push
 * fixed it, so posting it falls to this function, deterministically, through the same checks
 * a new finding gets:
 *
 *  - the prompt listed it (`input.prompted`), so the model had the chance to resolve it;
 *  - the model neither resolved it nor raised it again (a raise is a new finding, posted by
 *    the loop above, and the refusal cap does not apply to it);
 *  - its path is still in this diff (layer 4), and its line snaps to a commentable one. A
 *    draft whose file has left the diff stays drafted and is not posted;
 *  - GitHub has refused it fewer than `INSPECTOR_LIMITS.maxPostRefusals` times;
 *  - it has a body to post. A row written before bodies were persisted has none.
 *
 * Title and body are scrubbed again even though they were scrubbed when first planned: the
 * check is cheap and it is the outbound boundary. The id and fingerprint are the row's own,
 * so the posted marker names the row it came from.
 */
function carriedDrafts(input: PlanInput, raised: Set<string>): PlannedComment[] {
  const resolved = new Set(input.verdict.resolved);
  const out: PlannedComment[] = [];
  for (const row of input.existing.values()) {
    if (row.status !== "drafted") continue;
    if (!input.prompted.has(row.fingerprint)) continue;
    if (raised.has(row.fingerprint) || resolved.has(row.fingerprint)) continue;
    if ((row.postRefusals ?? 0) >= INSPECTOR_LIMITS.maxPostRefusals) continue;
    if (row.path === null || row.body === null) continue;
    const fileLines = input.lines.get(row.path);
    if (!fileLines) continue;
    const line = snapToLine(fileLines, row.line);
    if (line === null) continue;
    out.push({
      id: row.id,
      fingerprint: row.fingerprint,
      path: row.path,
      line,
      severity: row.severity,
      title: scrubSecrets(row.title),
      body: scrubSecrets(row.body),
      carried: true,
    });
  }
  return out;
}

/**
 * The review's top-level body: the summary, anything that couldn't be anchored, and -
 * when the cap bit - the fact that it did.
 *
 * Saying so matters. A silent truncation reads as "that's everything I found", which
 * is the one thing a reviewer must never imply when it isn't true.
 */
function reviewBody(
  summary: string,
  demoted: PlannedComment[],
  droppedOverCap: number,
  mode: InspectorMode,
  round: number,
): string {
  const parts = [reviewHeader(round), "", summary.trim()];
  if (demoted.length) {
    parts.push("", "---", "");
    for (const d of demoted) {
      parts.push(`- **${d.path}** · \`${d.severity}\` - ${d.title}`, "", `  ${d.body}`, "");
    }
    // These have no GitHub thread to resolve. Persist that fact on the review itself
    // so a wiped local ledger cannot later turn an unknown into a merge-safe claim.
    parts.push(BODY_ONLY_FINDINGS_MARKER);
  }
  if (droppedOverCap > 0) {
    parts.push(
      "",
      `_${droppedOverCap} lower-severity finding${droppedOverCap === 1 ? "" : "s"} ` +
        `${droppedOverCap === 1 ? "was" : "were"} held back to keep this review readable._`,
    );
  }
  if (mode === "dry-run") {
    parts.push("", "_(dry run - this review was not posted)_");
  }
  return parts.join("\n");
}
