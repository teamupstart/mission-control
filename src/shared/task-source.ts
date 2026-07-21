import { z } from "zod";
import { AGENT_TYPES, type AgentType, type TaskKind, type TaskPriority } from "./types.ts";
import { MAX_LABELS, TASK_PRIORITIES, normalizeLabels } from "./task.ts";

// A task source reads an EXTERNAL system on a schedule and returns candidate tasks.
// That is the whole contract: it does not write to the database, it does not dispatch
// anything, and it does not decide whether a candidate is new.
//
// The split is the point of the design. `CLAUDE.md`'s "the daemon is the only writer of
// the DB" holds BY CONSTRUCTION rather than by every implementer remembering it, dedupe
// and normalization and the per-sweep cap get enforced exactly once (in
// `src/server/task-sources/ingest.ts`), and a source stays a pure function to test -
// `sweep(config) -> candidates` needs no database, no registry and no HTTP.
//
// Sources never type into a pane. The skills reload loop needs `settledIdle` plus a pane
// read plus `withPaneLock` before it dares (see "The daemon is no longer strictly
// reactive" in the README); a task source needs none of that, because the worst a broken
// one can do is file junk into a list a human then reads and deletes. Nothing is
// provisioned, no worktree is cut, no keystroke is sent. Auto-dispatching swept work is
// deliberately out of scope: it is a different risk class and would need its own gate.
//
// This file is the half that must stay pure - no `node:` imports - because the settings
// panel renders from it in the browser. The same split `HARNESS_CAPABILITIES` makes
// against `HARNESSES`: what a kind IS lives here, what it DOES lives on the server, and
// the server's record spreads this one in so a call site reads every slot off one object.

/**
 * The implementations that exist. **APPEND-ONLY**: these ids are persisted inside the
 * `taskSources` blob in `app_config`, so renaming one orphans every source configured
 * under the old spelling - it stops matching a registered kind and silently never
 * sweeps again.
 */
export const TASK_SOURCE_KINDS = ["github-issues"] as const;
export type TaskSourceKind = (typeof TASK_SOURCE_KINDS)[number];

/** Where a candidate came from - the identity a sweep is de-duplicated on. */
export interface TaskSourceRef {
  /** The configured source instance that produced it. */
  sourceId: string;
  /**
   * Stable id in the EXTERNAL system, e.g. "owner/repo#123". Must be stable across
   * sweeps for the same underlying item and unique within the source; it is half of
   * the de-duplication key and nothing else is.
   */
  externalId: string;
  /** Deep link back to the item, shown on the task. Null when the system has no URL. */
  url: string | null;
}

/**
 * One item a source proposes for the backlog.
 *
 * Deliberately the shape of a TASK, not a passthrough of the external record. A source's
 * job is to translate - deciding what an issue's *intent* should say is the part that
 * needs judgement, and it is the part the source is uniquely able to do.
 */
export interface TaskCandidate {
  ref: TaskSourceRef;
  /** Short label. Falls back to a derived title when empty. */
  title: string;
  /** The prompt the agent will actually receive as its first message. */
  intent: string;
  /** Absolute path of the repo to base the task on. Validated as a git root on ingest. */
  repoRoot: string;
  kind?: TaskKind;
  agent?: AgentType;
  priority?: TaskPriority | null;
  labels?: string[];
}

/** The outcome of one sweep. */
export interface SweepResult {
  items: TaskCandidate[];
  /**
   * Human-readable failure, or null. A failure NEVER retracts anything: an unreachable
   * API means "unknown", not "there is no work" - the same stance `pr.ts` takes when
   * `gh` is missing, where an error leaves the existing chip alone rather than clearing
   * it. So a non-zero exit must become `{items: [], error}` and never an empty success.
   */
  error: string | null;
}

/** What the daemon lends a sweep. Narrow on purpose - no registry, no DB. */
export interface SweepContext {
  sourceId: string;
  /** The repo this source is bound to, already resolved to a git root. */
  repoRoot: string;
  /** Abort signal, so a hung sweep cannot wedge the loop. */
  signal: AbortSignal;
}

/**
 * What can be answered about a kind WITHOUT a `node:` import, so the settings panel can
 * render a source whose implementation it cannot import: its name, its blurb, and the
 * shape of its config. The server's `TaskSourceImpl` spreads this in and adds the two
 * calls that leave the process.
 */
export interface TaskSourceKindInfo<C = unknown> {
  kind: TaskSourceKind;
  /** What the settings panel calls it. */
  label: string;
  /** One line under the label, saying what this source sweeps. */
  blurb: string;
  /**
   * Validates and defaults this kind's config blob. The panel renders from it too.
   *
   * Input is `unknown`, not `C`: what is parsed is whatever the `app_config` blob holds,
   * which is a value an older build wrote and every field of which the schema may since
   * have made optional. A schema that only accepted its own output could not read it.
   */
  configSchema: z.ZodType<C, z.ZodTypeDef, unknown>;
}

