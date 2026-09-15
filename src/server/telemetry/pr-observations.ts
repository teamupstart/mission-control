/**
 * Verified per-repository pull request facts, and the one thing Phase 3 had to persist to get
 * them right: an observation that outlives its source ownership.
 *
 * THE PROBLEM, stated exactly. A task's pull request lives on its work-episode binding.
 * `invalidateTaskOwnershipInTransaction` DELETES that binding without archiving it, so after a
 * rotation or a re-dispatch both `mergedPrFor` and `taskPrPollTargets` stop knowing the pull
 * request exists. A merge that lands afterwards is then observed by nothing at all - not by
 * the session, which is gone, and not by the poller, which no longer harvests the URL.
 *
 * THE SHAPE OF THE FIX, and its limits. Copying the invalidated binding into
 * `historical_task_work_episode_bindings` would restore the observation, but that table is
 * read by `mergedPrFor`, so it would ALSO make an invalidated binding eligible to complete a
 * task and release its dependents - a change to operational completion and selection-time
 * dependency policy that a telemetry phase has no business making. So the association is
 * retained over here instead, in a table with no authority over anything: nothing reads it to
 * complete a task, satisfy an edge, or bind a session. It is evidence, not a binding.
 *
 * WHAT LEAVES THE MACHINE. The URL does not. It is local polling metadata, kept so the shared
 * poller has something to ask `gh` about, and every exported record identifies the pull request
 * by a digest instead. Repository roots are digested for the same reason: "how many
 * repositories did this task deliver to" is a product question and "which repositories does
 * this operator have" is not.
 */
import type { DatabaseSync } from "node:sqlite";
import { taskWorkEpisodeForTask, workEpisodeRepoPrsForTask } from "../db.ts";
import { SYSTEM_ACTOR, TELEMETRY_LIMITS } from "@shared/telemetry.ts";
import { PR_OBSERVED_EVENT } from "@shared/telemetry-catalog.ts";
import { TASK_KINDS, type TaskKind } from "@shared/types.ts";
import { captureTelemetry } from "./capture.ts";
import { getTelemetryConfig } from "./config.ts";
import { digest } from "./identity.ts";
import { registerTelemetrySource } from "./registration.ts";
import { telemetryTransaction } from "./store.ts";
import { attributionValue, type AttributionValue } from "./attribution.ts";

const SOURCE_KIND = "mission.pr";

/**
 * How long a retained association is polled for and kept.
 *
 * The reducer-state window rather than a number of its own, and deliberately so: P5's late
 * outcome horizon and this retention are the same decision, and two constants would drift the
 * first time one of them was tuned. The rows are tiny - no payload - which is exactly why the
 * long window is the right one.
 */
const LATE_OUTCOME_HORIZON_MS = TELEMETRY_LIMITS.reducerStateRetentionMs;

/** One retained association, as this module reads it back. */
export interface RetainedPrObservation {
  taskId: string;
  prKey: string;
  prUrl: string;
  repoKey: string;
  repoRole: "primary" | "secondary";
  taskKind: AttributionValue<TaskKind>;
  sessionId: string | null;
  associatedAt: number;
  mergedAt: number | null;
  expiresAt: number;
}

interface ObservationRow {
  task_id: string;
  pr_key: string;
  pr_url: string;
  repo_key: string;
  repo_role: string;
  task_kind: string;
  context_json: string;
  session_id: string | null;
  associated_at: number;
  merged_at: number | null;
  expires_at: number;
}

/**
 * A pull request first became a task's, in one of its repositories.
 *
 * Called from the durable owner's own announcement, which fires only AFTER the work-episode
 * write succeeded - so this is a verified association rather than an intention. An agent
 * saying it opened a pull request reaches nothing here.
 *
 * `fact` is `creation_verified` only when the daemon watched the agent create it. Everything
 * else is `associated_existing`, which is a weaker and honest claim.
 */
