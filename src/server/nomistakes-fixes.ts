import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { run } from "./util/exec.ts";
import { sourceRef } from "./diff.ts";
import { gateRepliesFor } from "./db.ts";
import type { GateReplyRow } from "./db.ts";
import type {
  NmFixAttribution,
  NmFixDecision,
  NmFixDetail,
  NmFixFile,
  NmFixFinding,
  NmFixSummary,
} from "@shared/types.ts";

// The log of what no-mistakes actually changed on a branch, and why.
//
// Built by joining two sources that already exist, rather than by recording
// anything new:
//
//   git   - every fix self-commits as `no-mistakes(<step>): <summary>`, so the
//           list of fixes IS `git log <base>..HEAD --grep '^no-mistakes'`.
//   nm db - each `step_rounds` row holds the findings that justified the fix and
//           the reply that authorized it, keyed by a `fix_summary` that is
//           character-for-character the commit subject after the prefix.
//   ours  - `gate_replies`, the one thing no-mistakes cannot tell us: WHO wrote
//           that reply. It records only what we witnessed ourselves (the Fix box
//           typing, the foreman nudging a pane), so it names an author when there
//           is one to name and stays quiet otherwise - most replies come from the
//           agent driving its own gate, which we never saw.
//
// Driven FROM git, never from the rounds: a round can record a fix_summary and
// commit nothing (the lint step does this constantly - "typecheck clean, no
// fixes needed"), so git is what proves a fix changed code and the database only
// explains it. A commit with no matching round still lists, just without context.
//
// This is why the log needs no reset bookkeeping: `git reset --hard origin/main`
// destroys the commits, so the log empties itself.

/** Most fixes to list per branch. A long-lived branch is not a reason to hang. */
const MAX_FIXES = 50;
/** Most findings to carry per fix. The live 22-finding case is already extreme. */
const MAX_FINDINGS = 40;
/** Most per-file rows to carry per fix. */
const MAX_FILES = 60;
/** Descriptions run 500-900 chars; this is a sanity bound, not a display clamp. */
const MAX_DESCRIPTION = 2000;
/** The reply is one text for the whole fix, but it can be an essay. */
const MAX_REPLY = 4000;

function git(cwd: string, args: string[]): ReturnType<typeof run> {
  return run("git", ["-C", cwd, ...args], { timeoutMs: 15000 });
}

/** The no-mistakes state dir: NM_HOME wins, else ~/.no-mistakes (matching paths.New). */
function nmDbPath(): string {
  const root = process.env.NM_HOME || join(homedir(), ".no-mistakes");
  return join(root, "state.sqlite");
}

/** The commit subject shape every fix commits under (deterministicFixCommitMessage). */
const FIX_SUBJECT = /^no-mistakes\(([^)]+)\):\s*(.+)$/;

/** Parse `no-mistakes(review): fix(queue): thing` -> step "review", summary "fix(queue): thing". */
export function parseFixSubject(subject: string): { step: string; summary: string } | null {
  const m = subject.trim().match(FIX_SUBJECT);
  if (!m) return null;
  const step = m[1]!.trim();
  const summary = m[2]!.trim();
  if (!step || !summary) return null;
  return { step, summary };
}

export interface FixCommit {
  sha: string;
  step: string;
  summary: string;
  committedAt: number;
  files: NmFixFile[];
  filesChanged: number;
  added: number;
  removed: number;
}

// Record-separated so a summary containing our field separator can't split a row.
const REC = "\x00";
const FIELD = "\x1f";
/**
 * The separators are written as git's own `%x00`/`%x1f` escapes rather than as
 * literal control bytes: Node rejects argv strings containing NUL outright, so
 * git has to be the one that expands them.
 */
const FORMAT = `--format=%x00%h%x1f%ct%x1f%s`;

/**
 * Parse `git log --format=<REC>%h<FIELD>%ct<FIELD>%s --numstat` output.
 *
 * Exported for tests: the shapes that matter (binary files as `-`/`-`, rename
 * arrows, a summary containing `: `) are easier to pin here than through git.
 */