/**
 * An implementation. One per kind, registered in `src/server/task-sources/index.ts`.
 *
 * Extends the pure half rather than restating it, so an implementation is one object a
 * call site reads every slot off - the same shape `Harness extends HarnessCapabilities`
 * gives the harness registry.
 *
 * Both calls may leave the process, which is why they live on the server's record and
 * not in `TASK_SOURCE_KIND_INFO`. Neither may write: a sweep RETURNS candidates, and
 * `ingest.ts` decides what becomes of them.
 */
export interface TaskSourceImpl<C> extends TaskSourceKindInfo<C> {
  /**
   * "Can this run at all?" - null when fine, else a sentence naming the fix
   * ("gh is not authenticated - run `gh auth login`"). Separate from `sweep` so the
   * settings panel can tell a misconfigured source from an empty one, which is the
   * difference between "you have nothing to do" and "this has been silently broken".
   */
  preflight(config: C, ctx: SweepContext): Promise<string | null>;
  sweep(config: C, ctx: SweepContext): Promise<SweepResult>;
}

// ---- github-issues: the first kind's config ----

/**
 * The GitHub issues sweep, as configured.
 *
 * Auth is the `gh` CLI run with `cwd` set to the repo - the same thing `src/server/pr.ts`
 * does - so this feature stores no token, opens no OAuth flow and adds no secret that can
 * leak. That is worth more than the flexibility of an API client.
 */
export const GithubIssuesConfigSchema = z
  .object({
    /** Empty = the repo `gh` resolves from `repoRoot`'s origin. */
    repo: z.string().max(200).default(""),
    /**
     * Match issues carrying ANY of these labels. Empty = no label filter.
     *
     * NOT run through `normalizeLabels`: these are a QUERY against GitHub, not tags
     * stored on a task, and GitHub's label match is exact - trimming them to our length
     * cap or de-duplicating case-insensitively would silently stop matching the labels
     * they name.
     */
    labelsAny: z.array(z.string().min(1).max(100)).max(20).default([]),
    /** Only issues assigned to the authenticated `gh` user. */
    assignedToMe: z.boolean().default(false),
    /** Only issues with no assignee - the "up for grabs" sweep. */
    unassignedOnly: z.boolean().default(false),
    milestone: z.string().max(200).nullable().default(null),
    /** GitHub label -> task priority, e.g. {"P0": "blocker", "P1": "high"}. */
    priorityFrom: z.record(z.string(), z.enum(TASK_PRIORITIES)).default({}),
    /** Copy the issue's GitHub labels onto the task. */
    copyLabels: z.boolean().default(true),
    limit: z.number().int().min(1).max(200).default(50),
  })
  // Together these select NOTHING, and a filter that silently matches nothing is the
  // worst possible failure for a background sweep: it is indistinguishable from a repo
  // with no open issues, forever. Refused at the schema so neither the route nor the
  // panel has to remember.
  .refine((c) => !(c.assignedToMe && c.unassignedOnly), {
    message: "assignedToMe and unassignedOnly select nothing together - pick one",
    path: ["unassignedOnly"],
  });
export type GithubIssuesConfig = z.infer<typeof GithubIssuesConfigSchema>;

/**
 * Every kind's pure half, keyed by id.
 *
 * `Record<TaskSourceKind, …>` is the enforcement: a new id appended above does not
 * compile until it has said what it is called, what it sweeps, and what its config
 * looks like.
 */
export const TASK_SOURCE_KIND_INFO: Record<TaskSourceKind, TaskSourceKindInfo> = {
  "github-issues": {
    kind: "github-issues",
    label: "GitHub issues",
    blurb:
      "Files an open issue as a backlog task, through the gh CLI you are already signed in to.",
    configSchema: GithubIssuesConfigSchema,
  },
};

// ---- the configured instances ----

/** Never sweep faster than this, whatever a caller stores. */
export const MIN_SWEEP_INTERVAL_MS = 60_000;
/** Never wait longer than a day, so a mistyped interval cannot park a source forever. */
export const MAX_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** What a freshly added source sweeps at. */
export const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** Hard cap on the rows one sweep may file, and the ceiling a caller may raise it to. */
export const DEFAULT_MAX_PER_SWEEP = 25;
export const MAX_PER_SWEEP_CEILING = 200;

/** Clamp a stored interval into the range the sweeper will actually honour. */
export function clampSweepInterval(ms: number): number {
  return Math.min(MAX_SWEEP_INTERVAL_MS, Math.max(MIN_SWEEP_INTERVAL_MS, Math.round(ms)));
}

