import { z } from "zod";
import {
  AGENT_TYPES,
  TASK_KINDS,
  type AgentType,
  type TaskKind,
  type TaskPriority,
} from "./types.ts";
import {
  MAX_LABELS,
  TASK_KIND_BACKLOG_REFUSAL,
  TASK_PRIORITIES,
  normalizeLabels,
  taskKindAllowsBacklog,
} from "./task.ts";

// A task source is this app's connection to an EXTERNAL work tracker. Inbound, it reads
// that tracker on a schedule and RETURNS candidate tasks. Outbound, a kind may declare
// three verbs, and they are three because they answer three different questions:
// `push` files one of OUR tasks as a new item upstream, `annotate` writes a note onto an
// item a sweep already brought in, and `resolve` marks that item finished.
//
// What no implementation may do, in any direction, is write to OUR database. A sweep
// returns candidates and `src/server/task-sources/ingest.ts` decides what becomes of
// them; a push writes upstream and returns the ref it minted, and one chokepoint beside
// `ingest.ts` records that ref here; a write-back reports what it managed to say, and
// `writeback.ts` - the third chokepoint - is the only thing that touches the delivery
// ledger. Those chokepoints are the only DB writers on these paths, which is what keeps
// every implementation a pure function over a subprocess.
//
// The split is the point of the design. `CLAUDE.md`'s "the daemon is the only writer of
// the DB" holds BY CONSTRUCTION rather than by every implementer remembering it, dedupe
// and normalization and the per-sweep cap get enforced exactly once (in `ingest.ts`), and
// a source stays a pure function to test - `sweep(config) -> candidates` needs no
// database, no registry and no HTTP, and `push(config, draft) -> ref` needs none either.
//
// The asymmetry between the directions is deliberate, and it is about what a mistake
// costs. A sweep is periodic and unattended, and the worst a broken one can do is file
// junk into a list a human then reads and deletes - so it runs on a timer. A push
// PUBLISHES, to a place other people are watching, and it cannot be taken back by
// deleting a row here - so it fires only on an explicit per-task operator action, never
// from the sweep loop, and never as a consequence of anything a sweep saw.
//
// The write-back verbs are automatic, which looks like the sweep's risk class and is not:
// they publish, exactly as a push does. What stands in for the operator's click is
// CONSENT STORED PER SOURCE - three switches, every one of them off by default - plus a
// ledger key that makes a repeated observation cost nothing. A source nobody has switched
// on writes nothing, which is every source in every existing installation.
//
// Sources never type into a pane. The skills reload loop needs `settledIdle` plus a pane
// read plus `withPaneLock` before it dares (see "The daemon is no longer strictly
// reactive" in the README); a task source needs none of that, because nothing here is
// provisioned, no worktree is cut, and no keystroke is sent. Auto-dispatching swept work
// is deliberately out of scope: it is a different risk class and would need its own gate.
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
export const TASK_SOURCE_KINDS = ["github-issues", "jira"] as const;
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
  /** Absolute path of the repo to base the task on. Validated as a task root on ingest. */
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

// ---- the outward direction: one of our tasks, filed upstream ----

/**
 * The task being pushed, reduced to what an external item can carry.
 *
 * A DRAFT rather than the `Task` itself, for the same reason `TaskCandidate` is not a
 * passthrough of an issue: the implementation should not be able to read a status, an id
 * or a worktree off the thing it is publishing, because none of that means anything
 * upstream and all of it would leak our internals into somebody else's tracker.
 */
export interface PushDraft {
  /** Becomes the external item's title. */
  title: string;
  /** Becomes its body - the task's intent, which is the text a human wrote. */
  intent: string;
}