export function parseFixLog(stdout: string): FixCommit[] {
  const out: FixCommit[] = [];
  for (const chunk of stdout.split(REC)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const [sha, ct, ...rest] = (lines.shift() ?? "").split(FIELD);
    const subject = rest.join(FIELD); // a subject can't contain FIELD, but don't lose it if it does
    if (!sha || !subject) continue;
    const parsed = parseFixSubject(subject);
    if (!parsed) continue; // --grep is a prefilter; this is the real gate

    const files: NmFixFile[] = [];
    let added = 0;
    let removed = 0;
    let filesChanged = 0;
    for (const line of lines) {
      // `<added>\t<removed>\t<path>`, where a binary file reports `-` for both.
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      filesChanged++;
      const a = m[1] === "-" ? 0 : Number(m[1]);
      const r = m[2] === "-" ? 0 : Number(m[2]);
      added += a;
      removed += r;
      if (files.length < MAX_FILES) files.push({ path: m[3]!, added: a, removed: r });
    }
    // `filesChanged` stays the true count, so the card never claims a fix touched
    // fewer files than it did just because we stopped listing their names.
    if (filesChanged > MAX_FILES) {
      console.warn(
        `[nomistakes] fix ${sha}: listing ${MAX_FILES} of ${filesChanged} files (cap)`,
      );
    }

    out.push({
      sha,
      step: parsed.step,
      summary: parsed.summary,
      committedAt: Number(ct) * 1000,
      files,
      filesChanged,
      added,
      removed,
    });
  }
  return out;
}

/** The fix commits on this checkout's branch, newest first. */
async function listFixes(cwd: string): Promise<FixCommit[]> {
  const ref = await sourceRef(cwd);
  // No source ref means no shared history to bound the log; listing every commit
  // on an unbounded history would be both slow and wrong, so report nothing.
  if (!ref) return [];
  const res = await git(cwd, [
    "log",
    `${ref}..HEAD`,
    // The pattern carries no metacharacter on purpose. `(` is literal in basic
    // regex but opens a group in extended and perl, and which one git uses is the
    // USER's choice (`grep.patternType`) - so `^no-mistakes(` dies with
    // "parentheses not balanced" on their machine and not on ours. Escaping only
    // moves the failure between modes, since basic regex spells a group `\(`.
    // Dropping the paren means the same thing in all three; --basic-regexp then
    // pins the mode regardless of config, and parseFixSubject is the real gate.
    "--basic-regexp",
    "--grep=^no-mistakes",
    FORMAT,
    "--numstat",
    // One MORE than the cap, so hitting the cap is something we detect rather
    // than infer: at exactly MAX_FIXES you can't tell "50 fixes" from "50 shown
    // of more", and a log that quietly drops the tail reads as complete.
    `--max-count=${MAX_FIXES + 1}`,
  ]);
  if (res.code !== 0) {
    // Never silently: an empty log renders as "the pipeline changed nothing",
    // which is what a failed read would claim too. Those must not look alike.
    console.warn(
      `[nomistakes] ${cwd}: cannot read the fix log (git exited ${res.code}): ${res.stderr.trim()}`,
    );
    return [];
  }
  const all = parseFixLog(res.stdout);
  if (all.length > MAX_FIXES) {
    console.warn(
      `[nomistakes] ${cwd}: ${all.length - MAX_FIXES}+ fix(es) beyond the ${MAX_FIXES} cap are not listed`,
    );
    return all.slice(0, MAX_FIXES);
  }
  return all;
}

interface RoundContext {
  decision: NmFixDecision;
  reply: string | null;
  findings: NmFixFinding[];
  /** True count, before MAX_FINDINGS - so the card can say "40 of 50 shown". */
  findingCount: number;
  /** The run this fix's round belongs to. Half the key the byline joins on. */
  runId: string;
  /**
   * When this fix's gate was open, off no-mistakes' round clock. See `ReplyWindow`.
   *
   * Null when either round's `created_at` was unreadable, which costs the byline and
   * not the log - the same trade the rest of this file makes.
   */
  window: ReplyWindow | null;
  /**
   * Every finding id the DECIDING round reported - uncapped, and independent of
   * which side (`findings` above) we ended up displaying.
   *
   * The byline's tiebreak between two replies inside one `window`. Uncapped because a
   * capped set silently weakens the match rather than the display, and untangled
   * from `findings` because that list is narrowed to what was ACTED on, while a
   * reply's ids are drawn from everything that was up at the gate.
   */
  roundFindingIds: string[];
}

