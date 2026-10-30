import { BUG_FIX_REVIEW_WORKFLOW_ID, PLAN_VALIDATION_WORKFLOW_ID, LOCAL_PLAN_VALIDATION_WORKFLOW_ID, DOCUMENTATION_REVIEW_WORKFLOW_ID } from "./builtin-workflow.ts";
// Kind, priority and label vocabulary for dispatched tasks, shared by the server (route
// validation, the roundup report, task sources) and the web app (the dispatch form,
// the board's backlog column, the roundup panel) so the two can never disagree about
// what a label is or what a priority chip means.
//
// Priority and labels are OPTIONAL and default to nothing: `priority: null` and
// `labels: []`. Nothing in the product infers either one - a task carries a priority
// because a human or a task source said so, never because we guessed from its text.
// Kind is not optional; every task names one registered launch contract, and `ship` is the
// default.

import { TASK_KINDS } from "./types.ts";
import type { Session, Task, TaskKind, TaskPriority } from "./types.ts";

/**
 * How each kind PRESENTS itself. Where a surface offers the choice, its copy comes from
 * here - every one of them, now that `TaskSourcesPanel` and `ScheduleEditor` render from
 * this record too. They used to spell their own `<option>`s, each differently, and were
 * named in `KNOWN_HAND_WRITTEN` (`test/task-kinds.test.ts`) as a list allowed to shrink
 * and never grow; adding a third kind is what emptied it, because a hand-written pair
 * does not fail to compile when a kind is added - it just quietly stops offering it.
 *
 * The ids themselves live in `TASK_KINDS` (`types.ts`), which the server validates
 * against; this is the copy half, kept out of `types.ts` for the reason `AGENT_IDENTITY`
 * is kept out of it - what a thing is called is not what a thing is.
 *
 * `Record<TaskKind, …>` is the enforcement: a new kind does not compile until it has
 * said how it is offered. One record rather than parallel records over the same domain,
 * matching `AGENT_IDENTITY` - the registry the select directly above the Kind select
 * renders from - because these are one question ("what is this choice?") asked of one
 * kind at one surface each.
 *
 * `label` is lowercase because it is the option's own text and these are jargon, not
 * proper nouns; it reads as the word the task carries, not as a heading.
 */
/**
 * One stroke of a kind's icon, on a 16-unit grid and drawn in `currentColor`. Plain data rather
 * than markup because this module is browser-safe shared logic with no React in it; the web's
 * `TaskKindIcon` turns each shape into its SVG element.
 */
export type TaskKindIconShape =
  | { shape: "path"; d: string }
  | { shape: "circle"; cx: number; cy: number; r: number }
  | { shape: "rect"; x: number; y: number; width: number; height: number; rx: number };

export interface TaskKindInfo {
  /** The option's text. */
  label: string;
  /** One line saying what choosing it means, for a picker that has room to say so. */
  blurb: string;
  /**
   * What the kind is for, as one short verb phrase and no sentence - for the readers that
   * have room for a clause but not for a line.
   *
   * Two of them, which is why this is a field and not a local: Foreman's backlog planner
   * (`server/foreman/backlog-prompt.ts`) glosses each task's kind for the model, and the
   * two `<select>`s that are the ONLY control offering the choice on their screen (the
   * Recurring Mission editor, task-source defaults) suffix it to the label, where the
   * dispatch form can afford to show `blurb` beside the option instead.
   *
   * Not `blurb`, for both readers and for the same reason: `blurb` explains consequences
   * inside the dispatch form ("no diff, so no after-work" is about a control on that
   * screen), which a planner ordering a backlog and a schedule editor with no after-work
   * field both read as noise. This is the half that survives leaving that screen.
   *
   * Kept parallel across the kinds - verb, then object - because these are read as a list.
   */
  purpose: string;
  /**
   * The kind's own colour, as a CSS colour value. Applied inline as `--kind` wherever a
   * surface marks the kind (`TaskKindMark`), the way a harness's brand colour arrives as
   * `--agent-accent`, so a new kind does not compile until it has one and `styles.css` needs
   * no per-kind rule. Chosen to stay clear of the state tones that already colour a card's
   * left edge and the header's status pill. Colour is never the only cue: the kind's icon is
   * always drawn with it, and the word is printed too except in two places. The card's
   * `medallion` style is icon-only and names the kind on hover and as its accessible name, and
   * the header badge sheds its word at the narrowest width, where the word stays the badge's
   * accessible text and hover still names the kind.
   */
  accent: string;
  /**
   * The kind's icon, declared here beside its colour so a new kind does not compile until it
   * has both. Every kind's icon is different (`test/task-kind-mark.test.ts` renders them).
   */
  icon: readonly TaskKindIconShape[];
  afterWorkHint?: string;
}