/** The outcome of one push. Exactly one of `ref` / `error` is set. */
export interface PushResult {
  /** What was created, or null when nothing was (or nothing could be read back). */
  ref: TaskSourceRef | null;
  /** Human-readable failure, or null. */
  error: string | null;
  /**
   * The item MAY exist upstream and we cannot tell.
   *
   * The load-bearing flag of this whole direction, and the reason a push cannot reuse
   * `SweepResult`. A failed sweep retracts nothing, so "failed" is a complete answer; a
   * failed push either published or did not, and the two demand opposite responses. A
   * caller may retry a failure with `outcomeUnknown: false` - nothing was published, so a
   * retry cannot duplicate. It must NEVER blind-retry one with `outcomeUnknown: true`:
   * the item may already be there, and a second attempt files a duplicate into a tracker
   * other people are reading. This mirrors `RunResult.outcomeUnknown` and the Inspector's
   * `wasRefused`, which is the same rule for the same reason.
   */
  outcomeUnknown: boolean;
}

/**
 * What the daemon lends a push - the same lends as a sweep, deliberately.
 *
 * An alias rather than a fresh interface: the shape is identical (which source, which
 * repo, which signal) and giving it a second declaration would let the two drift apart
 * for no reason. Note that `signal` is shape parity only - see `TaskSourceImpl.push`.
 */
export type PushContext = SweepContext;

// ---- the outward direction: a note written back onto the item a task came from ----
//
// Where `push` files something NEW, these two write onto an item that already exists and
// that somebody is watching. See `WritebackNotice` for why the payload is a snapshot, and
// `src/server/task-sources/writeback.ts` for the ledger that makes delivery durable.

/**
 * Why a write-back is owed.
 *
 * **APPEND-ONLY**, for the reason `TASK_SOURCE_KINDS` is: these strings are persisted in
 * the `task_source_writeback` ledger, and they are half of the unique key a delivery is
 * de-duplicated on. Renaming one orphans every undelivered row written under the old
 * spelling - the worker stops recognising it and the comment silently never appears.
 */
export const WRITEBACK_SIGNALS = ["pr-opened", "task-completed"] as const;
export type WritebackSignal = (typeof WRITEBACK_SIGNALS)[number];

/** What is owed. **APPEND-ONLY**, persisted in the same ledger for the same reason. */
export const WRITEBACK_ACTIONS = ["annotate", "resolve"] as const;
export type WritebackAction = (typeof WRITEBACK_ACTIONS)[number];

/**
 * The facts one write-back may state upstream. A SNAPSHOT, never the live `Task`.
 *
 * A draft rather than the task itself, for the reason `PushDraft` is one: an
 * implementation must not be able to read a status, a worktree or an id off the thing it
 * is publishing, because none of that means anything upstream and all of it would leak
 * our internals into somebody else's tracker.
 *
 * And for a second reason that is specific to this direction. A delivery is enqueued when
 * a fact is OBSERVED and attempted later, by a worker, possibly after a restart. The task
 * may be gone by then - deleted, cleaned up, rescheduled - and "the pull request opened"
 * stays true regardless. Holding a snapshot is what lets the ledger deliver it anyway,
 * and it is why no row on that table joins back to `tasks`.
 */
export interface WritebackNotice {
  signal: WritebackSignal;
  action: WritebackAction;
  /** The item upstream, e.g. "acme/demo#123" or "MC-431". */
  externalId: string;
  /** Deep link back to the item, when the source recorded one. */
  externalUrl: string | null;
  taskTitle: string;
  /** The pull request this is about, or null for a completion that opened none. */
  prUrl: string | null;
  /** Which repository the pull request is in - a multi-repo task owes one notice per repo. */
  repoRoot: string;
  /** The completion's own words, for `task-completed`. Null otherwise. */
  outcome: string | null;
  /** When the fact was OBSERVED, not when delivery is attempted. */
  observedAt: number;
}

/**
 * The outcome of one write-back. Mirrors `PushResult`, for the same reason.
 */