/**
 * The span in which a reply to a fix's gate must have been filed.
 *
 * Bounded by no-mistakes' OWN round clock, and pointedly not by git's. A fix's
 * `committedAt` is `%ct`, which this very pipeline REWRITES: `axi run` rebases before
 * it pushes, re-stamping every replayed fix with the rebase's own committer time. Two
 * fixes minutes apart during the run then share one second, and any ordering read off
 * them collapses silently. The round rows are rows in a database - a rebase cannot
 * reach them - so bracketing against those makes the byline rebase-immune by
 * construction rather than by tolerance.
 *
 * What makes the bracket exact is WHEN the executor writes a round: after the step
 * returns (the same fact `RETRY_MS` below exists for). So:
 *
 *   after  - the DECIDING round's `created_at`. Its review had just returned the
 *            findings, so this is the moment the gate parked, and the first moment
 *            anyone could have answered it.
 *   before - the FIX round's `created_at`. The fix had run by then, so a reply filed
 *            later cannot have caused it.
 *
 * A reply to that gate necessarily falls strictly between the two. Both bounds are
 * whole seconds and real rounds sit 11-79 minutes apart, so that granularity is
 * immaterial and wants no tolerance - the tolerance this design replaced existed for
 * `%ct`'s flooring, and `%ct` no longer has a say here.
 */
export interface ReplyWindow {
  /** When the gate parked: the deciding round returned its findings. Milliseconds. */
  after: number;
  /** When the fix had run: the fix round returned. Milliseconds. */
  before: number;
}

/**
 * The reply that best explains a fix, out of every reply filed against its gate.
 *
 * Pure, and exported for tests: the cases that matter (two rounds of one step, a
 * re-run round with an identical finding set, an unreadable blob leaving no ids)
 * are all about which candidate wins, which is invisible from the outside.
 *
 * Two rules, in order:
 *  1. THE WINDOW. A reply outside it answered a different gate - filed before this one
 *     parked, or after its fix had already run. This runs first and carries the join,
 *     so the ids below only ever break a tie WITHIN one gate's lifetime.
 *  2. OVERLAP, then RECENCY. A window can still hold more than one reply - you answered
 *     twice, or a foreman nudge landed before your dashboard reply - so prefer the one
 *     whose finding ids overlap this round's most, and REJECT one that shares none when
 *     both sides had ids to compare. Ties, and rounds we could read no ids for, fall
 *     back to the newest: the plain "who spoke last before this landed".
 *
 * Ids confirm here; they do not carry. They are semantic slugs rather than per-round
 * handles ("zero-overlap-misattribution", "prune-redundant-count"), so a finding that
 * SURVIVES a fix returns under the SAME id at the next round - which makes two rounds
 * of one (run, step), the case ids exist to separate, the likeliest of all to share
 * one. That is why the window and not the ids is what keeps rounds apart.
 *
 * Ids, never `findingsDigest`: descriptions arrive TRUNCATED by `axi status` (600 runes
 * plus a "… (truncated, %d chars total)" suffix), so a digest of them would bind this
 * join to another tool's display constants, failing silently and invisibly the day
 * either moved. Ids are short, stable and never truncated.
 */
