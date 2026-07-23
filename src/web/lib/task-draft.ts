// The dispatch form's working copy of a task, and the two translations between it and
// a stored `Task`: seeding the form from a row, and turning the form back into a PATCH.
//
// Out of the component because both translations are where a shelved task can silently
// lose an edit, and neither needs a DOM to be wrong. The rule they exist to enforce:
// **the form writes what the operator changed, and nothing else.** A modal that posts
// every field posts the values it was seeded with too - so a priority set on the board's
// card while this form sat open (or closed, half-written) is reverted by a save that
// never meant to touch it. The API takes a patch for exactly this reason: an omitted key
// means "leave it alone" (see `UpdateTaskSchema`).

import type { Task, TaskKind, AgentType, TaskPriority, ThinkingLevel } from "@shared/types.ts";
import type { TaskDependencyInput, UpdateTask } from "@shared/protocol.ts";
import { normalizeLabels } from "@shared/task.ts";
import type { PendingAttachment } from "../components/ImageDrop.tsx";

/**
 * The form fields a dispatch carries. Held by `DispatchLayer` (not the modal) so
 * an accidental close - Escape, backdrop click, Cancel, or the ✕ - keeps a
 * half-written task around; the draft is wiped only once it's actually
 * dispatched or shelved, or when the footer's Clear discards it on purpose
 * (see `freshDispatchDraft`).
 */
export type DispatchDraft = {
  /** On a fresh dispatch, seeded from the last one's repo - see `lib/lastRepo.ts`. */
  repoRoot: string;
  intent: string;
  title: string;
  kind: TaskKind;
  agent: AgentType;
  /** Unset by default - "" is the empty option, which posts as null. */
  priority: TaskPriority | "";
  /**
   * Labels as the RAW comma-separated text, not the parsed array. Keeping the string
   * is what lets a half-typed "bug, perf" survive a close/reopen with the trailing
   * comma intact; parsing on every keystroke would eat the separator as you type it.
   */
  labels: string;
  /**
   * Model override, or "" to follow the configured default for `agent`. Empty is
   * stored rather than the resolved default so the choice stays a deferral: the
   * daemon reads the default when it launches, which is what a shelved task needs.
   */
  model: string;
  /** Effort override, or "" to follow the configured default for `agent`. */
  effort: ThinkingLevel | "";
  /** Selected prerequisite ids; the daemon resolves them to durable dependency edges. */
  dependencies: TaskDependencyInput[];
  /** Images dropped on the task box; sent as paths appended to the intent. */
  attachments: PendingAttachment[];
};

export const EMPTY_DISPATCH_DRAFT: DispatchDraft = {
  repoRoot: "",
  intent: "",
  title: "",
  kind: "ship",
  agent: "claude",
  priority: "",
  labels: "",
  model: "",
  effort: "",
  dependencies: [],
  attachments: [],
};

/**
 * Split the labels field's raw text into the array the API takes.
 *
 * Splits on commas AND newlines so a list pasted from anywhere works, then hands the
 * pieces to the SHARED cleaner rather than trimming here - the server runs the same
 * function inside `DispatchSchema`, so what the chips preview is exactly what gets
 * stored. Doing it twice is the point: this one is for the preview, that one is the
 * guarantee.
 */
export function parseLabelInput(raw: string): string[] {
  return normalizeLabels(raw.split(/[,\n]/));
}

/**
 * The same form, seeded from a task already sitting in the backlog.
 *
 * Attachments start empty rather than being reconstructed: an image attached earlier
 * is already IN the intent, as the path `withAttachments` appended, so the text box
 * carries it and there is nothing to restore. Anything dropped now appends to that
 * same tail on save.
 */
export function draftFromTask(t: Task): DispatchDraft {
  return {
    repoRoot: t.repoRoot,
    intent: t.intent,
    title: t.title,
    kind: t.kind,
    agent: t.agent,
    // "" is the form's empty option, which is how an unset priority round-trips: a task
    // reopened and saved unchanged must not acquire one.
    priority: t.priority ?? "",
    labels: t.labels.join(", "),
    // Stored nulls are deferrals, and read back as the same empty options they were
    // picked from - so reopening a shelved task shows "Default", not overrides it never chose.
    model: t.model ?? "",
    effort: t.effort ?? "",
    dependencies: t.dependencies.map((dependency) =>
      dependency.type === "task"
        ? { type: "task" as const, taskId: dependency.taskId }
        : { type: "session" as const, sessionId: dependency.sessionId },
    ),
    attachments: [],
  };
}