export interface WritebackResult {
  /** Human-readable failure, or null. */
  error: string | null;
  /**
   * The write MAY have landed and we cannot tell.
   *
   * The same load-bearing flag `PushResult` carries, and it matters MORE here. A
   * duplicated push files a second issue, which is noise a human deletes. A duplicated
   * `resolve` re-closes or re-transitions an item a human may have deliberately moved
   * back - it undoes a person rather than adding to a list. So an unknown outcome is
   * never retried automatically, and an operator retrying one is asserting they have gone
   * and looked.
   */
  outcomeUnknown: boolean;
  /** One line for the panel, e.g. "commented" or "closed as completed". Null on failure. */
  detail: string | null;
}

/**
 * What the daemon lends a write-back - the same lends as a sweep, deliberately.
 *
 * An alias for the reason `PushContext` is one: the shape is identical (which source,
 * which repo, which signal) and a second declaration would only let the two drift.
 * `signal` is shape parity here too - nothing aborts a write that has already left.
 */
export type WritebackContext = SweepContext;

/**
 * Per-source consent to write back, stored beside `defaults` on the instance.
 *
 * All three default OFF, for the reason `TaskSourceInstance.enabled` does: adding a
 * source is configuration, and writing onto somebody else's tracker is consent. The
 * default is also what makes this feature invisible to every installation that existed
 * before it - a stored source gains these three `false`s on read and behaves exactly as
 * it did.
 */
export const TaskSourceWritebackSchema = z
  .object({
    /** Comment the pull request onto the item when one is first linked to the task. */
    onPrOpened: z.boolean().default(false),
    /** Comment the outcome onto the item when the task completes. */
    onCompleted: z.boolean().default(false),
    /**
     * Also resolve the item on completion - close the issue, move the ticket.
     *
     * Requires `onCompleted`. Refused at the schema rather than stored, because a stored
     * switch that can never fire is worse than a rejected one: the panel would show
     * auto-resolve ON while nothing ever resolved, and the operator would have no way to
     * tell that from an upstream that keeps refusing.
     */
    resolve: z.boolean().default(false),
  })
  .refine((w) => !(w.resolve && !w.onCompleted), {
    message:
      "auto-resolve needs the completion trigger - a resolve with nothing to trigger it never fires",
    path: ["resolve"],
  });
