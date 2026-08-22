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

import { DEFAULT_TASK_KIND, TASK_KINDS } from "./types.ts";
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
}

export const TASK_KIND_INFO: Record<TaskKind, TaskKindInfo> = {
  ship: {
    label: "ship",
    blurb: "Deliver a change, as a pull request.",
    purpose: "deliver a change",
  },
  scout: {
    label: "scout",
    blurb: "Investigate and report. No diff, so no after-work.",
    purpose: "investigate and report",
  },
  plan: {
    label: "plan",
    blurb: "Produce a reviewed plan, and optionally schedule the work. No diff, so no after-work.",
    purpose: "produce a reviewed plan",
  },
  pipeline: {
    label: "pipeline",
    blurb: "Start conductor's SDLC pipeline. Conductor owns its worktree and PR; no after-work.",
    purpose: "run a conductor pipeline",
  },
  chat: {
    label: "chat",
    blurb: "Talk with an agent without a planned artifact. No after-work.",
    purpose: "have an open-ended conversation",
  },
};

/** The launch and scheduling rules every surface must apply to a task kind. */
export interface TaskKindBehavior {
  /** Which repository catalog may offer this kind. */
  repoAvailability: "workspace" | "pipeline-enabled";
  /** Who owns the launched process and runtime choices. */
  launch: "harness" | "pipeline";
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
export const TASK_KIND_BEHAVIOR: Record<TaskKind, TaskKindBehavior> = {
  ship: {
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
};

/** Whether the external provider projection, rather than a host session, owns completion. */
export function providerOwnsTaskCompletion(kind: TaskKind): boolean {
  return TASK_KIND_BEHAVIOR[kind].launch === "pipeline";
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
 * A `Record` and not `kind !== "ship"`: those happen to agree today and are not the same
 * claim. `ship` is the default kind, which is why the pill stays silent for it; having a
 * diff is why an after-work Workflow can run over it. A new kind that produced a diff
 * without being the default would have to answer these two questions differently, and the
 * record is what makes it answer this one at all.
 */
const KIND_PRODUCES_A_DIFF: Record<TaskKind, boolean> = {
  ship: true,
  scout: false,
  plan: false,
  pipeline: false,
  chat: false,
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
  ship: true,
  scout: true,
  plan: true,
  pipeline: true,
  chat: false,
};

export const TASK_KIND_BACKLOG_REFUSAL =
  "Chat tasks must be launched immediately from Dispatch.";

export function taskKindAllowsBacklog(kind: TaskKind): boolean {
  return KIND_ALLOWS_BACKLOG[kind];
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
   * The kind badge, or null when the kind is the one every writer defaults to. Absence
   * means `ship` unambiguously: `kind` is `NOT NULL`, so the pill only exists when there
   * is a task, and a task always has a kind.
   */
  kind: TaskKind | null;
  /** The task's title, or null when the session's own name already carries it. */
  title: string | null;
  /**
   * True when nothing the pill hosts on EVERY surface has anything to say - no kind
   * badge, no title, no outcome and no schedule origin.
   *
   * The pill is not an empty frame: it has a background, a border and a tone-coloured
   * left edge, so drawing one with nothing in it is a bar of chrome that says less than
   * nothing. That is the common case now that the two text parts above went conditional -
   * an ordinary running `ship` task on a session named after it - so the reduction is not
   * finished until the container goes with them.
   *
   * A surface that draws something of its OWN inside the pill has to say so: the card
   * adds a `dispatching…` / `failed` word that the console detail does not, and it ORs
   * that in at the point it draws it rather than being asserted here.
   *
   * `repoPrs` is deliberately NOT one of the operands, and it is the one a reader will
   * reach for. A multi-repo task's per-repo pull-request list is a SIBLING row, not
   * pill content - it is a separate row precisely because it is as wide as the repo
   * count while the pill's outcome link is pinned right - and it gates itself on being
   * non-empty. Folding it in here would draw a pill with nothing in it above that row,
   * which was measured in a browser: the pill hugs its content on a card, so an empty
   * one is a 14px stub rather than a bar, and the row reads better with nothing above it
   * than with that. The row is self-describing (each chip names its repo and its PR
   * state) and it still sits under the session's own title.
   */
  silent: boolean;
}

/** A session with no task at all: nothing to draw, and no pill either. */
const NO_PILL: TaskPillParts = { kind: null, title: null, silent: true };

/**
 * What the task pill should draw for a session.
 *
 * Both parts are usually silent, and for different reasons. Every automated writer
 * defaults to `ship` - the MCP `create_task` tool cannot produce anything else - so a
 * badge rendered unconditionally reads `SHIP` in almost every session, is not
 * colour-differentiated in the console header, is frozen once the task leaves `backlog`,
 * and repeats the chip on the Board tile you clicked through. Only a kind somebody deliberately
 * chose says anything, so `ship` is the silent one and every other kind is drawn.
 *
 * Written as "not the default" rather than as a list of the kinds that are drawn, so a
 * new kind is offered on the same reasoning without an edit here. The reasoning is
 * about `ship` being what you get by not choosing, which is a property of `ship`.
 *
 * The title is a duplicate because `dispatcher.ts` names a dispatched session after its
 * task, so the pill usually repeats the `h2` two rows above it. It is NOT always a
 * duplicate, which is why this is a comparison rather than a deletion: a session
 * re-assigned to a later task keeps the first task's title as its name, and the pill is
 * then the only place the task now executing appears (`test/task-multi-session.test.ts`).
 *
 * Shared rather than inlined at each call site because a session is drawn by four
 * components: the Console detail and the Board tile both render this pill, and a rule applied
 * to one of them would look right in one layout and wrong in the other.
 */
export function taskPillParts(session: Pick<Session, "name" | "task">): TaskPillParts {
  const task = session.task;
  if (!task) return NO_PILL;
  const kind = task.kind === DEFAULT_TASK_KIND ? null : task.kind;
  const title = task.title === session.name ? null : task.title;
  return {
    kind,
    title,
    // `scheduleId` rather than a call into `ScheduleOriginChip`: this module is browser-safe
    // shared logic and cannot import a component, and the chip's own gate is that one field
    // (`scheduleProvenance`). `task-pill.test.ts` pins the two answering together.
    silent: !kind && !title && !task.outcome && !task.scheduleId,
  };
}