export const TASK_KIND_INFO: Record<TaskKind, TaskKindInfo> = {
  document: {
    label: "document",
    blurb: "Update repository documentation, with Documentation Review before the pull request.",
    purpose: "write and maintain documentation",
    accent: "#e9b96e",
    icon: [
      { shape: "path", d: "M4 1.5h5l3 3V14H4zM9 1.5v3h3M6 7h4M6 9.5h4M6 12h2" },
    ],
    afterWorkHint: "Documentation Review checks accuracy, consistency, concise prose, and references.",
  },
  ship: {
    label: "ship",
    blurb: "Deliver a change, as a pull request.",
    purpose: "deliver a change",
    accent: "#3dd6c6",
    icon: [{ shape: "path", d: "M8 10.5V2.5M4.6 5.9 8 2.5l3.4 3.4M3 9.5v3.5h10V9.5" }],
  },
  bugfix: {
    label: "bugfix",
    blurb: "Fix a bug, with Bug Fix Review before the pull request.",
    purpose: "fix a bug",
    accent: "#ff7b72",
    icon: [
      { shape: "rect", x: 5, y: 5, width: 6, height: 8.5, rx: 3 },
      { shape: "path", d: "M8 7v6.5M5 9H2.5M11 9h2.5M5 12l-2 1.3M11 12l2 1.3M6 5.4 4.4 3.6M10 5.4l1.6-1.8" },
    ],
    afterWorkHint: "Bug Fix Review checks the cause, regression proof, and code risk.",
  },
  scout: {
    label: "scout",
    blurb: "Investigate and report. No diff, so no after-work.",
    purpose: "investigate and report",
    accent: "#79c0ff",
    icon: [
      { shape: "circle", cx: 7, cy: 7, r: 4.2 },
      { shape: "path", d: "m10.1 10.1 3.4 3.4" },
    ],
  },
  plan: {
    label: "plan",
    blurb: "Produce a reviewed plan with Plan Validation, and optionally schedule the work.",
    purpose: "produce a reviewed plan",
    accent: "#a371f7",
    icon: [
      { shape: "path", d: "M6.5 4h7M6.5 8h7M6.5 12h7" },
      { shape: "path", d: "m2.2 4 .9.9L4.6 3.2M2.2 8l.9.9 1.5-1.7" },
      { shape: "circle", cx: 3.4, cy: 12, r: 0.9 },
    ],
    afterWorkHint: "Plan Validation checks agreement across plan files and phases.",
  },
  pipeline: {
    label: "pipeline",
    blurb: "Start conductor's SDLC pipeline. Conductor owns its worktree and PR; no after-work.",
    purpose: "run a conductor pipeline",
    accent: "#db61a2",
    icon: [
      { shape: "circle", cx: 3.4, cy: 8, r: 1.7 },
      { shape: "circle", cx: 12.6, cy: 3.8, r: 1.7 },
      { shape: "circle", cx: 12.6, cy: 12.2, r: 1.7 },
      { shape: "path", d: "M5.1 8h2.4l3.4-3.6M7.5 8l3.4 3.6" },
    ],
  },
  chat: {
    label: "chat",
    blurb: "Talk with an agent without a planned artifact. No after-work.",
    purpose: "have an open-ended conversation",
    accent: "#b4c0cf",
    icon: [{ shape: "path", d: "M2.5 3.2h11v7.2H7.6l-3.2 2.6v-2.6H2.5z" }],
  },
  resident: {
    label: "resident",
    blurb: "Hold a standing role from a resident profile until Complete & close. No after-work.",
    purpose: "hold a standing role from a profile",
    accent: "#b5d462",
    icon: [
      { shape: "path", d: "M2.5 7.4 8 2.8l5.5 4.6M4 6.3V13.2h8V6.3" },
      { shape: "rect", x: 6.6, y: 9.2, width: 2.8, height: 4, rx: 0.6 },
    ],
  },
};