export type TaskSourceWriteback = z.infer<typeof TaskSourceWritebackSchema>;

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
   * What the panel says when `preflight` finds nothing wrong.
   *
   * Here rather than in the panel because it is a fact about the KIND - which upstream was
   * reached, and what it proved - and the panel had it hardcoded as "gh is reachable and
   * this repo lists issues", which a Jira source would have said while never going near
   * `gh`. A `Record<TaskSourceKind, …>` then makes it the compiler's problem: a new kind
   * cannot ship a success sentence describing somebody else's upstream.
   */
  preflightOk: string;
  /**
   * This kind can receive a task pushed OUTWARD from the backlog.
   *
   * On the pure half, and required, so the `Record<TaskSourceKind, …>` makes every kind
   * declare it - a new kind cannot arrive silently unable to push and have the UI find
   * out by calling. Being browser-safe is the other half of the point: the modal decides
   * whether to offer the action without importing an implementation it cannot load.
   *
   * The server's registry holds the corresponding `push` slot, and
   * `test/task-source-contract.test.ts` pins the two together - a kind that says `true`
   * and implements nothing is a button that fails when pressed.
   */
  canPush: boolean;
  /**
   * This kind can write a note back onto an item it swept - a comment, a remote link.
   *
   * Required, and on the pure half, for the reasons `canPush` is both: the
   * `Record<TaskSourceKind, …>` makes a new kind declare it rather than discovering the
   * answer by calling, and the settings panel decides whether to offer the switch without
   * importing an implementation the browser cannot load.
   *
   * A capability the BUILD does not have is a different thing from a switch an operator
   * has not turned on, which is why the panel disables rather than hides it - and why
   * `test/task-source-contract.test.ts` pins this against the presence of `annotate` in
   * both directions.
   */
  canAnnotate: boolean;
  /**
   * This kind can mark an item resolved - close the issue, transition the ticket.
   *
   * Separate from `canAnnotate` rather than one "can write back" flag, because a kind can
   * honestly have one and not the other: commenting is one call everywhere, while
   * "finished" is whatever a project's own workflow calls it. Pinned against `resolve`
   * the same way.
   */
  canResolve: boolean;
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
 * Every call here may leave the process, which is why they live on the server's record
 * and not in `TASK_SOURCE_KIND_INFO`. None of them may write to OUR database: a sweep
 * RETURNS candidates and `ingest.ts` decides what becomes of them, and a push RETURNS the
 * ref it minted upstream for its own chokepoint to record.
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
  /**
   * File one of our tasks as an item in the external system, and report what was created.
   *
   * Optional, and present EXACTLY when the kind's `canPush` says so - the contract test
   * pins both directions, because a kind offering the action without implementing it and
   * a kind implementing it without offering it are both silent bugs. Reach it through
   * `pushToSource` (`src/server/task-sources/index.ts`), never by testing `inst.kind`.
   *
   * Fires only on an explicit per-task operator action. NEVER from the sweep loop, and
   * never from anything a sweep saw: this publishes to a place other people watch, and
   * deleting the row here does not take it back.
   *
   * `ctx.signal` is shape parity with `SweepContext` and nothing more. There is no
   * cancellation path - `run()` takes no signal - so an implementation must not pretend
   * to one, and a caller must not rely on aborting to stop a push. The real bounds are
   * the implementation's own subprocess timeout and the caller's in-flight guard.
   */
  push?(config: C, draft: PushDraft, ctx: PushContext): Promise<PushResult>;
  /**
   * Write a note onto the item this task was swept from, and report what was said.
   *
   * Optional, and present EXACTLY when the kind's `canAnnotate` says so - the contract
   * test pins both directions. Reach it through `annotateWith`
   * (`src/server/task-sources/index.ts`), never by testing `inst.kind`.
   *
   * NEVER called from the sweep loop, and never inline on a hot path. The only caller is
   * the write-back worker, draining a ledger row a trigger enqueued - so an implementation
   * may take its subprocess or its round trip without anything waiting on it.
   *
   * `ctx.signal` is shape parity with `SweepContext` and nothing more, exactly as it is on
   * `push`: nothing cancels a comment that has already been sent.
   */
  annotate?(
    config: C,
    notice: WritebackNotice,
    ctx: WritebackContext,
  ): Promise<WritebackResult>;
  /**
   * Mark the item finished, and report what moved.
   *
   * Optional, present exactly when `canResolve` says so, reached through `resolveWith`,
   * and called only by the worker - all as for `annotate` above. The difference is what a
   * mistake costs: this is the one verb in the feature that changes an item's STATE, so a
   * refusal must name what to fix rather than guess, and an unknown outcome must never be
   * retried automatically. See `WritebackResult.outcomeUnknown`.
   */
  resolve?(
    config: C,
    notice: WritebackNotice,
    ctx: WritebackContext,
  ): Promise<WritebackResult>;
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
    /**
     * How `resolve` closes an issue, when the source's write-back consent says to.
     *
     * OUR spelling, not `gh`'s. `gh issue close --reason` takes `completed` or
     * `not planned` WITH A SPACE, and the argv builder maps this value rather than
     * passing it through. Storing `gh`'s spelling instead would put a space inside a
     * persisted enum for no gain, and passing ours through unmapped is a close that `gh`
     * rejects on every attempt until the ledger row exhausts its retries - a switch that
     * looks configured and never works.
     */
    closeReason: z.enum(["completed", "not-planned"]).default("completed"),
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

// ---- jira: a JQL filter as a backlog queue ----

/**
 * The Jira site a source points at unless it says otherwise.
 *
 * A default rather than a required field, because the config schema MUST parse `{}` - a
 * freshly added source stores an empty blob and is configured afterwards. Upstart's own
 * host is the useful default for the operators this was built for, and it is only a
 * default: any Jira Cloud host works, and the field is editable in the panel.
 */
