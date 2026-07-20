import { z } from "zod";
import type { InspectorComment, InspectorMode, InspectorSeverity } from "@shared/types.ts";
import type { CommentableLines } from "./diff-lines.ts";
import { fingerprint } from "./marker.ts";
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
  findings: z
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
        title: z.preprocess((v) => (typeof v === "string" ? clampTo(120)(v) : v), z.string().min(1)),
        body: z.preprocess((v) => (typeof v === "string" ? clampTo(4000)(v) : v), z.string().min(1)),
      }),
    )
    .max(50)
    .default([]),
  /**
   * Fingerprints of previously-raised findings this push has addressed.
   *
   * Model-supplied, and the only model-supplied thing that closes a thread - which is
   * why the planner treats it as strictly narrowing: it can close a thread we own and
   * already told the model about, and it can do nothing else.
   */
  resolved: z.array(z.string()).max(50).default([]),
});
export type InspectorVerdict = z.infer<typeof InspectorVerdictSchema>;

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
  /** Findings discarded because they named a file this PR never touched (layer 4). */
  droppedOffDiff: number;
  /** Findings discarded by the per-round cap. */
  droppedOverCap: number;
}

export interface PlanInput {
  mode: InspectorMode;
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

const SEVERITY_RANK: Record<InspectorSeverity, number> = {
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
 *    it. Without this, dry-run would permanently swallow everything it previewed.
 *  - Resolution is narrowing only, and never contradicts a live finding: if the model
 *    both closes a fingerprint and raises it again this round, the raise wins.
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
    const fp = fingerprint(path, f.title);
    if (raised.has(fp)) continue; // the model said the same thing twice
    raised.add(fp);

    const prior = existing.get(fp);
    // Already surfaced and still open: leave it be. Re-posting is how an automated
    // reviewer becomes noise.
    if (prior && prior.status === "open") continue;

    candidates.push({
      id: prior?.id ?? input.newId(),
      fingerprint: fp,
      path,
      line: snapToLine(fileLines, f.line),
      severity: f.severity,
      title: f.title,
      body: scrubSecrets(f.body),
    });
  }

  candidates.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const kept = candidates.slice(0, input.maxComments);
  const droppedOverCap = candidates.length - kept.length;

  // A file whose diff is pure deletion has no right-side line to anchor to. Rare, but
  // the finding is still worth saying, so it goes in the body rather than being lost.
  const inline = kept.filter((c) => c.line !== null);
  const demoted = kept.filter((c) => c.line === null);

  const resolve: { fingerprint: string; threadId: string }[] = [];
  for (const fp of verdict.resolved) {
    const thread = threads.get(fp);
    if (!thread || thread.isResolved) continue; // not ours, or already closed
    if (raised.has(fp)) continue; // it also raised this - the raise wins
    resolve.push({ fingerprint: fp, threadId: thread.threadId });
  }

  return {
    inline,
    demoted,
    body: scrubSecrets(reviewBody(verdict.summary, demoted, droppedOverCap, mode, round)),
    resolve,
    droppedOffDiff,
    droppedOverCap,
  };
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
  const parts = [`**⌕ Inspector** · round ${round}`, "", summary.trim()];
  if (demoted.length) {
    parts.push("", "---", "");
    for (const d of demoted) {
      parts.push(`- **${d.path}** · \`${d.severity}\` - ${d.title}`, "", `  ${d.body}`, "");
    }
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