/** The launch and scheduling rules every surface must apply to a task kind. */
export interface TaskKindBehavior {
  /** Which repository catalog may offer this kind. */
  repoAvailability: "workspace" | "pipeline-enabled" | "optional";
  /**
   * Who owns the launched process and runtime choices.
   *
   * `resident` is Mission Control's own harness launch with every choice taken from a
   * resident profile: the profile names the harness, model and effort, and the run is always
   * the Agent SDK. That is why it is not `harness` - per-kind defaults would be a second
   * source for answers the profile already gives.
   */
  launch: "harness" | "pipeline" | "resident";
  /** Whether Foreman's backlog loop may pick this kind unattended. */
  autopilot: boolean;
  /** A short, operator-facing explanation of non-default launch constraints. */
  constraint: string | null;
}

/**
 * Behaviour stays registry-driven so every picker and autonomous path gains a new kind only
 * after answering the same three questions: where it is available, who launches it, and
 * whether Foreman may schedule it.
 */
export const TASK_KIND_BEHAVIOR = {
  document: {
    repoAvailability: "workspace",
    launch: "harness",
    autopilot: true,
    constraint: null,
  },
  ship: {
    repoAvailability: "workspace",
    launch: "harness",
    autopilot: true,
    constraint: null,
  },
  bugfix: {
    repoAvailability: "workspace",
    launch: "harness",
    autopilot: true,
    constraint: null,
  },
  scout: {
    repoAvailability: "workspace",
    launch: "harness",
    autopilot: true,
    constraint: null,
  },
  plan: {
    repoAvailability: "workspace",
    launch: "harness",
    autopilot: true,
    constraint: null,
  },
  pipeline: {
    repoAvailability: "pipeline-enabled",
    launch: "pipeline",
    autopilot: false,
    constraint:
      "Pipeline tasks use Conductor's configured Engineer host. Conductor owns its downstream agent, model, and effort; attached repos, after-work workflows, and backlog autopilot do not apply.",
  },
  chat: {
    repoAvailability: "workspace",
    launch: "harness",
    autopilot: false,
    constraint: null,
  },
  resident: {
    repoAvailability: "optional",
    launch: "resident",
    autopilot: false,
    constraint:
      "Resident tasks launch only from a resident profile, in the Agent SDK, with the profile's harness, model and effort.",
  },
  // `as const satisfies` rather than a plain annotation: `satisfies` keeps the
  // exhaustiveness gate exactly as it was - a new kind still does not compile until it has
  // answered all four questions - while `as const` keeps each answer's LITERAL type, which
  // is what lets `HarnessLaunchedTaskKind` below be derived from this record instead of
  // being a second, hand-maintained list that can silently disagree with it.
} as const satisfies Record<TaskKind, TaskKindBehavior>;

/**
 * The kinds Mission Control itself launches a harness for, derived rather than listed.
 *
 * `pipeline` is absent because it declares `launch: "pipeline"` - Conductor owns its
 * downstream agent, model and effort, so a per-kind default would be a control that could
 * never reach the process it appears to describe. Derived from the behaviour registry so a
 * future harness-launched kind joins this list by answering `TASK_KIND_BEHAVIOR`, and a
 * future provider-launched one stays out of it, without either editing a second list.
 */
export type HarnessLaunchedTaskKind = {
  [K in TaskKind]: (typeof TASK_KIND_BEHAVIOR)[K]["launch"] extends "harness" ? K : never;
}[TaskKind];

export const HARNESS_LAUNCHED_TASK_KINDS = TASK_KINDS.filter(
  taskKindLaunchesHarness,
) as readonly HarnessLaunchedTaskKind[];

/** Whether this kind's launch is ours to give an agent, model and effort to. */
export function taskKindLaunchesHarness(kind: TaskKind): kind is HarnessLaunchedTaskKind {
  return TASK_KIND_BEHAVIOR[kind].launch === "harness";
}

/** Whether the external provider projection, rather than a host session, owns completion. */
export function providerOwnsTaskCompletion(kind: TaskKind): boolean {
  return TASK_KIND_BEHAVIOR[kind].launch === "pipeline";
}