export const DEFAULT_JIRA_SITE = "upstartnetwork.atlassian.net";

/**
 * The Jira sweep, as configured.
 *
 * No credential lives here, and that is the design rather than an omission. The local method
 * reads the operator's own `jira` CLI first and falls back to `JIRA_API_TOKEN` + `JIRA_EMAIL`.
 * The UpstartClaw method uses the operator's completed Claude plugin setup. Neither stores a
 * token or opens a second OAuth flow in Mission Control.
 */
export const JiraConfigSchema = z.object({
  /** The Jira Cloud host, e.g. `your-org.atlassian.net`. A URL is accepted and reduced. */
  site: z.string().max(200).default(DEFAULT_JIRA_SITE),
  /**
   * The filter, in JQL. Empty is a valid STORED config and an unusable sweep.
   *
   * It cannot be refused here: the schema has to parse `{}`, because that is the blob a
   * freshly added source carries before anybody configures it. So the emptiness is caught
   * where it can be explained instead - `preflight` names it, and `sweep` returns an error
   * rather than an empty success, because a source that silently sweeps nothing is
   * indistinguishable from a filter with no matching issues.
   */
  jql: z.string().max(1000).default(""),
  /** Which credential boundary executes the JQL. Existing sources retain their local path. */
  queryVia: z.enum(["local", "upstartclaw"]).default("local"),
  /** How many issues one sweep asks Jira for. */
  limit: z.number().int().min(1).max(200).default(50),
  /**
   * Map the issue's own Jira priority onto the task's (Highest -> Blocker, and so on).
   *
   * Off, every swept task takes the source's default priority instead. Unmapped names
   * leave the priority OPEN either way, so the source's default still applies - see
   * `priorityFor` in `src/server/task-sources/jira.ts`.
   */
  priorityFromJira: z.boolean().default(true),
  /**
   * The status a resolved issue should land in, e.g. `Done`. Empty is a valid STORED
   * config and an unusable resolve, exactly as `jql` is and for the same reason: this
   * schema has to parse `{}`, because that is the blob a freshly added source carries.
   * So the emptiness is caught where it can be explained instead.
   *
   * Jira has no single "close": a project's own workflow decides both what finished is
   * called and which transitions are reachable from where the issue is standing right
   * now. Matching a name the operator wrote against the transitions Jira offers is the
   * only way to be right about that, and refusing with the available names is the only
   * useful thing to do when it does not fit.
   *
   * Read by the verbs Phase 2 implements. Stored here from Phase 1 so
   * `src/shared/task-source.ts` has exactly one owner across the feature; until then
   * `jira` declares `canAnnotate: false, canResolve: false` and nothing reads it.
   */
  resolveTransition: z.string().max(120).default(""),
  /**
   * How `annotate` links the pull request onto the issue.
   *
   * Both by default, because they answer different questions: the remote link is where a
   * person looks for "what work touched this", and the comment is what reaches the
   * activity feed and a notification. Phase 2 implements them.
   */
  linkVia: z.enum(["comment", "remote-link", "both"]).default("both"),
});
export type JiraConfig = z.infer<typeof JiraConfigSchema>;

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
    preflightOk: "Looks good - gh is reachable and this repo lists issues.",
    // `gh issue create` is the outward half, so a backlog task can become an issue other
    // people sweeping this repo can see.
    canPush: true,
    // `gh issue comment` and `gh issue close`, through the same CLI and the same auth as
    // everything else here - so the write-back direction adds no token and no new secret.
    canAnnotate: true,
    canResolve: true,
    configSchema: GithubIssuesConfigSchema,
  },
  jira: {
    kind: "jira",
    label: "Jira",
    blurb:
      "Files the issues a JQL filter matches as backlog tasks, through local Jira credentials or UpstartClaw.",
    preflightOk: "Looks good - Jira answered, and this JQL filter runs.",
    // Inbound only, and that is a decision rather than a gap: creating a Jira issue means
    // a project key, an issue type and whatever fields that project marks required, which
    // is a configuration surface of its own. Declared false so the action is hidden
    // instead of failing when pressed.
    canPush: false,
    // A comment and a remote link carrying the pull request, through the same two rungs and
    // the same egress guard the sweep uses - so the write-back direction adds no token and
    // no new secret here either.
    canAnnotate: true,
    // `resolve` moves the issue to the status the source names, matched against the
    // transitions Jira offers from where the issue is standing. True only because both
    // verbs exist: `test/task-source-contract.test.ts` refuses to compile past a kind that
    // advertises either one without implementing it.
    canResolve: true,
    configSchema: JiraConfigSchema,
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
  kind: z
    .enum(TASK_KINDS)
    .refine(taskKindAllowsBacklog, TASK_KIND_BACKLOG_REFUSAL)
    .default("ship"),
  /**
   * `null` inherits the kind's agent from Settings -> Models, resolved as each swept row is
   * filed. A source that names one pins it, and a stored source that already names one keeps
   * it - only a source left unset follows the kind.
   */
  agent: z.enum(AGENT_TYPES).nullable().default(null),
  priority: z.enum(TASK_PRIORITIES).nullable().default(null),
  labels: z.array(z.string()).max(MAX_LABELS).default([]).transform(normalizeLabels),
  /**
   * Whether Foreman's backlog autopilot may schedule tasks this source files.
   *
   * Defaults OFF, for the same reason a source itself does: a sweep is a machine deciding
   * that something upstream is work, and an upstream tracker is not a queue anyone curated.
   * Left on, the first sweep of a busy repo lands twenty-five rows the autopilot may start
   * dispatching before an operator has read one of their titles - and the only way back is
   * to catch each one already running. Parked instead, they arrive as a list to triage, and
   * enabling a row is the operator saying yes to THAT row. A source whose upstream is
   * already curated turns this on once, in the editor, and every later sweep honours it.
   */
  enabled: z.boolean().default(false),
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
  /**
   * Whether this source may write back onto the items it swept, and how far.
   *
   * A default over the `app_config` blob, so a source written by an older build gains
   * three `false`s on read and needs no migration - the same way every other field here
   * arrived.
   */
  writeback: TaskSourceWritebackSchema.default({}),
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

/**
 * One source's write-back queue, as the panel reads it.
 *
 * Derived from the `task_source_writeback` ledger on every read, unlike `TaskSourceStatus`
 * above, which is process-local. The difference is what each describes: a sweep's outcome
 * is re-established by simply sweeping again, while an owed write-back is a fact that must
 * survive a restart, so its counts come from the table that survived with it.
 */
export interface TaskSourceWritebackStatus {
  sourceId: string;
  /** Owed and not yet attempted, or waiting out a backoff or a settle window. */
  pending: number;
  /** Refused until the attempts ran out. Nothing was written; a retry is safe. */
  failed: number;
  /**
   * May have landed upstream, and we cannot tell.
   *
   * Never retried automatically. A person looks at the item first, which is why the
   * panel's retry control separates these from `failed` rather than sweeping both up.
   */
  unknown: number;
  delivered: number;
  /** The most recent failure's words, or null. */
  lastError: string | null;
  lastDeliveredAt: number | null;
}

/** The whole Task sources panel in one read: what is configured, and how it is doing. */
export interface TaskSourcesView {
  sources: TaskSourceInstance[];
  status: TaskSourceStatus[];
  /**
   * Each source's write-back queue - one entry per CONFIGURED source, in no particular
   * relation to `sources` beyond `sourceId`.
   *
   * A source that owes nothing still gets an entry, with zeroes: "this source owes
   * nothing" and "there is no such source" are different answers, and the panel draws a
   * line for the first and nothing for the second.
   */
  writeback: TaskSourceWritebackStatus[];
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
