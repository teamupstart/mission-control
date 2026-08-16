import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_TYPES,
  TASK_KINDS,
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
import {
  MAX_LABELS,
  PRIORITY_LABELS,
  TASK_KIND_INFO,
  TASK_KIND_BEHAVIOR,
  TASK_PRIORITIES,
  hasReviewableDiff,
} from "@shared/task.ts";
import { modelChoicesFor } from "@shared/model.ts";
import type { EnvironmentCheckView } from "@shared/environment-checks.ts";
import {
  TASK_SOURCE_KIND_INFO,
  type TaskSourceInstance,
  type TaskSourceRef,
} from "@shared/task-source.ts";
import {
  api,
  fetchEnvironmentChecks,
  fetchHarnessesConfig,
  fetchPipelineRepos,
  fetchRepos,
  fetchTaskSources,
} from "../lib/api.ts";
import {
  readLastDispatchRepo,
  rememberDispatchRepo,
} from "../lib/lastRepo.ts";
import {
  EMPTY_DISPATCH_DRAFT,
  draftFromTask,
  draftsEqual,
  parseLabelInput,
  taskUpdatePatch,
  type DispatchDraft,
} from "../lib/task-draft.ts";
import { formatScheduledFor } from "../lib/schedules.ts";
import { repoLeaf } from "../lib/format.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { RepositoryName } from "./RepositoryName.tsx";
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
import {
  GuidedPicker,
  GuidedRail,
  GuidedToggle,
  type GuidedAnswer,
  type GuidedOption,
} from "./GuidedDispatch.tsx";
import { useGuidedDispatch } from "../lib/guided-dispatch.ts";
import {
  GUIDED_HARNESS_KEYS,
  GUIDED_KIND_KEYS,
  NO_GUIDED_PASS,
  activeGuidedStep,
  answerGuidedStep,
  backGuidedStep,
  endGuidedPass,
  guidedMnemonic,
  isGuidedPassRunning,
  jumpToGuidedStep,
  startGuidedPass,
  type GuidedPass,
  type GuidedStepId,
} from "../lib/guided-dispatch-steps.ts";
import type { PersonaView, WorkflowConfig, WorkflowSummary } from "@shared/workflow.ts";
import { workflowRequest } from "../workflows/workflowApi.ts";
import {
  EnsembleDispatch,
  EnsembleLaunchControls,
  useEnsembleLaunch,
} from "../ensembles/dispatch/EnsembleDispatch.tsx";
import { freshEnsembleDraft, type EnsembleDispatchDraft } from "../ensembles/dispatch/config.ts";
import type { EnsembleStrategyId } from "@shared/ensemble.ts";

/**
 * What a fresh dispatch form holds: nothing, except the repo the last one went to.
 *
 * Read at call time rather than captured in a constant, so a dispatch sent moments ago
 * seeds the next form in this same tab - not just the next reload. Lives here rather
 * than beside the rest of the draft shape because it is the one piece that reads the
 * browser: `lib/task-draft.ts` stays a pure translation between a form and a task.
 */
function freshDispatchDraft(): DispatchDraft {
  return {
    ...EMPTY_DISPATCH_DRAFT,
    repoRoot: readLastDispatchRepo(),
    // Secondary repos widen one task's worktree and write scope. They are never a default
    // for the next task, even though the primary repo deliberately remains sticky.
    extraRepoRoots: [],
  };
}

/**
 * The secondary repos a draft sends: trimmed, with blanks dropped, and nothing else removed.
 *
 * It deliberately does NOT filter out an entry equal to the primary. It used to, and that
 * was a silent drop: retyping the primary onto an already-attached repo left the chip on
 * screen, the submit enabled, and the dispatch quietly single-repo. A chip is the operator's
 * stated intent, so the form either sends it or refuses - see `repoCollision`, which blocks
 * the submit and names the repo instead.
 */
function attachedRepoRoots(d: DispatchDraft): string[] {
  return d.extraRepoRoots.map((raw) => raw.trim()).filter(Boolean);
}

/**
 * The attached repo that is also the primary, or is attached twice - or null.
 *
 * STRING equality, and that bound is the honest one: only the daemon resolves a path to a
 * repo's main checkout, so it stays the authority on whether two spellings are one repo and
 * refuses those itself. What this catches is the case the operator can SEE - the same text
 * in two places - which is exactly the one that would otherwise be dropped without a word.
 */
function repoCollision(d: DispatchDraft): string | null {
  const primary = d.repoRoot.trim();
  const attached = attachedRepoRoots(d);
  return attached.find((root, i) => root === primary || attached.indexOf(root) !== i) ?? null;
}

/**
 * "Nothing put aside", for the after-work choice a scout switch stashes.
 *
 * A sentinel rather than `undefined`, because `undefined` is itself one of the three
 * values a stash can hold - it is the draft's way of saying "follow the dispatch default"
 * - and a fresh form stashes exactly that. Conflating the two would turn the very common
 * default-then-scout-then-ship reversal into a no-op.
 */
const NO_STASH = Symbol("no-stash");
type StashedWorkflowId = DispatchDraft["workflowId"] | typeof NO_STASH;

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
    d.extraRepoRoots.length === 0 &&
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
 * The configured sources this task could actually be filed into.
 *
 * The SAME two questions the daemon asks, deliberately - `pushTask` refuses a kind whose
 * `canPush` is false and a source whose stored `repoRoot` is not the task's, by exact string
 * comparison of two values that were both resolved to a git root when they were stored. The
 * browser cannot run git, so it cannot re-derive either of them; matching the daemon's
 * comparison exactly is what keeps the modal from offering an action the route would refuse.
 *
 * `canPush` is readable here because it lives on the pure half of the contract
 * (`TASK_SOURCE_KIND_INFO`), which is the whole reason it was put there: the modal decides
 * whether to offer the action without importing an implementation the browser cannot load.
 */
function eligiblePushSources(
  sources: TaskSourceInstance[],
  repoRoot: string,
): TaskSourceInstance[] {
  return sources.filter((s) => TASK_SOURCE_KIND_INFO[s.kind].canPush && s.repoRoot === repoRoot);
}

/** What to call a source in a picker: the operator's own name for it, else its kind's. */
function sourceName(source: TaskSourceInstance): string {
  return source.label.trim() || TASK_SOURCE_KIND_INFO[source.kind].label;
}

/**
 * The push surface's state, tagged with the task it belongs to.
 *
 * The tag is the whole point of the type: see the state's declaration in `DispatchModal`.
 * Every field here answers a question about ONE task, and a reader that forgets which task
 * shows another one's issue as this one's.
 */
type PushState = {
  taskId: string;
  /** Which eligible source the operator picked. Null takes the first. */
  sourceId: string | null;
  /** What the push created, read off the route's own 200 body. */
  ref: TaskSourceRef | null;
  /** The daemon's own refusal, kept verbatim. */
  error: string | null;
  /** The 504: the item MAY exist, so the action is withdrawn rather than offered again. */
  outcomeUnknown: boolean;
};