export function pickGateReply(
  replies: GateReplyRow[],
  roundFindingIds: string[],
  window: ReplyWindow,
): GateReplyRow | null {
  // Both bounds STRICT, which is what makes a collapsed window admit nothing - and it
  // does collapse, for a real case rather than a defensive one: a round-1 fix decides
  // and fixes inside a single round, so `after` and `before` are the same row's stamp.
  // `document` and `lint` do their work on first execution, and such rounds DO record
  // `selection_source = user` (3 of them on this machine), so they read as `replied`
  // and reach here rather than being turned away as `auto` upstream. One timestamp
  // taken after the fix had run orders nothing, so they get no byline - the honest
  // answer, and one this filter already gives. Nothing else is needed to say it: a
  // second guard restating the same thing is how the byline collected its bugs.
  const caused = replies.filter((r) => r.ts > window.after && r.ts < window.before);
  if (caused.length === 0) return null;
  const round = new Set(roundFindingIds);
  let best: GateReplyRow | null = null;
  let bestOverlap = -1;
  for (const r of caused) {
    const overlap = round.size === 0 ? 0 : r.findingIds.filter((id) => round.has(id)).length;
    // Sharing NOTHING when both sides had ids to compare is positive evidence of a
    // different round, not an absence of evidence - we read this round's ids, we
    // read the candidate's, and they disagree - so it disqualifies the candidate
    // outright rather than falling through to recency. Ids missing from EITHER side
    // are the genuine "we cannot tell" the recency half of rule 2 exists for, and
    // still fall back to it.
    if (round.size > 0 && r.findingIds.length > 0 && overlap === 0) continue;
    // `>=` on a tie, over a list already sorted oldest-first: the later reply wins,
    // which is rule 3. A strict `>` would keep the earliest instead and explain a
    // fix with a superseded decision.
    if (overlap > bestOverlap || (overlap === bestOverlap && r.ts >= (best?.ts ?? 0))) {
      best = r;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * Rounds the last `loadRoundContext` pulled from the database.
 *
 * A test seam, and the only way to see the narrowing that matters. Keeping the
 * read proportional to the BRANCH is invisible in the output: whatever the SQL
 * returns, the (step, summary) key re-filters it to the same answer, so dropping
 * `AND r.fix_summary IN (...)` reads the repo's entire round history and still
 * produces a log that looks right. Only the size of the read tells them apart.
 *
 * Last-write-wins, so it means nothing when logs are read concurrently (the
 * poller does). Nothing outside tests reads it.
 */
let roundsRead = 0;

/** Rounds the last `loadRoundContext` read. See `roundsRead`. Test seam. */
export function lastRoundsRead(): number {
  return roundsRead;
}

/** Join key. A summary is unique per (branch, step) in practice; scope covers the rest. */
function key(step: string, summary: string): string {
  return `${step}\x00${summary}`;
}

/**
 * A `step_rounds.created_at` as milliseconds, or null when it isn't readable.
 *
 * Two clocks meet in the byline's window and they are NOT in the same unit:
 * no-mistakes stamps `created_at` in whole SECONDS, while our own `gate_replies.ts`
 * is `Date.now()`, in milliseconds. Verified against live data - the newest
 * `created_at` is 1784141997, which reads as today as seconds and as 1970 as millis.
 *
 * Named rather than left as a `* 1000` inside the comparison because getting it wrong
 * fails SILENTLY and totally: every reply's `ts` (~1.78e12) is a thousand times every
 * `created_at` (~1.78e9), so an unconverted upper bound rejects every reply ever filed
 * and the byline vanishes from the product without one error to explain it - which is
 * exactly the failure this design exists to stop making. Pinned by "the byline reads
 * no-mistakes' round clock in seconds and its own in milliseconds".
 */
function roundMs(createdAt: unknown): number | null {
  const seconds = Number(createdAt);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Pull `findings` out of a findings_json blob. The shape is
 * `{findings: [{id, severity, file, line, description, action, user_instructions}]}`.
 * Defensive throughout: this is another tool's private schema, so anything
 * unexpected degrades to "no context" rather than throwing.
 *
 * `only` restricts to a set of finding ids, for the auto-fix case where the
 * round reported more than it actually fixed.
 */
function parseFindings(
  raw: string | null,
  only?: Set<string> | null,
): { findings: NmFixFinding[]; reply: string | null; total: number } {
  const none = { findings: [], reply: null, total: 0 };
  if (!raw) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return none;
  }
  const items = (parsed as { findings?: unknown })?.findings;
  if (!Array.isArray(items)) return none;

  const findings: NmFixFinding[] = [];
  let reply: string | null = null;
  let total = 0;
  for (const it of items) {
    const f = it as Record<string, unknown>;
    const id = typeof f.id === "string" ? f.id : "";
    if (only && !only.has(id)) continue;
    // no-mistakes copies the `--instructions` text onto EVERY selected finding,
    // so it's one reply repeated N times. Take the first and drop the rest.
    if (reply === null && typeof f.user_instructions === "string" && f.user_instructions.trim()) {
      reply = clamp(f.user_instructions.trim(), MAX_REPLY);
    }
    const description = typeof f.description === "string" ? f.description : "";
    if (!id && !description) continue;
    // Counted before the cap: the card states how many findings justified a fix,
    // and that number has to be the real one even when we stop carrying their text.
    total++;
    if (findings.length >= MAX_FINDINGS) continue;
    findings.push({
      id,
      severity: typeof f.severity === "string" ? f.severity : "",
      file: typeof f.file === "string" ? f.file : "",
      line: typeof f.line === "number" && f.line > 0 ? f.line : null,
      description: clamp(description, MAX_DESCRIPTION),
    });
  }
  if (total > findings.length) {
    console.warn(`[nomistakes] carrying ${findings.length} of ${total} findings (cap)`);
  }
  return { findings, reply, total };
}

/**
 * Every finding id in a findings_json blob, uncapped and in file order.
 *
 * Separate from `parseFindings` on purpose: that one caps its list for display
 * and narrows to what was acted on, and both are exactly wrong for a join key.
 * Same defensiveness - another tool's private schema, so a bad blob costs the
 * byline, not the log.
 */
function findingIdsOf(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const items = (JSON.parse(raw) as { findings?: unknown })?.findings;
    if (!Array.isArray(items)) return [];
    return items
      .map((it) => (it as Record<string, unknown>)?.id)
      .filter((id): id is string => typeof id === "string" && id !== "");
  } catch {
    return [];
  }
}

/** Parse a `selected_finding_ids` JSON array into a set, or null when absent. */
function parseSelected(raw: unknown): Set<string> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids) || ids.length === 0) return null;
    return new Set(ids.filter((i): i is string => typeof i === "string"));
  } catch {
    return null;
  }
}

