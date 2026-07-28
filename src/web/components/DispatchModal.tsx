import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_TYPES,
  type Task,
  type Session,
  type TaskKind,
  type AgentType,
  type TaskPriority,
  type ThinkingLevel,
} from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import type { HarnessesConfig, TaskDependencyInput } from "@shared/protocol.ts";
import { withAttachments } from "@shared/attachments.ts";
import { MAX_LABELS, PRIORITY_LABELS, TASK_PRIORITIES } from "@shared/task.ts";
import { modelChoicesFor } from "@shared/model.ts";
import { api, fetchHarnessesConfig, fetchRepos } from "../lib/api.ts";
import { readLastDispatchRepo, rememberDispatchRepo } from "../lib/lastRepo.ts";
import {
  EMPTY_DISPATCH_DRAFT,
  draftFromTask,
  draftsEqual,
  parseLabelInput,
  taskUpdatePatch,
  type DispatchDraft,
} from "../lib/task-draft.ts";
import { formatScheduledFor } from "../lib/schedules.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import {
  AttachmentStrip,
  readyAttachments,
  revokeAttachments,
  useImageDrop,
  type PendingAttachment,
} from "./ImageDrop.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { LabelChips } from "./session-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";
import type { PersonaView, WorkflowConfig, WorkflowSummary } from "@shared/workflow.ts";
import { workflowRequest } from "../workflows/workflowApi.ts";
import {
  EnsembleDispatch,
  EnsembleLaunchControls,
  useEnsembleLaunch,
} from "../ensembles/dispatch/EnsembleDispatch.tsx";
import { freshEnsembleDraft, type EnsembleDispatchDraft } from "../ensembles/dispatch/config.ts";

/**
 * What a fresh dispatch form holds: nothing, except the repo the last one went to.
 *
 * Read at call time rather than captured in a constant, so a dispatch sent moments ago
 * seeds the next form in this same tab - not just the next reload. Lives here rather
 * than beside the rest of the draft shape because it is the one piece that reads the
 * browser: `lib/task-draft.ts` stays a pure translation between a form and a task.
 */
function freshDispatchDraft(): DispatchDraft {
  return { ...EMPTY_DISPATCH_DRAFT, repoRoot: readLastDispatchRepo() };
}

/**
 * True when a draft holds nothing worth keeping - so "Clear" has nothing to do.
 *
 * The seeded repo is not "something worth keeping": it was carried over from the last
 * dispatch, not typed here, and Clear puts it back rather than blanking it. Comparing
 * against the seed instead of "" is what keeps Clear greyed out on a form nobody has
 * touched yet.
 */
function isEmptyDispatchDraft(d: DispatchDraft): boolean {
  return (
    d.repoRoot.trim() === readLastDispatchRepo() &&
    !d.intent.trim() &&
    !d.title.trim() &&
    !d.labels.trim() &&
    d.attachments.length === 0 &&
    d.kind === EMPTY_DISPATCH_DRAFT.kind &&
    d.agent === EMPTY_DISPATCH_DRAFT.agent &&
    d.priority === EMPTY_DISPATCH_DRAFT.priority &&
    d.model === EMPTY_DISPATCH_DRAFT.model &&
    d.effort === EMPTY_DISPATCH_DRAFT.effort &&
    d.workflowId === EMPTY_DISPATCH_DRAFT.workflowId &&
    d.dependencies.length === 0
  );
}