/**
 * Field-by-field draft equality. A dispatch POST can resolve after the modal
 * instance that sent it is gone, so its resolve path hands back the draft it sent
 * and the owner compares: still the same draft means nothing newer to lose (see
 * onSubmitted).
 *
 * Also what decides whether a kept working copy is still good: comparing it against a
 * draft re-seeded from the stored row says whether the row has moved on underneath it.
 *
 * Attachments compare by identity rather than contents, because the question this
 * answers is "did the human add or drop an image since?" - and an upload landing
 * mid-flight rewrites the row without being an answer to it.
 */
export function draftsEqual(a: DispatchDraft, b: DispatchDraft): boolean {
  return (
    a.repoRoot === b.repoRoot &&
    a.intent === b.intent &&
    a.title === b.title &&
    a.kind === b.kind &&
    a.agent === b.agent &&
    a.priority === b.priority &&
    a.labels === b.labels &&
    a.model === b.model &&
    a.effort === b.effort &&
    dependencyInputsEqual(a.dependencies, b.dependencies) &&
    a.attachments.length === b.attachments.length &&
    a.attachments.every((att, i) => att.id === b.attachments[i]!.id)
  );
}

function dependencyInputKey(dependency: TaskDependencyInput): string {
  return dependency.type === "task" ? `task:${dependency.taskId}` : `session:${dependency.sessionId}`;
}

function dependencyInputsEqual(a: TaskDependencyInput[], b: TaskDependencyInput[]): boolean {
  if (a.length !== b.length) return false;
  const bKeys = new Set(b.map(dependencyInputKey));
  return a.every((dependency) => bKeys.has(dependencyInputKey(dependency)));
}

/**
 * What a save should send: the fields where the form disagrees with the task AS IT NOW
 * READS, and null when it agrees about everything.
 *
 * The comparison is against the live row rather than against whatever the form was
 * seeded with, which is what makes a concurrent edit survive: the operator retitles a
 * task while somebody else's triage sets its priority on the board, and the save carries
 * the title alone. Sending the whole form would carry the stale priority with it and
 * quietly undo the triage, with no error and nothing on screen to notice.
 *
 * Null rather than an empty object because the API refuses an empty patch (`UpdateTaskSchema`
 * has nothing to merge and says so) - and rightly: a form that changed nothing has
 * nothing to save, and its Save is a close.
 *
 * `intent` is passed in rather than read off the draft: what gets stored is the typed
 * text with any attachment paths appended, which only the modal can compose.
 */
export function taskUpdatePatch(task: Task, draft: DispatchDraft, intent: string): UpdateTask | null {
  const patch: UpdateTask = {};
  const repoRoot = draft.repoRoot.trim();
  if (repoRoot !== task.repoRoot) patch.repoRoot = repoRoot;
  if (intent !== task.intent) patch.intent = intent;
  // Empty is meaningful here and only here: it asks for a title to be derived again from
  // the intent as it now reads. A title equal to the stored one is simply not sent.
  const title = draft.title.trim();
  if (title !== task.title) patch.title = title;
  if (draft.kind !== task.kind) patch.kind = draft.kind;
  if (draft.agent !== task.agent) patch.agent = draft.agent;
  // "" is the empty option: no priority, which is a different answer from "low".
  const priority = draft.priority || null;
  if (priority !== task.priority) patch.priority = priority;
  // Compared parsed, not raw: a trailing comma or a repeated tag reads as a change to the
  // text box and as no change at all to the task, and the task is the one being saved.
  const labels = parseLabelInput(draft.labels);
  if (labels.length !== task.labels.length || labels.some((l, i) => l !== task.labels[i])) {
    patch.labels = labels;
  }
  // An explicit null takes an override back off a row that has one - the only way to say
  // "follow the harness default again" - so it cannot go through a truthiness check.
  const model = draft.model || null;
  if (model !== task.model) patch.model = model;
  const effort = draft.effort || null;
  if (effort !== task.effort) patch.effort = effort;
  const storedDependencies: TaskDependencyInput[] = task.dependencies.map((dependency) =>
    dependency.type === "task"
      ? { type: "task", taskId: dependency.taskId }
      : { type: "session", sessionId: dependency.sessionId },
  );
  if (!dependencyInputsEqual(draft.dependencies, storedDependencies)) {
    patch.dependencies = draft.dependencies;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