/**
 * The repo row id for this checkout, or null. Sessions usually run in a worktree,
 * whose path is NOT `repos.working_path` - the main checkout is. `--git-common-dir`
 * resolves a worktree to the main repo's `.git`, whose parent is that path.
 */
async function repoIdFor(db: DatabaseSync, cwd: string): Promise<string | null> {
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0 || !common.stdout.trim()) return null;
  const root = dirname(common.stdout.trim());
  try {
    const row = db.prepare("SELECT id FROM repos WHERE working_path = ?").get(root) as
      | { id?: string }
      | undefined;
    return typeof row?.id === "string" ? row.id : null;
  } catch {
    return null;
  }
}

/**
 * Context for the given fix commits, keyed by (step, summary).
 *
 * Scoped to the commits we're actually explaining. The work here is bounded by
 * the BRANCH, not by the repo's history: a repo accumulates fix rounds forever
 * (67 already, against 6 fixes on a live branch) and each round carries ~20KB of
 * json, so resolving them all to use a handful gets steadily more wasteful as the
 * repo ages while the branch stays small.
 *
 * Reads no-mistakes' own sqlite READ-ONLY. This is a private schema with no
 * compatibility promise (`axi` is the supported surface, and it does not expose
 * rounds at all - findings are emitted only while parked at a gate, so an
 * auto-fix round's justification never appears there). So every step here fails
 * soft: a missing db, a moved column, or a bad blob costs the *why*, never the
 * log itself.
 */