/** Nothing asked yet, for this task. */
function freshPushState(taskId: string): PushState {
  return { taskId, sourceId: null, ref: null, error: null, outcomeUnknown: false };
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
 * What the three crew questions describe, hoisted to constants because two surfaces now ask
 * each one: the field's own `<select>`, and the guided pass's floating list over it. Hovering
 * an option in the list has to say what hovering the control says, or the pass would be a
 * place where the app describes the same choice in different words.
 */
const AGENT_FIELD_TIP =
  "Which harness this task is dispatched to - switching resets the model and effort overrides";
const KIND_FIELD_TIP =
  "What this task is asked to produce - a kind with no diff also clears the after-work Workflow";
const AFTER_WORK_FIELD_TIP =
  "Run a published Workflow when Foreman confirms this agent's work is complete";

/**
 * What a harness would launch with, as one line - the model and effort the pass deliberately
 * does not ask about, said out loud so choosing a harness is not choosing them blind.
 *
 * Null until the defaults land, and null for a harness the machine has nothing configured
 * for; both render as an option with no second line rather than as a promise the form cannot
 * keep.
 */
function harnessDefaultsLine(agent: AgentType, defaults: HarnessesConfig | null): string | null {
  if (!defaults) return null;
  const modelId = defaults.defaultModel[agent];
  const model = modelId
    ? modelChoicesFor(agent, modelId).find((m) => m.id === modelId)?.label ?? modelId
    : null;
  const effort = defaults.defaultEffort[agent] || null;
  const parts = [model, effort].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
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
  harnessesRevision = 0,
  launchIntent = null,
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
  /**
   * `MissionState.harnessesRevision`. Forwarded to the modal so a change to the per-harness
   * defaults re-reads them WHILE THE MODAL IS OPEN - the read used to happen only on open,
   * so a modal left open kept naming a model that was no longer the default.
   */
  harnessesRevision?: number;
  /**
   * What the caller wants this opening to be, when it is not an ordinary Dispatch.
   *
   * The Library's strategy launchers reach the modal through here rather than by setting the
   * launch mode themselves: mode and Ensemble draft are this component's state (so switching
   * mode or closing loses neither), and a caller allowed to write them would be a second
   * place that decides what Ensemble mode means. An intent is a request; the modal applies it.
   */
  launchIntent?: { strategyId: EnsembleStrategyId } | null;
  onClose: () => void;
  /** Open Recurring Missions from a generated task's read-only provenance in edit mode. */
  onOpenSchedule?: (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => void;
  /** Navigate to a freshly launched Ensemble run's detail. */
  onEnsembleLaunched?: (runId: string) => void;
}): React.JSX.Element | null {
  const [draft, setDraft] = useState<DispatchDraft>(freshDispatchDraft);
  /**
   * The guided pass belongs to the new-dispatch draft, so it has the same lifetime.
   *
   * `null` means this draft has not started a pass yet. When Guided is on, the modal derives
   * the first question from that value; the first answer replaces it with the real progress.
   * Keeping it here means dismissing the modal loses neither answered rungs nor a completed
   * handoff. Clear and a successful submit rotate both the draft and this state together.
   */
  const [guidedPass, setGuidedPass] = useState<GuidedPass | null>(null);
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
  /**
   * The mode the OPERATOR last chose, as distinct from one a launch intent imposed.
   *
   * The modal deliberately keeps its launch mode across a close - switching mode and closing
   * must lose neither. That was unambiguous while the toggle was the only way in; a Library
   * strategy card is a second way, and without this an operator who launched one ensemble
   * would find every later Dispatch sitting in Ensemble mode, having never asked for it.
   * So an intent arms Ensemble for its own opening, and hands the mode back when it is spent.
   */
  const operatorMode = useRef<"single" | "ensemble">("single");
  const chooseLaunchMode = useCallback((mode: "single" | "ensemble") => {
    operatorMode.current = mode;
    setLaunchMode(mode);
  }, []);

  // A launch intent is applied the way the edit slot above is - during render, once per
  // opening, keyed on what was asked for - so the modal never paints one frame of Single
  // mode before flipping to Ensemble.
  const [armedStrategy, setArmedStrategy] = useState<EnsembleStrategyId | null>(null);
  const askedStrategy = open && !editTask ? launchIntent?.strategyId ?? null : null;
  if (askedStrategy !== armedStrategy) {
    setArmedStrategy(askedStrategy);
    if (askedStrategy) {
      setLaunchMode("ensemble");
      // Only RESET the config when the strategy actually changes, which is the rule the
      // in-modal strategy picker keeps: relaunching the same strategy from the Library must
      // not throw away a config the operator already filled in.
      if (ensembleDraft.strategyId !== askedStrategy) {
        setEnsembleDraft(freshEnsembleDraft(askedStrategy));
      }
    } else {
      setLaunchMode(operatorMode.current);
    }
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
      setGuidedPass(null);
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
   * The edited task was deleted. The same teardown a saved edit gets, minus the staleness
   * test: that test exists to avoid discarding newer typing, and there is no row left for
   * newer typing to be saved to. Dropping the slot is what keeps a deleted task's working
   * copy from sitting in memory holding blob URLs open for the life of the page.
   */
  const onEditDeleted = useCallback(() => {
    const cur = editRef.current;
    if (cur) revokeAttachments(cur.draft.attachments);
    setEdit(null);
    onClose();
  }, [onClose]);

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
    setGuidedPass(null);
  }, []);

  /**
   * Clear the Ensemble draft: reset the compose fields AND rotate the request id, so the next
   * launch is a genuinely new request rather than an idempotent replay of a half-abandoned one.
   */
  const onEnsembleClear = useCallback(() => {
    revokeAttachments(draftRef.current.attachments);
    setDraft(freshDispatchDraft());
    setGuidedPass(null);
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
        setGuidedPass(null);
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
        onDeleted={onEditDeleted}
        onOpenSchedule={onOpenSchedule}
        workflowSummaries={workflowSummaries}
        foremanEnabled={foremanEnabled}
        harnessesRevision={harnessesRevision}
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
      guidedPass={guidedPass}
      onGuidedPassChange={setGuidedPass}
      launchMode={launchMode}
      onLaunchModeChange={chooseLaunchMode}
      ensembleDraft={ensembleDraft}
      onEnsembleDraftChange={setEnsembleDraft}
      onEnsembleClear={onEnsembleClear}
      onEnsembleLaunched={onEnsembleLaunchedInternal}
      personas={personas}
      workflowSummaries={workflowSummaries}
      foremanEnabled={foremanEnabled}
      harnessesRevision={harnessesRevision}
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
  guidedPass = null,
  onGuidedPassChange,
  onDeleted,
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
  harnessesRevision = 0,
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
  /** Progress for the new-dispatch draft, owned by `DispatchLayer` so close/reopen keeps it. */
  guidedPass?: GuidedPass | null;
  onGuidedPassChange?: (pass: GuidedPass | null) => void;
  /**
   * The edited task was deleted, so the working copy over it has nothing left to describe.
   * Edit-only - a new dispatch has no row to delete - and the layer's implementation drops
   * the slot and revokes its thumbnails before closing. Absent, closing is the whole job.
   */
  onDeleted?: () => void;
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
  /**
   * `MissionState.harnessesRevision`. Watched so the "Default - …" labels re-read when the
   * defaults change under an open modal, rather than only when the modal is reopened.
   */
  harnessesRevision?: number;
}): React.JSX.Element {
  const editing = mode.kind === "edit" ? mode.task : null;
  // Ensemble mode is a new-dispatch-only concern, and only when the layer wired the state up.
  const ensembleMode = !editing && launchMode === "ensemble" && ensembleDraft !== undefined;
  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [pipelineRepos, setPipelineRepos] = useState<Set<string>>(new Set());
  // The attach-a-repo control is a two-step (open, then pick) rather than a combobox that
  // is always mounted: an empty repo picker sitting under the primary on every dispatch
  // would read as a second required field. Local rather than drafted - a half-typed path
  // in a picker that has not been confirmed is not part of the task.
  const [addingRepo, setAddingRepo] = useState(false);
  const [addRepoValue, setAddRepoValue] = useState("");
  // The configured per-harness defaults, so both pickers can name what "Default"
  // means. Null until the fetch lands (and if it fails).
  const [defaults, setDefaults] = useState<HarnessesConfig | null>(null);
  const [workflowConfig, setWorkflowConfig] = useState<WorkflowConfig | null>(null);
  /**
   * What this MACHINE has to say about tooling a launched session will inherit - already
   * filtered to the checks that actually found something, so rendering is a fold over it.
   *
   * Empty on a machine none of the checks recognise, which is most of them, and empty when
   * the fetch does not land. Both must look identical here: this is context, not a gate, and
   * nothing below reaches `submit` or the primary button's `disabled`. An operator who knows
   * their agent will hit a setup gate is still allowed to dispatch - that is the difference
   * between this and `selectedWorkflowBlocked`, which genuinely blocks.
   */
  const [envWarnings, setEnvWarnings] = useState<EnvironmentCheckView[]>([]);
  /**
   * The configured sources, or null while the read is out - and if it never landed.
   *
   * Not tagged with a task the way `pushState` below is, because it is not about one: the
   * source list is global, and the eligibility filter is applied against whichever task the
   * form is over at render time. A list fetched for one task is therefore correct for the
   * next; it is re-read per opening only so a source added in Settings a moment ago is usable
   * without a reload.
   */
  const [taskSources, setTaskSources] = useState<TaskSourceInstance[] | null>(null);
  /**
   * What has been asked of the push surface, and what came back - CARRYING THE TASK IT IS
   * ABOUT.
   *
   * One tagged object rather than four loose pieces of state, because every one of them is
   * meaningful only about the task that produced it, and the cost of that going wrong is the
   * worst kind: a `ref` left over from task A renders as task B's link, telling an operator
   * that a task they have not filed anywhere is already upstream. An `outcomeUnknown` left
   * over withdraws B's button for a failure that was not B's.
   *
   * `DispatchLayer` keys this component on the task id, so today a different task remounts it
   * and the whole question is moot. That is exactly why the tag is here: the invariant this
   * state depends on lives in another component, three hundred lines away, in a prop that is
   * easy to drop in a refactor and whose loss would show up as a wrong ISSUE LINK rather than
   * as anything that looks like a missing key. Reading it through `editing.id` makes the
   * staleness unrepresentable instead of merely unlikely.
   *
   * `ref` is held even though the daemon emits `task_upsert` for the same fact, because the
   * two arrive on different clocks: the route's own reply carries the updated `Task`, so
   * reading the ref off it draws the link in the tick the button was pressed rather than
   * whenever the event loop delivers the frame. The event still lands and still updates
   * `editing`; this just refuses to race it.
   *
   * `outcomeUnknown` is scoped to the opening for the reason the 504 exists: the item may be
   * upstream already, and the operator's next move is to go and look, not to press again.
   * Reopening the form is a deliberate second act, and by then the row itself will say whether
   * the sweep found it.
   */
  const [pushState, setPushState] = useState<PushState | null>(null);
  // Which action is in flight, not merely whether one is: every footer button reaches the
  // daemon, and only the one that was pressed should say so.
  const [pending, setPending] = useState<null | "shelve" | "dispatch" | "delete" | "push">(null);
  const busy = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const intentRef = useRef<HTMLTextAreaElement>(null);
  // The primary repo field's input. Held because the Repo question is the one whose control is
  // a text field: the pass has to put the caret in it when the question opens, and has to be
  // able to tell a key pressed IN it from one pressed anywhere else in the dialog.
  const repoInputRef = useRef<HTMLInputElement>(null);
  // The overlay owns the dispatch chord, but its listener is intentionally stable (see
  // `Overlay`). Point it at the current submit closure so a field edit does not leave the
  // shortcut submitting the previous render's draft.
  const submitRef = useRef<(dispatchNow: boolean) => Promise<void>>(async () => {});
  // The guided pass's keys, reached the same way and for the same reason: `Overlay`'s
  // listener is subscribed once, so pointing it at a ref rather than at a closure is what
  // keeps typing in the task box from re-subscribing a window listener on every keystroke.
  const guidedKeyRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
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
  const [guided, setGuided] = useGuidedDispatch();
  /**
   * Whether a guided pass belongs to this form AT ALL - for a given value of the preference,
   * so the toggle can ask it about the value it is about to write.
   *
   * ONE predicate with three readers (the mount rule, the header toggle, and Clear), because
   * they ask the same question at three moments: *should this form be asking the questions?*
   * An edit never should - those answers exist already, and re-asking them would be a quiz -
   * and Ensemble never should, because its body replaces Crew and After work outright, so
   * there would be nothing left to point at.
   *
   * This is deliberately NOT `guidedRunning`, which answers something narrower: is a question
   * on screen *right now*. The two part company the moment a pass hands over, and a reader
   * that wants the first question but asks the second gets a plain form.
   */
  const guidedAppliesWith = (on: boolean): boolean =>
    on && mode.kind === "new" && launchMode === "single";
  const guidedApplies = guidedAppliesWith(guided);
  /**
   * Whether the switch is offered at all: "would a pass apply here if the preference were on".
   *
   * The same predicate, asked with the preference held true, so the switch appears exactly
   * where flipping it does something. Gating it on anything else is how it ends up live and
   * inert - which is the failure the comment beside it warns about, and Ensemble was the one
   * launch mode where it was true.
   */
  const guidedOfferable = guidedAppliesWith(true);
  /**
   * Where the guided pass stands. `null` is an untouched draft: Guided turns it into the
   * first question at render time, without mistaking a deliberately ended pass for a fresh
   * one. The owner lives above this per-opening modal, beside the draft, so dismiss/reopen
   * resumes the first unanswered question instead of asking completed questions again.
   * That persisted progress is read only where a pass applies. Edit and Ensemble forms must
   * hold the no-pass value even while the separate new-dispatch draft has saved progress.
   */
  const pass = guidedApplies ? (guidedPass ?? startGuidedPass()) : NO_GUIDED_PASS;
  const setPass = (next: GuidedPass | null): void => onGuidedPassChange?.(next);
  const guidedRunning = isGuidedPassRunning(pass);
  const drop = useImageDrop({
    attachments: draft.attachments,
    onChange: onAttachmentsChange,
    // The pass makes the Task field inert, but a file dropped on the window still means
    // exactly what it means over that field. Handoff removes this wider target again.
    windowTarget: guidedRunning,
  });
  /**
   * `null` means "wherever the draft already points", resolved at render.
   *
   * Deliberately not resolved when a step is entered: answering writes the draft through
   * React state, so a seed computed inside the same handler would read the value the answer
   * just replaced - and the After work step, which the Kind answer moves, would open on the
   * wrong row every single time.
   */
  const [highlight, setHighlight] = useState<number | null>(null);
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
  const kindBehavior = TASK_KIND_BEHAVIOR[draft.kind];
  const usesHarness = kindBehavior.launch === "harness";
  const kindAvailable = (kind: TaskKind): boolean => {
    const behavior = TASK_KIND_BEHAVIOR[kind];
    return behavior.repoAvailability === "workspace" || pipelineRepos.has(draft.repoRoot.trim());
  };
  const kindUnavailable = !kindAvailable(draft.kind);
  const offeredKinds = TASK_KINDS.filter(
    (kind) => kindAvailable(kind) || kind === draft.kind,
  );
  const selectedWorkflowBlocked = usesHarness && Boolean(
    selectedWorkflowId
    && (!foremanEnabled || !capabilitiesFor(draft.agent).workQueue),
  );
  // Whether this harness can hold write access outside its cwd. Read through
  // `capabilitiesFor`, which is the browser-safe door to the same record the daemon reads,
  // so the control that is offered and the request that is accepted cannot disagree.
  const multiRepoSupported =
    usesHarness && capabilitiesFor(draft.agent).multiRepoDispatch !== null;
  // The control is absent in ENSEMBLE mode: an ensemble is N sessions over ONE repo, and
  // running one across several is deliberately out of scope for this release. The draft is
  // shared between the two modes, so the attachments are kept rather than cleared - flipping
  // back to a single dispatch brings the chips back exactly as they were - and the ensemble
  // launch, which composes its own request from the primary alone, simply does not use them.
  const multiRepoOffered = !ensembleMode && multiRepoSupported;
  // The chips outlive the ADDER. A harness that cannot hold write access outside its cwd
  // stops offering new attachments, but the ones already made stay on screen with their
  // Detach buttons - otherwise the refusal below tells the operator to detach repos that
  // are not drawn anywhere, and the only way out of a blocked form is to guess.
  const repoChipsShown = !ensembleMode && (multiRepoSupported || draft.extraRepoRoots.length > 0);
  // Blocks the SINGLE dispatch only, and only for the reason an operator can act on from
  // this form. Blocking in ensemble mode would put an unreachable instruction on screen:
  // its chips are not rendered, so there would be nothing to detach.
  const multiRepoBlocked = !ensembleMode && !multiRepoSupported && draft.extraRepoRoots.length > 0;
  // The same repo named twice - as the primary and a chip, or as two chips. Only meaningful
  // where the chips are part of the request at all, which is not ensemble mode.
  const collidingRepo = ensembleMode ? null : repoCollision(draft);
  // One gate for "this repo set cannot be sent as it stands", so the three submit paths and
  // the two sentences under the field cannot disagree about it.
  const repoSetBlocked = multiRepoBlocked || collidingRepo !== null;

  // Merge one field's change into the lifted draft.
  function update(patch: Partial<DispatchDraft>): void {
    onDraftChange({ ...draft, ...patch });
  }

  /**
   * What a ship-to-scout switch put aside, so switching back can hand it straight back.
   *
   * A ref rather than draft state: it is scratch belonging to one uninterrupted sequence
   * of clicks, not something a shelved task should carry. Losing it on close is correct -
   * a reopened form has no reversal in flight - and the no-stash path leaves the stored
   * selection alone rather than inventing one.
   */
  const stashedWorkflowId = useRef<StashedWorkflowId>(NO_STASH);

  /**
   * The after-work choice a kind switch carries with it, as a patch fragment.
   *
   * Kind carries this the same way switching harness carries model and effort: the
   * dependent choice belongs to the kind now selected, not the one it replaced. A scout
   * investigates and reports and a plan proposes a route - neither sets out to produce a
   * delivered change to hand off - so choosing either moves the selection to None, which
   * would otherwise run a review Workflow over a task that has no diff to review.
   *
   * Switching back HANDS BACK the exact choice that was put aside, rather than recomputing
   * the machine default. That is what keeps the reversal lossless, and it is deliberately
   * a pure function of what was already on screen: recomputing would need
   * `workflowConfig`, which lands on its own fetch, so a scout-then-ship inside that
   * window would resolve to `null` and SAVE an explicit None - fetch timing quietly
   * converting a promised restoration into a task that finishes with no handoff at all.
   * Reading the stash instead means there is no window in which this can be wrong.
   *
   * Still only a default, in both directions: the stash is dropped the moment the operator
   * picks an after-work Workflow by hand, so their choice is never reverted underneath
   * them by a later kind switch.
   *
   * One stash and not one per kind, which is what makes a scout-to-plan switch safe. Both
   * sides of that switch want None, and the naive version stashes on every entry - so it
   * would put aside the `null` scout had just set, overwriting the operator's real
   * ship-time selection, and then hand that `null` back as an explicit "no handoff" on the
   * way out to ship. Between two diffless kinds nothing has been decided, so nothing moves.
   */
  function afterWorkForKind(kind: TaskKind): Partial<DispatchDraft> {
    if (kind === draft.kind) return {};
    if (!hasReviewableDiff(kind)) {
      // Whatever is selected right now is either the None the first diffless kind set or a
      // pick made by hand after it. Both are already right for this kind, and both survive
      // by leaving the field and the stash exactly as they stand.
      if (!hasReviewableDiff(draft.kind)) return {};
      stashedWorkflowId.current = draft.workflowId;
      return { workflowId: null };
    }
    const stashed = stashedWorkflowId.current;
    stashedWorkflowId.current = NO_STASH;
    // Nothing to hand back - a modal opened on a scout, or an operator who has since
    // chosen for themselves. Leave the selection exactly as it stands rather than
    // inventing one: `taskUpdatePatch` reads an omitted key as "leave it alone".
    return stashed === NO_STASH ? {} : { workflowId: stashed };
  }

  /**
   * The overrides a harness switch carries with it, as a patch fragment - the same shape as
   * `afterWorkForKind` above, and guarded the same way for the same reason.
   *
   * Neither the model nor the effort selection is portable across harnesses, so switching
   * drops both back to the defaults of the one now chosen. CONFIRMING the harness already
   * selected is not a switch, and drops nothing.
   *
   * That second sentence had nowhere to live until the guided pass existed. A `<select>`
   * never fires `onChange` for re-picking its own value, so the no-op case was unreachable
   * through the form; the pass reaches it, because it commits whichever option is taken,
   * changed or not. Unguarded, pressing `c` on the already-selected Claude Code - the fastest
   * way to move the pass along - silently wiped a Model or Effort override set moments
   * earlier, with nothing on screen to say so.
   *
   * Here rather than in the option's `commit` so that the pass and the `<select>` read one
   * rule. Two copies of this expression are what let them disagree in the first place.
   */
  function overridesForAgent(agent: AgentType): Partial<DispatchDraft> {
    return agent === draft.agent ? {} : { model: "", effort: "" };
  }

  // ---- the guided pass ----------------------------------------------------------------
  //
  // A phase of THIS dialog, not a second one: `OVERLAY_IDS.dispatch` keeps its single entry
  // either way, so App's stand-down guard and everything built on it are untouched. What
  // follows is the options each question offers, the moves between them, and the keys - the
  // drawing is in `GuidedDispatch.tsx`.

  const guidedStep = activeGuidedStep(pass);

  /**
   * The After work value as its `<select>` spells it, so the pass's list and the control it
   * floats over are reading one thing. `undefined` is "follow the dispatch default", which is
   * a different answer from an explicit None - see `NO_STASH`.
   */
  const afterWorkValue =
    draft.workflowId === undefined ? "__default" : draft.workflowId ?? "__none";

  /**
   * The After work options, in the `<select>`'s order and with its copy.
   *
   * Built once and read twice - by the picker, and by the rail, which needs the chosen row's
   * short form. `d` and `n` are spent on the two sentinels before the workflows are walked,
   * so a workflow whose name starts with either letter earns its next free one instead of
   * shadowing the option above it.
   */
  const afterWorkOptions: GuidedOption[] = (() => {
    const taken = new Set<string>();
    const out: GuidedOption[] = [];
    const push = (option: GuidedOption): void => {
      if (option.hotkey) taken.add(option.hotkey);
      out.push(option);
    };
    const chosen = (workflowId: DispatchDraft["workflowId"]): void => {
      // Chosen by hand, exactly as the `<select>`'s own handler reads it: a later kind
      // switch must not hand back what scout put aside and revert this underneath them.
      //
      // Unguarded on purpose, unlike `overridesForAgent` above, and the difference is what
      // the gesture MEANS. Dropping an override is a consequence of switching harness, and
      // confirming the current one is not a switch - so it must drop nothing. Dropping the
      // stash is a consequence of choosing for yourself, and being asked "what runs after
      // the work?" and answering IS choosing for yourself, even when the answer is the row
      // that was already lit. Taking None at that question therefore stands, and a later
      // kind switch leaves it alone.
      stashedWorkflowId.current = NO_STASH;
      update({ workflowId });
    };
    const defaultName = defaultWorkflow
      ? `${defaultWorkflow.name} · v${defaultWorkflow.publishedVersion}`
      : workflowConfig === null
        ? "loading…"
        : workflowConfig.defaultWorkflowId
          ? "unavailable workflow"
          : "none";
    push({
      value: "__default",
      label: `Dispatch default — ${defaultName}`,
      short: defaultName,
      sub: "Whatever Settings → Workflows has this machine handing off to",
      hotkey: "d",
      commit: () => chosen(undefined),
    });
    push({
      value: "__none",
      label: "None — finish without a Workflow",
      short: "None",
      sub: "The agent finishes and the task is done - nothing runs after it.",
      hotkey: "n",
      commit: () => chosen(null),
    });
    for (const workflow of publishedWorkflows) {
      const label = `${workflow.name} · v${workflow.publishedVersion}`;
      push({
        value: workflow.id,
        label,
        short: workflow.name,
        hotkey: guidedMnemonic(workflow.name, taken),
        commit: () => chosen(workflow.id),
      });
    }
    // The same fallback row the `<select>` carries, for a reopened draft pinned to a
    // Workflow this build no longer publishes: without it the list would render on nothing
    // and read as a choice the operator never made.
    if (draft.workflowId && !publishedWorkflows.some((w) => w.id === draft.workflowId)) {
      push({
        value: draft.workflowId,
        label: "Unavailable Workflow",
        short: "Unavailable Workflow",
        hotkey: guidedMnemonic("unavailable", taken),
        commit: () => chosen(draft.workflowId),
      });
    }
    return out;
  })();

  /** The options for each question, in the order the rail and the digits count them. */
  const guidedOptions: Record<GuidedStepId, readonly GuidedOption[]> = {
    // None, and that is the Repo step's whole shape: `RepoCombobox` draws the list, filters it
    // and arrows through it, so a second list here would be a copy of a control the operator is
    // already looking at. See `answeredBy` on the step.
    repo: [],
    kind: TASK_KINDS.filter(kindAvailable).map((k) => ({
      value: k,
      label: TASK_KIND_INFO[k].label,
      sub: TASK_KIND_INFO[k].blurb,
      hotkey: GUIDED_KIND_KEYS[k],
      // Byte-identical to the Kind `<select>`'s own handler, `afterWorkForKind` and all.
      // The diffless-kind-clears-after-work rule has one implementation and the pass
      // calls it - which is why adding `plan` needed no edit on this side at all.
      commit: () => update({ kind: k, ...afterWorkForKind(k) }),
      // A provider-owned launch has no harness or after-work choice. Advance through those
      // registry-inapplicable questions while preserving the ordinary guided state machine.
      advance: (current) => {
        let next = answerGuidedStep(current);
        if (TASK_KIND_BEHAVIOR[k].launch === "pipeline-terminal") {
          next = answerGuidedStep(next);
          next = answerGuidedStep(next);
        }
        return next;
      },
    })),
    harness: AGENT_TYPES.map((a) => ({
      value: a,
      label: AGENT_IDENTITY[a].label,
      accent: AGENT_IDENTITY[a].accent,
      sub: harnessDefaultsLine(a, defaults),
      hotkey: GUIDED_HARNESS_KEYS[a],
      // And identical to the Agent `<select>`'s, `overridesForAgent` and all - including its
      // guard, which is what keeps confirming the current harness from dropping anything.
      commit: () => update({ agent: a, ...overridesForAgent(a) }),
    })),
    afterWork: afterWorkOptions,
  };

  /** Which option a question opens on: the one the draft already points at. */
  function guidedSeed(id: GuidedStepId): number {
    // A field step draws no list, so it has no row to seed. Its equivalent is the draft's own
    // `repoRoot` sitting in the field when the question opens, which is what makes ↵ with
    // nothing typed a real answer rather than a skip.
    if (id === "repo") return 0;
    const value =
      id === "kind" ? draft.kind : id === "harness" ? draft.agent : afterWorkValue;
    const at = guidedOptions[id].findIndex((option) => option.value === value);
    return at < 0 ? 0 : at;
  }

  const guidedList = guidedStep ? guidedOptions[guidedStep.id] : [];
  const guidedAt = guidedStep ? highlight ?? guidedSeed(guidedStep.id) : 0;

  /** What the answered rungs read, taken from the draft rather than from what was clicked. */
  const guidedAnswers: Partial<Record<GuidedStepId, GuidedAnswer>> = {
    // The leaf, never the path: four rungs share one 640px row, and the part of a repo path
    // that tells two repos apart is the last segment. The full path is still on screen in the
    // field the rung sends you back to.
    repo: { text: repoLeaf(draft.repoRoot) },
    kind: { text: TASK_KIND_INFO[draft.kind].label },
    harness: {
      text: AGENT_IDENTITY[draft.agent].label,
      accent: AGENT_IDENTITY[draft.agent].accent,
    },
    afterWork: {
      text:
        afterWorkOptions.find((option) => option.value === afterWorkValue)?.short ??
        "Dispatch default",
    },
  };

  /** Take the highlighted option and move on. */
  function guidedTake(index: number): boolean {
    const option = guidedList[index];
    if (!option) return false;
    option.commit();
    setPass(option.advance?.(pass) ?? answerGuidedStep(pass));
    setHighlight(null);
    return true;
  }

  /**
   * The active question was answered through the field's OWN control rather than the list
   * floating under it, and the pass takes it.
   *
   * The list is positioned below its control, not over it, so the `<select>` a question is
   * about stays visible and clickable throughout - and a mouse user reaching for the control
   * they can see is doing the reasonable thing. Left to its own `onChange` it would write the
   * draft correctly and leave the pass parked on a question it had just answered, with the
   * rail still calling it unanswered and the list still open. So the two routes converge here
   * instead: the value is written by the option's own `commit`, which IS that `onChange`, and
   * the pass then advances exactly as if the option had been clicked.
   *
   * Returns false when this step is not the live one - an ordinary form, another question's
   * field, an edit - and the caller runs its own handler untouched.
   */
  function guidedTakeValue(id: GuidedStepId, value: string): boolean {
    if (guidedStep?.id !== id) return false;
    const at = guidedList.findIndex((option) => option.value === value);
    return at < 0 ? false : guidedTake(at);
  }

  /**
   * The Repo question has been answered - by ↵ on the field, or by taking a row from its list.
   *
   * It writes nothing, and that is the same division every other step keeps: `RepoCombobox`'s
   * own `onChange` has already put the path in the draft through the very `update(...)` the
   * ordinary form uses, exactly as an option's `commit` is the field's own handler. This moves
   * the pass, and only that.
   *
   * `pass` is read from THIS render rather than through the functional form of `setPass`, like
   * every other move here, and the Repo step is the one where it matters: two routes can fire
   * for one ↵. Advancing twice from a stale-but-equal pass lands on the same question, where
   * advancing twice from the live one would skip past Kind without asking it.
   */
  function answerGuidedRepo(): boolean {
    if (guidedStep?.id !== "repo") return false;
    setPass(answerGuidedStep(pass));
    setHighlight(null);
    return true;
  }

  const guidedLeave = useCallback((): void => {
    setPass(endGuidedPass(pass));
    setHighlight(null);
  }, [onGuidedPassChange, pass]);

  /**
   * The pass's keys, offered the event before the dialog's own ⌘↵ and reporting whether it
   * took it.
   *
   * Bare letters are safe here for a stated reason rather than by luck: <kbd>p</kbd>,
   * <kbd>t</kbd> and <kbd>c</kbd> are all bound in App's global `selection` group, and
   * `App.tsx` stands down whenever any overlay is open. That is why no capture-phase listener
   * is needed - `LaunchMenu`'s pattern, which does need one, is competing with a live handler.
   *
   * Escape is not here. For the closed-set questions, `Overlay` ends the pass before it can
   * close Dispatch; a second press closes the modal. The Repo question's combobox consumes
   * the first press to dismiss its own list, so that step reports it through
   * `guidedRepoEscaped` and ends the pass there instead.
   *
   * Modifier chords fall through untouched, so ⌘↵ still dispatches and ⌘V still pastes; and
   * so does anything typed while a text field genuinely holds the caret, which the pass takes
   * as evidence that it is not the thing being driven.
   */
  function handleGuidedKey(event: KeyboardEvent): boolean {
    if (!guidedStep || event.metaKey || event.ctrlKey || event.altKey) return false;
    if (guidedStep.answeredBy === "field") return handleGuidedFieldKey(event);
    const target = event.target as HTMLElement | null;
    if (
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.isContentEditable === true
    ) return false;

    const count = guidedList.length;
    const take = (index: number): boolean => {
      if (!guidedList[index]) return false;
      event.preventDefault();
      return guidedTake(index);
    };
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (count === 0) return false;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : count - 1;
        setHighlight((guidedAt + step) % count);
        return true;
      }
      case "Enter":
        return take(guidedAt);
      case "Backspace":
        event.preventDefault();
        // A no-op at the first question rather than an exit: ⇥ is the exit, and it is
        // printed on the strip. The event is still swallowed so it cannot reach anything
        // behind the dialog.
        setPass(backGuidedStep(pass));
        setHighlight(null);
        return true;
      case "Tab":
        event.preventDefault();
        guidedLeave();
        return true;
      default:
        break;
    }
    if (event.key.length !== 1) return false;
    if (event.key >= "1" && event.key <= "9") return take(Number(event.key) - 1);
    const hit = guidedList.findIndex((option) => option.hotkey === event.key.toLowerCase());
    return hit < 0 ? false : take(hit);
  }

  /**
   * A step whose control is the form's own field - Repo, and only Repo.
   *
   * Two keys, because `RepoCombobox` owns the rest and owning them is the reason the plan
   * points this step at it: every character filters (DIGITS INCLUDED - repository names contain
   * them), <kbd>↑</kbd><kbd>↓</kbd> walk its list, and <kbd>⌫</kbd> deletes a character rather
   * than stepping back, which is the same no-op the machine would give at a first question.
   *
   * Gated on the caret being IN that field, so a key pressed anywhere else in the dialog - the
   * Guided switch, the launch-mode radios - is left to the control that has focus.
   */
  function handleGuidedFieldKey(event: KeyboardEvent): boolean {
    if (event.target !== repoInputRef.current) return false;
    switch (event.key) {
      case "Enter":
        // The combobox takes ↵ for a highlighted row and marks it handled, and `onPick` has
        // already moved the pass by the time this runs. What is left for this branch is the
        // case it does NOT take: a field whose text is already a repo, where the list is not
        // even drawn - which is the seeded ↵-alone path this step exists for.
        if (event.defaultPrevented) return true;
        event.preventDefault();
        return answerGuidedRepo();
      case "Tab":
        event.preventDefault();
        guidedLeave();
        return true;
      default:
        // Escape is deliberately not here, and could not be: `RepoCombobox` stops that press
        // to close its own list, so `Overlay`'s window listener never sees it. It arrives
        // through `onEscape` on the field instead - see `guidedRepoEscaped`.
        return false;
    }
  }

  /**
   * The repo field's list was dismissed with Escape, which ends the pass.
   *
   * Escape in this question is progressive rather than a cancel, and that is forced rather
   * than chosen: `RepoCombobox` closes its portalled list on Escape and stops the event,
   * deliberately, so that an open list over half a form cannot let one press close the whole
   * dialog. The plan points this step at that control rather than at a picker of its own, so
   * the press is the list's; what the pass does is leave WITH it. A pass still running over a
   * question whose list has gone would be a dimmed form waiting on keys that no longer arrive.
   *
   * The operator gets the ladder the form already has, one rung longer: the first press
   * closes the list and ends the pass, leaving the ordinary form with the field exactly as
   * typed, and the second closes the modal, as Escape does in every other dialog.
   *
   * Reading the press earlier - on the way down to the field - was tried and is wrong in a way
   * worth recording: ending the pass mid-dispatch moves the caret to the task box, the blur
   * closes the list before the widget's own handler runs, and the press it would have stopped
   * carries on to `Overlay` and closes the dialog. One Escape, both rungs.
   */
  function guidedRepoEscaped(): void {
    if (guidedStep?.id === "repo") guidedLeave();
  }

  /**
   * Repo Escape still has its first rung after the combobox has lost focus.
   *
   * The input owns Escape while its dropdown is open and reports the swallowed press through
   * `guidedRepoEscaped` above. Blur closes that dropdown without a key, though, and focus can
   * move to a live header or footer control while the Repo question remains active. In that
   * state `Overlay` would see the next Escape first and close the whole modal.
   *
   * Listen in capture only for the case the combobox cannot own: an Escape whose target is
   * not the repo input while Repo is active. `stopImmediatePropagation` is intentional because
   * Overlay's dismiss listener is another window listener; stopping ordinary propagation at
   * the same node would not stop that sibling listener. An Escape in the input falls through
   * untouched, preserving the combobox's close-and-report path instead of recreating the
   * one-press-two-rungs bug described above.
   */
  useEffect(() => {
    if (pass.active !== "repo") return;
    function onBlurredRepoEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.target === repoInputRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      guidedLeave();
    }
    window.addEventListener("keydown", onBlurredRepoEscape, true);
    return () => window.removeEventListener("keydown", onBlurredRepoEscape, true);
  }, [guidedLeave, pass.active]);
  guidedKeyRef.current = handleGuidedKey;

  /**
   * A switch to Ensemble ends the pass. Its body replaces Crew and After work entirely, so a
   * question floating over a control that is no longer rendered would be pointing at nothing.
   * An effect rather than a line in the toggle's `onClick` because the layer can arm Ensemble
   * from a launch intent too, and both routes have to end the same way.
   */
  useEffect(() => {
    if (ensembleMode) {
      setPass(endGuidedPass(pass));
      setHighlight(null);
    }
  }, [ensembleMode]);

  /**
   * The mount autofocus, now conditional - and the reason it had to become so.
   *
   * `Overlay.onKeyDown` is a `window` listener, so while a pass is running <kbd>p</kbd> would
   * both advance it and type a `p` into the task box. The caret therefore stays out of the
   * textarea until the pass ends, and this same effect is what puts it there when it does:
   * completing the last question, <kbd>⇥</kbd>, turning Guided off, or switching to Ensemble
   * all land on the same transition. `clearDraft()`'s own refocus is untouched.
   */
  useEffect(() => {
    if (!guidedRunning) intentRef.current?.focus();
  }, [guidedRunning]);

  /**
   * The Repo question puts the caret in the repo field, which is where the mount autofocus
   * above used to go and is why it had to become conditional in the first place.
   *
   * The other three questions focus their own floating list (`GuidedPicker`), so this is the
   * one step whose focus the pass has to place itself - and placing it is what makes the
   * question answerable at all: `RepoCombobox` opens its list on focus, filters on what is
   * typed into it, and takes ↵ on the row it has highlighted.
   *
   * Keyed on the pass OBJECT rather than on the active step's id, and that is the difference
   * between working and looking like it works: Clear restarts a pass that may already be on
   * Repo, so an id-keyed effect would not re-run and the caret would stay on the Clear button
   * the operator just clicked - where every key that followed would be swallowed rather than
   * answering. `startGuidedPass()` is a new object every time, so this re-runs.
   */
  useEffect(() => {
    // `preventScroll` for the reason the picker gives: the dialog is fully on screen already,
    // and the browser's scroll-into-view would nudge something that is not moving.
    if (pass.active === "repo") repoInputRef.current?.focus({ preventScroll: true });
  }, [pass]);

  /**
   * Everything the pass is not asking about recedes, and stops taking the pointer inside the
   * body - a click into the task box mid-pass would put the caret somewhere the next
   * mnemonic gets swallowed instead of typed. The footer keeps its clicks: it is dim because
   * it is not the question, not because it is unavailable.
   *
   * All three are empty strings when no pass is running, so a form with the preference off
   * carries exactly the classes it carried before this existed.
   */
  const guidedDim = guidedRunning ? " dispatch-guided-dim" : "";
  const guidedDimUnless = (id: GuidedStepId): string =>
    guidedRunning && guidedStep?.id !== id ? " dispatch-guided-dim" : "";
  const guidedAnchor = (id: GuidedStepId): string =>
    guidedStep?.id === id ? " dispatch-guided-anchor" : "";
  /** The question over a field, or nothing. One call site per step, beside its control. */
  const guidedPickerFor = (
    id: GuidedStepId,
    tip: string,
    { hint, place }: { hint?: string | null; place?: "below" | "above" } = {},
  ): React.JSX.Element | null =>
    guidedStep?.id === id ? (
      <GuidedPicker
        step={guidedStep}
        options={guidedList}
        highlight={guidedAt}
        hint={hint}
        optionTip={tip}
        canGoBack={pass.answered.length > 0}
        place={place}
        onPick={(index) => guidedTake(index)}
      />
    ) : null;

  // Read the harness defaults so the model and effort pickers can name what "Default"
  // means. Keyed on `harnessesRevision` as well as the mount, so a default changed in
  // Settings is renamed here WHILE THIS MODAL IS OPEN. Previously this rode the mount-only
  // effect below, and a modal left open went on offering "Default - Opus 5" after the
  // operator had moved the default to something else - the dispatch used the new value, so
  // the label was the only thing that lied, which is the worse failure of the two.
  useEffect(() => {
    let alive = true;
    void fetchHarnessesConfig().then((cfg) => {
      if (alive && cfg) setDefaults(cfg);
    });
    return () => {
      alive = false;
    };
  }, [harnessesRevision]);

  // Index the workspace's repos so the base can be searched/picked.
  // Re-fetched on every open so a freshly-cloned repo shows up without a full app reload.
  useEffect(() => {
    let alive = true;
    void fetchRepos().then((list) => {
      if (!alive) return;
      setRepos(list);
      setReposLoading(false);
    });
    void fetchPipelineRepos().then((answer) => {
      if (!alive) return;
      setPipelineRepos(new Set((answer?.repos ?? []).map((repo) => repo.repoRoot)));
    });
    void workflowRequest<WorkflowConfig>("/api/workflows/config")
      .then((config) => {
        if (alive) setWorkflowConfig(config);
      })
      .catch(() => {});
    // Asked on every open, never cached, because the answer changes when the operator
    // repairs their own machine - they run the setup a warning names, reopen the form, and
    // the note is gone. A read taken once at load would go on naming a problem they have
    // already fixed, which is the fastest way to teach someone to ignore a warning.
    void fetchEnvironmentChecks().then((view) => {
      if (!alive) return;
      // A read that did not land is reported as "nothing to warn about", never as the last
      // answer. Those two are indistinguishable by design (see the state above), and this
      // assignment is what makes that true HERE rather than only as a consequence of
      // `DispatchLayer` unmounting the modal on close - which is where it currently comes
      // from, and is not a property this callback should have to rely on. A note the daemon
      // can no longer vouch for is the one kind that could outlive the problem it named.
      setEnvWarnings(view ? view.checks.filter((check) => check.warning !== null) : []);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * What this task could be filed into, read once when the editor opens.
   *
   * Gated twice, and each gate removes a read that could tell nobody anything: a fresh
   * dispatch has no row to file, and a task that already carries a source renders its link
   * from the row it is over. A read that does not land leaves this `null` rather than `[]` -
   * see `PushToSourceBlock`, where those two states print different sentences.
   *
   * Here rather than lifted to `App`, like every other open-scoped read this form does: the
   * answer is only ever rendered inside this dialog, it changes when the operator edits
   * Settings (which no server event announces), and asking on each open is what makes a source
   * added five seconds ago usable without a reload.
   *
   * Keyed on the task's id as well as on whether it needs asking, so that a form which shows a
   * DIFFERENT task without remounting still re-reads. Nothing stale can be rendered in the
   * meantime - the list is global and the filter is applied per render - but a list read for
   * yesterday's opening should not be the last word on today's.
   */
  const editingId = editing?.id ?? null;
  const unlinkedEdit = editing !== null && editing.source === null;
  useEffect(() => {
    if (!unlinkedEdit) return;
    let alive = true;
    void fetchTaskSources().then((view) => {
      if (alive && view) setTaskSources(view.sources);
    });
    return () => {
      alive = false;
    };
  }, [editingId, unlinkedEdit]);

  /**
   * The push state, but only if it is THIS task's.
   *
   * The read that makes the tag worth carrying. Everything below - the link, the picker's
   * selection, the error, the withdrawn button - comes through here, so a state object left
   * over from another task is not merely unlikely to be rendered, it cannot be.
   */
  const push = editing && pushState?.taskId === editing.id ? pushState : null;
  // The link this form should draw: the row's own, or the one this opening just created.
  const taskLink = editing?.source ?? push?.ref ?? null;
  /**
   * The form holds edits the daemon has not been told about.
   *
   * Load-bearing for the push, not only for Revert: the issue is composed by the DAEMON from
   * the stored row, so pushing over an unsaved title publishes the old one to a place that
   * cannot be edited from here. Disabled with a tooltip that says which order to do it in,
   * rather than silently pushing something the operator can see is not what is on screen.
   */
  const editDirty = editing !== null && !draftsEqual(draft, draftFromTask(editing));

  /**
   * File this task upstream, through the source the block has selected.
   *
   * The one action in this form that PUBLISHES, which is why it folds into `pending` like the
   * others: `busy` seals all four dismiss routes (`closable={!busy}`), so a modal cannot be
   * escaped out from under a `gh issue create` that is still running and take the only thing
   * that can report what happened with it.
   *
   * Both failures are kept apart exactly as the route sends them. A 502 published nothing, so
   * the button stays and the error sits beside it; a 504 may have published, so the button is
   * withdrawn for this opening and the sentence tells the operator to look before retrying.
   */
  async function pushToSource(): Promise<void> {
    if (!editing || busy) return;
    const eligible = eligiblePushSources(taskSources ?? [], editing.repoRoot);
    const chosen = eligible.find((s) => s.id === push?.sourceId) ?? eligible[0];
    if (!chosen) return;
    // Captured, not re-read after the await. Every write below is tagged with the task this
    // push was FOR, so an answer that arrives late lands on that task or on nothing - the same
    // reconciliation `onSubmitted` does against the draft, for the same reason.
    const taskId = editing.id;
    const answered = (patch: Partial<PushState>): void =>
      setPushState({ ...freshPushState(taskId), sourceId: chosen.id, ...patch });
    setPending("push");
    answered({});
    const r = await api.pushTaskToSource(taskId, chosen.id);
    setPending(null);
    if (r.ok && r.source) {
      answered({ ref: r.source });
      return;
    }
    // An accepted push that names nothing cannot be told from a created issue we failed to
    // read, so it takes the cautious reading rather than the convenient one. This is the
    // route's contract being violated, not a state it can reach - and the direction to fail in
    // is the one where nobody files a duplicate.
    answered({
      outcomeUnknown: r.ok || Boolean(r.outcomeUnknown),
      error: r.ok
        ? "the push was accepted but the daemon did not name the issue it created - check GitHub before retrying"
        : r.error ?? "could not create the issue",
    });
  }

  // Put the form back where it started without closing: every close path preserves
  // what's typed, so this is the one way to abandon it. For a new dispatch that means
  // a form as freshly opened - blank but for the seeded repo, which is where "start
  // again" starts; for an edit it means the task as the daemon still holds it, which
  // is the only "start again" an edit has.
  function clearDraft(): void {
    revokeAttachments(draft.attachments);
    onRevert();
    setError(null);
    // A pass is part of how a guided dispatch OPENED, so putting the form back where it
    // started puts the questions back too - whether or not one is still on screen. Asking
    // `guidedApplies` rather than `guidedRunning` is the whole point: the two agree until the
    // pass hands over, and after that `guidedRunning` is false while the preference is still
    // on, so Clear on a finished guided dispatch would blank the draft and leave the operator
    // in the plain form - which is the one thing Clear is not for.
    //
    // Mid-pass it also un-strands the keyboard. Answering Kind alone is enough to enable this
    // button, and the focus call below would put the caret in the task box with the strip
    // still up - where `handleGuidedKey` stands down for a text field, so every remaining key
    // would type instead of answering.
    setPass(guidedApplies ? startGuidedPass() : null);
    if (guidedApplies) {
      setHighlight(null);
      return;
    }
    intentRef.current?.focus();
  }

  /**
   * Throw the task away - the same `DELETE /api/tasks/:id` the Sitrep row calls, offered
   * where the task is actually read.
   *
   * Edit mode only, and the button that reaches this is not rendered otherwise: there is no
   * row behind a new dispatch to delete, and a Delete beside "Add to backlog" would read as
   * an offer to discard the form.
   *
   * No confirm, deliberately, because the Sitrep's has none and two dialogs asking the same
   * question in two places is how they drift. Reaching this already took opening the card.
   *
   * The card leaves every surface at once on the daemon's `task_remove`, so this closes
   * rather than trying to reconcile a form over a row that is gone. A REFUSAL - a task that
   * went `running` under the open modal, a worktree that would not reclaim - keeps the modal
   * up with the reason printed where every other refusal from this form is printed, because
   * the task still exists and the operator's next move is still about it.
   */
  async function remove(): Promise<void> {
    if (!editing || busy) return;
    setPending("delete");
    setError(null);
    const r = await api.deleteTask(editing.id);
    setPending(null);
    if (!r.ok) setError(r.error ?? "could not delete the task");
    else (onDeleted ?? onClose)();
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
      repoSetBlocked ||
      kindUnavailable ||
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
          extraRepoRoots: attachedRepoRoots(submitted),
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
    if (r.ok && !editing) {
      rememberDispatchRepo(submitted.repoRoot.trim());
    }
    // Clear the draft and close only once the task row exists - the worktree and
    // terminal home are provisioned in the background after this reply, and any
    // failure there surfaces on the task card rather than here. A rejected submit
    // keeps the modal open with the fields intact so you can retry.
    if (!r.ok) setError(r.error ?? (editing ? "could not save the task" : "dispatch failed"));
    else if (launched && !launched.ok) setError(`saved, but ${launched.error ?? "could not dispatch"}`);
    else onSubmitted(submitted);
  }

  submitRef.current = submit;
  const onOverlayEscape = useCallback((event: KeyboardEvent): boolean => {
    if (!guidedRunning) return false;
    event.preventDefault();
    guidedLeave();
    return true;
  }, [guidedLeave, guidedRunning]);

  const onOverlayKeyDown = useCallback((event: KeyboardEvent): void => {
    // The guided pass gets first refusal, and refuses every modifier chord - so ⌘↵ below
    // still dispatches from inside a pass, which is the one shortcut that has to keep
    // working while the questions are up.
    if (guidedKeyRef.current(event)) return;
    // This is the dialog's primary action, not a textarea editing command. Keeping it on
    // the topmost overlay makes it work after the operator moves through Crew, Backlog
    // details, or the footer, while Overlay's stack still prevents a covered dialog from
    // acting. Ensemble keeps its deliberate Review-then-Launch flow.
    if (
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey) ||
      ensembleMode
    ) return;
    event.preventDefault();
    void submitRef.current(true);
  }, [ensembleMode]);

  // The brief - repo, title, task - is shared by both modes but arranged differently:
  // Single leads repo-then-task with the title folded into Backlog details, Ensemble puts
  // repo and title side by side above the shared composer. One JSX definition each, so the
  // two arrangements cannot drift apart in behavior.
  const repoField = (
    <label className={`field${guidedDimUnless("repo")}`}>
      <span className="field-label">
        Repo{" "}
        {/* The question rides in the field's own hint slot, which is the one place on this
            field a question can go. Below the input is where `RepoCombobox` portals its list,
            so a question drawn there would be covered by the answers to it; above the input
            would insert a row and move every field under it, and a pass that reflows the form
            it is about to hand over is the one thing this interaction promises not to do.
            Same slot, same line, a different sentence while the question stands. */}
        {guidedStep?.id === "repo" ? (
          <span className="dispatch-guided-ask">
            {guidedStep.question} <kbd>↑↓</kbd> <kbd>↵</kbd> <kbd>⇥</kbd>
          </span>
        ) : (
          <span className="field-hint">
            {reposLoading
              ? "indexing workspace…"
              : `${repos.length} repo${repos.length === 1 ? "" : "s"} found - type to filter`}
          </span>
        )}
      </span>
      <RepoCombobox
        repos={repos}
        value={draft.repoRoot}
        inputRef={repoInputRef}
        onChange={(v) => update({ repoRoot: v })}
        // Taking a row from the list ANSWERS the Repo question, by the rule the other three
        // steps already keep: a question answered through its own control moves the pass on,
        // rather than leaving it parked over a form that has already moved. Inert unless that
        // question is the live one.
        onPick={() => answerGuidedRepo()}
        // And dismissing the list ENDS the pass, on the press the dialog never sees.
        onEscape={() => guidedRepoEscaped()}
      />
      {/* Attached secondary repos. The primary above stays exactly what it was - its own
          combobox, its own value - rather than becoming the first of a list of chips: it
          is the session's working directory and the task's repo everywhere else in the
          app, and demoting it to "chip one" would make the one field every single-repo
          dispatch fills in a different control for the sake of a case most tasks never
          reach. The chips are strictly additive, and absent entirely for a harness that
          cannot be granted write access beyond its cwd. */}
      {repoChipsShown && (
        // Dimmed and inert while the Repo QUESTION is up, even though the field around them is
        // the one thing on the form that is lit. The question is which repo this task is for,
        // and multi-repo is a form control the pass has no opinion about: left live under a lit
        // field it reads as part of the question, and clicking it puts the caret in a second
        // combobox the pass cannot see, where ↵ answers nothing and the operator is stuck in a
        // question they cannot finish. They come back the moment the pass hands over. The other
        // three steps need no rule here - the whole field is dim for them.
        <div className={`repo-chips${guidedStep?.id === "repo" ? " dispatch-guided-dim" : ""}`}>
          {draft.extraRepoRoots.map((root, index) => (
            <span key={`${root}-${index}`} className="repo-chip">
              {/* The full path through the app's own tooltip, never a native `title` -
                  `tooltip-coverage.test.ts` enforces that, and it is what makes the
                  shortened chip readable without a browser-styled box. */}
              <RepositoryName path={root} className="repo-chip-name" />
              <Tooltip label="Detach this repo">
                <button
                  type="button"
                  className="dep-chip-x"
                  aria-label={`Detach repo: ${root}`}
                  onClick={() =>
                    update({
                      extraRepoRoots: draft.extraRepoRoots.filter((_, i) => i !== index),
                    })
                  }
                >
                  ✕
                </button>
              </Tooltip>
            </span>
          ))}
          {!multiRepoOffered ? null : addingRepo ? (
            <div className="repo-chip-add">
              <RepoCombobox
                repos={repos}
                value={addRepoValue}
                placeholder="repo to attach…"
                onChange={setAddRepoValue}
              />
              <Tooltip label="Attach this repo to the task">
                <button
                  type="button"
                  className="dep-add"
                  aria-label="Attach repo"
                  // Refuses the obviously redundant entry - the same path as the primary, or
                  // one already attached. Deliberately STRING equality and nothing cleverer:
                  // only the daemon resolves a path to a repo's main checkout, so it stays
                  // the one authority on whether two spellings are one repo, and a second
                  // half-implementation of that rule here would be a source of truth that
                  // could disagree with it.
                  disabled={
                    !addRepoValue.trim()
                    || addRepoValue.trim() === draft.repoRoot.trim()
                    || draft.extraRepoRoots.includes(addRepoValue.trim())
                  }
                  onClick={() => {
                    update({ extraRepoRoots: [...draft.extraRepoRoots, addRepoValue.trim()] });
                    setAddRepoValue("");
                    setAddingRepo(false);
                  }}
                >
                  Attach
                </button>
              </Tooltip>
            </div>
          ) : (
            <Tooltip label="Work across several repos in one session - each changed repo gets its own PR">
              <button
                type="button"
                className="dep-add"
                aria-label="Add another repo"
                onClick={() => setAddingRepo(true)}
              >
                + Add another repo
              </button>
            </Tooltip>
          )}
        </div>
      )}
      {draft.extraRepoRoots.length > 0 && multiRepoOffered && (
        <span className="field-hint">
          One session, one worktree per repo. Each repo you change gets its own pull request.
        </span>
      )}
      {/* Refused rather than silently dropped, which is what the equivalent workflow gate
          above this form does and for the same reason: sending the dispatch minus the repos
          the operator attached would launch a session that quietly does less than they
          asked for. The submit is blocked; this sentence says why. */}
      {multiRepoBlocked && (
        <span className="dispatch-workflow-warning">
          {draft.agent} cannot be given write access beyond one repo. Detach the{" "}
          {draft.extraRepoRoots.length === 1 ? "attached repo" : "attached repos"} or choose
          a harness that can.
        </span>
      )}
      {collidingRepo !== null && (
        <span className="dispatch-workflow-warning">
          <RepositoryName path={collidingRepo} /> is named twice. Detach it, or point the Repo
          field at a different repo.
        </span>
      )}
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
    <label className={`field${guidedDim}`}>
      <span className="field-label">
        Task{" "}
        <span className="field-hint">
          {ensembleMode
            ? "every candidate gets this brief - drop or paste images to attach"
            : "drop or paste images to attach them"}
        </span>
      </span>
      <div className="drop-zone" {...(guidedRunning ? {} : drop.dropProps)}>
        <textarea
          ref={intentRef}
          className="field-input field-textarea"
          placeholder="What should this agent do?"
          rows={5}
          value={draft.intent}
          onChange={(e) => update({ intent: e.target.value })}
          onPaste={drop.onPaste}
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
      className={`modal dispatch-modal${ensembleMode ? " dispatch-modal-ensemble" : ""}${
        guidedRunning ? " dispatch-modal-guided" : ""
      }`}
      role="dialog"
      ariaLabel={editing ? "Edit a backlog task" : "Dispatch an agent"}
      onEscape={onOverlayEscape}
      onKeyDown={onOverlayKeyDown}
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
        {/* The preference, beside the launch mode and for its reason: both are properties of
            the dialog rather than fields in it. Turning it ON starts a pass here and now -
            arming one for the NEXT opening is a switch that appears to do nothing, which is
            a switch nobody flips twice.
            Offered exactly where that is true, off the SAME predicate the pass itself reads,
            so the two cannot drift: absent on an edit, whose answers already exist, and
            absent in Ensemble, which replaces Crew and After work outright - a switch
            offering to ask about controls that are not on screen is the inert switch that
            sentence is about. Settings is the durable home for it either way (phase 3). */}
        {guidedOfferable && (
          <GuidedToggle
            on={guided}
            onChange={(next) => {
              setGuided(next);
              setHighlight(null);
              // Asked about the value being written, not the one being replaced.
              setPass(guidedAppliesWith(next) ? startGuidedPass() : endGuidedPass(pass));
            }}
          />
        )}
        <Tooltip
          label={
            busy
              ? "Waiting for the dispatch to land"
              : guidedRunning
                ? "Close without dispatching"
                : "Close without dispatching (Escape)"
          }
        >
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </Tooltip>
      </header>

      {guidedRunning && (
        <GuidedRail
          pass={pass}
          answers={guidedAnswers}
          onJump={(id) => {
            setPass(jumpToGuidedStep(pass, id));
            setHighlight(null);
          }}
        />
      )}

      <div className="dispatch-body">
        {editing?.scheduleId && (
          <div className="rm-provenance-note">
            <span className="rm-provenance-text">
              <span aria-hidden>◷</span> Scheduled by a recurring mission
              {editing.scheduledFor != null
                ? ` for ${formatScheduledFor(editing.scheduledFor)}`
                : ""}
              . This origin is immutable and is not changed by saving.
              {/* Two provenances, and no longer a contradiction. This used to say "(conflict)"
                  because the only way a task could carry both was a bug - a schedule created
                  it, and a sweep somehow claimed it too. Now a scheduled task can be filed
                  upstream on purpose, so the second line is where it came to be, not evidence
                  that something went wrong.

                  Read from `taskLink`, the same value the block below draws, rather than from
                  `editing.source` directly: a scheduled task pushed in this opening gets its
                  link from the route's own reply, and `editing.source` does not catch up until
                  the `task_upsert` frame lands. Sourced separately, the two banners disagree
                  about the same fact for as long as that takes. */}
              {taskLink && " This task is also linked to an external item below."}
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
        {/* Beside the schedule's provenance rather than among the fields, because it is the
            same kind of fact: where this task stands in relation to something outside the
            form. Edit-only - a task that does not exist yet cannot be filed anywhere. */}
        {editing && (
          <PushToSourceBlock
            link={taskLink}
            sources={taskSources}
            /* The STORED repo, never `draft.repoRoot`: the daemon compares a source against
               the row it holds, so filtering on an unsaved edit would offer sources for a repo
               this task is not based on yet - and the push would be refused with a sentence
               about a mismatch the operator cannot see. */
            repoRoot={editing.repoRoot}
            selectedSourceId={push?.sourceId ?? null}
            onSelectSource={(id) =>
              setPushState({ ...(push ?? freshPushState(editing.id)), sourceId: id })
            }
            onPush={() => void pushToSource()}
            pushing={pending === "push"}
            dirty={editDirty}
            error={push?.error ?? null}
            outcomeUnknown={push?.outcomeUnknown ?? false}
          />
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
          <span className={`field-label${guidedDim}`}>Crew</span>
          <div className="dispatch-crew">
            {/* The cell exists so the guided pass's list can hang off the field WITHOUT
                being inside its `<label>`. A `<label>` names the control it wraps from its
                own text content, so a list rendered in there would rewrite the Agent
                select's accessible name to the whole question - and a click on the list's
                own chrome would be forwarded to the select and pop the native dropdown
                under it. Always rendered, so the grid's items do not change shape when a
                pass starts. */}
            <div className={`dispatch-crew-cell${guidedAnchor("harness")}`}>
              <label className={`field${guidedDimUnless("harness")}`}>
                <span className="field-label">Agent</span>
                <Tooltip label={AGENT_FIELD_TIP}>
                  <span
                    className="agent-accent-select"
                    style={{ ["--agent-accent" as string]: AGENT_IDENTITY[draft.agent].accent }}
                  >
                    <select
                      className="field-input"
                      value={draft.agent}
                      disabled={!usesHarness}
                      // Switching harness drops model and effort overrides with it: neither
                      // selection is portable across harnesses. Back to the defaults, which are
                      // per-agent and always right for the harness now chosen.
                      onChange={(e) => {
                        const agent = e.target.value as AgentType;
                        // While the pass is asking this question, using the control it is
                        // about answers it - the same write, and the pass moves on.
                        if (guidedTakeValue("harness", agent)) return;
                        update({ agent, ...overridesForAgent(agent) });
                      }}
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
              {guidedPickerFor("harness", AGENT_FIELD_TIP)}
            </div>
            <div className={`dispatch-crew-cell${guidedAnchor("kind")}`}>
              <label className={`field${guidedDimUnless("kind")}`}>
                <span className="field-label">Kind</span>
                <Tooltip label={KIND_FIELD_TIP}>
                  <select
                    className="field-input"
                    value={draft.kind}
                    onChange={(e) => {
                      const kind = e.target.value as TaskKind;
                      if (guidedTakeValue("kind", kind)) return;
                      update({ kind, ...afterWorkForKind(kind) });
                    }}
                  >
                    {/* Driven off the tuple for the reason the harness select above it is:
                        a hand-written pair goes stale silently, and the array's order is
                        the order every surface that offers the choice lists it in. */}
                    {offeredKinds.map((k) => (
                      <option
                        key={k}
                        value={k}
                        disabled={!kindAvailable(k) && k !== draft.kind}
                      >
                        {TASK_KIND_INFO[k].label}
                      </option>
                    ))}
                  </select>
                </Tooltip>
              </label>
              {guidedPickerFor("kind", KIND_FIELD_TIP)}
            </div>
            <label className={`field${guidedDim}`}>
              <span className="field-label">Model</span>
              <Tooltip label="Pin the model this task's agent launches with, overriding the harness default">
                <select
                  className="field-input"
                  value={draft.model}
                  disabled={!usesHarness}
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
            <label className={`field${guidedDim}`}>
              <span className="field-label">Effort</span>
              <Tooltip label="How much reasoning effort this task's agent spends, overriding the harness default">
                <select
                  className="field-input"
                  value={draft.effort}
                  disabled={!usesHarness}
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
          <span className={`field-hint dispatch-crew-hint${guidedDim}`}>
            {usesHarness
              ? "Defaults from Settings → Harnesses. Switching agent resets the model and effort overrides."
              : kindBehavior.constraint}
          </span>
          {kindUnavailable && (
            <span className={`dispatch-workflow-warning${guidedDim}`}>
              This kind is available only when conductor is enabled for the selected repository.
            </span>
          )}
        </div>

        {/* The completion handoff is a first-class dispatch choice, not backlog metadata:
            it changes what happens after the agent finishes rather than how the task is
            ranked. The rail shape makes that sequence legible without turning one select
            into another full-width card. */}
        {/* The lit/dim class goes on the rail rather than on the control inside it: an
            `opacity` on an ancestor cannot be undone by a descendant, and this whole block -
            mark, control and consequence - is what the After work question is about. The rail
            is also the pass's anchor, and already `position: relative`; the question hangs
            off it rather than off the `<label>` inside it, for the reason the crew cells
            above exist. An absolutely-positioned child takes no grid track. */}
        <div
          className={`dispatch-workflow${selectedWorkflowId ? " armed" : ""}${guidedDimUnless(
            "afterWork",
          )}${guidedAnchor("afterWork")}`}
        >
          <span className="dispatch-workflow-mark" aria-hidden>⌘</span>
          <label className="dispatch-workflow-control">
            <span className="field-label">After work</span>
            <Tooltip label={AFTER_WORK_FIELD_TIP}>
              <select
                className="field-input"
                disabled={!usesHarness}
                value={
                  draft.workflowId === undefined
                    ? "__default"
                    : draft.workflowId ?? "__none"
                }
                onChange={(event) => {
                  const value = event.target.value;
                  if (guidedTakeValue("afterWork", value)) return;
                  // Chosen by hand, so a later kind switch must not hand back what scout
                  // put aside and revert this underneath the operator.
                  stashedWorkflowId.current = NO_STASH;
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
          {/* The one question that says something the others do not have to: the row it
              opens on was moved by the answer before it, and a preselection nobody
              explained reads as the form having lost the operator's place.
              Named per kind rather than said generically, because the sentence is only
              worth reading if it names the kind the operator just chose - "a scout has no
              diff" answers "why did this move?" where "this kind has no diff" restates it.
              Opens UPWARD - this rail is the last field before the fold and the footer, and
              a list of every published Workflow hung below it leaves the panel entirely. */}
          {guidedPickerFor("afterWork", AFTER_WORK_FIELD_TIP, {
            hint: hasReviewableDiff(draft.kind)
              ? null
              : `A ${TASK_KIND_INFO[draft.kind].label} has no diff, so None is preselected.`,
            place: "above",
          })}
        </div>
        {selectedWorkflowBlocked && (
          <span className={`dispatch-workflow-warning${guidedDim}`}>
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
                className={`dispatch-more${detailsOpen ? " open" : ""}${guidedDim}`}
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
              <div className={`dispatch-more-body${guidedDim}`}>
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

        {/* What the MACHINE says about tooling this dispatch would inherit from `~/.claude`.
            Last in the body, so it is the final thing read before the buttons - and a note,
            never a gate: the footer below is untouched by it, because a stalled agent is a
            cost the operator may knowingly accept while a blocked Workflow is a task the
            daemon would have to refuse. Absent entirely on a machine no check recognises. */}
        {envWarnings.map((check) => (
          <p className="dispatch-wait-note dispatch-env-note" key={check.id}>
            <span aria-hidden>⚠</span>
            <span>
              <strong>{check.label}:</strong> {check.warning}
              {check.detail && <span className="dispatch-env-detail">{check.detail}</span>}
            </span>
          </p>
        ))}

        {error && <p className="dispatch-error">{error}</p>}
      </div>

      <footer className={`modal-foot${guidedDim}`}>
        {/* Leading edge, ahead of the verbs that keep the task, because it is the one action
            here that destroys something - and edit-only, because a new dispatch has no row
            behind it to delete. Ghost-danger rather than filled: it must be findable without
            competing with the primary, which is the same weight the Sitrep's Delete carries. */}
        {editing && (
          <Tooltip label="Delete this task from the backlog">
            <button
              // The same pair the Sitrep's Delete wears, and the same pair every other
              // destructive control in the app wears (ReportPanel, WorkflowRuns,
              // WorkflowLibrary, ActionBar): one class for the danger tone, none for the
              // frame. Deleting a backlog task should look like itself wherever it is
              // offered, so this deliberately does not get a bespoke weight for this footer.
              className="btn btn-danger-ghost"
              onClick={() => void remove()}
              disabled={busy}
            >
              {pending === "delete" ? "Deleting…" : "Delete"}
            </button>
          </Tooltip>
        )}
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
                || repoSetBlocked
                || kindUnavailable
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
              (ensembleMode ? false : editing ? !editDirty : isEmptyDispatchDraft(draft))
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
                repoSetBlocked ||
                kindUnavailable ||
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

/**
 * Where a backlog task meets the world outside Mission Control: the item it is linked to, or
 * the one action that creates one.
 *
 * Two things share this spot because they are two readings of one fact - `Task.source`, which
 * until now was persisted, swept into, and rendered nowhere. A task that arrived from a source
 * shows its link here with no fetch and no click; a task that was written here offers to
 * become such an item. The states are exclusive by construction rather than by CSS, and the
 * order below is the priority: a linked task is never also offered the button, because the
 * daemon would refuse the second push and the operator should not have to learn that by
 * pressing it.
 *
 * Deliberately pure and exported: it renders from props alone, so
 * `test/backlog-edit-render.test.ts` can put it in each of its states without a daemon, and a
 * later surface that wants to show a task's source (a board card, a Sitrep row) reuses this
 * rendering rather than inventing a second one that drifts.
 *
 * The wording of the linked state names no tracker, and that is not vagueness - `Task.source`
 * is also what a JIRA sweep writes, and this block is the first place any of them is drawn.
 * The external id it prints ("acme/demo-repo#123", "MC-14") already says which world it came
 * from, and says it truthfully for a kind that cannot receive pushes at all.
 */
export function PushToSourceBlock({
  link,
  sources,
  repoRoot,
  selectedSourceId = null,
  onSelectSource,
  onPush,
  pushing = false,
  dirty = false,
  error = null,
  outcomeUnknown = false,
}: {
  /** The item this task is linked to - stored on the row, or minted by a push in this opening. */
  link: TaskSourceRef | null;
  /**
   * The configured sources, or null while the read is out - AND if it never landed.
   *
   * Those two really are the same state here. "We could not ask the daemon" and "you have no
   * source for this repo" are different sentences, and only the second one is safe to print:
   * a failed read that rendered the Settings hint would tell an operator to go and configure a
   * source they may already have.
   */
  sources: TaskSourceInstance[] | null;
  /** The task's STORED repo, which is the value the daemon compares a source against. */
  repoRoot: string;
  /** Which eligible source the operator picked. Null takes the first. */
  selectedSourceId?: string | null;
  onSelectSource?: (id: string) => void;
  onPush?: () => void;
  /** A push is in flight. Folded into the modal's `busy`, which seals every dismiss route. */
  pushing?: boolean;
  /** The form holds unsaved edits, so the item would carry text the daemon does not have. */
  dirty?: boolean;
  /** The daemon's own refusal, rendered verbatim. */
  error?: string | null;
  /** The 504: the item MAY exist, so the action is withdrawn rather than offered again. */
  outcomeUnknown?: boolean;
}): React.JSX.Element | null {
  if (link) {
    return (
      <div className="rm-provenance-note source-provenance-note">
        <span className="rm-provenance-text">
          <span aria-hidden>↗</span> Filed upstream as{" "}
          {link.url ? (
            <Tooltip label={`Open ${link.externalId} in a new tab`}>
              <a
                className="source-provenance-link"
                href={link.url}
                target="_blank"
                rel="noreferrer"
              >
                {link.externalId}
              </a>
            </Tooltip>
          ) : (
            /* A kind with no URL for its items. The id is still the whole identity, so it is
               shown as text rather than as a link to nowhere. */
            <strong>{link.externalId}</strong>
          )}
          . This task stays in the backlog, and that source will not file it back as a new one.
        </span>
      </div>
    );
  }
  // Nothing at all until the read lands: a button that appears a beat after the form does is
  // a button the operator's cursor is already moving past.
  if (sources === null) return null;

  const eligible = eligiblePushSources(sources, repoRoot);
  if (eligible.length === 0) {
    return (
      // A muted line rather than the banner the other two states wear, deliberately: this is
      // the state EVERY task is in on a machine with no GitHub source configured, and a
      // bordered box at the top of every editor would be permanent chrome advertising a
      // feature nobody here uses. Said at all, because the reason the action is missing is
      // something the operator can fix in about a minute - and an action that appears on some
      // tasks and not others, with no explanation, reads as a bug.
      <p className="source-provenance-hint">
        <span aria-hidden>↗</span> To create a GitHub issue from this task, add a GitHub
        Issues task source for this repo in Settings.
      </p>
    );
  }

  const selected = eligible.find((s) => s.id === selectedSourceId) ?? eligible[0];
  if (!selected) return null;
  const name = sourceName(selected);
  // An unknown outcome always carries the daemon's own sentence; the fallback exists so that
  // withdrawing the button is never unexplained, which would read as the action vanishing.
  const failure =
    error ??
    (outcomeUnknown
      ? "the push did not report back - the issue may already exist; check GitHub before retrying"
      : null);
  return (
    <div className="rm-provenance-note source-provenance-note">
      <span className="rm-provenance-text">
        {/* "any labels" rather than "the labels": a source with an empty filter is a valid
            source, and it files an issue carrying none. The sentence has to be true of both.
            The source's name is quoted because it is an arbitrary string in the middle of a
            sentence - unquoted, "any labels mission-control bugs filters on" reads as prose
            that has lost a word. */}
        <span aria-hidden>↗</span> Not filed in an external tracker. The issue carries this
        task's saved title and text, plus any labels &ldquo;{name}&rdquo; filters on.
        {failure && (
          // The refusal wears `dispatch-error` as well as its own layout class, so the two
          // refusals this form can print - a failed save at the foot of the body, a failed push
          // here - are the same red by construction rather than by two rules agreeing.
          <span
            className={
              outcomeUnknown
                ? "source-provenance-warn"
                : "dispatch-error source-provenance-error"
            }
          >
            <span aria-hidden>{outcomeUnknown ? "⚠" : "✕"}</span> {failure}
          </span>
        )}
      </span>
      {/* One source needs no picker - a select of one is a control that cannot be used. */}
      {eligible.length > 1 && (
        <Tooltip label="Which configured source files the issue - they may point at different repositories or sweep different labels">
          <select
            className="field-input source-provenance-pick"
            aria-label="GitHub issue source"
            value={selected.id}
            onChange={(e) => onSelectSource?.(e.target.value)}
            disabled={pushing}
          >
            {eligible.map((s) => (
              <option key={s.id} value={s.id}>
                {sourceName(s)}
              </option>
            ))}
          </select>
        </Tooltip>
      )}
      {/* Withdrawn, not merely disabled, when the outcome is unknown. A disabled button is a
          promise that something will re-enable it; here the correct next move is to go and
          look at GitHub, and pressing this again is the one thing that could file a duplicate.
          A refusal is the opposite case - nothing was published, so the button stays live. */}
      {!outcomeUnknown && (
        <Tooltip
          label={
            dirty
              ? "Save your changes first - the issue carries the task's saved title and intent"
              : `File this task as a GitHub issue through "${name}" - it carries the task's title, its text, and any labels that source filters on`
          }
        >
          <button className="btn" type="button" onClick={onPush} disabled={pushing || dirty}>
            {pushing ? "Creating issue…" : "Create GitHub issue"}
          </button>
        </Tooltip>
      )}
    </div>
  );
}