function ensembleDraftsEqual(
  a: EnsembleDispatchDraft,
  b: EnsembleDispatchDraft,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Which task the modal is over, when it is over one. `new` writes a task that does
 * not exist yet; `edit` rewrites one that is waiting in the backlog.
 */
type DispatchMode = { kind: "new" } | { kind: "edit"; task: Task };

/**
 * A kept working copy of one backlog task: what the operator has written, and the
 * `seed` it was written on top of. The seed is what makes the copy falsifiable - see
 * the staleness test in `DispatchLayer`.
 */
type EditSlot = { id: string; seed: DispatchDraft; draft: DispatchDraft };

/**
 * What the "no override" option is called - the auto-recommended choice, so it names
 * the model the dispatch will really run on rather than saying a bare "Default" the
 * operator would have to open Settings to decode.
 *
 * Three readings, all honest: the configured default by name; "the harness decides"
 * when no default is set (nothing is passed to the CLI, so its own configuration
 * wins); and a plain "Default" in the instant before the config lands, which never
 * claims a model it can't see.
 */
function defaultModelOptionLabel(
  agent: AgentType,
  defaults: HarnessesConfig["defaultModel"] | null,
): string {
  if (!defaults) return "Default";
  const id = defaults[agent];
  if (!id) return "Default - whatever the harness is set to";
  const label = modelChoicesFor(agent, id).find((m) => m.id === id)?.label ?? id;
  return `Default - ${label}`;
}

function defaultEffortOptionLabel(
  agent: AgentType,
  defaults: HarnessesConfig["defaultEffort"] | null,
): string {
  if (!defaults) return "Default";
  const level = defaults[agent];
  return level ? `Default - ${level}` : "Default - whatever the harness is set to";
}

/**
 * Owns the dispatch draft and mounts the modal over it. Stays mounted whether or
 * not the modal is open, which is the whole point of the indirection:
 *  - the draft can't live in the modal, which unmounts on close and would take a
 *    half-written task with it;
 *  - it can't live in App either, where every keystroke would re-render the
 *    session grid - dozens of cards, each with an ActionBar - behind the backdrop
 *    where none of it can be seen. A child's state update doesn't re-render its
 *    parent, so parking the draft here keeps typing inside the modal subtree.
 *
 * The modal itself still mounts per open, so its fetch-repos and autofocus
 * effects run each time.
 *
 * TWO drafts, not one. `editTask` reopens this same form over a task already in the
 * backlog, and that working copy is kept in its own slot: a half-written new dispatch
 * must survive someone clicking a backlog card to check what they queued yesterday,
 * and it would not if the two shared a slot. Only one task is held at a time, though -
 * opening the editor on a different card seeds fresh from that card's stored row, so
 * an unsaved edit lives exactly as long as the operator keeps coming back to it.
 *
 * And only as long as the ROW it was written against stands still. A kept working copy
 * is a picture of the task as it read when the form was closed, and the task is live:
 * the board's priority picker, another window, a task source. Reopening on the old
 * picture would show values the daemon no longer holds and save them back over the
 * newer ones - the reported bug, where a priority set on the card came back changed by
 * a save that was only meant to fix a typo. So the slot carries the seed it was built
 * from, and a reopen whose row has moved on drops it and starts from the row.
 */
export function DispatchLayer({
  open,
  editTask,
  tasks = [],
  sessions = [],
  personas = [],
  workflowSummaries = [],
  foremanEnabled = false,
  onClose,
  onOpenSchedule,
  onEnsembleLaunched,
}: {
  open: boolean;
  /** The backlog task being edited, or null for a fresh dispatch. */
  editTask: Task | null;
  tasks?: Task[];
  sessions?: Session[];
  /** Live Personas, for the Ensemble evaluator-guidance selector. */
  personas?: PersonaView[];
  /** Live Workflow summaries, for the optional post-selection handoff placement. */
  workflowSummaries?: WorkflowSummary[];
  /** Whether the completion detector needed by an after-work Workflow is running. */
  foremanEnabled?: boolean;
  onClose: () => void;
  /** Open Recurring Missions from a generated task's read-only provenance in edit mode. */
  onOpenSchedule?: (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => void;
  /** Navigate to a freshly launched Ensemble run's detail. */
  onEnsembleLaunched?: (runId: string) => void;
}): React.JSX.Element | null {
  const [draft, setDraft] = useState<DispatchDraft>(freshDispatchDraft);
  // The Single vs Ensemble launch mode and the Ensemble draft live BESIDE the compose draft,
  // so switching mode or closing the modal loses neither. Edit mode is always Single: an
  // existing backlog Task cannot be turned into an Ensemble.
  const [launchMode, setLaunchMode] = useState<"single" | "ensemble">("single");
  const [ensembleDraft, setEnsembleDraft] = useState<EnsembleDispatchDraft>(freshEnsembleDraft);
  // Read by the dispatch-accepted callback below, which can fire after the modal
  // instance that armed it is gone - a stale closure would compare against
  // whatever the draft held when that instance last rendered.
  const draftRef = useRef(draft);
  const ensembleDraftRef = useRef(ensembleDraft);
  draftRef.current = draft;
  ensembleDraftRef.current = ensembleDraft;

  // The working copy of the task being edited, if any, beside the seed it was built
  // from. Seeded during render rather than from an effect: an effect would show one
  // frame of whatever the slot last held - an empty form, or the PREVIOUS task's text -
  // and a task whose intent blinks blank is a task that looks like it lost its intent.
  const [edit, setEdit] = useState<EditSlot | null>(null);
  const stored = editTask ? draftFromTask(editTask) : null;
  // Which task the open form is over. Held as state so the staleness test below runs
  // exactly once per opening, and never again while the form is up: re-testing on every
  // render would re-seed the fields under the operator's cursor the moment anything
  // touched the row, which loses the very typing the slot exists to keep.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const openOn = open && editTask ? editTask.id : null;
  if (openOn !== openedOn) {
    setOpenedOn(openOn);
    // The row moved while this form was closed, so the working copy describes a task
    // that no longer exists. Dropping it costs an abandoned draft; keeping it costs
    // whoever made that change their change, silently, on the next Save.
    if (openOn && edit?.id === openOn && stored && !draftsEqual(edit.seed, stored)) setEdit(null);
  }
  const slot = editTask && edit?.id === editTask.id ? edit : null;
  const editDraft = slot ? slot.draft : stored;
  // The effective slot, refreshed every render, for the callbacks below that can fire
  // long after the render that armed them.
  const editRef = useRef<EditSlot | null>(null);
  editRef.current =
    editTask && editDraft && stored
      ? { id: editTask.id, seed: slot ? slot.seed : stored, draft: editDraft }
      : null;

  const onEditDraftChange = useCallback((next: DispatchDraft) => {
    const cur = editRef.current;
    if (cur) setEdit({ ...cur, draft: next });
  }, []);

  // A dispatch is accepted server-side. The reply to an async network POST can
  // land after the modal has been closed and reopened, so reconcile against what
  // the draft holds *now*, not against the instance that sent it:
  //  - unchanged since dispatch -> it's been consumed; clear and close, whether or
  //    not the modal is still open (a closed modal makes the close a no-op, and
  //    reopening shows an empty form instead of a ghost that invites a duplicate).
  //  - edited since dispatch -> that's newer input; keep it and leave the modal be.
  const onSubmitted = useCallback(
    (submitted: DispatchDraft) => {
      if (!draftsEqual(draftRef.current, submitted)) return;
      // The task has the paths now; these thumbnails are the last thing holding the
      // blobs. (The files themselves stay on the daemon - the agent hasn't read them
      // yet, and won't for as long as it takes to provision a worktree.)
      revokeAttachments(draftRef.current.attachments);
      // Fresh, not blank: the repo just dispatched into is the one the next task is
      // most likely to want, and it was remembered before this fired.
      setDraft(freshDispatchDraft());
      onClose();
    },
    [onClose],
  );

  // The same reconciliation for a saved edit, against the edit slot. Dropping the slot
  // is what makes the next open re-read the row we just wrote, rather than re-showing
  // a working copy that is now merely a duplicate of it.
  const onEditSubmitted = useCallback(
    (submitted: DispatchDraft) => {
      const cur = editRef.current;
      if (!cur || !draftsEqual(cur.draft, submitted)) return;
      revokeAttachments(cur.draft.attachments);
      setEdit(null);
      onClose();
    },
    [onClose],
  );

  /**
   * Attachment writes go through a functional update with a STABLE identity, which
   * the other fields don't need and this one can't do without: an upload resolves
   * a network round-trip after the drop that started it, and patches its row from
   * a callback captured back then. Handed a plain `{...draft, attachments}` from
   * that render, a late upload would restore the intent as it read at drop time,
   * silently eating everything typed since.
   */
  const onAttachmentsChange = useCallback((attachments: PendingAttachment[]) => {
    setDraft((d) => ({ ...d, attachments }));
  }, []);

  /** The same, for the edit slot - where the ref, not a functional update, is what
   *  keeps a late upload from resurrecting the text as it read at drop time. */
  const onEditAttachmentsChange = useCallback((attachments: PendingAttachment[]) => {
    const cur = editRef.current;
    if (cur) setEdit({ ...cur, draft: { ...cur.draft, attachments } });
  }, []);

  /**
   * Revert: throw the working copy away, rather than replace it with a copy of the row.
   *
   * Those are not the same thing even though they look identical on screen. Writing a
   * snapshot back into the slot leaves the form pinned to the row as it read at THAT
   * moment - which is the state this whole slot has to be able to leave. Dropping it
   * puts the form back on the live derivation, which is what "put it back how it was"
   * means when the thing it was is still moving.
   */
  const onEditRevert = useCallback(() => {
    setEdit(null);
  }, []);

  /** Clear, for a fresh dispatch: blank but for the seeded repo, as it opened. */
  const onNewRevert = useCallback(() => {
    setDraft(freshDispatchDraft());
  }, []);

  /**
   * Clear the Ensemble draft: reset the compose fields AND rotate the request id, so the next
   * launch is a genuinely new request rather than an idempotent replay of a half-abandoned one.
   */
  const onEnsembleClear = useCallback(() => {
    revokeAttachments(draftRef.current.attachments);
    setDraft(freshDispatchDraft());
    setEnsembleDraft(freshEnsembleDraft());
  }, []);

  /**
   * An Ensemble was accepted. Like a Single dispatch it clears the compose draft and revokes
   * its attachments, and it mints a fresh request id so the same key never launches a second
   * fleet; then it hands the run id up to navigate to its detail.
   */
  const onEnsembleLaunchedInternal = useCallback(
    (runId: string, submitted: DispatchDraft, submittedEnsemble: EnsembleDispatchDraft) => {
      const draftChanged =
        !draftsEqual(draftRef.current, submitted) ||
        !ensembleDraftsEqual(ensembleDraftRef.current, submittedEnsemble);
      if (draftChanged) {
        setEnsembleDraft({
          ...ensembleDraftRef.current,
          requestId: crypto.randomUUID(),
          previewFingerprint: null,
        });
      } else {
        revokeAttachments(draftRef.current.attachments);
        setDraft(freshDispatchDraft());
        setEnsembleDraft(freshEnsembleDraft());
      }
      onEnsembleLaunched?.(runId);
      onClose();
    },
    [onClose, onEnsembleLaunched],
  );

  if (!open) return null;
  if (editTask && editDraft) {
    return (
      <DispatchModal
        // Remounted per task, so the autofocus and repo-index effects run for each one
        // and the box you land in is that task's, not the previous card's.
        key={editTask.id}
        mode={{ kind: "edit", task: editTask }}
        tasks={tasks}
        sessions={sessions}
        draft={editDraft}
        onDraftChange={onEditDraftChange}
        onAttachmentsChange={onEditAttachmentsChange}
        onRevert={onEditRevert}
        onClose={onClose}
        onSubmitted={onEditSubmitted}
        onOpenSchedule={onOpenSchedule}
        workflowSummaries={workflowSummaries}
        foremanEnabled={foremanEnabled}
      />
    );
  }
  return (
    <DispatchModal
      mode={{ kind: "new" }}
      tasks={tasks}
      sessions={sessions}
      draft={draft}
      onDraftChange={setDraft}
      onAttachmentsChange={onAttachmentsChange}
      onRevert={onNewRevert}
      onClose={onClose}
      onSubmitted={onSubmitted}
      launchMode={launchMode}
      onLaunchModeChange={setLaunchMode}
      ensembleDraft={ensembleDraft}
      onEnsembleDraftChange={setEnsembleDraft}
      onEnsembleClear={onEnsembleClear}
      onEnsembleLaunched={onEnsembleLaunchedInternal}
      personas={personas}
      workflowSummaries={workflowSummaries}
      foremanEnabled={foremanEnabled}
    />
  );
}

/**
 * Launch (or shelve) a new agent: pick a repo, describe the task, and dispatch.
 * The daemon provisions an isolated worktree, opens a terminal home, and
 * injects the intent - the new session then appears on the grid on the next poll.
 *
 * Also the EDITOR for a task already in the backlog (`mode.kind === "edit"`), which
 * is the same form over a row that exists: shelved work is written here, so it is
 * read and corrected here too rather than through a second, thinner dialog that would
 * inevitably offer fewer fields than the one that created it. The verbs shift with the
 * mode - "Add to backlog" becomes "Save", "Clear" becomes "Revert" - and "Dispatch
 * now" means the same thing in both: this is ready, start it.
 *
 * The form values live in a draft on `DispatchLayer` so they survive close/reopen;
 * only the transient UI state (repo index, in-flight action, error) is local here.
 */
function DispatchModal({
  mode,
  tasks,
  sessions,
  draft,
  onDraftChange,
  onAttachmentsChange,
  onRevert,
  onClose,
  onSubmitted,
  onOpenSchedule,
  launchMode = "single",
  onLaunchModeChange,
  ensembleDraft,
  onEnsembleDraftChange,
  onEnsembleClear,
  onEnsembleLaunched,
  personas = [],
  workflowSummaries = [],
  foremanEnabled = false,
}: {
  mode: DispatchMode;
  tasks: Task[];
  sessions: Session[];
  draft: DispatchDraft;
  onDraftChange: (draft: DispatchDraft) => void;
  onAttachmentsChange: (attachments: PendingAttachment[]) => void;
  /** Discard the working copy - an empty form for a create, the live row for an edit. */
  onRevert: () => void;
  onClose: () => void;
  onSubmitted: (submitted: DispatchDraft) => void;
  /** Open Recurring Missions from a scheduled task's read-only provenance. */
  onOpenSchedule?: (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => void;
  /** Single vs Ensemble. Only meaningful for a new dispatch; an edit is always Single. */
  launchMode?: "single" | "ensemble";
  onLaunchModeChange?: (mode: "single" | "ensemble") => void;
  ensembleDraft?: EnsembleDispatchDraft;
  onEnsembleDraftChange?: (draft: EnsembleDispatchDraft) => void;
  onEnsembleClear?: () => void;
  onEnsembleLaunched?: (
    runId: string,
    submitted: DispatchDraft,
    submittedEnsemble: EnsembleDispatchDraft,
  ) => void;
  personas?: PersonaView[];
  workflowSummaries?: WorkflowSummary[];
  foremanEnabled?: boolean;
}): React.JSX.Element {
  const editing = mode.kind === "edit" ? mode.task : null;
  // Ensemble mode is a new-dispatch-only concern, and only when the layer wired the state up.
  const ensembleMode = !editing && launchMode === "ensemble" && ensembleDraft !== undefined;
  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  // The configured per-harness defaults, so both pickers can name what "Default"
  // means. Null until the fetch lands (and if it fails).
  const [defaults, setDefaults] = useState<HarnessesConfig | null>(null);
  const [workflowConfig, setWorkflowConfig] = useState<WorkflowConfig | null>(null);
  // Which action is in flight, not merely whether one is: both footer buttons submit,
  // and only the one that was pressed should say so.
  const [pending, setPending] = useState<null | "shelve" | "dispatch">(null);
  const busy = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const intentRef = useRef<HTMLTextAreaElement>(null);
  const drop = useImageDrop({ attachments: draft.attachments, onChange: onAttachmentsChange });
  // Parsed once per render: the preview below and the submit body must never disagree
  // about what the typed text means.
  const labels = parseLabelInput(draft.labels);
  const draftHasBacklogDetails = Boolean(
    draft.priority ||
      draft.labels.trim() ||
      draft.title.trim() ||
      draft.dependencies.length > 0,
  );
  // The backlog details fold (priority, labels, title, dependencies). Open from the start
  // when there is something inside to see - an edit, or a draft that already carries one of
  // them - and closed on a fresh dispatch, where the summary line names what is unset.
  const [detailsOpen, setDetailsOpen] = useState<boolean>(
    () => editing !== null || draftHasBacklogDetails,
  );
  const previousEnsembleMode = useRef(ensembleMode);
  useEffect(() => {
    const returnedToSingle = previousEnsembleMode.current && !ensembleMode;
    previousEnsembleMode.current = ensembleMode;
    if (returnedToSingle && draftHasBacklogDetails) setDetailsOpen(true);
  }, [draftHasBacklogDetails, ensembleMode]);
  // The Ensemble preview/launch state machine, called unconditionally (it is a hook) and
  // inert outside Ensemble mode. The form body and the footer both read this one object,
  // so the plan strip and the Launch button cannot disagree about what is reviewed.
  const ensembleLaunch = useEnsembleLaunch({
    compose: {
      repoRoot: draft.repoRoot,
      title: draft.title,
      intent: draft.intent,
      attachments: draft.attachments,
    },
    ensemble: ensembleMode ? ensembleDraft : undefined,
    onEnsembleChange: onEnsembleDraftChange,
    uploading: drop.uploading,
    onLaunched:
      onEnsembleLaunched === undefined
        ? undefined
        : (runId, submittedEnsemble) => onEnsembleLaunched(runId, draft, submittedEnsemble),
  });
  const dependencyKey = (dependency: TaskDependencyInput): string =>
    dependency.type === "task" ? `task:${dependency.taskId}` : `session:${dependency.sessionId}`;
  const dependencyByKey = useMemo(() => {
    const out = new Map<string, { input: TaskDependencyInput; label: string; group: "backlog" | "session" }>();
    for (const task of tasks) {
      if (task.status !== "backlog" || task.id === editing?.id) continue;
      out.set(`task:${task.id}`, {
        input: { type: "task", taskId: task.id },
        label: `${task.title} (${task.kind})`,
        group: "backlog",
      });
    }
    for (const session of sessions) {
      if (
        session.state === "exited" ||
        !session.hooksSeen ||
        (editing !== null && session.task?.id === editing.id)
      ) continue;
      const linkedTask = session.task
        ? tasks.find((task) => task.id === session.task?.id)
        : undefined;
      const input: TaskDependencyInput = linkedTask
        ? { type: "task", taskId: linkedTask.id }
        : { type: "session", sessionId: session.id };
      const key = dependencyKey(input);
      if (out.has(key)) continue;
      out.set(key, {
        input,
        label: `${session.task?.title ?? session.name}${session.prState === "merged" ? " (merged)" : session.prState === "open" ? " (PR open)" : ""}`,
        group: "session",
      });
    }
    // Keep disappeared targets visible in an edit. They remain blocking until removed,
    // but hiding them from the select would also make them impossible to remove.
    for (const dependency of editing?.dependencies ?? []) {
      const input: TaskDependencyInput = dependency.type === "task"
        ? { type: "task", taskId: dependency.taskId }
        : { type: "session", sessionId: dependency.sessionId };
      const key = dependencyKey(input);
      if (!out.has(key)) out.set(key, { input, label: `${dependency.title} (unavailable)`, group: "session" });
    }
    return out;
  }, [editing, sessions, tasks]);
  const unmetDependencyCount = draft.dependencies.filter((dependency) => {
    const stored = editing?.dependencies.find(
      (candidate) =>
        dependencyKey(
          candidate.type === "task"
            ? { type: "task", taskId: candidate.taskId }
            : { type: "session", sessionId: candidate.sessionId },
        ) === dependencyKey(dependency),
    );
    if (stored?.satisfiedAt != null) return false;
    if (dependency.type === "session") {
      return sessions.find((session) => session.id === dependency.sessionId)?.prState !== "merged";
    }
    return sessions.find((session) => session.task?.id === dependency.taskId)?.prState !== "merged";
  }).length;
  const selectedDependenciesUnmet = unmetDependencyCount > 0;
  const publishedWorkflows = useMemo(
    () =>
      workflowSummaries.filter(
        (workflow) => workflow.archivedAt === null && workflow.currentVersionId !== null,
      ),
    [workflowSummaries],
  );
  const selectedWorkflowId =
    draft.workflowId === undefined ? workflowConfig?.defaultWorkflowId ?? null : draft.workflowId;
  const defaultWorkflow = workflowConfig?.defaultWorkflowId
    ? workflowSummaries.find(
        (workflow) => workflow.id === workflowConfig.defaultWorkflowId,
      ) ?? null
    : null;
  const selectedWorkflowBlocked = Boolean(
    selectedWorkflowId
    && (!foremanEnabled || !capabilitiesFor(draft.agent).workQueue),
  );

  // Merge one field's change into the lifted draft.
  function update(patch: Partial<DispatchDraft>): void {
    onDraftChange({ ...draft, ...patch });
  }

  useEffect(() => {
    intentRef.current?.focus();
  }, []);

  // Index the workspace's repos so the base can be searched/picked, and read the
  // harness defaults so the model and effort pickers can show what "Default" means.
  // Re-fetched on every open so a freshly-cloned repo - or a default just changed in
  // Settings - shows up without a full app reload.
  useEffect(() => {
    let alive = true;
    void fetchRepos().then((list) => {
      if (!alive) return;
      setRepos(list);
      setReposLoading(false);
    });
    void fetchHarnessesConfig().then((cfg) => {
      if (alive && cfg) setDefaults(cfg);
    });
    void workflowRequest<WorkflowConfig>("/api/workflows/config")
      .then((config) => {
        if (alive) setWorkflowConfig(config);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Put the form back where it started without closing: every close path preserves
  // what's typed, so this is the one way to abandon it. For a new dispatch that means
  // a form as freshly opened - blank but for the seeded repo, which is where "start
  // again" starts; for an edit it means the task as the daemon still holds it, which
  // is the only "start again" an edit has.
  function clearDraft(): void {
    revokeAttachments(draft.attachments);
    onRevert();
    setError(null);
    intentRef.current?.focus();
  }

  async function submit(dispatchNow: boolean): Promise<void> {
    // A new task with unmet dependencies is filed into the backlog even from the primary
    // action. It is not launching yet, so an unavailable Foreman must not erase the user's
    // after-work choice or prevent the task from being saved for later.
    const launchesNow = dispatchNow && !selectedDependenciesUnmet;
    // An image still uploading has no path yet, so dispatching now would launch the
    // agent on a task missing the screenshot it was written around. The buttons say
    // so; this also guards ⌘Enter, which doesn't.
    if (
      !draft.repoRoot.trim() ||
      !draft.intent.trim() ||
      busy ||
      drop.uploading ||
      (launchesNow && selectedWorkflowBlocked) ||
      Boolean(editing && dispatchNow && selectedDependenciesUnmet)
    ) return;
    setPending(dispatchNow ? "dispatch" : "shelve");
    setError(null);
    // Submitting is an async network POST, so this promise can resolve after the
    // modal has been closed - even a short round-trip leaves room for a quick
    // Escape, a reopen, and fresh typing. Hand the exact draft we sent back to the
    // owner, which clears it only if nothing newer has been typed since - see
    // onSubmitted in DispatchLayer.
    const submitted = draft;
    // Paths ride at the end of the intent, which the dispatcher already delivers
    // as one bracketed paste - so the agent's first prompt cites the screenshot
    // exactly as a terminal drag would have.
    const intent = withAttachments(
      submitted.intent.trim(),
      readyAttachments(submitted.attachments),
    );
    // An edit sends a PATCH of what actually changed, a create sends the whole form.
    // The asymmetry is the point: there is no row behind a create to leave alone, while
    // an edit posting all nine fields posts the ones it was merely seeded with too, and
    // those overwrite whatever the daemon has learned about them since (see
    // `taskUpdatePatch`). A patch with nothing in it is not sent at all - a form that
    // changed nothing has nothing to save.
    //
    // An emptied title means different things to the two endpoints, and both are the
    // right meaning: on create, "no title given, go and summarize one"; on update,
    // "drop the title I had, derive it from the intent as it now reads". Only the
    // create path can express the first as an absent field.
    //
    // "No model" splits the same way, and neither half pins a model: create omits the
    // field, update sends an explicit null to take an override back off a row that has
    // one. Either way the daemon resolves the default at launch, so a task shelved
    // today runs on the default in force when it is finally picked up.
    const patch = editing ? taskUpdatePatch(editing, submitted, intent) : null;
    const r = editing
      ? patch
        ? await api.updateTask(editing.id, patch)
        : { ok: true }
      : await api.dispatch({
          repoRoot: submitted.repoRoot.trim(),
          intent,
          kind: submitted.kind,
          agent: submitted.agent,
          // "" is the empty option: no priority, which is a different answer from "low".
          priority: submitted.priority || null,
          labels: parseLabelInput(submitted.labels),
          title: submitted.title.trim() || undefined,
          model: submitted.model || undefined,
          effort: submitted.effort || undefined,
          workflowId: submitted.workflowId,
          dependencies: submitted.dependencies,
          backlog: !launchesNow,
        });
    // An edit is a save first and a launch second, so the two are two calls: the save
    // has landed by the time the dispatch is asked for, and a refused dispatch leaves
    // the modal open over a task whose text is already stored - nothing to lose, and
    // the same button to press again.
    const launched =
      r.ok && editing && dispatchNow ? await api.dispatchBacklog(editing.id, true) : null;
    setPending(null);
    // Seed the next dispatch with this repo, once the daemon has accepted it - a repo
    // that was rejected is not one to hand the next task. Shelving counts as much as
    // launching: both are "the repo I'm working in right now", which is the whole
    // question this answers.
    //
    // Only from THIS form, not the editor. Reopening a task shelved last week and
    // saving it is a visit to an old decision, not a statement about what to dispatch
    // next, and letting it move the seed would strand the next task in that repo.
    if (r.ok && !editing) rememberDispatchRepo(submitted.repoRoot.trim());
    // Clear the draft and close only once the task row exists - the worktree and
    // terminal home are provisioned in the background after this reply, and any
    // failure there surfaces on the task card rather than here. A rejected submit
    // keeps the modal open with the fields intact so you can retry.
    if (!r.ok) setError(r.error ?? (editing ? "could not save the task" : "dispatch failed"));
    else if (launched && !launched.ok) setError(`saved, but ${launched.error ?? "could not dispatch"}`);
    else onSubmitted(submitted);
  }

  // The brief - repo, title, task - is shared by both modes but arranged differently:
  // Single leads repo-then-task with the title folded into Backlog details, Ensemble puts
  // repo and title side by side above the shared composer. One JSX definition each, so the
  // two arrangements cannot drift apart in behavior.
  const repoField = (
    <label className="field">
      <span className="field-label">
        Repo{" "}
        <span className="field-hint">
          {reposLoading
            ? "indexing workspace…"
            : `${repos.length} repo${repos.length === 1 ? "" : "s"} found - type to filter`}
        </span>
      </span>
      <RepoCombobox
        repos={repos}
        value={draft.repoRoot}
        onChange={(v) => update({ repoRoot: v })}
      />
    </label>
  );

  const titleField = (
    <label className="field">
      <span className="field-label">
        Title{" "}
        <span className="field-hint">
          {/* "optional" is a promise about a field you are yet to fill in. On a task
              that already has a title, the useful half of that sentence is what the
              title will go on to name. */}
          {editing
            ? "names the session / card"
            : ensembleMode
              ? "optional - names the run"
              : "optional - names the session / card"}
        </span>
      </span>
      <input
        className="field-input"
        placeholder={
          editing ? "clear it to re-derive one from the task" : "summarized from the task if left blank"
        }
        value={draft.title}
        onChange={(e) => update({ title: e.target.value })}
      />
    </label>
  );

  const taskField = (
    <label className="field">
      <span className="field-label">
        Task{" "}
        <span className="field-hint">
          {ensembleMode
            ? "every candidate gets this brief - drop or paste images to attach"
            : "drop or paste images to attach them"}
        </span>
      </span>
      <div className="drop-zone" {...drop.dropProps}>
        <textarea
          ref={intentRef}
          className="field-input field-textarea"
          placeholder="What should this agent do?"
          rows={5}
          value={draft.intent}
          onChange={(e) => update({ intent: e.target.value })}
          onPaste={drop.onPaste}
          onKeyDown={(e) => {
            // In Ensemble mode the launch is a deliberate review-then-confirm, so the
            // dispatch chord does not short-circuit it.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !ensembleMode) void submit(true);
          }}
        />
        <AttachmentStrip attachments={draft.attachments} onRemove={drop.remove} />
        {drop.dropping && <div className="drop-veil">Drop images to attach</div>}
      </div>
    </label>
  );

  // What the collapsed Backlog details row says. It names every field it hides, set or
  // not, so nothing carried by the draft can hide behind the fold silently.
  const dependencyCount = draft.dependencies.length;
  const backlogSummary = [
    draft.priority ? PRIORITY_LABELS[draft.priority] : "no priority",
    labels.length > 0 ? labels.join(", ") : "no labels",
    draft.title.trim() ? "titled" : "title summarized",
    dependencyCount > 0
      ? `${dependencyCount} ${dependencyCount === 1 ? "dependency" : "dependencies"}`
      : "no dependencies",
  ].join(" · ");

  /** Dependency choices not already picked, for the add control's grouped options. */
  const unselectedDependencies = (
    group: "backlog" | "session",
  ): Array<[string, { input: TaskDependencyInput; label: string }]> =>
    [...dependencyByKey.entries()].filter(
      ([key, option]) =>
        option.group === group &&
        !draft.dependencies.some((dependency) => dependencyKey(dependency) === key),
    );

  return (
    <Overlay
      id={OVERLAY_IDS.dispatch}
      onClose={onClose}
      // Ensemble alone widens the dialog: a candidate lane holds four controls on one
      // line at 760 and clips at Single's width.
      className={`modal dispatch-modal${ensembleMode ? " dispatch-modal-ensemble" : ""}`}
      role="dialog"
      ariaLabel={editing ? "Edit a backlog task" : "Dispatch an agent"}
      // Sealed while a submit is in flight, all four dismiss routes at once. A modal
      // dismissed mid-save unmounts the only thing that can report the answer, so a
      // refusal - a repo that no longer resolves, a task the autopilot just started -
      // lands on nothing and reads as a save that worked.
      closable={!busy}
    >
      <header className="modal-head">
        <h2>{editing ? "Edit backlog task" : "Dispatch an agent"}</h2>
        {/* The launch mode lives at dialog level, not among the fields: choosing Single or
            Ensemble reshapes the whole form below it. Only a new dispatch has the choice -
            an existing backlog Task cannot be turned into an Ensemble. */}
        {!editing && onLaunchModeChange && (
          <div className="dispatch-mode-toggle" role="radiogroup" aria-label="Launch mode">
            <Tooltip label="Dispatch one agent to this task">
              <button
                type="button"
                role="radio"
                aria-checked={launchMode === "single"}
                className={launchMode === "single" ? "active" : ""}
                onClick={() => onLaunchModeChange("single")}
              >
                Single agent
              </button>
            </Tooltip>
            <Tooltip label="Launch several agents on the same task and compare them">
              <button
                type="button"
                role="radio"
                aria-checked={launchMode === "ensemble"}
                className={launchMode === "ensemble" ? "active" : ""}
                onClick={() => onLaunchModeChange("ensemble")}
              >
                Ensemble
              </button>
            </Tooltip>
          </div>
        )}
        <Tooltip label={busy ? "Waiting for the dispatch to land" : "Close without dispatching (Escape)"}>
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </Tooltip>
      </header>

      <div className="dispatch-body">
        {editing?.scheduleId && (
          <div className="rm-provenance-note">
            <span className="rm-provenance-text">
              <span aria-hidden>◷</span> Scheduled by a recurring mission
              {editing.scheduledFor != null
                ? ` for ${formatScheduledFor(editing.scheduledFor)}`
                : ""}
              . This origin is immutable and is not changed by saving.
              {editing.source && " This task also carries an external source (conflict)."}
            </span>
            <Tooltip label="Open this task's recurring mission and its run history">
              <button
                className="btn"
                type="button"
                onClick={() =>
                  onOpenSchedule?.(
                    editing.scheduleId!,
                    editing.scheduleOccurrenceId ?? undefined,
                    editing.scheduledFor ?? undefined,
                  )
                }
              >
                Open schedule / history
              </button>
            </Tooltip>
          </div>
        )}
        {/* The brief leads: repo and task are the dispatch, everything below them is a
            default you occasionally override. */}
        {ensembleMode ? (
          <div className="field-row dispatch-brief">
            {repoField}
            {titleField}
          </div>
        ) : (
          repoField
        )}

        {taskField}

        {!ensembleMode && (
        <>
        {/* The crew: which agent, doing what kind of work, on which model at which effort -
            one compact row instead of four full-width ones. Overrides read as values (a
            named model instead of "Default"), so no per-field "overriding" hint is needed. */}
        <div className="field dispatch-crew-field">
          <span className="field-label">Crew</span>
          <div className="dispatch-crew">
            <label className="field">
              <span className="field-label">Agent</span>
              <Tooltip label="Which harness this task is dispatched to - switching resets the model and effort overrides">
                <span
                  className="agent-accent-select"
                  style={{ ["--agent-accent" as string]: AGENT_IDENTITY[draft.agent].accent }}
                >
                  <select
                    className="field-input"
                    value={draft.agent}
                    // Switching harness drops model and effort overrides with it: neither
                    // selection is portable across harnesses. Back to the defaults, which are
                    // per-agent and always right for the harness now chosen.
                    onChange={(e) =>
                      update({ agent: e.target.value as AgentType, model: "", effort: "" })
                    }
                  >
                  {/* Driven off the union, so a harness that exists cannot be one the
                      operator has no way to pick: a hand-written pair of options is a
                      list that goes stale silently, with the new agent dispatchable
                      everywhere except the modal that dispatches. */}
                    {AGENT_TYPES.map((a) => (
                      <option key={a} value={a}>
                        {AGENT_IDENTITY[a].label}
                      </option>
                    ))}
                  </select>
                </span>
              </Tooltip>
            </label>
            <label className="field">
              <span className="field-label">Kind</span>
              <Tooltip label="Whether this task asks for a delivered change or an investigation">
                <select
                  className="field-input"
                  value={draft.kind}
                  onChange={(e) => update({ kind: e.target.value as TaskKind })}
                >
                  <option value="ship">ship</option>
                  <option value="scout">scout</option>
                </select>
              </Tooltip>
            </label>
            <label className="field">
              <span className="field-label">Model</span>
              <Tooltip label="Pin the model this task's agent launches with, overriding the harness default">
                <select
                  className="field-input"
                  value={draft.model}
                  onChange={(e) => update({ model: e.target.value })}
                >
                <option value="">
                  {defaultModelOptionLabel(draft.agent, defaults?.defaultModel ?? null)}
                </option>
                {/* The draft's own id is folded in, for the same reason the Settings picker
                    folds in the stored default: reopening a shelved task can seed this from a
                    row naming a model this build's catalog doesn't list, and an unlisted value
                    renders the select on nothing - reading as "Default" over a task that is
                    pinned, and saving as one on the next edit. */}
                  {modelChoicesFor(draft.agent, draft.model).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} - {m.hint}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </label>
            <label className="field">
              <span className="field-label">Effort</span>
              <Tooltip label="How much reasoning effort this task's agent spends, overriding the harness default">
                <select
                  className="field-input"
                  value={draft.effort}
                  onChange={(e) => update({ effort: e.target.value as ThinkingLevel | "" })}
                  aria-label={`Effort for dispatched ${AGENT_IDENTITY[draft.agent].label} session`}
                >
                <option value="">
                  {defaultEffortOptionLabel(draft.agent, defaults?.defaultEffort ?? null)}
                </option>
                  {capabilitiesFor(draft.agent).effort?.levels.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </label>
          </div>
          <span className="field-hint dispatch-crew-hint">
            Defaults from Settings → Harnesses. Switching agent resets the model and effort overrides.
          </span>
        </div>

        {/* The completion handoff is a first-class dispatch choice, not backlog metadata:
            it changes what happens after the agent finishes rather than how the task is
            ranked. The rail shape makes that sequence legible without turning one select
            into another full-width card. */}
        <div className={`dispatch-workflow${selectedWorkflowId ? " armed" : ""}`}>
          <span className="dispatch-workflow-mark" aria-hidden>⌘</span>
          <label className="dispatch-workflow-control">
            <span className="field-label">After work</span>
            <Tooltip label="Run a published Workflow when Foreman confirms this agent's work is complete">
              <select
                className="field-input"
                value={
                  draft.workflowId === undefined
                    ? "__default"
                    : draft.workflowId ?? "__none"
                }
                onChange={(event) => {
                  const value = event.target.value;
                  update({
                    workflowId:
                      value === "__default"
                        ? editing
                          ? workflowConfig?.defaultWorkflowId ?? null
                          : undefined
                        : value === "__none"
                          ? null
                          : value,
                  });
                }}
              >
                {!editing && (
                  <option value="__default">
                    {workflowConfig === null
                      ? "Dispatch default — loading…"
                      : workflowConfig.defaultWorkflowId
                      ? defaultWorkflow
                        ? `Dispatch default — ${defaultWorkflow.name} · v${defaultWorkflow.publishedVersion}`
                        : "Dispatch default — unavailable workflow"
                      : "Dispatch default — none"}
                  </option>
                )}
                <option value="__none">None — finish without a Workflow</option>
                {publishedWorkflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name} · v{workflow.publishedVersion}
                  </option>
                ))}
                {draft.workflowId
                  && !publishedWorkflows.some((workflow) => workflow.id === draft.workflowId)
                  && (
                    <option value={draft.workflowId}>
                      Unavailable Workflow
                    </option>
                  )}
              </select>
            </Tooltip>
          </label>
          <span className="dispatch-workflow-state">
            <span aria-hidden>→</span>
            {selectedWorkflowId ? "Foreman complete" : "No handoff"}
          </span>
        </div>
        {selectedWorkflowBlocked && (
          <span className="dispatch-workflow-warning">
            {!foremanEnabled
              ? "You can add this task to the backlog, but turn on Foreman before dispatching it—or choose None."
              : `You can add this task to the backlog, but ${AGENT_IDENTITY[draft.agent].label} cannot detect the completion boundary; choose another agent or None before dispatching.`}
          </span>
        )}
        </>
        )}

        {/* Backlog details: the fields that rank, label, name and gate the task. Folded
            behind a summary that names every field it hides - set or not - so nothing the
            draft carries can hide silently. Opens in place: dispatch stays one screen. */}
        {!ensembleMode && (
          <div className="dispatch-more-wrap">
            <Tooltip
              label={
                detailsOpen
                  ? "Collapse the backlog details"
                  : "Priority, labels, title and dependencies"
              }
            >
              <button
                type="button"
                className={`dispatch-more${detailsOpen ? " open" : ""}`}
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                <span className="dispatch-more-title">Backlog details</span>
                {!detailsOpen && <span className="dispatch-more-summary">{backlogSummary}</span>}
                <span className="dispatch-more-chev" aria-hidden>
                  {detailsOpen ? "▴" : "▾"}
                </span>
              </button>
            </Tooltip>
            {detailsOpen && (
              <div className="dispatch-more-body">
                <div className="field-row">
                  <label className="field">
                    <span className="field-label">
                      Priority <span className="field-hint">optional</span>
                    </span>
                    <Tooltip label="How this task is ranked in the backlog - a task carries one only if you choose it">
                      <select
                        className="field-input"
                        value={draft.priority}
                        onChange={(e) => update({ priority: e.target.value as TaskPriority | "" })}
                      >
                      {/* The empty option is first and is the default: a task carries a priority
                          only because someone chose one, never because the form defaulted it. */}
                        <option value="">none</option>
                        {TASK_PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY_LABELS[p]}
                          </option>
                        ))}
                      </select>
                    </Tooltip>
                  </label>
                  <label className="field">
                    <span className="field-label">
                      Labels <span className="field-hint">optional - comma separated</span>
                    </span>
                    <input
                      className="field-input"
                      placeholder="e.g. bug, infra"
                      value={draft.labels}
                      onChange={(e) => update({ labels: e.target.value })}
                    />
                    {/* Previews what will actually be stored - deduped, trimmed and capped by
                        the same function the server applies - so a trailing comma or a repeat
                        is visibly a no-op rather than a surprise on the card. Rendered INSIDE
                        this field rather than under the row, or it would sit beneath the
                        priority select and read as that control's output. */}
                    {labels.length > 0 && (
                      <span className="dispatch-label-preview">
                        <LabelChips labels={labels} />
                        {labels.length >= MAX_LABELS && (
                          <span className="field-hint">{MAX_LABELS} maximum</span>
                        )}
                      </span>
                    )}
                  </label>
                </div>

                {titleField}

                <div className="field">
                  <span className="field-label">
                    Dependencies{" "}
                    <span className="field-hint">each waits for its merged PR</span>
                  </span>
                  {/* Chips plus one grouped add control, instead of an always-tall native
                      multi-select: each chip names its target and removes with one click,
                      and the picker only offers what is not already chosen. */}
                  <div className="dep-chips">
                    {draft.dependencies.map((dependency) => {
                      const key = dependencyKey(dependency);
                      const label = dependencyByKey.get(key)?.label ?? "unavailable";
                      return (
                        <span key={key} className="dep-chip">
                          {label}
                          <Tooltip label="Remove this dependency">
                            <button
                              type="button"
                              className="dep-chip-x"
                              aria-label={`Remove dependency: ${label}`}
                              onClick={() =>
                                update({
                                  dependencies: draft.dependencies.filter(
                                    (candidate) => dependencyKey(candidate) !== key,
                                  ),
                                })
                              }
                            >
                              ✕
                            </button>
                          </Tooltip>
                        </span>
                      );
                    })}
                    <Tooltip label="Tasks that must finish before this one may be dispatched">
                      <select
                        className="dep-add"
                        value=""
                        aria-label="Add dependency"
                        onChange={(event) => {
                          const option = dependencyByKey.get(event.target.value);
                          if (option) update({ dependencies: [...draft.dependencies, option.input] });
                        }}
                      >
                        <option value="">+ Add dependency</option>
                        {unselectedDependencies("backlog").length > 0 && (
                          <optgroup label="Backlog tasks">
                            {unselectedDependencies("backlog").map(([key, option]) => (
                              <option key={key} value={key}>{option.label}</option>
                            ))}
                          </optgroup>
                        )}
                        {unselectedDependencies("session").length > 0 && (
                          <optgroup label="Active sessions">
                            {unselectedDependencies("session").map(([key, option]) => (
                              <option key={key} value={key}>{option.label}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </Tooltip>
                  </div>
                  <span className="field-hint">
                    Sessions without observable hooks cannot be selected.
                  </span>
                  {selectedDependenciesUnmet && (
                    <span className="dispatch-wait-note">
                      <span aria-hidden>◷</span> Waits for {unmetDependencyCount}{" "}
                      {unmetDependencyCount === 1 ? "dependency" : "dependencies"} - it{" "}
                      {editing ? "stays in" : "lands in"} the backlog and dispatches when their
                      PRs merge.
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {ensembleMode && ensembleDraft && onEnsembleDraftChange && (
          <EnsembleDispatch
            ensemble={ensembleDraft}
            onEnsembleChange={onEnsembleDraftChange}
            personas={personas}
            workflowSummaries={workflowSummaries}
            launch={ensembleLaunch}
          />
        )}

        {error && <p className="dispatch-error">{error}</p>}
      </div>

      <footer className="modal-foot">
        {/* Ensemble launches immediately and owns its own member backlog wave, so "Add to
            backlog" makes no sense there; its Review/Launch control owns the primary slot. */}
        {!ensembleMode && (
          <Tooltip label={editing ? "Keep it in the backlog" : "Shelve it without launching an agent"}>
            <button
              className="btn btn-ghost"
              onClick={() => void submit(false)}
              disabled={
                busy
                || drop.uploading
                || !draft.repoRoot.trim()
                || !draft.intent.trim()
              }
            >
            {editing
              ? pending === "shelve"
                ? "Saving…"
                : "Save"
              : pending === "shelve"
                ? "Shelving…"
                  : "Add to backlog"}
            </button>
          </Tooltip>
        )}
        <Tooltip label={editing ? "Undo these edits" : "Reset the form"}>
          <button
            className="btn btn-ghost"
            onClick={ensembleMode ? onEnsembleClear : clearDraft}
            disabled={
              busy ||
              (ensembleMode
                ? false
                : editing
                  ? draftsEqual(draft, draftFromTask(editing))
                  : isEmptyDispatchDraft(draft))
            }
          >
            {editing ? "Revert" : "Clear"}
          </button>
        </Tooltip>
        <span className="actions-spacer" />
        <Tooltip label="Close without dispatching (Escape)">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </Tooltip>
        {ensembleMode ? (
          // The Ensemble two-step lives in the primary slot: Review until the plan
          // verifies, then a Reviewed chip beside Launch. One action row, like Single.
          <EnsembleLaunchControls launch={ensembleLaunch} />
        ) : (
          <Tooltip
            label={
              selectedDependenciesUnmet
                ? "Dependencies must complete first; schedule this in the backlog"
                : selectedWorkflowBlocked
                  ? "Resolve the after-work Workflow requirement before dispatching"
                : "Provision a worktree and launch the agent now (⌘/Ctrl+Enter)"
            }
          >
            <button
              className={`btn btn-primary${selectedDependenciesUnmet && !editing ? " btn-wait" : ""}`}
              onClick={() => void submit(true)}
              disabled={
                busy ||
                drop.uploading ||
                !draft.repoRoot.trim() ||
                !draft.intent.trim() ||
                (selectedWorkflowBlocked && !selectedDependenciesUnmet) ||
                Boolean(editing && selectedDependenciesUnmet)
              }
            >
            {pending === "dispatch"
              ? "Dispatching…"
              : drop.uploading
                ? "Uploading…"
                : selectedDependenciesUnmet
                  ? editing
                    ? "Waiting for dependencies"
                    : "Schedule after dependencies"
                    : "Dispatch now"}
            </button>
          </Tooltip>
        )}
      </footer>
    </Overlay>
  );
}