/**
 * The runtime a kind always launches on, or null when the harness's configured runtime decides.
 *
 * A resident is an Agent SDK session by definition: its persona travels as standing
 * instructions on the SDK channel and its lifetime is the embedded session's. Derived from
 * `launch` so the answer cannot disagree with who owns the launch.
 */
export function taskKindForcedRuntime(kind: TaskKind): "sdk" | null {
  return TASK_KIND_BEHAVIOR[kind].launch === "resident" ? "sdk" : null;
}

/**
 * Why a session running a task of this kind cannot Continue in terminal, or null. A kind that
 * forces the Agent SDK keeps its session there: its role is delivered on the SDK channel, and a
 * terminal handoff would leave the kind's one runtime.
 */
export function taskKindTerminalHandoffRefusal(kind: TaskKind): string | null {
  return taskKindForcedRuntime(kind) === "sdk"
    ? `A ${TASK_KIND_INFO[kind].label} runs only in the Agent SDK, so it cannot continue in a terminal.`
    : null;
}

/** Whether Foreman's unattended backlog loop may schedule this kind. */
export function allowsBacklogAutopilot(kind: TaskKind): boolean {
  return TASK_KIND_BEHAVIOR[kind].autopilot;
}

/**
 * Whether a kind sets out to produce a diff worth reviewing.
 *
 * Its own record rather than a field on `TaskKindInfo`, which is scoped by its own comment
 * to one question asked of a human at one surface. This is not copy - it is a fact about
 * what the work produces, and the dispatch form reads it to decide a DIFFERENT control's
 * value. Mixing them would put "what is this choice?" and "what follows from it?" in one
 * record and lose the reason either is written down.
 *
 * Ship and Bugfix produce implementation diffs; Plan and Document produce reviewable documents.
 * This record keeps that property independent from which kind is the dispatch default.
 */
const KIND_PRODUCES_A_DIFF: Record<TaskKind, boolean> = {
  document: true,
  ship: true,
  bugfix: true,
  scout: false,
  plan: true,
  pipeline: false,
  chat: false,
  resident: false,
};

/**
 * Does a task of this kind end in something an after-work Workflow could review?
 *
 * The dispatch form's after-work rule (`DispatchModal.tsx`) is the caller: a kind with no
 * diff preselects None, because arming a change-review over a task that never set out to
 * produce a change reviews an empty diff and reports on nothing.
 */
export function hasReviewableDiff(kind: TaskKind): boolean {
  return KIND_PRODUCES_A_DIFF[kind];
}

/** Whether this kind can be stored in the backlog or produced by backlog automation. */
const KIND_ALLOWS_BACKLOG: Record<TaskKind, boolean> = {
  document: true,
  ship: true,
  bugfix: true,
  scout: true,
  plan: true,
  pipeline: true,
  chat: false,
  resident: false,
};

export const TASK_KIND_BACKLOG_REFUSAL =
  "Chat tasks must be launched immediately from Dispatch.";

/** The refusal a resident task meets on any surface but its profile's Launch. */
export const RESIDENT_TASK_REFUSAL =
  "Resident tasks are launched from a resident profile. Launch a new resident instead.";

/**
 * Why a kind with no backlog cannot be stored, retried or edited into one. One sentence per
 * kind, so a refusal names the surface that does launch it.
 */
const KIND_BACKLOG_REFUSALS: Record<TaskKind, string | null> = {
  document: null,
  ship: null,
  bugfix: null,
  scout: null,
  plan: null,
  pipeline: null,
  chat: TASK_KIND_BACKLOG_REFUSAL,
  resident: RESIDENT_TASK_REFUSAL,
};

export function taskKindAllowsBacklog(kind: TaskKind): boolean {
  return KIND_ALLOWS_BACKLOG[kind];
}

/** The sentence a backlog-only operation refuses this kind with. */
export function taskKindBacklogRefusal(kind: TaskKind): string {
  return KIND_BACKLOG_REFUSALS[kind] ?? TASK_KIND_BACKLOG_REFUSAL;
}

/**
 * Which creation surface may file a task of this kind.
 *
 * - `any`: every creator, durable producers included.
 * - `dispatch`: only the manual Dispatch capability (`chat`).
 * - `resident-launch`: only `ResidentManager.launch`, which reserves the run first. The
 *   Dispatch form does not offer it as a kind and `DispatchSchema` refuses it.
 */
export type TaskKindCreator = "any" | "dispatch" | "resident-launch";