async function loadRoundContext(
  cwd: string,
  branch: string,
  commits: FixCommit[],
): Promise<Map<string, RoundContext>> {
  const out = new Map<string, RoundContext>();
  roundsRead = 0;
  const path = nmDbPath();
  if (!branch || commits.length === 0 || !existsSync(path)) return out;

  // What we actually need context for. `summaries` narrows the SQL; `wanted`
  // then enforces the full (step, summary) key, since two steps could in
  // principle land the same summary.
  const summaries = [...new Set(commits.map((c) => c.summary))];
  const wanted = new Set(commits.map((c) => key(c.step, c.summary)));

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return out; // locked, corrupt, or a schema we can't open - the log still works
  }
  try {
    const repoId = await repoIdFor(db, cwd);
    // Scope by REPO, not by branch. A fix commit outlives the branch it was made
    // on: `axi run` rebases, branches get renamed, and work gets carried forward,
    // so the round that explains a commit on this branch was very often recorded
    // under an older one. Verified: "fix(queue): drafts surface, scope anchors
    // once" sits on mancej/session-work-queue-impl but its round is filed under
    // mancej/cite-idle-nudge-evidence. Branch-scoping silently dropped the context
    // for two thirds of a real branch's fixes.
    //
    // Repo alone is specific enough: the key is (step, summary), and a summary is
    // a whole English sentence the agent wrote. Only fall back to branch-scoping
    // when the repo can't be resolved, since matching a summary across unrelated
    // repos would be a genuine mix-up.
    //
    // Pass 1: only the rounds that committed one of THESE fixes. Deliberately does
    // not select the json blobs - a findings_json runs ~20KB, and narrowing by
    // summary here is what keeps the whole read proportional to the branch.
    const scope = repoId ? "n.repo_id = ?" : "n.branch = ?";
    const holes = summaries.map(() => "?").join(",");
    const fixSql = `
      SELECT s.step_name AS step, r.fix_summary AS summary,
             r.step_result_id AS stepResultId, r.round AS round,
             s.run_id AS runId, r.created_at AS fixedAt
      FROM step_rounds r
      JOIN step_results s ON s.id = r.step_result_id
      JOIN runs n ON n.id = s.run_id
      WHERE ${scope}
        AND r.fix_summary IN (${holes})
      ORDER BY r.created_at ASC`;
    // Ascending, so when a summary repeats across runs the newest wins the key -
    // the most recent telling of that fix is the one most likely to be on HEAD.
    const fixRows = db.prepare(fixSql).all(repoId ?? branch, ...summaries) as Array<
      Record<string, unknown>
    >;
    roundsRead = fixRows.length;

    // Pass 2: the round that DECIDED each fix.
    //
    // This offset is the whole subtlety of the join. A round records the findings
    // *it* produced. So a round carrying a fix_summary at round >= 2 is the round
    // that RAN the fix, and its own findings are the re-review afterwards - the
    // justification for the NEXT fix, not this one. What caused this commit is on
    // round-1, where the executor wrote the selection (SetStepRoundSelection /
    // SetStepRoundUserFindings) before looping round to execute it.
    //
    // Verified against live data: commit "fix(queue): queues survive a restart"
    // sits on round 2, whose own findings are 13 with the reply "fix all thirteen";
    // it was actually caused by round 1's 4 findings and "apply all four".
    //
    // Round 1 is the exception, and a real one: `document` and `lint` do their work
    // on first execution, so the findings and the fix come from the same call and
    // nobody was ever asked. There is no earlier round - the context is its own.
    const priorSql = `
      SELECT r.findings_json AS findings, r.user_findings_json AS userFindings,
             r.selection_source AS source, r.selected_finding_ids AS selected,
             r.created_at AS decidedAt
      FROM step_rounds r
      WHERE r.step_result_id = ? AND r.round = ?`;
    const prior = db.prepare(priorSql);

    for (const row of fixRows) {
      const step = typeof row.step === "string" ? row.step : "";
      const summary = typeof row.summary === "string" ? row.summary.trim() : "";
      const stepResultId = typeof row.stepResultId === "string" ? row.stepResultId : "";
      const runId = typeof row.runId === "string" ? row.runId : "";
      const round = Number(row.round);
      if (!step || !summary || !stepResultId || !Number.isFinite(round) || round < 1) continue;
      // The SQL narrowed by summary alone; the real key is (step, summary).
      if (!wanted.has(key(step, summary))) continue;

      const p = prior.get(stepResultId, round >= 2 ? round - 1 : 1) as
        | Record<string, unknown>
        | undefined;
      if (!p) continue;

      const decision: NmFixDecision = p.source === "user" ? "replied" : "auto";
      // When someone answered, user_findings_json IS the fixed set: the selected
      // findings with the reply merged onto each. Otherwise the round reported
      // more than it auto-fixed, so narrow by the ids it actually selected.
      const userSide = parseFindings(typeof p.userFindings === "string" ? p.userFindings : null);
      const context =
        userSide.findings.length > 0
          ? userSide
          : parseFindings(typeof p.findings === "string" ? p.findings : null, parseSelected(p.selected));

      // The gate's lifetime, from the two rows this join already had in hand: the
      // deciding round returned the findings (the gate parked), the fix round returned
      // once the fix had run. For a round-1 fix those are ONE row, so the window
      // collapses to a point and `pickGateReply` turns it away - see it there.
      const decidedAt = roundMs(p.decidedAt);
      const fixedAt = roundMs(row.fixedAt);

      out.set(key(step, summary), {
        decision,
        reply: userSide.reply,
        findings: context.findings,
        findingCount: context.total,
        runId,
        window: decidedAt !== null && fixedAt !== null ? { after: decidedAt, before: fixedAt } : null,
        // Off findings_json, which is the round's WHOLE finding set - not off
        // `context`, which is narrowed to what was acted on. A reply's ids are
        // drawn from everything that was up at the gate (the foreman logs the lot;
        // the Fix box logs a selection out of it), so the full set is the one both
        // are subsets of, and the only one that can overlap either.
        //
        // Only for a `replied` round, because only those can carry a byline
        // (`attribute` returns early otherwise and never reads this). Auto fixes are
        // the majority, and this re-parses the same ~20KB blob `parseFindings` just
        // read - so parsing it for them doubles the JSON work on the common path of
        // a read this file deliberately keeps proportional to the branch.
        roundFindingIds:
          decision === "replied" ? findingIdsOf(typeof p.findings === "string" ? p.findings : null) : [],
      });
    }
  } catch {
    return out; // schema moved - degrade to a log without context
  } finally {
    db.close();
  }
  return out;
}