/** Applied to any candidate that doesn't set its own. */
export const TaskSourceDefaultsSchema = z.object({
  kind: z.enum(["ship", "scout"]).default("ship"),
  agent: z.enum(AGENT_TYPES).default("claude"),
  priority: z.enum(TASK_PRIORITIES).nullable().default(null),
  labels: z.array(z.string()).max(MAX_LABELS).default([]).transform(normalizeLabels),
});
export type TaskSourceDefaults = z.infer<typeof TaskSourceDefaultsSchema>;

const TaskSourceInstanceBase = z.object({
  /** uuid, minted when you add one. */
  id: z.string().min(1).max(64),
  kind: z.enum(TASK_SOURCE_KINDS),
  /** Your name for it, e.g. "mission-control bugs". */
  label: z.string().max(80).default(""),
  /**
   * Ships OFF, and that is deliberate rather than cautious: adding a source is
   * configuration, turning it on is consent, and they should be two separate acts.
   */
  enabled: z.boolean().default(false),
  /** Which repo swept tasks are filed against. Resolved to a git root by the route. */
  repoRoot: z.string().min(1),
  intervalMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_SWEEP_INTERVAL_MS)
    .transform(clampSweepInterval),
  defaults: TaskSourceDefaultsSchema.default({}),
  maxPerSweep: z.number().int().min(1).max(MAX_PER_SWEEP_CEILING).default(DEFAULT_MAX_PER_SWEEP),
  /** Kind-specific, validated below by that kind's own `configSchema`. */
  config: z.unknown().default({}),
});

/**
 * One configured source.
 *
 * `config` is validated against the KIND's schema here rather than left to the sweeper,
 * so a blob that could never sweep is refused at the door (`parseBody`) instead of
 * failing silently every fifteen minutes with nobody watching. It stays typed `unknown`
 * on the way out: the daemon re-parses it through the implementation's own schema when
 * it sweeps, which is the one place the config's type is known.
 */
export const TaskSourceInstanceSchema = TaskSourceInstanceBase.transform((inst, ctx) => {
  const parsed = TASK_SOURCE_KIND_INFO[inst.kind].configSchema.safeParse(inst.config ?? {});
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["config"],
      message: `${inst.kind}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
    return z.NEVER;
  }
  return { ...inst, config: parsed.data as unknown };
});
export type TaskSourceInstance = z.infer<typeof TaskSourceInstanceSchema>;

/**
 * The whole `taskSources` blob: a schema-validated value over the `app_config` KV, the
 * same pattern as `harnesses.ts` / `foreman/config.ts`, which is what means a new key
 * needs no migration.
 */
export const TaskSourcesConfigSchema = z.object({
  sources: z
    .array(TaskSourceInstanceSchema)
    .max(50)
    .default([])
    // Ids key the seen table, the status map and the sweep routes. Two sources sharing
    // one would share their seen rows - so whichever swept first would permanently
    // suppress the other's items - and `/api/task-sources/:id/sweep` would sweep an
    // arbitrary one of them.
    .refine((list) => new Set(list.map((s) => s.id)).size === list.length, {
      message: "two sources share an id",
    }),
});
export type TaskSourcesConfig = z.infer<typeof TaskSourcesConfigSchema>;

/**
 * What one source's last sweep did, derived and never persisted.
 *
 * In memory on purpose: a restart simply sweeps everything once more, and ingest
 * de-duplicates that pass down to nothing. Persisting it would buy a slightly prettier
 * panel and a schema to migrate.
 */
export interface TaskSourceStatus {
  sourceId: string;
  lastSweepAt: number | null;
  /** Why the last sweep failed, or null. Cleared by the next one that works. */
  lastError: string | null;
  /** How many rows the last sweep filed. */
  lastFiled: number;
  /** Items this source has ever filed and will not file again. */
  seenCount: number;
  /** A sweep is running right now, so "Sweep now" would double-file. */
  sweeping: boolean;
}

/** The whole Task sources panel in one read: what is configured, and how it is doing. */
export interface TaskSourcesView {
  sources: TaskSourceInstance[];
  status: TaskSourceStatus[];
  /** The kinds this build offers, so the panel's "add" control is not a hand-kept list. */
  kinds: { kind: TaskSourceKind; label: string; blurb: string }[];
}

/** What one sweep did, reported back to whoever asked for it. */
export interface SweepReport {
  sourceId: string;
  /** Tasks actually created. */
  filed: number;
  /** Candidates dropped because this source had already filed them. */
  alreadySeen: number;
  /** Candidates dropped by `maxPerSweep`, reported rather than silently truncated. */
  overCap: number;
  /** Per-candidate refusals (a repoRoot that is not a git root, a bad shape). */
  refused: string[];
  /** The sweep itself failed. Distinct from an empty success - see `SweepResult`. */
  error: string | null;
}