const KIND_CREATOR: Record<TaskKind, TaskKindCreator> = {
  document: "any",
  ship: "any",
  bugfix: "any",
  scout: "any",
  plan: "any",
  pipeline: "any",
  chat: "dispatch",
  resident: "resident-launch",
};

export function taskKindCreator(kind: TaskKind): TaskKindCreator {
  return KIND_CREATOR[kind];
}

/** Kinds the Single agent Dispatch form may offer: everything a profile does not launch. */
export const DISPATCH_TASK_KINDS = TASK_KINDS.filter(
  (kind) => taskKindCreator(kind) !== "resident-launch",
);

/** The fields `taskRequeueRefusal` reads, so a `TaskSummary` answers as well as a `Task`. */
export type RequeueCandidate = Pick<Task, "kind" | "status"> & {
  pipelineCommissionId?: Task["pipelineCommissionId"];
};

/**
 * Why this task cannot be sent back to the backlog, or null when it can.
 *
 * One answer for the daemon's refusal and the dashboard's disabled control, so the button is
 * never offered on a click the route would reject. A live task (dispatching or running) is
 * cancelled on the way back; a stopped one (cancelled or failed) is re-filed as it stands.
 * A done task keeps its result, and a Pipeline commission is its own durable lifecycle that
 * the backlog cannot restart.
 */
export function taskRequeueRefusal(task: RequeueCandidate): string | null {
  if (!taskKindAllowsBacklog(task.kind)) return taskKindBacklogRefusal(task.kind);
  if (task.kind === "pipeline" && task.pipelineCommissionId) {
    return "a Pipeline commission cannot return to the backlog; create a new Pipeline task";
  }
  switch (task.status) {
    case "dispatching":
    case "running":
    case "cancelled":
    case "failed":
      return null;
    case "backlog":
      return "task is already in the backlog";
    case "done":
      return "task is done; its result is recorded, not re-run";
  }
}

/**
 * Whether a dispatch still has no durable milestone proving provisioning or launch began.
 *
 * Live failure handling and startup reconciliation share this resource proof; live handling
 * additionally limits recovery to its base-freeze and worktree-provisioning phase. Every
 * worktree is recorded before either harness runtime can start, so this shape cannot hide a
 * second agent on the same work. Branch and base-SHA fields are descriptive metadata, not
 * launch milestones, so stale or precomputed values there do not keep an otherwise
 * resource-free row stranded.
 */
export function dispatchHasNoProvisionedResources(task: Task): boolean {
  return task.status === "dispatching" && taskHasNoProvisionedResources(task);
}

/** Resource ownership, independently of the task lifecycle state. */
export function taskHasNoProvisionedResources(task: Task): boolean {
  return (
    task.pipelineRun === null &&
    task.worktreePath === null &&
    task.provider === null &&
    task.homeName === null &&
    task.terminalResourceId === null &&
    task.sessionId === null &&
    task.extraRepos.every((entry) => entry.worktreePath === null && entry.provider === null)
  );
}

/** Task kinds offered by surfaces that can only create or edit backlog work. */
export const BACKLOG_TASK_KINDS = TASK_KINDS.filter(taskKindAllowsBacklog);

/**
 * The priorities, in ascending urgency. Array order is picker order and the order the
 * README's table lists - one array so a fifth level is one edit. It is NOT a backlog sort
 * order; nothing sorts by priority (see `byBacklogRank`).
 */
export const TASK_PRIORITIES = ["low", "med", "high", "blocker"] as const;

/** Human-facing label for each priority. Short, because these render inside a chip. */
export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  med: "Medium",
  high: "High",
  blocker: "Blocker",
};

/**
 * Urgency rank, ascending. The interesting value is the one for *unset*, which sits
 * between `low` and `med` rather than at the bottom: `low` is an explicit demotion BELOW
 * the default, and everything above it is an explicit promotion. Bottom would say the
 * false thing - that an item nobody has looked at is less urgent than one somebody
 * deliberately marked as able to wait.
 *
 * NOT A SORT RANK ANY MORE. The backlog is in the operator's order (`byBacklogRank`), and
 * this survives for two readers that compare urgency without ordering anything: the
 * planner panel's "N of the ready carry a higher priority" line, and the one-time
 * `backlog_rank` backfill through `byPriorityThenAge`.
 */