export interface FixLog {
  summaries: NmFixSummary[];
  details: Map<string, NmFixDetail>;
}

/**
 * Per-checkout cache, keyed by HEAD. The log only changes when a commit lands, so
 * a gated session on a still branch costs one `rev-parse` per poll instead of a
 * `git log` plus a sqlite read.
 */
const cache = new Map<string, { headSha: string; at: number; log: FixLog }>();

/** How long a fully-resolved log stays fresh. */
const FRESH_MS = 60_000;
/**
 * How long a log whose context might still be landing stays fresh. Shorter
 * because of an ordering race: the fix commits BEFORE its round row is written
 * (the executor inserts the round after the step returns), so a log read in that
 * window sees the commit with no context. Keyed on HEAD alone it would stay
 * contextless forever, since HEAD doesn't move again. Retrying soon closes that.
 */
const RETRY_MS = 5_000;
/**
 * How long after a fix commits its round row might still be unwritten.
 *
 * The gate on RETRY_MS, and the reason it isn't `decision === null` alone: a
 * missing round is also a PERMANENT, documented state (a fix whose run has since
 * been deleted has no round and never will), and a contextless fix is the common
 * case, not an edge one. Retrying on that state re-read git and sqlite on every
 * tick forever - RETRY_MS is <= the poll interval, so the guard never held - for
 * an answer that cannot change. Only a RECENT unresolved fix is worth a retry;
 * the race closes in seconds, so a minute is already generous.
 */
const RACE_MS = 60_000;

/** Whether a fix might still be waiting on a round row, vs. permanently without one. */
function awaitingContext(log: FixLog, now: number): boolean {
  // Distance, not age: a commit date is not our clock. It comes from whichever
  // machine made the commit, and a skewed or rebased one dates into the future -
  // which as a plain `now - committedAt` is negative, i.e. forever inside the
  // window, i.e. the exact permanent re-read loop this gate exists to stop.
  return log.summaries.some((s) => s.decision === null && Math.abs(now - s.committedAt) < RACE_MS);
}

/** Drop a checkout's cached log, so the next read is from scratch. */
export function forgetFixLog(cwd: string): void {
  cache.delete(cwd);
}

/**
 * Keep only the checkouts in `live`, dropping every other cached log.
 *
 * The cache is keyed by cwd and nothing else evicts it: sessions leave the
 * registry with no say here, so a daemon that ran for a week held the log of
 * every worktree it had ever polled - each carrying up to MAX_FIXES x
 * MAX_FINDINGS descriptions. FRESH_MS bounds staleness, not size.
 *
 * Bounded by the live sessions rather than by age on purpose: age alone still lets
 * a long-lived busy set of sessions accumulate, whereas the set of checkouts worth
 * remembering is exactly the set we're still polling. Dropping one costs a
 * re-read, never a wrong answer - the detail route re-reads its own cwd on a miss.
 */
export function retainFixLogs(live: Iterable<string>): void {
  const keep = new Set(live);
  for (const cwd of [...cache.keys()]) if (!keep.has(cwd)) cache.delete(cwd);
}

async function ensureFixLog(cwd: string, now: number): Promise<FixLog> {
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const headSha = head.code === 0 ? head.stdout.trim() : "";
  const hit = cache.get(cwd);
  if (hit && headSha && hit.headSha === headSha) {
    if (now - hit.at < (awaitingContext(hit.log, now) ? RETRY_MS : FRESH_MS)) return hit.log;
  }
  const log = await readFixLog(cwd);
  cache.set(cwd, { headSha, at: now, log });
  return log;
}