export function retainPrObservation(input: {
  taskId: string;
  taskKind: string;
  repoRoot: string;
  primaryRepoRoot: string | null;
  prUrl: string;
  sessionId: string | null;
  creationVerified: boolean;
  now?: number;
}): { retained: boolean; prKey: string } {
  const now = input.now ?? Date.now();
  const prKey = prKeyFor(input.prUrl);
  // BEFORE the write, and this is the one place it genuinely matters. A retained row holds a
  // pull request URL - the daemon's own polling metadata, but still a repository this operator
  // never consented to being observed. "Default off" has to mean the table stays empty, not
  // that a row is written and then filtered on the way out.
  if (!getTelemetryConfig().enabled) return { retained: false, prKey };
  const repoKey = repoKeyFor(input.repoRoot);
  const repoRole =
    input.primaryRepoRoot !== null && input.repoRoot !== input.primaryRepoRoot
      ? "secondary"
      : "primary";
  const taskKind = taskKindOf(input.taskKind);

  let retained = false;
  try {
    retained = telemetryTransaction((d) => {
      const existing = d
        .prepare(`SELECT task_id FROM telemetry_pr_observations WHERE task_id = ? AND pr_key = ?`)
        .get(input.taskId, prKey) as { task_id: string } | undefined;
      // First association only. A second sighting of the same pull request is not news, and
      // re-stamping `associated_at` would reset the horizon this row is polled under.
      if (existing) return false;
      d.prepare(
        `INSERT INTO telemetry_pr_observations
           (task_id, pr_key, pr_url, repo_key, repo_role, task_kind, context_json,
            session_id, associated_at, merged_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        input.taskId,
        prKey,
        input.prUrl,
        repoKey,
        repoRole,
        taskKind,
        // The attribution FROZEN now, while its source ownership still exists. A late merge is
        // reported against the session and repository that produced it, not against whatever
        // the task happens to be bound to weeks later.
        JSON.stringify({ sessionId: input.sessionId, repoRole, taskKind }),
        input.sessionId,
        now,
        now + LATE_OUTCOME_HORIZON_MS,
      );
      return true;
    });
  } catch (error) {
    // Capture never fails a business operation, and neither does its retention. An acceptance
    // failure here produces incomplete coverage, which is what the gap counters are for.
    console.warn("[telemetry] could not retain a pull request observation:", error);
    return { retained: false, prKey };
  }

  if (retained) {
    capturePrFact({
      taskId: input.taskId,
      prKey,
      repoKey,
      repoRole,
      taskKind,
      sessionId: input.sessionId,
      fact: input.creationVerified ? "creation_verified" : "associated_existing",
      delivery: "live",
      ageMs: 0,
      now,
    });
  }
  return { retained, prKey };
}

/**
 * Every pull request URL telemetry still wants an answer about.
 *
 * Handed to the EXISTING daemon poller as a third harvest rather than given a timer of its
 * own. A task waiting on its own merge is very often also the task telemetry is watching, and
 * two cadences would spend two `gh` calls and two backoffs on one pull request.
 */
export function telemetryPrPollTargets(now = Date.now()): string[] {
  // The PR poller calls this on every tick, forever. Asked before the transaction so an
  // installation that never opted in does not take a write lock every poll interval for a
  // table it has no rows in.
  if (!getTelemetryConfig().enabled) return [];
  try {
    const rows = telemetryTransaction((d) =>
      d
        .prepare(
          `SELECT pr_url FROM telemetry_pr_observations
           WHERE merged_at IS NULL AND expires_at > ?
           ORDER BY associated_at ASC
           LIMIT 500`,
        )
        .all(now) as unknown as Array<{ pr_url: string }>,
    );
    return [...new Set(rows.map((r) => r.pr_url))];
  } catch (error) {
    console.warn("[telemetry] could not read pull request poll targets:", error);
    return [];
  }
}

/**
 * Record the merges the shared poller observed, against retained associations.
 *
 * OBSERVATION ONLY. This does not enter `mergedPrFor`, does not call task completion and
 * cannot satisfy a dependency edge - a URL that also carries operational provenance is
 * reconciled by the existing operational path, under its own eligibility and selection-time
 * rules, and this function never widens them.
 *
 * `delivery` is `late` when the association's own session is no longer the task's current one,
 * which is precisely the case the ownership-invalidation gap used to lose.
 */
export function recordTelemetryPrMerges(
  mergedUrls: Map<string, number>,
  isLive: (observation: RetainedPrObservation) => boolean = ownsCurrentPrBinding,
  now = Date.now(),
): number {
  if (mergedUrls.size === 0 || !getTelemetryConfig().enabled) return 0;
  let recorded = 0;
  let pending: RetainedPrObservation[] = [];
  try {
    pending = telemetryTransaction((d) => {
      const out: RetainedPrObservation[] = [];
      for (const [url, mergedAt] of mergedUrls) {
        const rows = d
          .prepare(
            `SELECT * FROM telemetry_pr_observations
             WHERE pr_url = ? AND merged_at IS NULL AND expires_at > ?`,
          )
          .all(url, now) as unknown as ObservationRow[];
        for (const row of rows) {
          // Stamped INSIDE the transaction that selected it, so a repeated poll result - the
          // same merge observed on two consecutive ticks - finds nothing the second time and
          // produces exactly one late-delivery fact.
          d.prepare(
            `UPDATE telemetry_pr_observations SET merged_at = ?
             WHERE task_id = ? AND pr_key = ? AND merged_at IS NULL`,
          ).run(mergedAt, row.task_id, row.pr_key);
          out.push(toObservation({ ...row, merged_at: mergedAt }));
        }
      }
      return out;
    });
  } catch (error) {
    console.warn("[telemetry] could not record observed pull request merges:", error);
    return 0;
  }

  for (const observation of pending) {
    const result = capturePrFact({
      taskId: observation.taskId,
      prKey: observation.prKey,
      repoKey: observation.repoKey,
      repoRole: observation.repoRole,
      taskKind: observation.taskKind,
      sessionId: observation.sessionId,
      fact: "merged",
      delivery: isLive(observation) ? "live" : "late",
      ageMs: Math.max(0, (observation.mergedAt ?? now) - observation.associatedAt),
      // The merge's OWN time, not the poll's. A pull request that landed overnight belongs in
      // the hour it landed, which is the whole reason `occurredAt` exists separately.
      occurredAt: observation.mergedAt ?? now,
      now,
    });
    if (result.kind === "accepted") recorded += 1;
  }
  return recorded;
}

/** A URL's other authors and dependency consumers do not establish this author's ownership. */
function ownsCurrentPrBinding(observation: RetainedPrObservation): boolean {
  const binding = taskWorkEpisodeForTask(observation.taskId);
  if (!binding || binding.sessionId !== observation.sessionId) return false;
  if (observation.repoRole === "primary") return binding.prUrl === observation.prUrl;
  return workEpisodeRepoPrsForTask(observation.taskId).some((pr) =>
    pr.episodeId === binding.episodeId && pr.sessionId === observation.sessionId &&
    pr.prUrl === observation.prUrl && repoKeyFor(pr.repoRoot) === observation.repoKey,
  );
}

/**
 * The cohort input Phase 6 reads: every retained association and what became of it.
 *
 * A LOOKUP over the same rows rather than a second store. A separate cohort table would be a
 * copy of this one that could disagree with it, and the disagreement would show up as a
 * dashboard that says a task delivered while the trace says it did not.
 */
export function telemetryPrCohortInputs(now = Date.now()): RetainedPrObservation[] {
  try {
    return telemetryTransaction((d) =>
      (
        d
          .prepare(
            `SELECT * FROM telemetry_pr_observations WHERE expires_at > ? ORDER BY associated_at ASC`,
          )
          .all(now) as unknown as ObservationRow[]
      ).map(toObservation),
    );
  } catch (error) {
    console.warn("[telemetry] could not read pull request cohort inputs:", error);
    return [];
  }
}

/**
 * Drop associations past the late-outcome horizon.
 *
 * Run from the ordinary retention pass rather than on a timer of its own. An expired row is a
 * coverage gap by definition - the horizon passed with no verdict - and is recorded as one by
 * the pass that sweeps it.
 */
export function expirePrObservations(d: DatabaseSync, now: number, limit = 500): number {
  const rows = d
    .prepare(
      `SELECT task_id, pr_key FROM telemetry_pr_observations WHERE expires_at <= ? LIMIT ?`,
    )
    .all(now, limit) as unknown as Array<{ task_id: string; pr_key: string }>;
  for (const row of rows) {
    d.prepare(`DELETE FROM telemetry_pr_observations WHERE task_id = ? AND pr_key = ?`).run(
      row.task_id,
      row.pr_key,
    );
  }
  return rows.length;
}

/** Register the pull request source. See `SESSION_SOURCE` for why the honesty is required. */
const PR_SOURCE = {
  id: SOURCE_KIND,
  recovers: [
    "A retained association survives a restart in its own table, so a merge observed days " +
      "later still carries the attribution frozen when the pull request was first seen.",
  ],
  unrecoverable: [
    "An association made while capture was off. The operational binding it came from may " +
      "already have been invalidated, and nothing else records it.",
    "A merge that lands after the late-outcome horizon expires. The row is swept and the " +
      "outcome is reported as unobserved rather than guessed at.",
  ],
  maxScanPerTick: 500,
} as const;

export function registerPrTelemetrySource(): void {
  registerTelemetrySource(PR_SOURCE);
}

// ---- helpers ----

function capturePrFact(input: {
  taskId: string;
  prKey: string;
  repoKey: string;
  repoRole: "primary" | "secondary";
  taskKind: AttributionValue<TaskKind>;
  sessionId: string | null;
  fact: "associated_existing" | "creation_verified" | "updated" | "merged" | "closed_unmerged";
  delivery: "live" | "late";
  ageMs: number;
  occurredAt?: number;
  now: number;
}) {
  return captureTelemetry({
    event: PR_OBSERVED_EVENT,
    source: {
      kind: SOURCE_KIND,
      id: `${input.taskId}:${input.prKey}:${input.fact}`,
      revision: 1,
    },
    actor: SYSTEM_ACTOR,
    facts: {
      fact: input.fact,
      task_kind: input.taskKind,
      repo_role: input.repoRole,
      delivery: input.delivery,
      // The forge's own answer is not asked for here, so it is `unknown` rather than assumed.
      // A repository's visibility is a fact about the operator's account, and P2 requires the
      // difference between "not observed" and "observed as zero" stay visible.
      visibility: "unknown",
      age_ms: Math.max(0, Math.round(input.ageMs)),
    },
    refs: {
      task_id: input.taskId,
      repo_key: input.repoKey,
      pr_key: input.prKey,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
    },
    occurredAt: input.occurredAt,
    now: input.now,
  });
}

/** The exported identity of a pull request. One-way, so a holder cannot recover the URL. */
export function prKeyFor(url: string): string {
  return digest(["mission.pr", url]).slice(0, 24);
}

/** The exported identity of a repository, for the same reason. */
export function repoKeyFor(repoRoot: string): string {
  return digest(["mission.repo", repoRoot]).slice(0, 24);
}

function taskKindOf(kind: string): AttributionValue<TaskKind> {
  return attributionValue(kind, TASK_KINDS);
}

function toObservation(row: ObservationRow): RetainedPrObservation {
  return {
    taskId: row.task_id,
    prKey: row.pr_key,
    prUrl: row.pr_url,
    repoKey: row.repo_key,
    repoRole: row.repo_role === "secondary" ? "secondary" : "primary",
    taskKind: taskKindOf(row.task_kind),
    sessionId: row.session_id,
    associatedAt: row.associated_at,
    mergedAt: row.merged_at,
    expiresAt: row.expires_at,
  };
}