const PRIORITY_RANK: Record<TaskPriority, number> = { low: 0, med: 2, high: 3, blocker: 4 };
const UNSET_RANK = 1;

/** Ascending rank for a task's priority, with unset landing between `low` and `med`. */
export function priorityRank(p: TaskPriority | null): number {
  return p == null ? UNSET_RANK : PRIORITY_RANK[p];
}

/** Longest a single label may be. Long enough for `type: needs-design`, short enough to chip. */
export const LABEL_MAX = 32;

/** How many labels one task may carry, so a sweep of a heavily-tagged issue can't flood a card. */
export const MAX_LABELS = 12;

/**
 * How many prerequisites one task may carry. The one owner of the rule: the single-task and
 * MCP create schemas, the bulk edit's schema, and `bulkTaskPatch` all read it from here.
 */
export const MAX_TASK_DEPENDENCIES = 50;

/**
 * Clean a caller's labels into the canonical set stored on a task: trimmed, empties
 * dropped, deduped, capped.
 *
 * Dedupe is case-INSENSITIVE but the first spelling is what survives. Case-sensitive
 * dedupe would let `bug` and `Bug` both sit on one card as if they were different
 * tags, which is the bug this exists to prevent. Lowercasing everything would be
 * simpler and is deliberately not done: a task source maps an external system's tags
 * onto these, and GitHub labels like `Type: Bug` are authored with their case on
 * purpose - mangling them would make a swept task's labels stop matching the issue it
 * came from.
 */