/** The card-weight fix list for a checkout. */
export async function fixSummaries(cwd: string, now = Date.now()): Promise<NmFixSummary[]> {
  return (await ensureFixLog(cwd, now)).summaries;
}

/** One fix's full context, or null when that sha isn't a fix on this branch. */
export async function fixDetail(cwd: string, sha: string, now = Date.now()): Promise<NmFixDetail | null> {
  return (await ensureFixLog(cwd, now)).details.get(sha) ?? null;
}

/** Reads the replies filed against one run's gate at a step. See `readFixLog`. */
export type GateReplyReader = (runId: string, step: string) => GateReplyRow[];

/**
 * The full fix log for a checkout: card-weight summaries plus the per-fix detail
 * behind them, keyed by short sha.
 *
 * `replies` is injected, defaulting to the daemon's own store. Not for looseness -
 * the reader is a two-column lookup with no shape worth abstracting - but because
 * `gateRepliesFor` opens the daemon's DB at a path fixed from the environment at
 * import time, and this module's tests point NM_HOME at a fixture while leaving
 * that alone. Called for real, they'd read (and create) the developer's live
 * database from a unit test. The seam keeps the default honest in production and
 * the tests off the real thing.
 */
export async function readFixLog(
  cwd: string,
  replies: GateReplyReader = gateRepliesFor,
): Promise<FixLog> {
  const commits = await listFixes(cwd);
  // A fresh value per call, not a shared constant: this reads as per-checkout
  // state and gets cached under a cwd and hung off a session, so one instance
  // aliased across every fix-less checkout is a hazard waiting for its first mutation.
  if (commits.length === 0) return { summaries: [], details: new Map() };

  const branchRes = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : "";
  const context = await loadRoundContext(cwd, branch, commits);

  const summaries: NmFixSummary[] = [];
  const details = new Map<string, NmFixDetail>();
  for (const c of commits) {
    const ctx = context.get(key(c.step, c.summary)) ?? null;
    const attribution = ctx ? attribute(ctx, c, replies) : null;
    summaries.push({
      sha: c.sha,
      step: c.step,
      summary: c.summary,
      committedAt: c.committedAt,
      filesChanged: c.filesChanged,
      added: c.added,
      removed: c.removed,
      decision: ctx?.decision ?? null,
      repliedBy: attribution?.source ?? null,
      findingCount: ctx?.findingCount ?? 0,
    });
    details.set(c.sha, {
      sha: c.sha,
      step: c.step,
      summary: c.summary,
      committedAt: c.committedAt,
      decision: ctx?.decision ?? null,
      reply: ctx?.reply ?? null,
      attribution,
      findings: ctx?.findings ?? [],
      findingCount: ctx?.findingCount ?? 0,
      files: c.files,
      filesChanged: c.filesChanged,
      added: c.added,
      removed: c.removed,
    });
  }
  return { summaries, details };
}

/**
 * Put a byline on one fix, or don't.
 *
 * Only ever for a fix no-mistakes says was `replied`. An `auto` fix was decided
 * under the pipeline's own round limit with nobody asked - so a reply that merely
 * shares its run and step (an earlier gate on the same step) explains something
 * else entirely, and hanging an author on it would invent the one fact this whole
 * feature exists to state precisely.
 *
 * A `replied` fix with no match stays unattributed, which is the honest and COMMON
 * answer, not a failure: the usual replier is the agent driving its own gate via
 * the `/no-mistakes` skill, which nothing on our side witnessed. The card says
 * `replied` and names nobody, exactly as it did before.
 *
 * Fails soft for the same reason the rest of this file does: a byline is never
 * worth taking the log down for.
 */
function attribute(
  ctx: RoundContext,
  c: FixCommit,
  replies: GateReplyReader,
): NmFixAttribution | null {
  if (ctx.decision !== "replied" || !ctx.runId || !ctx.window) return null;
  try {
    const hit = pickGateReply(replies(ctx.runId, c.step), ctx.roundFindingIds, ctx.window);
    if (!hit) return null;
    return {
      source: hit.source,
      text: hit.text ? clamp(hit.text, MAX_REPLY) : null,
      at: hit.ts,
    };
  } catch (err) {
    console.warn(`[nomistakes] fix ${c.sha}: cannot read the gate reply byline:`, err);
    return null;
  }
}