export function normalizeLabels(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const label = entry.trim().slice(0, LABEL_MAX);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

/**
 * Order two tasks by priority, most urgent first and oldest first within a priority.
 *
 * NO LONGER THE BACKLOG'S ORDER. The backlog is ordered by `byBacklogRank` below - the
 * operator arranges it and priority is pure annotation, which is the whole point of the
 * manual-order feature (see `docs/plans/backlog-manual-order/plan.md`). This survives for
 * exactly one job: the one-time `backlog_rank` backfill in `migrate()`, which numbers an
 * upgrading operator's backlog in the order their board was already showing so upgrade day
 * changes nothing visible. Nothing else calls it, and nothing else should.
 */
export function byPriorityThenAge(a: Task, b: Task): number {
  const rank = priorityRank(b.priority) - priorityRank(a.priority);
  return rank !== 0 ? rank : a.createdAt - b.createdAt;
}

/**
 * The fields `byBacklogRank` needs, so it can order rows read straight out of SQLite
 * (`normalizeBacklogRanks`) with the same comparator the browser orders `Task`s with.
 * A `Task` satisfies this structurally, so callers pass one unchanged.
 */
export interface BacklogRanked {
  id: string;
  createdAt: number;
  backlogRank: number | null;
}

/**
 * Order the backlog: the operator's arrangement, ascending, unranked rows last.
 *
 * The single comparator every backlog surface reads through - `backlogTasks` sorts by it,
 * and the board column, the Line drawer, the Sitrep, `plannableBacklog` and `readyBacklog`
 * all come through there. One order, so none of them can drift from the scheduler.
 *
 * THE TWO-STEP COMPARISON IS LOAD-BEARING AND THE ONE-LINER IS WRONG. The obvious
 * `(a.backlogRank ?? Infinity) - (b.backlogRank ?? Infinity)`, guarded with
 * `Number.isFinite`, looks equivalent and is not: a finite rank minus `Infinity` is
 * `-Infinity`, the guard rejects it, and the comparison falls through to `createdAt` - so
 * an old unranked row sorts AHEAD of every ranked one, the exact opposite of the rule.
 * Hence the explicit mixed-case branch, and only then the age fallback.
 *
 * Total on purpose. `Infinity - Infinity` is `NaN` and a `NaN`-returning comparator sorts
 * unpredictably, which is why two unranked rows fall through to `createdAt` and then `id`.
 * Two rows can genuinely share a rank (a restored backup, a hand-edited database), and
 * returning 0 there would let two cards swap places between renders for no reason a human
 * could see.
 */
export function byBacklogRank(a: BacklogRanked, b: BacklogRanked): number {
  const ar = a.backlogRank ?? Infinity;
  const br = b.backlogRank ?? Infinity;
  if (ar !== br && Number.isFinite(ar - br)) return ar - br;
  if (ar !== br) return ar === Infinity ? 1 : -1;
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** What a session's task pill has left to say once the constants and duplicates are dropped. */
export interface TaskPillParts {
  /**
   * The task's title, or null when the session is already named after it. Kept rather than
   * dropped because a session re-assigned to a later task keeps the first task's title as its
   * name, and the pill is then the only place the task now executing appears.
   */
  title: string | null;
  /**
   * True when nothing the pill hosts on EVERY surface has anything to say - no title, no
   * outcome and no schedule origin.
   *
   * The pill is not an empty frame: it has a background, a border and a tone-coloured
   * left edge, so drawing one with nothing in it is a bar of chrome that says less than
   * nothing. That is the common case - an ordinary running task on a session named after
   * it - so the reduction is not finished until the container goes with the text.
   *
   * The task's KIND is deliberately not an operand any more. It used to be drawn here for
   * every kind but `ship`, which left the most common kind printed nowhere at all. It is now
   * drawn for every kind, `ship` included, by `TaskKindMark` beside the session's own name,
   * where the operator chooses its style (`taskKindHeader` in Settings > Display). Drawing
   * it here as well would say it twice.
   *
   * `repoPrs` is deliberately NOT one of the operands, and it is the one a reader will
   * reach for. A multi-repo task's per-repo pull-request list is a SIBLING row, not
   * pill content - it is a separate row precisely because it is as wide as the repo
   * count while the pill's outcome link is pinned right - and it gates itself on being
   * non-empty. Folding it in here would draw a pill with nothing in it above that row.
   */
  silent: boolean;
}

/** A session with no task at all: nothing to draw, and no pill either. */
const NO_PILL: TaskPillParts = { title: null, silent: true };

/**
 * What the task pill should draw for a session.
 *
 * The title is a duplicate because `dispatcher.ts` names a dispatched session after its
 * task, so the pill usually repeats the `h2` two rows above it. It is NOT always a
 * duplicate, which is why this is a comparison rather than a deletion: a session
 * re-assigned to a later task keeps the first task's title as its name, and the pill is
 * then the only place the task now executing appears (`test/task-multi-session.test.ts`).
 */
export function taskPillParts(session: Pick<Session, "name" | "task">): TaskPillParts {
  const task = session.task;
  if (!task) return NO_PILL;
  const title = task.title === session.name ? null : task.title;
  return {
    title,
    // `scheduleId` rather than a call into `ScheduleOriginChip`: this module is browser-safe
    // shared logic and cannot import a component, and the chip's own gate is that one field
    // (`scheduleProvenance`). `task-pill.test.ts` pins the two answering together.
    silent: !title && !task.outcome && !task.scheduleId,
  };
}

/** Kinds that defer publication and share PR follow-through and ship recovery. */
export function isShippingTaskKind(kind: TaskKind | null | undefined): boolean {
  return kind === "ship" || kind === "bugfix" || kind === "document";
}

const KIND_WORKFLOW_DEFAULTS: Record<TaskKind, string | undefined> = {
  document: DOCUMENTATION_REVIEW_WORKFLOW_ID,
  ship: undefined,
  scout: undefined,
  plan: PLAN_VALIDATION_WORKFLOW_ID,
  pipeline: undefined,
  chat: undefined,
  bugfix: BUG_FIX_REVIEW_WORKFLOW_ID,
  resident: undefined,
};

export function taskHasOwnDefaultWorkflow(kind: TaskKind): boolean {
  return KIND_WORKFLOW_DEFAULTS[kind] !== undefined;
}

/** Explicit None and workflow choices bypass this default at the caller. */
export function taskDefaultWorkflowId(kind: TaskKind, machineDefault: string | null, storage: "repository" | "local" = "repository"): string | null {
  return kind === "plan" && storage === "local" ? LOCAL_PLAN_VALIDATION_WORKFLOW_ID : KIND_WORKFLOW_DEFAULTS[kind] ?? machineDefault;
}

/** Missing markers on historical tasks still mean a repository. Only residents may opt out. */
export function taskHasRepository(task: { kind?: TaskKind; workspaceKind?: "resident-workspace" | null }): boolean {
  return !(task.kind && TASK_KIND_BEHAVIOR[task.kind].repoAvailability === "optional"
    && task.workspaceKind === "resident-workspace");
}
