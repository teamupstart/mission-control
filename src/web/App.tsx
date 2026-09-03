import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_TYPES,
  type KeepAwakeStatus,
  type RestoringSession,
  type Session,
  type Task,
} from "@shared/types.ts";
import { agentList } from "@shared/agent.ts";
import {
  backlogTasks,
  canCycleMode,
  canInterruptSession,
  provisioningTasks,
  sessionWorkspaceRoot,
} from "@shared/session.ts";
import { agentLaunchAction } from "@shared/session-launch.ts";
import { api, fetchRepos } from "./lib/api.ts";
import { useEventStream } from "./useEventStream.ts";
import { fitTopbar, observeTopbar } from "./topbarLadder.ts";
import type { ActionBarHandle } from "./components/ActionBar.tsx";
import type { SessionLaunchersHandle } from "./components/LaunchMenu.tsx";
import type { TranscriptFindHandle } from "./components/TranscriptPanel.tsx";
import { ReviewModal } from "./components/ReviewModal.tsx";
import { AttentionInbox } from "./components/AttentionInbox.tsx";
import { DispatchLayer } from "./components/DispatchModal.tsx";
import { ProductIssueLayer } from "./components/ProductIssueModal.tsx";
import { ResetModal } from "./components/ResetModal.tsx";
import { CompleteModal } from "./components/CompleteModal.tsx";
import { KillModal } from "./components/KillModal.tsx";
import { ReportPanel } from "./components/ReportPanel.tsx";
import { RecurringMissionsPanel } from "./components/RecurringMissionsPanel.tsx";
import { AwayDigestCard } from "./components/AwayDigestCard.tsx";
import { AlertBar } from "./components/AlertBar.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import {
  DEFAULT_SETTINGS_CATEGORY,
  type SettingsCategoryId,
} from "./lib/settings-registry.ts";
import { settingsGearDot } from "./lib/settings-dots.ts";
import { ForemanBar } from "./components/ForemanBar.tsx";
import { SpendChip } from "./components/SpendChip.tsx";
import { KeepAwakeControl } from "./components/KeepAwakeControl.tsx";
import { ShipLogPage } from "./components/ShipLogPage.tsx";
import { ScoutsPage } from "./components/scouts/ScoutsPage.tsx";
import { LineStrip } from "./components/LineStrip.tsx";
import { ReviewDrawer } from "./components/line/ReviewDrawer.tsx";
import { DecideDrawer } from "./components/line/DecideDrawer.tsx";
import { IntakeDrawer } from "./components/line/IntakeDrawer.tsx";
import { BacklogDrawer } from "./components/line/BacklogDrawer.tsx";
import { ShippedDrawer } from "./components/line/ShippedDrawer.tsx";
import { LINE_STAGE_TARGETS } from "./lib/line-targets.ts";
import { nextLineDrawer, type LineDrawerStage } from "./lib/line-drawer.ts";
import type { LineStageId } from "@shared/line.ts";
import { Keycap } from "./components/Keycap.tsx";
import { Tooltip } from "./components/Tooltip.tsx";
import { ConsoleView } from "./components/layouts/ConsoleView.tsx";
import { BoardView } from "./components/layouts/BoardView.tsx";
import type {
  SessionViewProps,
  WorkflowDisclosureHandle,
} from "./components/layouts/types.ts";
import { dropMessageDrafts } from "./lib/drafts.ts";
import { dropHistory } from "./lib/transcript-history.ts";
import { useNotifier } from "./useNotifier.ts";
import { useForeman } from "./useForeman.ts";
import { useCost } from "./useCost.ts";
import { useLlm } from "./useLlm.ts";
import { useAlertSettings } from "./lib/alertSettings.ts";
import { useAwayMode } from "./lib/awayMode.ts";
import { useStalls } from "./lib/stalls.ts";
import { detailLayer, useLayoutMode, type LayoutMode } from "./lib/layout.ts";
import { toggleLineDensity, useLineDensity } from "./lib/line-density.ts";
import { moveSelection, type ArrowKey } from "./lib/layoutNav.ts";
import { conversationReveal } from "./lib/conversationReveal.ts";
import { orderSessions } from "./lib/fleet-order.ts";
import { useUiConfig } from "./lib/uiConfig.ts";
import { hiddenSessionIds, useRepoCollapsed } from "./lib/repo-collapse.ts";
import { reviewShortcutTarget } from "./lib/review-shortcut.ts";
import { heldSessionIds, ownBindingBySession } from "./lib/held.ts";
import { foldAttention } from "./lib/attention.ts";
import {
  useKeybindingHints,
  useKeybindings,
  chordFromEvent,
  chordHasCommandModifier,
  chordUsesFunctionKey,
  chordYieldsToSelection,
  formatChord,
  isTypingTarget,
} from "./lib/keybindings.ts";
import type { ActionId } from "./lib/keybindings.ts";
import { canRenameSession, stateDisplay, type Tone } from "./lib/format.ts";
import { matchesSessionFilter } from "./lib/fleet-filter.ts";
import type { BacklogTrustView } from "./lib/backlog-copy.ts";
import { clearInterrupting, markInterrupting } from "./lib/interrupting.ts";
import {
  OverlayHost,
  OverlayRegistration,
  OVERLAY_IDS,
  useOverlayHost,
} from "./components/Overlay.tsx";
import { FileWindow } from "./components/FileWindow.tsx";
import { FilePicker } from "./components/FilePicker.tsx";
import { useSessionFilesStore } from "./lib/sessionFiles.ts";
import { workspaceFileTarget } from "./lib/workspaceLinks.ts";
import { WorkflowRuns } from "./workflows/WorkflowRuns.tsx";
import { EnsembleRuns } from "./workflows/EnsembleRuns.tsx";
import {
  pageShortcutRoute,
  pipelineRunRoute,
  useWorkflowRoute,
} from "./workflows/useWorkflowRoute.ts";
import type { LibrarySurface, MissionRoute } from "./workflows/useWorkflowRoute.ts";
import { PipelineRuns } from "./pipelines/PipelineRuns.tsx";
import { RunsKindTabs, type RunsKind } from "./pipelines/RunsKindTabs.tsx";
import { pipelineRunKeyOf, type PipelineRun } from "@shared/pipeline.ts";
import { LibraryPage } from "./library/LibraryPage.tsx";
import type { EnsembleStrategyId } from "@shared/ensemble.ts";
import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "@shared/builtin-workflow.ts";
import { PersonaLibrary } from "./workflows/PersonaLibrary.tsx";
import { personaDriftSurface, usePersonaDrift } from "./workflows/usePersonaDrift.ts";
import { SessionActionLibrary } from "./workflows/SessionActionLibrary.tsx";
import { CommandLibrary } from "./workflows/CommandLibrary.tsx";
import { WorkflowLibrary } from "./workflows/WorkflowLibrary.tsx";
import { AppPageShell } from "./components/AppPageShell.tsx";
import { ExecutionPage } from "./workflows/ExecutionPage.tsx";
import { WorkflowConfirmModal } from "./workflows/WorkflowConfirmModal.tsx";
import {
  WorkflowBindingDialogHost,
  type WorkflowBindingTarget,
} from "./workflows/WorkflowBindingDialog.tsx";
import { Palette } from "./components/Palette.tsx";
import { ContextMenuHost, type ContextMenuHandle } from "./components/ContextMenu.tsx";
import type { PaletteStores, PaletteTarget } from "./lib/palette-index.ts";
import { buildSettingsBindings } from "./lib/settings-search.ts";
import { useRichText } from "./lib/rich-text.ts";
import { useDesktopUpdates } from "./useDesktopUpdates.ts";
import { UpdateBanner } from "./components/UpdateBanner.tsx";
import { SettingsRestoredBanner } from "./components/SettingsRestoredBanner.tsx";
import { SetupBanner } from "./components/SetupBanner.tsx";
import { useSetupChecks } from "./useSetupChecks.ts";
import { useGuidedDispatch } from "./lib/guided-dispatch.ts";
import { activateDeleteShortcut, deleteShortcutMatchesChord } from "./lib/delete-shortcut.ts";
import { GuidedTourController } from "./tour/GuidedTourController.tsx";
import { useGuidedTour } from "./lib/guided-tour.ts";
import type { TourId } from "./tour/contracts.ts";
import { TOUR_DEFINITIONS } from "./tour/definitions.ts";
import { tourEntry } from "./tour/entries.ts";
import {
  SEE_WORK_TOUR,
  type SeeWorkTourNavigation,
  type SeeWorkTourRuntime,
} from "./tour/tours/see-work.ts";
import {
  LIBRARY_TOUR,
  LIBRARY_TOUR_COMMAND_SLOT,
  selectLibraryTourRun,
  type LibraryTourNavigation,
  type LibraryTourRun,
  type LibraryTourRuntime,
} from "./tour/tours/library.ts";
import { SETUP_TOUR, type SetupTourNavigation } from "./tour/tours/setup.ts";
import { createTourTargetRegistry } from "./tour/target-registry.ts";
import { TourTargetHost, useOwnedTourTargetRef } from "./tour/target-context.tsx";
import {
  captureFocusBookmark,
  restoreFocusBookmark,
  type FocusBookmark,
} from "./tour/focus-containment.ts";

/**
 * The chords that act through the selected session's action bar, and the method each
 * one calls on it.
 *
 * A table rather than a chain of `else if`s because the board has to be able to NAME the
 * action it is deferring, not just perform it: its overview draws no action bar, so the
 * chord opens the drill-in first and the bar that mounts with it runs this. A sixth entry
 * is a row here; nothing else changes.
 */
const BAR_ACTIONS: readonly (readonly [ActionId, keyof ActionBarHandle])[] = [
  ["send", "startSend"],
  ["focus", "focusPane"],
  ["handoff", "handoff"],
  ["queue", "toggleQueue"],
  ["mode", "cycleMode"],
  ["interrupt", "requestInterrupt"],
  ["complete", "requestComplete"],
  ["kill", "requestKill"],
];

/** The two conversation-toolbar controls driven by selection shortcuts. */
const LAUNCHER_ACTIONS: readonly (
  readonly [ActionId, keyof SessionLaunchersHandle]
)[] = [
  ["terminal", "openTerminal"],
  ["agent", "openAgent"],
];

/**
 * What the worst-of settings dot on the gear is telling you, so its meaning reaches the
 * button's tooltip and label rather than living in the colour alone.
 */
function gearDotPhrase(tone: ReturnType<typeof settingsGearDot>): string | null {
  switch (tone) {
    case "failing":
      return "a task source failed its last sweep";
    case "armed":
      return "YOLO mode is armed";
    case "live":
      return "GitHub Inspector is live";
    // Foreman's purple never reaches the gear; the gear ranks only settingsStatus facts.
    case "foreman":
    case null:
      return null;
  }
}

/** The topbar's primary pages, in reading order, with one direct shortcut each. */
const PAGE_SEGMENTS = [
  {
    id: "fleet",
    action: "fleet",
    label: "Fleet",
    glyph: "▦",
    hint: "The fleet of running sessions, their tasks and their reviews",
  },
  {
    id: "library",
    action: "workflows",
    label: "Library",
    glyph: "⌗",
    hint: "The Library - workflows, Personas, actions, ensemble strategies and intake",
  },
  {
    id: "runs",
    action: "runs",
    label: "Runs",
    glyph: "▷",
    hint: "Workflow Runs - live and finished workflow reviews",
  },
  {
    id: "scouts",
    action: "scouts",
    label: "Scouts",
    glyph: "⌖",
    hint: "Scouts - finished investigations and the evidence they kept",
  },
] as const satisfies readonly {
  id: "fleet" | "library" | "runs" | "scouts";
  action: ActionId;
  label: string;
  glyph: string;
  hint: string;
}[];

/**
 * Everything a tour moves and therefore owes back.
 *
 * The complete `MissionRoute` is the authority - it already carries the Library shelf and the
 * asset a surface has open - so a tour that navigates anywhere is restored by replaying one
 * value rather than by a per-tour list of fields to put back.
 */
interface TourSnapshot {
  route: MissionRoute;
  layout: LayoutMode;
  selectedId: string | null;
  boardOpen: boolean;
  filter: string;
  lineDrawer: LineDrawerStage | null;
}

/** The one active tour run. Which tour it is lives in `tourId`, never in a second state slot. */
interface TourRun {
  id: string;
  tourId: TourId;
  snapshot: TourSnapshot;
  /** A resource the starting tour picked out for itself, such as a session to open on. */
  sessionId: string | null;
  focus: FocusBookmark;
}

/**
 * What App supplies for one tour.
 *
 * `mount` is a plain factory rather than a runtime/navigator pair so each tour keeps its own
 * `Runtime` and `Navigation` types all the way to the controller. Generic tour code holds a
 * `TourBinding` without ever naming a concrete tour, and without a cast that would let a
 * definition meet a runtime it was not written against.
 */
interface TourBinding {
  /** The task this run created, so its task-scoped targets can pick their one owner. */
  activeTaskId: string | null;
  /** The run this tour singled out, so its run-scoped targets can pick their one owner. */
  activeRunId: string | null;
  /** Reclaim everything the run created. Throwing leaves the run installed and retryable. */
  cleanup: () => Promise<void>;
  /** Null while this tour is not ready to be driven yet. */
  mount: (props: { isTop: boolean; onFinish: () => Promise<void> }) => React.JSX.Element | null;
}

export function App(): React.JSX.Element {
  const desktopUpdates = useDesktopUpdates();
  const {
    sessions,
    restoringSessions,
    reviews,
    tasks,
    personas,
    sessionActions,
    workflowCommands,
    workflowSummaries,
    workflowRunSummaries: workflowRuns,
    workflowBindingSummaries,
    ensembleSummaries,
    pipelineRuns,
    pipelineCommissions,
    fileCommentThreads,
    fileCommentReviews,
    fleetCost,
    lineSummary,
    settingsStatus,
    keepAwakeStatus,
    harnessesRevision,
    worktreesRevision,
    // One counter, bumped per reconciled batch of archives and once per reconnect. It is
    // how the Scouts page learns to refetch its current window without the browser polling
    // and without unbounded history entering the SSE snapshot.
    archivesRevision,
    settingsRestoreNotice,
    schedules,
    connected,
    hasSnapshot,
  } = useEventStream();
  const [workflowDirty, setWorkflowDirty] = useState(false);
  const { route, navigate, replace, pendingRoute, confirmPending, cancelPending } =
    useWorkflowRoute(workflowDirty);
  const [alertSettings, updateAlerts] = useAlertSettings();
  const { away, setAway, digest, dismissDigest, buffered } = useAwayMode();
  // Stalls come from the daemon (only it has the clock), but only the browser can
  // raise a notification - so they are polled back in here to give the `stuck` alert
  // a delivery path instead of leaving it to the return digest.
  const stalls = useStalls();
  const alertScope = useMemo(
    () => ({ sessions, tasks, stalls, workflowRuns, ensembleSummaries }),
    [sessions, tasks, stalls, workflowRuns, ensembleSummaries],
  );
  useNotifier(alertScope, alertSettings, hasSnapshot);
  const { bindings } = useKeybindings();
  const [keybindingHints] = useKeybindingHints();
  const [layout, setLayout] = useLayoutMode();
  const [lineDensity, setLineDensity] = useLineDensity();
  const foreman = useForeman();
  // Owned here rather than by SettingsPage, on the `foreman` precedent: the topbar spend
  // popover and the Cost panel read the same `view` setting, so a local copy in the page
  // would leave the popover showing the old choice until the next reload - and double-poll.
  const cost = useCost();
  const llm = useLlm();
  // One uncached mount read, shared by the App-level reminder and Settings > Setup. The
  // panel's Re-check calls this same owner; there is no second hook and no polling tick.
  const setup = useSetupChecks(true);
  // Owned here for the same reason as `cost` above: two surfaces read one answer. The Library
  // shelf badges reviewer cards with it and the Persona editor badges the open row, and a copy
  // per surface would mean two requests and two chances to disagree about the same file.
  //
  // Keyed to WHICH badge-rendering surface is open, not to the Library route: the shelf and the
  // Persona editor share that route, so a boolean stayed true while an operator clicked a card to
  // open the very Persona they wanted the badge for. This component mounts once, so without the
  // key the answer would be whatever the disk said when the tab was opened.
  const personaDrift = usePersonaDrift(personaDriftSurface(
    route.page,
    route.page === "library" ? route.shelf ?? null : null,
  ));
  // The worst subsystem status, inherited by the topbar gear from the settings rail dots.
  // Null status ("unknown", pre-snapshot) and an all-clear both render no dot.
  const gearDot = settingsGearDot(settingsStatus);
  const gearPhrase = gearDotPhrase(gearDot);
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  // The attention inbox: the ONE topbar surface for "something is waiting on you". It holds no
  // target of its own - what it draws is `attention` below, folded from state App already has -
  // so it cannot go stale behind an item that resolved while it was open.
  const [inboxOpen, setInboxOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which half of the Console holds the keyboard: the rail selector, or the open
  // conversation reader. Tab hands it right, Shift+Tab (and Escape) hands it back. It
  // decides what the vertical arrows do and which surface wears the active focus treatment,
  // so it means nothing in the other layouts and is reset to "rail" whenever the selection
  // or layout changes (a fresh detail is never opened mid-read).
  const [consoleZone, setConsoleZone] = useState<"rail" | "detail">("rail");
  // Board keyboard selection is deliberately separate from its open console detail:
  // arrows move the cursor among tiles, then Enter promotes it into the drill-in.
  // Pointer clicks set both in one gesture, as they always have.
  //
  // A flag, not a second id, because the drill-in is ALWAYS the selected session. Holding
  // an id of its own let another layout's arrows move the selection out from under it, so
  // coming back to the board reopened the session you left while the tile cursor sat on a
  // different one - and it needed the arrow keys to remember to keep the two in step.
  // `boardOpenId` below derives the invariant instead of restating it.
  const [boardOpen, setBoardOpen] = useState(false);
  // Only whether the dispatch modal is open. The draft it edits belongs to
  // DispatchLayer, deliberately out of this component: App re-renders the whole
  // session layout, and the draft has to survive a close without dragging every
  // keystroke through it.
  const [dispatchOpen, setDispatchOpen] = useState(false);
  // The backlog task the dispatch modal is open OVER, when it was opened by clicking a
  // backlog card rather than the Dispatch button. Only the id is held: the task itself
  // is read back out of `tasks` on every render, so an edit made anywhere else - or the
  // task being dispatched out from under the modal - is seen here rather than shadowed
  // by a copy taken at open time.
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  // What this opening of the dispatch modal is FOR, when it is not an ordinary dispatch.
  // Only the Library's strategy launchers set it, and only the modal reads it - the draft
  // and the launch mode stay where they are, in `DispatchLayer`.
  const [dispatchIntent, setDispatchIntent] = useState<{ strategyId: EnsembleStrategyId } | null>(
    null,
  );
  const [reportOpen, setReportOpen] = useState(false);
  // Whether the public Feedback form is on screen - and ONLY that. The draft, the last
  // result and this opening's request id belong to `ProductIssueLayer`, for the reason
  // `dispatchOpen` gives above: the draft has to outlive a close, and a fleet re-render
  // must not drag every keystroke through it.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  /**
   * The one opener, shared by the topbar glyph and the palette command.
   *
   * Memoised because both entry points close over it, and single because two openers
   * would eventually become two modals with two drafts - which is exactly the retention
   * bug this form is built to avoid.
   */
  const openFeedback = useCallback(() => setFeedbackOpen(true), []);
  const closeFeedback = useCallback(() => setFeedbackOpen(false), []);
  // Whether the ⌘K palette is open. Owned here, and rendered in the overlay slot that every
  // page shares, because it indexes BOTH homes: it opens over the fleet, the Library, a run,
  // an ensemble and Settings alike, and navigating from it must not close it out from under
  // the navigation it just performed.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteInvokerRef = useRef<FocusBookmark>(captureFocusBookmark(null));
  const openPalette = useCallback((): void => {
    paletteInvokerRef.current = captureFocusBookmark(document.activeElement);
    setPaletteOpen(true);
  }, []);
  /** The one Line drawer state is also part of the temporary tour's restoration snapshot. */
  const [lineDrawer, setLineDrawer] = useState<LineDrawerStage | null>(null);
  const tourTargets = useMemo(createTourTargetRegistry, []);
  /** The one active tour run, whichever tour it is. A second activation is a no-op. */
  const [activeTour, setActiveTour] = useState<TourRun | null>(null);
  const [seeWorkTourPreviewTaskId, setSeeWorkTourPreviewTaskId] = useState<string | null>(null);
  const [seeWorkTourPreviewError, setSeeWorkTourPreviewError] = useState<string | null>(null);
  const [seeWorkTourTaskId, setSeeWorkTourTaskId] = useState<string | null>(null);
  const [seeWorkTourBriefReady, setSeeWorkTourBriefReady] = useState(false);
  const [seeWorkTourRepoRoot, setSeeWorkTourRepoRoot] = useState<string | null>(null);
  /**
   * The finished run the Library tour pinned when it started, or null when none qualified.
   *
   * Held for the whole run rather than re-selected per stop: a newer run landing mid-tour
   * must not move the operator to a different artifact than the one the previous stop just
   * explained, and the summary keeps its durable `sessionName` after the live collection
   * drops the session it reviewed.
   */
  const [libraryTourRun, setLibraryTourRun] = useState<LibraryTourRun | null>(null);
  const tourSequence = useRef(0);
  const activeTourRef = useRef<TourRun | null>(null);
  const tourBindingsRef = useRef<Record<TourId, TourBinding> | null>(null);
  const seeWorkTourPreviewTaskIdRef = useRef<string | null>(null);
  const seeWorkTourPreviewStartedRef = useRef<string | null>(null);
  const seeWorkTourTaskIdRef = useRef<string | null>(null);
  const sessionsRef = useRef(sessions);
  const tasksRef = useRef(tasks);
  activeTourRef.current = activeTour;
  /** The active run, only when it is See the work's. Every other tour reads null here. */
  const seeWorkRun = activeTour?.tourId === "see-work" ? activeTour : null;
  seeWorkTourPreviewTaskIdRef.current = seeWorkTourPreviewTaskId;
  seeWorkTourTaskIdRef.current = seeWorkTourTaskId;
  sessionsRef.current = sessions;
  tasksRef.current = tasks;
  const dispatchTourRef = useOwnedTourTargetRef<HTMLButtonElement>(tourTargets, "see-work:dispatch");
  // The settings control the palette last asked to land on, if any.
  //
  // The anchor is deliberately not in the hash (the settings route is category-only), so it
  // travels as a prop to `SettingsPage`, which owns the one scroll-and-flash implementation.
  // The nonce is what makes asking twice for the same control flash twice - without it the
  // second request would be a prop that did not change, and nothing would happen.
  const [settingsJump, setSettingsJump] = useState<{ anchor: string; nonce: number } | null>(null);
  // A one-shot request rather than lifted popover state: ForemanBar still owns its ordinary
  // toggle/close lifecycle, while the System profile can ask that existing control to open.
  const [foremanOpenRequest, setForemanOpenRequest] = useState(0);
  const [launcherFocusError, setLauncherFocusError] = useState<string | null>(null);
  const launcherFocusErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The Recurring Missions overlay. `missionsTarget` carries an optional deep link from a
  // generated task's provenance mark - a schedule, and the occurrence whose history to open
  // - so opening Missions from a card lands on the right run rather than the catalog root.
  const [missionsOpen, setMissionsOpen] = useState(false);
  const [missionsTarget, setMissionsTarget] = useState<{
    scheduleId: string;
    occurrenceId: string | null;
    // The occurrence's instant, so history can seed its cursor and open the exact run
    // without a page cap - see ScheduleHistory.
    scheduledFor: number | null;
  } | null>(null);
  const [filesSessionId, setFilesSessionId] = useState<string | null>(null);
  const [filePickerSessionId, setFilePickerSessionId] = useState<string | null>(null);
  const [fileTabRequest, setFileTabRequest] = useState<{
    sessionId: string;
    nonce: number;
  } | null>(null);
  /**
   * Deep-linking's last mile: which line the reader asked for, and how many times.
   *
   * `workspaceFileTarget` has always parsed `path:line`, and until now `openSessionPath` took
   * only a path, so the line was parsed and then dropped - "open plan.md line 84" opened
   * plan.md at the top. This is the channel that was missing, shaped like `fileTabRequest`
   * beside it: a NONCE, because asking for the same line twice is an ordinary thing to do and
   * a bare line would fire only on a change.
   */
  const [fileLineRequest, setFileLineRequest] = useState<{
    sessionId: string;
    path: string;
    line: number;
    nonce: number;
  } | null>(null);
  const [conversationTabRequest, setConversationTabRequest] = useState<{
    sessionId: string;
    nonce: number;
  } | null>(null);

  const openSettingsAnchor = useCallback(
    (category: SettingsCategoryId, anchor: string): void => {
      navigate({ page: "settings", category });
      setSettingsJump((previous) => ({
        anchor,
        nonce: (previous?.nonce ?? 0) + 1,
      }));
    },
    [navigate],
  );
  const openForemanTrust = useCallback(
    (): void => openSettingsAnchor("trust", "trust/matrix"),
    [openSettingsAnchor],
  );
  const [workflowsTabRequest, setWorkflowsTabRequest] = useState<{
    sessionId: string;
    nonce: number;
  } | null>(null);
  // Console and Board own a session's diff as a detail tab. The nonce makes a new
  // request observable when the same session/fix is opened again.
  const [diffTabRequest, setDiffTabRequest] = useState<{
    sessionId: string;
    commit: string | null;
    nonce: number;
  } | null>(null);
  const [resetSessionId, setResetSessionId] = useState<string | null>(null);
  const [completeSessionId, setCompleteSessionId] = useState<string | null>(null);
  const [killSessionId, setKillSessionId] = useState<string | null>(null);
  const [workflowBindingTarget, setWorkflowBindingTarget] = useState<WorkflowBindingTarget | null>(null);
  // Bumped for a session each time it's reset. The compose boxes are uncontrolled
  // (their text is parked in the draft map, not React state), so clearing the map
  // alone leaves a box that's OPEN at reset still showing the old text - the same
  // way clearing the queue wouldn't empty an open panel if the panel weren't driven
  // by pushed state. This nonce is the reply box's remount key, so a reset re-hydrates
  // it from the now-empty draft, matching how reset visibly clears the queue.
  const [resetNonces, setResetNonces] = useState<Record<string, number>>({});
  const files = useSessionFilesStore(connected);

  // A session was reset: forget its half-written messages and conversation history,
  // then bump its nonce so open conversation state reseeds from the cleared stores.
  const onSessionReset = useCallback((id: string) => {
    dropMessageDrafts(id);
    dropHistory(id);
    files.drop(id);
    setResetNonces((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
  }, [files.drop]);
  // Which session title is being edited (its inline rename box is open). App owns
  // this so the rename shortcut and a title click drive the same session.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // The single source of truth for "is an overlay open". Populated by the overlays
  // themselves as they mount (see Overlay.tsx), so the guards below can never fall out
  // of step with what is actually on screen - which is what used to happen when a new
  // overlay was added and one of the lists here was missed.
  const overlays = useOverlayHost();
  const contextMenuRef = useRef<ContextMenuHandle>(null);

  // Read by the global key handler below instead of closing over `overlays` directly.
  // That handler is installed by a passive effect, so a closure over `overlays` keeps the
  // value from the render BEFORE the overlay opened until the next passive flush - and a
  // keydown arriving in that interval drives the session behind the overlay. Synced in a
  // layout effect, which runs in the same commit as the overlay's own registration
  // (Overlay.tsx), so the guard is never behind what is on screen.
  const overlaysRef = useRef(overlays);
  useLayoutEffect(() => {
    overlaysRef.current = overlays;
  }, [overlays]);
  const isOverlayOpen = useCallback(() => overlaysRef.current.anyOpen, []);

  // The native "Settings…" menu item (⌘,) pushes here over IPC; the topbar gear navigates
  // to the same route directly. No-op in a plain browser (no preload bridge).
  //
  // The IPC channel is reused exactly as it was - `mission:open-settings`, main and preload
  // untouched - because what changed is what the renderer DOES with it, not what the shell
  // sends. Only this listener's body is a navigation now.
  useEffect(
    () =>
      window.missionDesktop?.onOpenSettings(() => {
        navigate({ page: "settings", category: DEFAULT_SETTINGS_CATEGORY });
      }),
    [navigate],
  );

  // Live element + imperative-handle maps for the keyboard-selected session.
  const sessionEls = useRef<Map<string, HTMLElement>>(new Map());
  const actionHandles = useRef<Map<string, ActionBarHandle>>(new Map());
  // Board workflow disclosures stay local to their tiles, but the global, rebindable
  // expand action needs to drive the selected one through the exact same transition as
  // its Show full workflow / Collapse workflow button.
  const workflowDisclosureHandles = useRef<Map<string, WorkflowDisclosureHandle>>(new Map());
  const launcherHandles = useRef<Map<string, SessionLaunchersHandle>>(new Map());
  const findHandles = useRef<Map<string, TranscriptFindHandle>>(new Map());
  // The session whose find was asked for before its transcript existed. Held for exactly
  // one mount: `registerFind` replays it and clears it, so revealing a conversation for
  // some other reason later never opens a find nobody asked for.
  const pendingFind = useRef<string | null>(null);
  const detailScrollers = useRef<Map<
    string,
    (direction: -1 | 1, fromReader: boolean) => boolean
  >>(new Map());
  // Tab cycles the open detail's tabs (Conversation -> Work queue -> Gate -> Diff -> Files);
  // ConsoleDetail owns that state, so it registers a stepper here that App's global key
  // handler drives. "edge" means there is no further tab that way - forward it clamps, back
  // it hands the keyboard to the rail. Shared by the console and the board drill-in, which
  // mount the same ConsoleDetail.
  const readerTabbers = useRef<Map<string, (dir: -1 | 1) => "moved" | "edge">>(new Map());
  // The board's arrow cursor, armed to take DOM focus once the tile it names has
  // rendered. Same one-shot ref as above, for the same reason.
  const pendingTileFocus = useRef<string | null>(null);
  // A selection chord the board's overview had no action bar to run yet: it opens the
  // drill-in and this holds what to do against the bar that mounts with it.
  const pendingBarAction = useRef<{ id: string; run: keyof ActionBarHandle } | null>(null);
  // A launcher chord may have to reveal the conversation pane before its button exists.
  // Registration below consumes this the moment that exact session's toolbar mounts.
  const pendingLauncherAction = useRef<{
    id: string;
    run: keyof SessionLaunchersHandle;
  } | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const topbarRef = useRef<HTMLElement>(null);

  const registerEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) sessionEls.current.set(id, el);
    else sessionEls.current.delete(id);
  }, []);

  const registerWorkflowDisclosure = useCallback(
    (id: string, handle: WorkflowDisclosureHandle | null) => {
      if (handle) workflowDisclosureHandles.current.set(id, handle);
      else workflowDisclosureHandles.current.delete(id);
    },
    [],
  );

  // The rail row is a RailRow in BOTH the console rail and the board drill-in column, so
  // this focuses the left-bar selection in either layout. `.cdetail` is ConsoleDetail's
  // root, shared by both details - the guard keeps an arrow walk from yanking the cursor
  // out of an editor that is NOT the reader (the topbar filter).
  const focusReaderRail = useCallback((id: string) => {
    const active = document.activeElement as HTMLElement | null;
    const activeEditor = active?.closest("input, textarea, select, [contenteditable='true']");
    if (activeEditor && !active?.closest(".cdetail")) return;
    sessionEls.current.get(id)?.focus({ preventScroll: true });
  }, []);

  const focusReaderBody = useCallback(() => {
    // Files Preview has a reader inside the detail body. Enter it directly so the next
    // vertical arrow scrolls the document; before Tab, those arrows belong to the file list.
    // Every other tab lands on the body itself, preserving the conversation reader ring.
    const target = document.querySelector<HTMLElement>(".cdetail .file-preview-reader")
      ?? document.querySelector<HTMLElement>(".cdetail .detail-body");
    target?.focus({ preventScroll: true });
  }, []);

  const registerActions = useCallback((id: string, handle: ActionBarHandle | null) => {
    if (handle) actionHandles.current.set(id, handle);
    else actionHandles.current.delete(id);
  }, []);

  const registerLaunchers = useCallback(
    (id: string, handle: SessionLaunchersHandle | null) => {
      if (!handle) {
        launcherHandles.current.delete(id);
        return;
      }
      launcherHandles.current.set(id, handle);
      const pending = pendingLauncherAction.current;
      if (!pending || pending.id !== id) return;
      pendingLauncherAction.current = null;
      handle[pending.run]();
    },
    [],
  );

  const registerFind = useCallback(
    (id: string, handle: TranscriptFindHandle | null) => {
      if (!handle) {
        findHandles.current.delete(id);
        return;
      }
      findHandles.current.set(id, handle);
      // The chord fired while this panel was still unmounted; the reveal it asked for
      // has now happened, so honour the original keystroke.
      if (pendingFind.current !== id) return;
      pendingFind.current = null;
      handle.open();
    },
    [],
  );

  const registerDetailScroll = useCallback((
    id: string,
    scroll: ((direction: -1 | 1, fromReader: boolean) => boolean) | null,
  ) => {
    if (scroll) detailScrollers.current.set(id, scroll);
    else detailScrollers.current.delete(id);
  }, []);

  const registerReaderTab = useCallback(
    (id: string, nav: ((dir: -1 | 1) => "moved" | "edge") | null) => {
      if (nav) readerTabbers.current.set(id, nav);
      else readerTabbers.current.delete(id);
    },
    [],
  );

  /**
   * A kill landed: close whatever detail it was ordered from, straight away.
   *
   * The session does NOT leave the list when it dies - it is marked `exited` and lingers
   * ~8s before eviction, and only then does the reconciliation effect below drop the
   * selection. Until then the board stayed drilled into a transcript that can no longer
   * change, its action bar already gone, with Escape the only way out. Killing is the one
   * gesture that ends the reason the detail was open, so it takes the detail with it.
   *
   * Which layer that is is the layout's answer, not this callback's. `detailLayer` is the
   * same split Escape peels one press at a time.
   */
  const onKilled = useCallback(
    (id: string) => {
      const layer = detailLayer(layout);
      if (layer === "board") {
        // The board's drill-in holds no id of its own - it is whatever is selected - so
        // "was this kill ordered from inside it" is asked of the selection.
        if (selectedId === id) setBoardOpen(false);
        return;
      }
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [layout, selectedId],
  );

  const closeDispatch = useCallback(() => {
    setDispatchOpen(false);
    setEditingTaskId(null);
    setDispatchIntent(null);
  }, []);
  const closeComplete = useCallback(() => setCompleteSessionId(null), []);
  /**
   * Open the dispatch modal over a backlog task.
   *
   * Clears `dispatchOpen` in the same breath, so the two ways in can never both be
   * true: one modal, over one thing, and closing it goes all the way out rather than
   * dropping back onto a new-dispatch form nobody asked for.
   */
  const openTaskEditor = useCallback((taskId: string) => {
    setDispatchOpen(false);
    setEditingTaskId(taskId);
  }, []);
  /** The other way in - the topbar button and the dispatch chord - and its mirror image. */
  const openDispatch = useCallback(() => {
    setEditingTaskId(null);
    setDispatchIntent(null);
    setDispatchOpen(true);
  }, []);
  /**
   * The third way in: a Library strategy launcher, which opens the same modal already in
   * Ensemble mode on that strategy.
   *
   * The intent is cleared by `openDispatch` and by `closeDispatch`, so an ordinary Dispatch
   * after one of these is an ordinary Dispatch rather than an Ensemble the operator did not
   * ask for.
   */
  const launchEnsemble = useCallback((strategyId: EnsembleStrategyId) => {
    setEditingTaskId(null);
    setDispatchIntent({ strategyId });
    setDispatchOpen(true);
  }, []);
  const closeMissions = useCallback(() => {
    setMissionsOpen(false);
    setMissionsTarget(null);
  }, []);
  /**
   * Open Recurring Missions, optionally deep-linked to one schedule's run history.
   *
   * Stands the other operator overlays down first - opening Missions from a Sitrep row or
   * a dispatch surface should not leave one hanging behind it - then opens with the deep
   * link a generated task's provenance mark supplied. Nothing here reads a schedule table:
   * the panel consumes the live SSE catalog and fetches history on demand.
   */
  const onOpenSchedule = useCallback(
    (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => {
      setReportOpen(false);
      closeDispatch();
      setMissionsTarget({
        scheduleId,
        occurrenceId: occurrenceId ?? null,
        scheduledFor: scheduledFor ?? null,
      });
      setMissionsOpen(true);
    },
    [closeDispatch],
  );
  const openMissions = useCallback(() => {
    setReportOpen(false);
    closeDispatch();
    setMissionsTarget(null);
    setMissionsOpen(true);
  }, [closeDispatch]);

  // The formatting store, read here so the palette can flip that toggle from any page.
  // `AppearancePanel` reads the same module-level store, so there is no second copy.
  const [richText, setRichText] = useRichText();
  // The guided-dispatch preference, read here for the same reason: the palette may flip it
  // from any page, and `DispatchSettingsPanel` and the dispatch modal's header switch read
  // the same module-level store, so this is a third reader of one value rather than a copy.
  const [guidedDispatch, setGuidedDispatch] = useGuidedDispatch();
  const [guidedTourEnabled, guidedTourHydrated, consumeGuidedTour] = useGuidedTour();
  /**
   * Runtime get/set for the settings toggles the palette may flip in place.
   *
   * Three of the five are wired, and the other two are `null` ON PURPOSE. `buildSettingsBindings`
   * already states the rule: a source that has not loaded gets NO binding, and the control
   * degrades to a jump rather than drawing a switch for a value nobody has read. Auto mode and
   * the Skills master switch are backed by daemon configs that the Settings page alone polls
   * (`useHarnesses`, `useSkills`, deliberately scoped to that page so they stop polling when
   * you leave it) - so from a palette that opens on ANY page there is no loaded value for
   * them, and they jump to their panel, consistently, from everywhere.
   *
   * The formatting and guided-dispatch toggles are browser-local stores with shipped defaults
   * and cost telemetry is already App-owned, so all three are honestly bindable wherever the
   * palette opens.
   */
  const paletteBindings = useMemo(
    () =>
      buildSettingsBindings({
        formatMessages: { value: richText, set: setRichText },
        guidedDispatch: { value: guidedDispatch, set: setGuidedDispatch },
        autoMode: null,
        skillsEnabled: null,
        costTrack: cost.status
          ? { value: cost.status.config.enabled, set: (v) => void cost.update({ enabled: v }) }
          : null,
      }),
    [richText, setRichText, guidedDispatch, setGuidedDispatch, cost.status, cost.update],
  );
  /**
   * Session names, for the run rows that are bound to one.
   *
   * Derived here rather than passed whole, so the palette's dependency is honestly "the names
   * on the cards" rather than "the fleet" - sessions are not a searchable kind yet, and this
   * keeps the index unable to become one by accident.
   */
  const sessionNames = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.name])),
    [sessions],
  );
  /** Everything the palette's providers read, in one object. */
  const paletteStores = useMemo<PaletteStores>(
    () => ({
      workflows: workflowSummaries,
      runs: workflowRuns,
      ensembles: ensembleSummaries,
      personas,
      sessionActions,
      schedules,
      sessionNames,
      settingsBindings: paletteBindings,
    }),
    [
      workflowSummaries,
      workflowRuns,
      ensembleSummaries,
      personas,
      sessionActions,
      schedules,
      sessionNames,
      paletteBindings,
    ],
  );

  /**
   * The session See the work opens its third stop on, chosen before the run is committed.
   * An empty fleet answers null, which is what makes the tour start its own Chat preview.
   */
  const pickSeeWorkSession = useCallback((): string | null => (
    selectedId && sessions.some((session) => session.id === selectedId)
      ? selectedId
      : (sessions[0]?.id ?? null)
  ), [selectedId, sessions]);

  /** Clear the previous See the work run's temporary state and resolve the repo it needs. */
  const beginSeeWorkRun = useCallback((run: TourRun): void => {
    seeWorkTourPreviewTaskIdRef.current = null;
    seeWorkTourPreviewStartedRef.current = null;
    setSeeWorkTourPreviewTaskId(null);
    setSeeWorkTourPreviewError(null);
    setSeeWorkTourTaskId(null);
    setSeeWorkTourBriefReady(false);
    const preferredRepo = run.sessionId
      ? sessions.find((session) => session.id === run.sessionId)?.repoRoot ?? null
      : tasks.find((task) => task.repoRoot)?.repoRoot ?? null;
    setSeeWorkTourRepoRoot(preferredRepo);
    if (preferredRepo) return;
    void fetchRepos().then((repos) => {
      if (activeTourRef.current?.id !== run.id) return;
      const repoRoot = repos[0] ?? null;
      setSeeWorkTourRepoRoot(repoRoot);
      if (!repoRoot && run.sessionId === null) {
        setSeeWorkTourPreviewError("No git repository is available for the tour conversation.");
      }
    });
  }, [sessions, tasks]);

  /**
   * The version of the built-in workflow the tour teaches, and so the only version whose runs
   * it will open. Null until the catalog lands, or if the built-in is not published here.
   */
  const libraryTourWorkflowVersion = useMemo((): number | null => (
    workflowSummaries.find((workflow) => workflow.id === NO_MISTAKES_REVIEW_WORKFLOW_ID)
      ?.publishedVersion ?? null
  ), [workflowSummaries]);

  /** The run the Library tour pins when it starts. The rule itself lives with the tour. */
  const pickLibraryTourRun = useCallback((): LibraryTourRun | null => (
    selectLibraryTourRun(
      workflowRuns,
      new Set(sessions.map((session) => session.id)),
      libraryTourWorkflowVersion,
    )
  ), [libraryTourWorkflowVersion, sessions, workflowRuns]);

  /** Pin that run on this Library tour run. The tour creates nothing else to reclaim. */
  const beginLibraryRun = useCallback((): void => {
    setLibraryTourRun(pickLibraryTourRun());
  }, [pickLibraryTourRun]);

  /**
   * How each tour opens: the resource it wants to point at, and the run state it seeds.
   *
   * Keyed by `TourId`, so a new tour cannot be registered without saying both, and the
   * generic start path below never learns which tour it is starting.
   */
  const tourStarters = useMemo<Record<TourId, {
    resource: () => string | null;
    begin: (run: TourRun) => void;
  }>>(() => ({
    "see-work": { resource: pickSeeWorkSession, begin: beginSeeWorkRun },
    // The Library tour singles out a run rather than a session, and it pins it in `begin`
    // rather than as the run's `resource`: the run is a whole summary, not an id.
    "library": { resource: () => null, begin: beginLibraryRun },
    "setup": { resource: () => null, begin: () => {} },
  }), [beginLibraryRun, beginSeeWorkRun, pickSeeWorkSession]);

  /**
   * Start a tour. One active run at a time, whichever tour asks.
   *
   * The entry route transition is a PREFLIGHT: it runs before any tour state is committed, so
   * a dirty draft raises the existing leave dialog with no tour active and the ordinary route
   * flow owns the answer. Only a transition the app accepted commits a run.
   */
  const startTour = useCallback((
    tourId: TourId,
    focus = paletteInvokerRef.current,
  ): boolean => {
    if (activeTourRef.current) return false;
    const snapshot: TourSnapshot = { route, layout, selectedId, boardOpen, filter, lineDrawer };
    if (!navigate(tourEntry(tourId).entryRoute)) return false;
    const starter = tourStarters[tourId];
    const run: TourRun = {
      id: `${tourId}-${++tourSequence.current}`,
      tourId,
      snapshot,
      sessionId: starter.resource(),
      focus,
    };
    // Set the ref in the same turn as state so a fast second activation cannot start a
    // second controller before React commits this one.
    activeTourRef.current = run;
    starter.begin(run);
    setActiveTour(run);
    return true;
  }, [boardOpen, filter, layout, lineDrawer, navigate, route, selectedId, tourStarters]);

  /**
   * A fresh profile receives one automatic product orientation. The preference is consumed
   * only after the preflight accepts, so a dirty route that declines navigation can try again
   * after the operator resolves its ordinary leave dialog.
   */
  useEffect(() => {
    if (!guidedTourHydrated || !guidedTourEnabled) return;
    if (startTour("see-work", captureFocusBookmark(null))) consumeGuidedTour();
  }, [consumeGuidedTour, guidedTourEnabled, guidedTourHydrated, startTour]);

  // Only an empty fleet needs a synthetic desk. Start its fixed Chat session as soon as the
  // repository is known, while the operator is reading the Line and Board stops. A late
  // response after Exit is reclaimed immediately instead of appearing off-screen.
  useEffect(() => {
    const run = seeWorkRun;
    const repoRoot = seeWorkTourRepoRoot;
    if (
      !run ||
      run.sessionId !== null ||
      !repoRoot ||
      seeWorkTourPreviewStartedRef.current === run.id
    ) return;
    seeWorkTourPreviewStartedRef.current = run.id;
    void api.startTourPreview("see-work", repoRoot).then(async (result) => {
      const taskId = result.task?.id ?? null;
      if (!result.ok || !taskId) {
        if (activeTourRef.current === run) {
          setSeeWorkTourPreviewError(
            result.error ?? "Mission Control did not return a tour conversation.",
          );
        }
        return;
      }
      if (activeTourRef.current !== run) {
        await api.completeTourTask("see-work", taskId);
        return;
      }
      seeWorkTourPreviewTaskIdRef.current = taskId;
      setSeeWorkTourPreviewTaskId(taskId);
    }).catch((error: unknown) => {
      if (activeTourRef.current === run) {
        setSeeWorkTourPreviewError(
          error instanceof Error ? error.message : "The tour conversation could not start.",
        );
      }
    });
  }, [seeWorkRun, seeWorkTourRepoRoot]);

  const dispatchSeeWorkTourDemo = useCallback(async (repoRoot: string) => {
    if (seeWorkTourTaskIdRef.current) {
      return {
        ok: true,
        task: tasksRef.current.find((task) => task.id === seeWorkTourTaskIdRef.current),
      };
    }
    const run = activeTourRef.current;
    if (!run) return { ok: false, error: "the tour is no longer active" };
    const result = await api.startTourDemo("see-work", repoRoot);
    const taskId = result.task?.id ?? null;
    if (!result.ok || !taskId) {
      return { ok: false, error: result.error ?? "Mission Control did not return a demo task." };
    }
    // A slow response can land after Exit. Close that task instead of attaching it to a
    // newer run or leaving it alive off-screen.
    if (activeTourRef.current !== run) {
      await api.completeTourTask("see-work", taskId);
      return { ok: false, error: "The tour ended while the demo task was starting." };
    }
    seeWorkTourTaskIdRef.current = taskId;
    setSeeWorkTourTaskId(taskId);
    return result;
  }, []);

  const seeWorkNavigation = useMemo<SeeWorkTourNavigation | null>(() => {
    if (!seeWorkRun) return null;
    const enterFleet = (): boolean => {
      if (!navigate({ page: "fleet" })) return false;
      setFilter("");
      setLineDrawer(null);
      return true;
    };
    return {
      showLine: () => {
        if (!enterFleet()) return false;
        setBoardOpen(false);
        return true;
      },
      showBoard: () => {
        if (!enterFleet()) return false;
        setLayout("board");
        setBoardOpen(false);
        return true;
      },
      showSessionDetail: () => {
        if (!enterFleet()) return false;
        setLayout("board");
        const previewSession = seeWorkRun.sessionId
          ? sessionsRef.current.find((session) => session.id === seeWorkRun.sessionId) ?? null
          : sessionsRef.current.find(
              (session) => session.task?.id === seeWorkTourPreviewTaskIdRef.current,
            ) ?? null;
        setSelectedId(previewSession?.id ?? null);
        setBoardOpen(previewSession !== null);
        return true;
      },
      showDispatch: () => {
        if (!enterFleet()) return false;
        closeDispatch();
        setBoardOpen(false);
        return true;
      },
      showDispatchModal: () => {
        if (!enterFleet()) return false;
        setBoardOpen(false);
        openDispatch();
        return true;
      },
      closeDispatch,
      writeDemoBrief: () => setSeeWorkTourBriefReady(true),
      showDemoBoard: () => {
        if (!enterFleet()) return false;
        setLayout("board");
        setFilter("Tour demo");
        const session = sessionsRef.current.find(
          (candidate) => candidate.task?.id === seeWorkTourTaskIdRef.current,
        );
        setSelectedId(session?.id ?? null);
        setBoardOpen(false);
        return true;
      },
      showReview: () => {
        const session = sessionsRef.current.find(
          (candidate) => candidate.task?.id === seeWorkTourTaskIdRef.current,
        );
        if (session) {
          document.documentElement.dataset.mcTourReview = "true";
          setReviewSessionId(session.id);
        }
        return true;
      },
      closeReview: () => {
        delete document.documentElement.dataset.mcTourReview;
        setReviewSessionId(null);
      },
      showDemoDetail: () => {
        if (!enterFleet()) return false;
        setLayout("board");
        setFilter("Tour demo");
        const session = sessionsRef.current.find(
          (candidate) => candidate.task?.id === seeWorkTourTaskIdRef.current,
        );
        setSelectedId(session?.id ?? null);
        setBoardOpen(session != null);
        return true;
      },
      showComplete: () => {
        const session = sessionsRef.current.find(
          (candidate) => candidate.task?.id === seeWorkTourTaskIdRef.current,
        );
        if (session) setCompleteSessionId(session.id);
        return true;
      },
      closeComplete,
    };
  }, [closeComplete, closeDispatch, navigate, openDispatch, seeWorkRun, setLayout]);

  /**
   * Reclaim everything a See the work run created, and forget the run once it has.
   *
   * Kept whole and separate from the generic close below because a refusal here is the one
   * case the operator can retry: the surface is already restored, the ids are still held, and
   * the same controller offers Retry cleanup against the same two tasks.
   */
  const cleanupSeeWorkRun = useCallback(async (): Promise<void> => {
    const taskIds = [
      seeWorkTourPreviewTaskIdRef.current,
      seeWorkTourTaskIdRef.current,
    ].filter((taskId): taskId is string => taskId !== null);
    const failures: string[] = [];
    for (const taskId of new Set(taskIds)) {
      try {
        const result = await api.completeTourTask("see-work", taskId);
        if (!result.ok) failures.push(result.error ?? `task ${taskId} could not be closed`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) throw new Error(failures.join("; "));

    seeWorkTourPreviewTaskIdRef.current = null;
    seeWorkTourPreviewStartedRef.current = null;
    seeWorkTourTaskIdRef.current = null;
    setSeeWorkTourPreviewTaskId(null);
    setSeeWorkTourPreviewError(null);
    setSeeWorkTourTaskId(null);
    setSeeWorkTourBriefReady(false);
    setSeeWorkTourRepoRoot(null);
  }, []);

  /**
   * Reclaim what a Library run held, which is one pinned run summary and nothing else.
   *
   * It cannot fail, and that is a property of the tour rather than of this function: nothing
   * was created, dispatched, saved, or bound, so there is no daemon round trip to refuse.
   */
  const cleanupLibraryRun = useCallback(async (): Promise<void> => {
    setLibraryTourRun(null);
  }, []);
  // Setup only navigates and spotlights existing page chrome, so it creates nothing to reclaim.
  const cleanupSetupRun = useCallback(async (): Promise<void> => {}, []);

  /**
   * Close whichever tour is active.
   *
   * The order is the promise the popover makes while it says "Completing": put the operator
   * back where they started FIRST, then ask the tour to reclaim what it made. A tour that
   * cannot finish reclaiming leaves the run installed again so its controller can retry
   * against the same resources rather than stranding them.
   */
  const finishTour = useCallback(async (): Promise<void> => {
    const run = activeTourRef.current;
    if (!run) return;
    // A slow preview or Dispatch response must see the tour as closed while cleanup runs, so
    // it reclaims its own task instead of attaching it to a controller that is leaving.
    activeTourRef.current = null;
    const { snapshot, focus } = run;
    cancelPending();
    for (const flag of TOUR_DEFINITIONS[run.tourId].documentFlags) {
      delete document.documentElement.dataset[flag];
    }
    closeComplete();
    closeDispatch();
    setReviewSessionId(null);
    navigate(snapshot.route);
    setLayout(snapshot.layout);
    setSelectedId(snapshot.selectedId);
    setBoardOpen(snapshot.boardOpen);
    setFilter(snapshot.filter);
    setLineDrawer(snapshot.lineDrawer);

    try {
      await tourBindingsRef.current?.[run.tourId].cleanup();
    } catch (error) {
      activeTourRef.current = run;
      throw error;
    }
    setActiveTour(null);

    // Route restoration can remount the invoking control. Try the original node first, then
    // its semantic replacement for a few frames while the restored page commits.
    let attempts = 5;
    let settledFocus: Element | null = null;
    const restore = (): void => {
      const restored = restoreFocusBookmark(focus);
      const active = restored ? document.activeElement : null;
      const settled = restored && active === settledFocus;
      settledFocus = active;
      if (!settled && attempts-- > 0) requestAnimationFrame(restore);
    };
    requestAnimationFrame(restore);
  }, [cancelPending, closeComplete, closeDispatch, navigate, setLayout]);

  /**
   * Perform one palette row.
   *
   * Every branch below hands off to an opener that already exists and is already used by a
   * button somewhere: `navigate` for the routes phases 2 and 4 published, the three dispatch
   * and binding overlays, and the Missions panel. The palette adds a doorway, never a second
   * implementation - which is why this switch has no logic of its own beyond the settings
   * anchor, and why a row can only ask for something the app could already do in one click.
   */
  const onPaletteActivate = useCallback(
    (target: PaletteTarget): void => {
      switch (target.kind) {
        case "route":
          navigate(target.route);
          // Set unconditionally when the row carries one, INCLUDING when `navigate` was a
          // no-op because we were already on that category: the operator asked to be shown
          // this control, and being on the right page already is not a reason to show them
          // nothing. The nonce makes the repeat a fresh request.
          if (target.anchor) {
            const anchor = target.anchor;
            setSettingsJump((prev) => ({ anchor, nonce: (prev?.nonce ?? 0) + 1 }));
          }
          return;
        case "toggle": {
          const binding = paletteBindings.get(target.controlId);
          binding?.set(!binding.get());
          return;
        }
        case "dispatch":
          openDispatch();
          return;
        case "launch-ensemble":
          launchEnsemble(target.strategyId);
          return;
        case "bind-workflow":
          // Opened with no target at all, exactly as the runs rail and the Line's Review
          // drawer open it: the dialog asks for the session and the published version itself.
          setWorkflowBindingTarget({});
          return;
        case "start-tour":
          startTour(target.tourId);
          return;
        case "report-product-issue":
          openFeedback();
          return;
        case "open-mission":
          onOpenSchedule(target.scheduleId);
          return;
        default: {
          // Exhaustiveness: a new target kind fails to compile here rather than silently
          // doing nothing when its row is pressed.
          const unhandled: never = target;
          void unhandled;
        }
      }
    },
    [
      navigate,
      openDispatch,
      openFeedback,
      launchEnsemble,
      onOpenSchedule,
      paletteBindings,
      startTour,
    ],
  );
  /**
   * Which Line stage has its drawer open, or null. The one carrier of that fact: the strip
   * reads it for `aria-expanded`, the fleet body renders from it, and `esc` clears it.
   */
  /** Every stage button, so closing a drawer can put the keyboard back on the one that opened it. */
  const lineStageButtons = useRef(new Map<LineStageId, HTMLButtonElement>());
  const registerLineStage = useCallback(
    (stage: LineStageId, button: HTMLButtonElement | null): void => {
      if (button) lineStageButtons.current.set(stage, button);
      else lineStageButtons.current.delete(stage);
    },
    [],
  );
  /**
   * Close, and hand the keyboard back.
   *
   * The focus half is not decoration: the drawer takes focus as it opens (see `LineDrawer`),
   * so without this every close - ✕, `esc`, or a second click on the stage - would drop the
   * keyboard on `<body>` and the next Tab would restart from the top of the page.
   */
  // Mirrored in a ref so the closer can read what is open WITHOUT doing it from inside a
  // state updater: React may call an updater twice, and moving the keyboard is not a thing
  // to do twice. Same reason the router mirrors its held route.
  const lineDrawerRef = useRef<LineDrawerStage | null>(null);
  lineDrawerRef.current = lineDrawer;
  const closeLineDrawer = useCallback((): void => {
    const open = lineDrawerRef.current;
    if (open) lineStageButtons.current.get(open)?.focus();
    setLineDrawer(null);
  }, []);

  /**
   * Open one workflow run's reader, from anywhere.
   *
   * Six surfaces reach it now - a session detail's workflow chip, the board tile, the runs
   * rail, the ensembles detail's handoff link, the Review drawer, and the Library's
   * cross-link - and they used to spell the destination themselves. One opener, because the
   * FILTER rule is the part worth stating once: a run opened while the runs page is already
   * filtered keeps that filter, so Back returns to the list you were reading rather than to
   * an unfiltered one. Opened from anywhere else there is no filter to keep.
   */
  const keptRunFilters = route.page === "runs" ? route.filters : undefined;
  /**
   * How many repositories an external SDLC engine is being observed in, and therefore
   * whether the Runs page has two surfaces at all.
   *
   * Zero - which is every fleet until somebody consents to a repository in Settings - means
   * no tab strip, no pipelines surface, and nothing on that page asking the daemon anything
   * about pipelines. It rides the settings-status tuple already in the connect snapshot for
   * the same reason `present` does: the page has to decide on its first paint, and computing
   * it costs the daemon a config read.
   *
   * A pipelines hash on a fleet observing nothing falls back to the workflow rail rather
   * than to an empty page, which is the rule every unresolvable deep link in this router
   * already takes.
   */
  const pipelinesObserving = settingsStatus?.pipelines.observing ?? 0;
  const runsKind: RunsKind =
    route.page === "runs" && route.kind === "pipelines" && pipelinesObserving > 0
      ? "pipelines"
      : "workflows";
  const [pipelineCommissionSelection, setPipelineCommissionSelection] = useState<string | null>(null);
  const openWorkflowRun = useCallback(
    (runId: string): void => {
      navigate({ page: "runs", runId, ...(keptRunFilters ? { filters: keptRunFilters } : {}) });
    },
    [navigate, keptRunFilters],
  );
  const openEnsembleRun = useCallback(
    (ensembleId: string): void => {
      navigate({ page: "ensembles", ensembleId });
    },
    [navigate],
  );
  /**
   * Open one pipeline run, through the route helper that owns the address shape.
   *
   * No filter is kept: the pipelines rail has none. Its grouping comes from the daemon's
   * own classification of the engine's state, so there is nothing an operator narrowed that
   * a link out of the rail could lose.
   */
  const openPipelineRun = useCallback(
    // The run's KEY, not a whole `PipelineRun`: a session's own `pipeline` link carries the
    // three coordinates and nothing else, and it is the caller a detail, a ladder and an inbox
    // row all reach this through. `pipelineRunRoute` asks for exactly these three, so both
    // shapes satisfy it structurally and neither caller has to destructure.
    (run: { provider: PipelineRun["provider"]; repoRoot: string; slug: string }): void => {
      setPipelineCommissionSelection(null);
      navigate(pipelineRunRoute(run));
    },
    [navigate],
  );
  const openPipelineCommission = useCallback(
    (commissionId: string): void => {
      setPipelineCommissionSelection(commissionId);
      navigate({ page: "runs", kind: "pipelines" });
    },
    [navigate],
  );
  /** Land on the fleet with this session selected, drilling the board in if that is the layout. */
  const openSessionOnFleet = useCallback(
    (sessionId: string): void => {
      navigate({ page: "fleet" });
      setSelectedId(sessionId);
      if (layout === "board") setBoardOpen(true);
    },
    [navigate, layout],
  );
  /**
   * Run a Line stage click.
   *
   * The mapping itself is not here - it is `LINE_STAGE_TARGETS`, one table in one file - so
   * this only knows how to perform the four kinds of destination the dashboard has. Five of
   * the six stages now open a drawer between the strip and the board; Working still goes
   * somewhere, and NEITHER kind is a special case of the other.
   *
   * Two arms - `route` and `sitrep` - have no stage pointing at them right now. They stay
   * because a retarget is then a one-line edit to the table and nothing here, which is the
   * whole point of the seam: it has already absorbed three of them without this handler
   * changing at all.
   *
   * A stage that navigates also closes any open drawer, because the strip is one surface: a
   * press changes what it is showing you, and "swap to a stage that has no drawer" is a
   * close. The other half of that rule - leaving the fleet by any route at all - is the
   * effect below, which is where it has to live: most navigations away from an open drawer
   * start INSIDE it ("Open run", "All ensembles →").
   */
  const onLineStage = useCallback(
    (stage: LineStageId) => {
      const target = LINE_STAGE_TARGETS[stage];
      switch (target.kind) {
        case "drawer":
          setLineDrawer((open) => nextLineDrawer(open, target.stage));
          break;
        case "route":
          setLineDrawer(null);
          navigate(target.route);
          break;
        case "sitrep":
          setLineDrawer(null);
          setReportOpen(true);
          break;
        case "fleet":
          // Already the page under the strip, so the useful half is the filter: the stage
          // counts every live session and a filter box with something in it means the board
          // is showing fewer. Clearing it makes the count and the cards agree again.
          setLineDrawer(null);
          navigate({ page: "fleet" });
          setFilter("");
          break;
      }
    },
    [navigate],
  );
  /**
   * Leaving the fleet closes the drawer.
   *
   * An effect on the ROUTE rather than a call in each opener, because almost every navigation
   * away from an open drawer starts inside it - "Open run", "All ensembles →", the ensemble
   * provenance link - and one of those would eventually be added without the close. The
   * symptom is quiet and confusing: App never unmounts, so a drawer left open comes back the
   * moment you return to the fleet, still showing the rows you already triaged, and the next
   * click on that stage TOGGLES IT SHUT instead of opening it. (This is not hypothetical -
   * the drawers spec caught exactly that.)
   *
   * No focus restoration here on purpose: the keyboard is on whatever the operator clicked to
   * leave with, and pulling it back to a stage button on a page they are no longer looking at
   * would be worse than dropping the drawer quietly.
   */
  useEffect(() => {
    if (route.page !== "fleet") setLineDrawer(null);
  }, [route.page]);
  const closeReset = useCallback(() => setResetSessionId(null), []);
  const closeKill = useCallback(() => setKillSessionId(null), []);
  const closeFiles = useCallback(() => {
    if (filesSessionId) files.flush(filesSessionId);
    setFilesSessionId(null);
  }, [filesSessionId, files.flush]);
  const closeFilePicker = useCallback(() => setFilePickerSessionId(null), []);
  const requestFilesTab = useCallback((sessionId: string) => {
    files.ensure(sessionId);
    setFileTabRequest((request) => ({ sessionId, nonce: (request?.nonce ?? 0) + 1 }));
  }, [files.ensure]);
  const requestConversationTab = useCallback((sessionId: string) => {
    setConversationTabRequest((request) => ({ sessionId, nonce: (request?.nonce ?? 0) + 1 }));
  }, []);
  const requestWorkflowsTab = useCallback((sessionId: string) => {
    setWorkflowsTabRequest((request) => ({ sessionId, nonce: (request?.nonce ?? 0) + 1 }));
  }, []);

  /**
   * Every move the Library tour makes.
   *
   * All seven are route transitions the dashboard already performs for a link, plus the one
   * existing Workflows-tab request. Nothing here clicks a control, opens an editor, or writes:
   * the tour's whole subject is authoring, and it teaches it without authoring anything.
   */
  const libraryNavigation = useMemo<LibraryTourNavigation>(() => ({
    showLibrary: () => navigate({ page: "library" }),
    showPersona: (personaId) => navigate({ page: "library", shelf: "personas", assetId: personaId }),
    showAction: (actionId) => navigate({ page: "library", shelf: "actions", assetId: actionId }),
    showCommandSlot: () => navigate({
      page: "library",
      shelf: "commands",
      assetId: LIBRARY_TOUR_COMMAND_SLOT,
    }),
    showWorkflow: () => navigate({
      page: "library",
      shelf: "workflows",
      assetId: NO_MISTAKES_REVIEW_WORKFLOW_ID,
    }),
    showRun: (runId) => navigate({ page: "runs", runId }),
    showRunSession: (sessionId) => {
      if (!navigate({ page: "fleet" })) return false;
      setSelectedId(sessionId);
      if (layout === "board") setBoardOpen(true);
      // The existing request owner, nonce and all, rather than a second way to reveal a tab.
      requestWorkflowsTab(sessionId);
      return true;
    },
  }), [layout, navigate, requestWorkflowsTab]);
  const setupNavigation = useMemo<SetupTourNavigation>(() => ({
    showSetup: () => navigate({ page: "settings", category: "setup" }),
  }), [navigate]);
  const showLauncherFocusError = useCallback((message: string) => {
    if (launcherFocusErrorTimer.current) clearTimeout(launcherFocusErrorTimer.current);
    setLauncherFocusError(message);
    launcherFocusErrorTimer.current = setTimeout(() => {
      launcherFocusErrorTimer.current = null;
      setLauncherFocusError(null);
    }, 6000);
  }, []);
  useEffect(
    () => () => {
      if (launcherFocusErrorTimer.current) clearTimeout(launcherFocusErrorTimer.current);
    },
    [],
  );
  const openDiff = useCallback((sessionId: string, commit?: string) => {
    setSelectedId(sessionId);
    if (layout === "board") setBoardOpen(true);
    setDiffTabRequest((request) => ({
      sessionId,
      commit: commit ?? null,
      nonce: (request?.nonce ?? 0) + 1,
    }));
  }, [layout]);
  /**
   * Show one EXACT checkout-relative path in the session's Files workspace.
   *
   * The destination half of `openSessionFile`, split out because not every caller has
   * prose to parse. A path that came from `git diff` is already exact, and running it
   * through `workspaceFileTarget` would apply that function's `:line[:column]` rule to
   * it - correct for a path a human typed in a sentence, wrong for a file genuinely
   * named `notes:12`, which would silently open `notes` instead.
   */
  const openSessionPath = useCallback((
    sessionId: string,
    path: string,
    line?: number | null,
  ): void => {
    files.ensure(sessionId);
    files.select(sessionId, path);
    setSelectedId(sessionId);
    if (layout === "board") setBoardOpen(true);
    requestFilesTab(sessionId);
    // Carried beside the selection rather than through it: `files.select` is the file
    // controller's business and a scroll position is the viewer's, so folding a line into
    // `SessionFilesState` would put a transient request in durable per-session state.
    if (typeof line === "number" && line > 0) {
      setFileLineRequest((request) => ({
        sessionId,
        path,
        line,
        nonce: (request?.nonce ?? 0) + 1,
      }));
    }
  }, [files.ensure, files.select, layout, requestFilesTab]);

  const openSessionFile = useCallback((
    sessionId: string,
    href: string,
    probe = false,
  ): boolean | Promise<boolean> => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    const workspaceRoot = session ? sessionWorkspaceRoot(session) : null;
    let ambiguousRoot = false;
    const target = workspaceRoot ? workspaceFileTarget(href, workspaceRoot, () => {
      ambiguousRoot = true;
      return true;
    }) : null;
    if (!target) return false;
    if (probe) return ambiguousRoot ? files.probe(sessionId, target.path) : true;
    openSessionPath(sessionId, target.path, target.line);
    return true;
  }, [files.probe, openSessionPath, sessions]);

  /**
   * The overlays keyed on a session id, and how to drop that id.
   *
   * Whether an overlay is OPEN is answered by the registry, which the overlay populates
   * itself. This is the one fact the registry can't supply: which session an overlay is
   * bound to, so its id can be released when that session leaves the fleet. Declared
   * once here and consumed by the reconciliation effect below, so a new session-bound
   * overlay is one entry rather than another hand-written `if` in that effect.
   *
   * `reviewSessionId` is deliberately absent: the review modal is rendered from a lookup
   * that also requires a PENDING review, so it already closes on its own, and clearing
   * the id here would additionally stop it reopening when a session briefly drops out of
   * a sweep and comes back. That asymmetry predates this change; it isn't introduced by it.
   */
  const sessionBoundOverlays = useMemo(
    () => [
      { sessionId: resetSessionId, close: closeReset },
      { sessionId: completeSessionId, close: closeComplete },
      { sessionId: killSessionId, close: closeKill },
      { sessionId: filesSessionId, close: closeFiles },
      { sessionId: filePickerSessionId, close: closeFilePicker },
      {
        sessionId: workflowBindingTarget?.sessionId ?? null,
        close: () => setWorkflowBindingTarget(null),
      },
    ],
    [
      resetSessionId,
      completeSessionId,
      killSessionId,
      filesSessionId,
      filePickerSessionId,
      workflowBindingTarget,
      closeReset,
      closeComplete,
      closeKill,
      closeFiles,
      closeFilePicker,
    ],
  );

  /**
   * The runs each conversation is carrying, in a stable order, keyed by session.
   *
   * A session running a multi-repo task has ONE RUN PER REPOSITORY it changed, and a surface
   * that showed only the newest would silently hide a review. So the fold keeps them all, and
   * `workflowRunsFor` below picks the newest per REPOSITORY rather than per session: a
   * repository whose review finished and was run again should show its current run, not two.
   *
   * Ordered by repository so a card's chips do not reshuffle every time one run updates. The
   * session's own repository sorts first because its `repoRoot` is resolved to the session's
   * root and the sort is stable within a repository - and for the fleet's single-repo
   * sessions, which have exactly one run, order is not a question.
   */
  const workflowRunsBySession = useMemo(() => {
    const bySession = new Map<string, Map<string, (typeof workflowRuns)[number]>>();
    for (const run of workflowRuns) {
      if (!run.sessionId) continue;
      const byRepo = bySession.get(run.sessionId) ?? new Map();
      const key = run.repoRoot ?? "";
      const current = byRepo.get(key);
      if (!current || run.updatedAt > current.updatedAt) byRepo.set(key, run);
      bySession.set(run.sessionId, byRepo);
    }
    const out = new Map<string, (typeof workflowRuns)[number][]>();
    for (const [sessionId, byRepo] of bySession) {
      out.set(
        sessionId,
        [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, run]) => run),
      );
    }
    return out;
  }, [workflowRuns]);

  /**
   * The workflow each live conversation is armed with, keyed by session.
   *
   * Only `active` bindings: orphaned and paused ones still exist and still describe the
   * conversation's history, but they will not run at this session's completion, and a chip
   * that named them would promise a review that is not coming. The dialog still shows them -
   * it is where reattaching happens - which is the difference between a card's one-line claim
   * and a surface that exists to manage the binding.
   */
  const workflowBindingBySession = useMemo(
    () => ownBindingBySession(
      workflowBindingSummaries,
      new Map(sessions.map((session) => [session.id, session.repoRoot])),
    ),
    [workflowBindingSummaries, sessions],
  );

  // Nav-bar filter: live substring match over each card's title, status, agent, and visible
  // pull-request label. Empty filter shows everything.
  //
  // Ordered AFTER filtering, not before: `orderSessions` pulls an ensemble's siblings adjacent
  // and anchors the cluster at its first member, so a filter that hides that member has to be
  // applied first or the surviving siblings would sit at a position decided by a row nobody can
  // see. Keyboard nav and all three layouts read the result, so they stay in lockstep with
  // what's on screen.
  // Which sessions an open workflow run owns, folded once here off the same map the tile reads.
  // It reaches `orderSessions` as an argument rather than being looked up inside it because
  // held-ness is a join, not a property of a Session - see `heldSessionIds`.
  const heldIds = useMemo(() => heldSessionIds(workflowRunsBySession), [workflowRunsBySession]);

  // Repository grouping reorders the fleet, so it belongs to this memo's inputs rather than to
  // a view: `boardColumns` below is derived from the result, and the arrow keys walk those
  // arrays. Read from the same `useUiConfig` store BoardView and ConsoleView read it from, so
  // all three orderings agree by construction rather than by a prop being threaded correctly.
  const groupByRepo = useUiConfig().groupBoardByRepo;
  const fleet = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q ? sessions.filter((s) => matchesSessionFilter(s, q)) : sessions;
    return orderSessions(matched, heldIds, groupByRepo);
  }, [sessions, filter, heldIds, groupByRepo]);
  const visible = fleet.sessions;

  // Restoring rows are Board-only, but while they are visible there they obey the same
  // nav-bar filter contract as real session cards: title, displayed state, and agent. Keep
  // this derivation in App beside `visible`, so the layout remains an arranger rather than
  // growing a second opinion about what the operator asked to see.
  const visibleRestoringSessions = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? restoringSessions.filter((session) => matchesRestoringFilter(session, q))
      : restoringSessions;
  }, [restoringSessions, filter]);

  // The same filter over the board's Backlog column. A backlog item is a card the
  // operator is looking at, so the one filter box has to narrow it too - it used to
  // read straight off the unfiltered task list, which left "ghostty" showing all
  // fourteen items while the session layout beside it narrowed to none.
  const visibleBacklog = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const items = backlogTasks(tasks);
    if (!q) return items;
    return items.filter((t) => matchesTaskFilter(t, q));
  }, [tasks, filter]);

  // Dispatched, not yet standing on a session. Deliberately NOT narrowed by `filter`: this
  // is the answer to "did my dispatch land?", asked in the seconds after pressing Dispatch,
  // and a filter left over from browsing the fleet must not make the reply look like "no".
  const dispatchingTasks = useMemo(() => provisioningTasks(tasks), [tasks]);

  const counts = useMemo(() => summarize(sessions), [sessions]);
  const pendingReviews = reviews.filter((r) => r.status === "pending");
  // What the attention fold answers from, deliberately NARROWER than `pendingReviews`.
  //
  // An inbox row is a thing to act on, and a review whose session is gone has nothing left to
  // answer: it used to leave the topbar counting a question whose only entry point set
  // `reviewSessionId` to an id `sessions.find` never matched, so the click silently did
  // nothing. The daemon settles those now (`ReviewManager`'s two eviction halves), which is the
  // real fix; this is what keeps the count and what opens under it answering the same question
  // by construction, including in the seconds after a restart before the first discovery sweep
  // has said which agents are still out there. `pendingReviews` itself stays whole: Foreman's
  // draft-staleness check asks whether a review was RESOLVED, which is a different question
  // from whether its agent is still around to hear the answer.
  const answerableReviews = useMemo(() => {
    const live = new Set(sessions.map((s) => s.id));
    return pendingReviews.filter((r) => live.has(r.sessionId));
  }, [pendingReviews, sessions]);

  // Live schedule names by id, so a generated task's provenance mark reads "Scheduled by
  // <name>" without every renderer re-deriving it. Archived schedules leave the live
  // catalog, so their tasks fall back to a generic label - the deep link still works.
  const scheduleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const schedule of schedules) map.set(schedule.id, schedule.name);
    return map;
  }, [schedules]);
  // Live ensemble runs by id, so a cluster header, a chip's progress suffix and a tile flag's
  // hover copy all read the same summary. Keyed by RUN, not by session: a cluster header is
  // drawn once for several sessions, so a per-session join (the shape `workflowRunBySession`
  // takes) would answer a question nothing here is asking.
  const ensembleSummaryByRun = useMemo(() => {
    const map = new Map<string, (typeof ensembleSummaries)[number]>();
    for (const summary of ensembleSummaries) map.set(summary.id, summary);
    return map;
  }, [ensembleSummaries]);
  // The same shape for the other kind of run a session can sit under: an external engine's
  // pipeline - keyed by `pipelineRunKey` because that is what a session's own link
  // reconstitutes and what `orderSessions` buckets by. EMPTY on every fleet observing no
  // engine, which is the map every consumer of it is written to fall back from.
  const pipelineRunByKey = useMemo(() => {
    const map = new Map<string, PipelineRun>();
    for (const run of pipelineRuns) map.set(pipelineRunKeyOf(run), run);
    return map;
  }, [pipelineRuns]);
  const pipelineCommissionById = useMemo(() => {
    const map = new Map<string, (typeof pipelineCommissions)[number]>();
    for (const commission of pipelineCommissions) map.set(commission.id, commission);
    return map;
  }, [pipelineCommissions]);
  // The Ensembles tab badge: runs the DAEMON flagged as needing attention (a parked decision,
  // a failure, an unreadable row, or a member sitting on your answer). Counted here, never
  // recomputed - `ensembleNeedsAttention` is the server's derivation and the run list's dot,
  // the away digest and this badge must not invent competing thresholds.
  const ensembleAttentionCount = useMemo(
    () => ensembleSummaries.filter((s) => s.attention).length,
    [ensembleSummaries],
  );
  // Everything waiting on a person, in one ordered queue: the inbox renders it and the topbar
  // segment counts it, so the figure and what opens under it are the same fold rather than two
  // questions that agree until they don't. Folded here because every input is already in this
  // scope - and NOT through `detectAlerts`, which answers a different question (what deserves
  // an OS notification while you are away) and deliberately excludes reviews.
  const attention = useMemo(
    () =>
      foldAttention({
        sessions,
        reviews: answerableReviews,
        ensembles: ensembleSummaries,
        pipelineRuns,
      }),
    [sessions, answerableReviews, ensembleSummaries, pipelineRuns],
  );
  // The topbar badge: enabled schedules the daemon flagged as needing attention. Health is
  // the server's derivation (`schedule.health`); this only counts it, never recomputes it.
  const scheduleAttentionCount = useMemo(
    () => schedules.filter((s) => s.health === "attention").length,
    [schedules],
  );
  // First pending `input` review per session, so Foreman's Approve resolves the
  // right one instead of typing a terminal reply the blocked agent won't see.
  const inputReviewBySession = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of pendingReviews) {
      if (r.kind === "input" && !m.has(r.sessionId)) m.set(r.sessionId, r.id);
    }
    return m;
  }, [pendingReviews]);
  // Every pending review id, so Foreman's Approve can tell whether the review a
  // draft targets (its `handledMarker`) is still live or has since been resolved.
  const pendingReviewIds = useMemo(
    () => new Set(pendingReviews.map((r) => r.id)),
    [pendingReviews],
  );
  const foremanMode = foreman.config?.mode ?? "dry-run";
  const foremanAllowlist = foreman.config?.repoAllowlist;
  // The shipped default is OFF, and the worker short-circuits its whole loop on it -
  // so a card that reports only the MODE would explain a queue that isn't running by
  // describing what Foreman would do if it were running at all.
  const foremanEnabled = foreman.config?.enabled ?? false;
  // Null until BOTH reads land. A missing status cannot prove that a live worker owns the
  // lease, and a missing config cannot prove which repositories it may act in.
  const backlogTrust: BacklogTrustView | null = foreman.config && foreman.status
    ? {
        enabled: foreman.config.enabled,
        mode: foreman.config.mode,
        running: foreman.status.running,
        autoBacklog: foreman.config.autoBacklog,
        repoAllowlist: foreman.config.repoAllowlist,
      }
    : null;

  // The board's columns as ids, so the arrow keys can cross between them. Read off the same
  // `orderSessions` result the board renders - not a second grouping pass - so navigation
  // can't disagree with what's on screen, cluster reordering included.
  // Sessions inside a folded repository frame. A fold takes cards out of the DOM, so navigation
  // has to step over them: without this the cursor walked into rows nobody could see, nothing
  // drew as selected, and Enter opened a session that was not on screen. Read from the same
  // store the two views fold through, so what the arrow keys skip and what the board hides are
  // one fact. Empty for every fleet nobody has folded, which is nearly all of them.
  // Memoized because a fresh Set on every render would re-install the keyboard listener that
  // reads it, and recompute `boardColumns` beneath it, on every render. Both inputs are stable
  // between renders - the store hands back the same set until a fold changes it, and `fleet` is
  // itself a memo - so this recomputes exactly when a fold or the fleet moves.
  const collapsedRepoKeys = useRepoCollapsed();
  const foldedIds = useMemo(
    () => hiddenSessionIds(fleet.groups, collapsedRepoKeys),
    [fleet, collapsedRepoKeys],
  );

  const boardColumns = useMemo(
    () => fleet.groups.map((g) => g.sessions.filter((s) => !foldedIds.has(s.id)).map((s) => s.id)),
    [fleet, foldedIds],
  );

  // Console's detail is its selection. Board keeps its detail separate from the arrow-key
  // cursor; Enter or a click opens it, and what it opens is the cursor's session.
  const boardOpenId = boardOpen ? selectedId : null;
  const detailId = layout === "board" ? boardOpenId : selectedId;

  // A tab request is an instruction for the detail currently on screen, not a saved tab
  // preference. Leaving that detail consumes it so returning to the session later starts
  // on Conversation as usual.
  useEffect(() => {
    setFileTabRequest((request) =>
      request && request.sessionId !== detailId ? null : request,
    );
  }, [detailId]);
  useEffect(() => {
    setDiffTabRequest((request) =>
      request && request.sessionId !== detailId ? null : request,
    );
  }, [detailId]);
  useEffect(() => {
    setWorkflowsTabRequest((request) =>
      request && request.sessionId !== detailId ? null : request,
    );
  }, [detailId]);

  const modalSession = reviewSessionId ? sessions.find((s) => s.id === reviewSessionId) : null;
  const modalReviews = modalSession
    ? pendingReviews.filter((r) => r.sessionId === modalSession.id)
    : [];
  const seeWorkPreviewTask = seeWorkTourPreviewTaskId
    ? tasks.find((task) => task.id === seeWorkTourPreviewTaskId) ?? null
    : null;
  const seeWorkPreviewSession = seeWorkRun?.sessionId
    ? sessions.find((session) => session.id === seeWorkRun.sessionId) ?? null
    : seeWorkTourPreviewTaskId
      ? sessions.find((session) => session.task?.id === seeWorkTourPreviewTaskId) ?? null
      : null;
  const seeWorkPreviewFailed = Boolean(
    seeWorkTourPreviewError ||
    taskLaunchStopped(seeWorkPreviewTask),
  );
  const seeWorkDemoTask = seeWorkTourTaskId
    ? tasks.find((task) => task.id === seeWorkTourTaskId) ?? null
    : null;
  const seeWorkDemoSession = seeWorkTourTaskId
    ? sessions.find((session) => session.task?.id === seeWorkTourTaskId) ?? null
    : null;
  const seeWorkDemoReviewPending = seeWorkDemoSession
    ? pendingReviews.some((review) => review.sessionId === seeWorkDemoSession.id)
    : false;
  const seeWorkTourRuntime: SeeWorkTourRuntime = {
    previewSessionId: seeWorkPreviewSession?.id ?? null,
    previewPhase: seeWorkPreviewSession
      ? "ready"
      : seeWorkPreviewFailed
        ? "failed"
        : "launching",
    previewError: seeWorkTourPreviewError ?? seeWorkPreviewTask?.error ?? null,
    taskId: seeWorkTourTaskId,
    sessionId: seeWorkDemoSession?.id ?? null,
    phase: !seeWorkTourTaskId
      ? "not-started"
      : taskLaunchStopped(seeWorkDemoTask)
        ? "failed"
        : !seeWorkDemoSession
          ? "launching"
          : seeWorkDemoReviewPending
            ? "needs-you"
            : stateDisplay(seeWorkDemoSession).tone === "idle"
              ? "idle"
              : "working",
    dispatchOpen,
    dispatchBriefReady: seeWorkTourBriefReady,
    dispatchRepoReady: seeWorkTourRepoRoot !== null,
    completeOpen: Boolean(
      seeWorkDemoSession && completeSessionId === seeWorkDemoSession.id
    ),
    reviewPending: seeWorkDemoReviewPending,
    reviewOpen: Boolean(
      seeWorkDemoSession && reviewSessionId === seeWorkDemoSession.id && modalReviews.length > 0
    ),
    error: seeWorkDemoTask?.error ?? null,
  };
  const seeWorkTourDispatchPreview = seeWorkRun
    ? {
        id: seeWorkRun.id,
        briefReady: seeWorkTourBriefReady,
        repoRoot: seeWorkTourRepoRoot,
        dispatch: dispatchSeeWorkTourDemo,
      }
    : null;

  /** The built-in Persona and Session action the Library tour teaches on.
   *
   * Chosen from the live catalogs rather than pinned to a literal id: built-in asset ids are
   * durable app data, but the tour has no business hard-coding which shipped reviewer exists.
   * The lowest id among the active built-ins is deterministic across machines and reloads, and
   * an install with no built-in at all falls back to the tour's own "still loading" copy.
   */
  const libraryTourPersonaId = useMemo(() => (
    personas
      .filter((persona) => persona.builtin && persona.archivedAt === null)
      .map((persona) => persona.id)
      .sort()[0] ?? null
  ), [personas]);
  const libraryTourActionId = useMemo(() => (
    sessionActions
      .filter((action) => action.builtin && action.archivedAt === null)
      .map((action) => action.id)
      .sort()[0] ?? null
  ), [sessionActions]);
  const libraryTourRuntime: LibraryTourRuntime = {
    personaId: libraryTourPersonaId,
    actionId: libraryTourActionId,
    workflowReady: workflowSummaries.some(
      (workflow) => workflow.id === NO_MISTAKES_REVIEW_WORKFLOW_ID,
    ),
    run: libraryTourRun,
    // Read every render against the LIVE collection, so a session evicted between the run
    // stop and the ladder stop moves the tour to its own fallback through the ordinary event
    // path rather than through a state reading of the session it lost.
    runSessionLive: Boolean(
      libraryTourRun?.sessionId
      && sessions.some((session) => session.id === libraryTourRun.sessionId),
    ),
  };

  /**
   * Every tour's binding, keyed by `TourId`.
   *
   * The record type is the contract: a tour cannot be registered without saying how it is
   * driven and how it is cleaned up. `mount` closes over this render's runtime, so the
   * controller receives a fresh reading without generic App code touching it.
   */
  const tourBindings: Record<TourId, TourBinding> = {
    "see-work": {
      activeTaskId: seeWorkTourTaskId,
      activeRunId: null,
      cleanup: cleanupSeeWorkRun,
      mount: ({ isTop, onFinish }) => seeWorkNavigation && (
        <GuidedTourController
          definition={SEE_WORK_TOUR}
          registry={tourTargets}
          navigation={seeWorkNavigation}
          runtime={seeWorkTourRuntime}
          isTop={isTop}
          onFinish={onFinish}
        />
      ),
    },
    "library": {
      // This tour creates nothing, so it owns no task; the one resource it singles out is a
      // run that already existed, and forgetting it is the whole of its cleanup.
      activeTaskId: null,
      activeRunId: libraryTourRun?.id ?? null,
      cleanup: cleanupLibraryRun,
      mount: ({ isTop, onFinish }) => (
        <GuidedTourController
          definition={LIBRARY_TOUR}
          registry={tourTargets}
          navigation={libraryNavigation}
          runtime={libraryTourRuntime}
          isTop={isTop}
          onFinish={onFinish}
        />
      ),
    },
    "setup": {
      activeTaskId: null,
      activeRunId: null,
      cleanup: cleanupSetupRun,
      mount: ({ isTop, onFinish }) => (
        <GuidedTourController
          definition={SETUP_TOUR}
          registry={tourTargets}
          navigation={setupNavigation}
          runtime={null}
          isTop={isTop}
          onFinish={onFinish}
        />
      ),
    },
  };
  tourBindingsRef.current = tourBindings;
  const activeTourBinding = activeTour ? tourBindings[activeTour.tourId] : null;

  const selected = selectedId ? visible.find((s) => s.id === selectedId) ?? null : null;
  const visibleSelectedId = selected?.id ?? null;
  const resetSession = resetSessionId ? sessions.find((s) => s.id === resetSessionId) ?? null : null;
  const completeSession = completeSessionId
    ? sessions.find((s) => s.id === completeSessionId) ?? null
    : null;
  const killSession = killSessionId ? sessions.find((s) => s.id === killSessionId) ?? null : null;
  const filesSession = filesSessionId ? sessions.find((s) => s.id === filesSessionId) ?? null : null;
  const filePickerSession = filePickerSessionId
    ? sessions.find((s) => s.id === filePickerSessionId) ?? null
    : null;

  /**
   * Focus a session on the fleet, from wherever the operator was.
   *
   * The inbox's deep links are the callers: an item's home is a card, and a click that only
   * selected it would leave the operator on the Workflows page wondering what happened.
   *
   */
  function focusSession(sessionId: string): void {
    navigate({ page: "fleet" });
    setFilter("");
    setSelectedId(sessionId);
    if (layout === "board") setBoardOpen(true);
  }

  // Everything a layout needs, and nothing it could decide for itself. App stays the
  // one owner of session state; a view only arranges what it's handed.
  // Whether the CURRENT layout has anything to draw. Both layouts render provisioning tasks;
  // the board additionally renders backlog and restoring-session rows.
  const layoutHasContent =
    visible.length > 0 ||
    dispatchingTasks.length > 0 ||
    (layout === "board" && (visibleBacklog.length > 0 || visibleRestoringSessions.length > 0));
  const filterableSessionCount =
    sessions.length + (layout === "board" ? restoringSessions.length : 0);
  const filterableSessionNoun =
    layout === "board"
      ? `session ${filterableSessionCount === 1 ? "row" : "rows"}`
      : filterableSessionCount === 1
        ? "session"
        : "sessions";

  const viewProps: SessionViewProps = {
    sessions: visible,
    restoringSessions: visibleRestoringSessions,
    tasks,
    backlog: visibleBacklog,
    backlogPlan: foreman.backlogPlan,
    backlogTrust,
    onManageForemanTrust: openForemanTrust,
    selectedId,
    consoleZone,
    onConsoleZoneChange: setConsoleZone,
    onSelect:
      layout === "board"
        ? (id) => {
            setSelectedId(id);
            setBoardOpen(true);
          }
        : setSelectedId,
    // Selection alone, with no drill-in. The board is the
    // one caller today (a tile's workflow panel), and it wants exactly what an arrow key does.
    onCursorTo: setSelectedId,
    onDeselect: layout === "board" ? () => setBoardOpen(false) : () => setSelectedId(null),
    detailId,
    onOpenReviews: setReviewSessionId,
    onOpenDiff: openDiff,
    onOpenFiles: setFilesSessionId,
    onOpenFile: openSessionFile,
    onOpenFilePath: openSessionPath,
    fileTabRequest,
    diffTabRequest,
    conversationTabRequest,
    workflowsTabRequest,
    files,
    fileCommentThreads,
    fileCommentReviews,
    fileLineRequest,
    onReset: setResetSessionId,
    onComplete: setCompleteSessionId,
    onKill: setKillSessionId,
    onKilled,
    resetNonces,
    registerEl,
    registerWorkflowDisclosure,
    registerActions,
    registerLaunchers,
    registerFind,
    registerDetailScroll,
    isOverlayOpen,
    registerReaderTab,
    renamingId,
    onRenameStart: setRenamingId,
    onRenameClose: () => setRenamingId(null),
    foremanMode,
    foremanEnabled,
    foremanAllowlist,
    inputReviewBySession,
    pendingReviewIds,
    // The whole list, unnarrowed - the conversation replays RESOLVED reviews, which every
    // other consumer here filters out. See `SessionViewProps.reviews`.
    reviews,
    onEditTask: openTaskEditor,
    workflowRunsBySession,
    onOpenWorkflowRun: openWorkflowRun,
    workflowBindingBySession,
    onBindWorkflow: (sessionId) => setWorkflowBindingTarget({ sessionId }),
    onOpenSchedule,
    scheduleNameById,
    onOpenEnsemble: openEnsembleRun,
    ensembleSummaryByRun,
    onOpenPipelineRun: openPipelineRun,
    onOpenPipelineCommission: openPipelineCommission,
    pipelineRunByKey,
    pipelineCommissionById,
  };

  /**
   * The task the editor is over, or null. Deliberately requires `backlog` status, not
   * just existence: the whole form is a rewrite of a shelved row, and the daemon refuses
   * to rewrite one that has been dispatched - so a task that starts while its editor is
   * open must take the editor with it rather than leave a form whose Save can only fail.
   * The card can leave under you for good reasons (dropped onto an idle agent from the
   * same board, launched from the Sitrep panel, deleted), which is the task-shaped case
   * of the session-disappeared reconciliation below.
   */
  const editingTask = useMemo(
    () => (editingTaskId ? tasks.find((t) => t.id === editingTaskId && t.status === "backlog") ?? null : null),
    [editingTaskId, tasks],
  );
  useEffect(() => {
    if (editingTaskId && !editingTask) setEditingTaskId(null);
  }, [editingTaskId, editingTask]);

  // Drop selection / collapse / close the diff if the session disappears
  // (exited + reaped, etc.).
  //
  // The rename editor lives inside a session detail, so it reconciles against `visible`
  // rather than every known session. A session that leaves the filter (its status label
  // is part of the haystack, so an agent
  // going idle is enough) unmounts its editor without an unmount-time onBlur, and
  // nothing else would ever clear `renamingId`; the stand-down guard below would
  // then swallow every session shortcut for good. The overlay ids stay on `sessions`
  // because their modals are bound to a session, not to a mounted card.
  useEffect(() => {
    if (selectedId && !sessions.some((s) => s.id === selectedId)) {
      setSelectedId(null);
      // The board's drill-in goes with it. Left standing, the flag would silently
      // re-open on whatever the cursor landed on next.
      setBoardOpen(false);
    }
    for (const bound of sessionBoundOverlays) {
      if (bound.sessionId && !sessions.some((s) => s.id === bound.sessionId)) bound.close();
    }
    for (const id of Object.keys(files.sessions)) {
      if (!sessions.some((session) => session.id === id)) files.drop(id);
    }
    if (renamingId && !visible.some((s) => s.id === renamingId)) setRenamingId(null);
  }, [sessions, visible, selectedId, sessionBoundOverlays, renamingId, files.sessions, files.drop]);

  // Keep the keyboard-selected session in view as selection moves.
  useEffect(() => {
    if (!selectedId) return;
    sessionEls.current.get(selectedId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

  // The Console's keyboard lands on the rail whenever the selection or the layout
  // changes or the selected session leaves the filtered view: opening a different
  // session, filtering it away, or leaving Console and coming back all start from the
  // rail selector rather than dropping the operator mid-scroll into a reader they never
  // Tabbed into.
  useEffect(() => {
    setConsoleZone("rail");
  }, [visibleSelectedId, layout]);

  // Move DOM focus with the board's arrow cursor, onto the tile's own stretched open
  // button - the keyboard half SessionTile already draws for exactly this.
  //
  // Without it the last thing CLICKED keeps focus indefinitely (arrow selection moves no
  // focus of its own, and closing an overlay restores none), and Enter - which this app
  // deliberately leaves to a focused control rather than stealing - would fire that stale
  // button instead of opening the selected tile. Focusing the cursor makes the two the
  // same thing: native activation is the open. Scrolling is the effect above's job, hence
  // `preventScroll`.
  useEffect(() => {
    const id = pendingTileFocus.current;
    pendingTileFocus.current = null;
    if (!id || id !== selectedId) return;
    sessionEls.current
      .get(id)
      ?.querySelector<HTMLElement>("button.tile-open")
      ?.focus({ preventScroll: true });
  }, [selectedId]);

  // Fit the topbar to one row, and publish the height it settles at as `--topbar-h` for
  // the full-height Console and Board shells. See `topbarLadder.ts` for why the rungs are
  // measured rather than keyed on a width.
  //
  // After EVERY render, not once on mount: the bar's width requirement is a function of its
  // content, and its content is the fleet. A session arriving adds a pulse segment, which is
  // ~150px on a bar that may have had 40px to spare. `fitTopbar` guards its own cost.
  useLayoutEffect(() => {
    if (topbarRef.current) fitTopbar(topbarRef.current);
  });

  // And for the changes a render cannot report - the window resizing, or anything that resizes
  // the bar's content at a fixed width, like a browser minimum font size. Both live in
  // `observeTopbar`, with the reasoning, because telling those apart from the fit's own
  // settling is the subtle part and it belongs beside the fit.
  useEffect(() => (topbarRef.current ? observeTopbar(topbarRef.current) : undefined), []);

  // The palette does NOT close when the page changes - that is the whole difference between
  // it and the settings-only search it replaced. It navigates for a living, and a row that
  // flipped a setting or landed on a run would otherwise close the surface that performed it.
  // Every path that acts on a row closes it explicitly (`Palette.activate`), so the only
  // thing left to clear here is the settings anchor: once we have left settings, a stale
  // pointer at a control would flash the wrong thing on the next visit.
  useEffect(() => {
    if (route.page !== "settings") setSettingsJump(null);
  }, [route.page]);

  // Global keyboard driving. Every action's key comes from the editable bindings
  // (see useKeybindings): a keydown is normalized to a canonical chord and matched
  // against them. Esc and the arrow keys stay fixed as structural navigation.
  // Typing fields and the overlays keep their own keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      const typing = isTypingTarget(e.target);
      const chord = chordFromEvent(e);
      if (!chord) return; // a lone modifier press
      // An embedded session surface can own navigation without being a screen-owning
      // overlay. The inline diff uses this for its file list.
      if (e.defaultPrevented) return;

      // The interrupt chord yields to a live text selection, and this is the ONE gate that
      // makes it do so - ahead of every dispatch path below rather than inside any of them.
      //
      // ⌃C is Copy on Windows and Linux, which the Electron shell inherits, so the plan's
      // second decision is that a selection wins. Placing that check inside the typing
      // bypass further down would look sufficient and would not be: `typing` is true only
      // for focus inside an editable field, so selecting a transcript line, a diff hunk or
      // captured terminal output leaves it FALSE and falls straight through to the
      // `BAR_ACTIONS` dispatch, which calls `preventDefault()` unconditionally - as does the
      // board arm. Copying read-only text off a card is the most common copy in this app,
      // and it is exactly the case a bypass-local check would have broken while appearing to
      // handle the obvious one.
      //
      // Returning WITHOUT `preventDefault` is the whole point: the browser then performs the
      // copy it was always going to.
      const field = target as Partial<HTMLTextAreaElement> | null;
      if (
        chordYieldsToSelection({
          chord,
          interruptChord: bindings.interrupt,
          documentSelection: window.getSelection()?.toString() ?? "",
          fieldSelection:
            typeof field?.selectionStart === "number" || typeof field?.selectionEnd === "number"
              ? { start: field.selectionStart ?? null, end: field.selectionEnd ?? null }
              : null,
        })
      ) {
        return;
      }

      // Preserve the native activation of a focused link or button - including the
      // selected tile's own open button, which the arrow keys put the cursor on.
      if (chord === "Enter" && target?.closest("button, a[href]")) return;

      // The palette (⌘K by default) opens from ANY page and stays where it is - it indexes
      // both homes, so it no longer navigates anywhere to open, which is why this block sits
      // above the non-fleet return below and no longer touches the route. It is a plain
      // bubble-phase handler, so the Keyboard panel's capture-phase chord recorder still
      // swallows ⌘K while recording - "recording wins", the same contract the palette keeps.
      //
      // `onlyOpen` is the sitrep chord's pattern: fire when nothing is open, OR when the only
      // thing open is this palette (so ⌘K toggles it shut), but STAND DOWN for anyone else's
      // overlay - a dispatch dialog or Files must not end up mounted behind a palette. The
      // text-field bypass is gated on a ⌘/⌃ modifier: ⌘K is unambiguous mid-sentence, but a
      // bare-key rebinding must stay behind the typing guard, or that character would open
      // the palette from inside any input.
      if (
        chord === bindings.settingsSearch &&
        (!typing || chordHasCommandModifier(bindings.settingsSearch)) &&
        overlaysRef.current.onlyOpen(OVERLAY_IDS.palette)
      ) {
        e.preventDefault();
        setPaletteOpen((open) => {
          if (!open) paletteInvokerRef.current = captureFocusBookmark(document.activeElement);
          return !open;
        });
        return;
      }

      // The customizable Shift+F10 action and the keyboard's dedicated Menu key open the
      // same global host, from every page and from inside text fields. A rebound editing,
      // navigation or printable key still respects the typing guard; function keys have no
      // native text-field behavior and may keep the default's access from the composer.
      if (
        (e.key === "ContextMenu" || chord === bindings.contextMenu)
        && (
          !typing
          || e.key === "ContextMenu"
          || chordUsesFunctionKey(bindings.contextMenu)
        )
      ) {
        const focusTarget = target ?? (document.activeElement instanceof Element
          ? document.activeElement
          : null);
        if (contextMenuRef.current?.openFromKeyboard(focusTarget)) e.preventDefault();
        return;
      }

      // Delete is page-contextual rather than fleet-only. Every participating button
      // registers itself in the DOM; resolution prefers the focused row/current surface and
      // fails closed when several destructive controls are otherwise equally plausible.
      // A bare binding never fires while typing, including confirmation phrase fields.
      if (
        !typing
        && deleteShortcutMatchesChord({
          chord,
          deleteBinding: bindings.delete,
          diffBinding: bindings.diff,
        })
        && activateDeleteShortcut(e.target)
      ) {
        e.preventDefault();
        return;
      }

      // Fleet, Library and Runs are direct destinations rather than toggles. Their chords
      // fire off every page and sit above the fleet-only guard for that reason. The shared
      // pure helper keeps their typing/rename/overlay stand-downs testable without a DOM.
      const pageTarget = PAGE_SEGMENTS.find(({ action }) => chord === bindings[action])?.id ?? null;
      const shortcutTarget = pageShortcutRoute({
        target: pageTarget,
        typing,
        renaming: Boolean(renamingId),
        overlayOpen: overlaysRef.current.anyOpen,
      });
      if (shortcutTarget) {
        e.preventDefault();
        navigate(shortcutTarget);
        return;
      }

      // Every page that is not the fleet owns its own keys - the Workflows editor, the
      // Settings rail and its Escape. Fleet shortcuts must not dispatch, select, or drive a
      // session merely because its state remains mounted in App.
      if (route.page !== "fleet") return;

      // Sitrep toggles whether it's open or closed, so it stands down for every overlay
      // EXCEPT its own - `onlyOpen` is what draws that distinction without naming the
      // others. Asking the registry rather than listing overlays here is the point: a new
      // overlay is counted the moment it renders, with no edit to this guard.
      if (
        !typing &&
        !renamingId &&
        overlaysRef.current.onlyOpen(OVERLAY_IDS.sitrep) &&
        chord === bindings.roundup
      ) {
        e.preventDefault();
        setReportOpen((v) => !v);
        return;
      }

      // Stand down while any overlay owns the screen (or a session title is being
      // edited), so layout shortcuts don't drive a background session behind it.
      if (overlaysRef.current.anyOpen || renamingId) return;

      // Fold or unfold the Line. Chrome above every layout, so it sits here with the other
      // page-level toggles rather than among the session actions below - it drives no
      // session and needs no selection.
      //
      // `!typing` and no modifier exemption: this is a bare letter, and the one thing it
      // must never do is eat an `L` out of a half-written reply. Unlike interrupt below
      // there is no argument for reaching it from inside the composer - the strip is still
      // fully readable while you type, and the caret is one click away.
      if (!typing && chord === bindings.lineDensity) {
        e.preventDefault();
        // `toggleLineDensity()` rather than `setLineDensity(next(lineDensity))`: this
        // listener is registered by an effect with an explicit dependency list, and reading
        // the density from render here made every press after the first a no-op. See that
        // function for the whole story.
        toggleLineDensity();
        return;
      }

      // Escape closes the Line's drawer, but only while the keyboard is INSIDE it or on the
      // strip that opened it.
      //
      // Scoped by focus rather than taken unconditionally, because Escape on this page is
      // already a ladder that peels one layer at a time - session detail, then reader, then
      // board drill-in, then selection - and the drawer is not above any of those. It is
      // beside them. A drawer left open while you work in the console reader must not eat
      // the Escape that hands the keyboard back to the rail; a drawer you are reading must
      // close on the first press, which is where the keyboard actually is (the drawer takes
      // focus as it opens, and a close returns it to the stage button - so both ends of that
      // journey are in scope). It sits below the overlay stand-down above, which is what
      // makes "the drawer closes only when it is the topmost surface" true.
      if (
        chord === "Escape" &&
        lineDrawerRef.current &&
        (target?.closest(".line-drawer") || target?.closest(".line"))
      ) {
        e.preventDefault();
        closeLineDrawer();
        return;
      }

      // Reader navigation - identical in the console and the board drill-in, because both
      // mount the same ConsoleDetail. A session's detail is open (the console always shows
      // one beside the rail; the board shows one while drilled in), and Tab walks the
      // keyboard rightward through it: from the rail INTO the reader - landing on the
      // conversation pane the arrows scroll - then across the tab strip Conversation -> Work
      // queue -> Gate -> Diff -> Files, clamping at the last rather than tabbing away.
      // Shift+Tab walks left, and from the first tab hands the keyboard back to the rail.
      //
      // The gate is where DOM focus ACTUALLY is (`.cdetail` ancestry), never the
      // `consoleZone` React state, which lags and once desynced let a bare Tab fall through
      // to native browser tabbing (it walked to the next rail row). Reading focus is self-
      // correcting: outside the reader Tab always enters, inside it Shift+Tab always steps.
      // `consoleZone` is still set so the console's rail dimming follows, but it no longer
      // gates anything. `!typing` keeps native Tab in the topbar filter and the reply
      // composer; Shift+Tab outside the reader falls through to the `mode` binding below.
      const readerSession =
        layout === "console" ? selected : layout === "board" && boardOpen ? selected : null;
      if (readerSession && !typing) {
        const inReader = Boolean(target?.closest(".cdetail"));
        if (chord === "Tab") {
          e.preventDefault();
          if (!inReader) {
            setConsoleZone("detail");
            focusReaderBody();
          } else {
            readerTabbers.current.get(readerSession.id)?.(1);
          }
          return;
        }
        if (chord === "shift+Tab" && inReader) {
          e.preventDefault();
          // Step one tab left; running off the front ("edge", or no stepper) is the signal
          // to leave the reader and hand the keyboard back to the rail selection.
          if (readerTabbers.current.get(readerSession.id)?.(-1) !== "moved") {
            setConsoleZone("rail");
            focusReaderRail(readerSession.id);
          }
          return;
        }
      }

      // Interrupt is the second action allowed to fire from inside a text field, and the
      // only one that HAS to be. The whole reason the gesture exists is that the
      // replacement instruction gets typed immediately, so the cursor is usually already in
      // the composer when it is pressed - and the guard below would otherwise make this the
      // one chord that is dead exactly where it is most wanted.
      //
      // Gated on a ⌘/⌃ modifier the way the palette above is, so a rebinding to a bare key
      // falls back behind the guard rather than eating that character out of a half-written
      // message. The selection case is already settled at the top of this handler and must
      // not be re-implemented here.
      //
      // It runs against the selected session's own bar, which is the same handle the
      // `BAR_ACTIONS` dispatch below reaches; with no bar mounted there is no composer to
      // have been typing in, so the guard takes it.
      if (typing && chord === bindings.interrupt && chordHasCommandModifier(chord)) {
        const bar = selectedId ? actionHandles.current.get(selectedId) : undefined;
        if (bar) {
          e.preventDefault();
          bar.requestInterrupt();
          return;
        }
      }

      if (typing) return;

      // Global chords that don't need a selected session. Kept above the empty-fleet
      // guard so dispatch still opens when there are no sessions yet.
      if (chord === bindings.dispatch) {
        e.preventDefault();
        openDispatch();
        return;
      }
      if (chord === bindings.filter) {
        e.preventDefault();
        filterRef.current?.focus();
        return;
      }

      // The flat rail order, minus anything a folded repository frame is hiding. `visible` itself
      // is NOT filtered: the views still need every session to draw a frame's count and to know
      // what a fold is covering. Only what the keyboard walks is narrowed.
      const ids = visible.filter((s) => !foldedIds.has(s.id)).map((s) => s.id);
      if (ids.length === 0) return;
      const handle = (): ActionBarHandle | undefined =>
        selectedId ? actionHandles.current.get(selectedId) : undefined;

      // Fixed structural navigation (not rebindable).
      switch (e.key) {
        case "Escape":
          // Files Preview has one closer keyboard layer inside the detail. Escape leaves the
          // rendered page for its selected file first, matching Shift+Tab; only a later press
          // peels the whole detail back to the session rail.
          if (
            readerSession
            && target?.closest(".file-preview-reader")
            && readerTabbers.current.get(readerSession.id)?.(-1) === "moved"
          ) {
            e.preventDefault();
            return;
          }
          // The reader (console detail or board drill-in) sits above the selection: if the
          // keyboard is inside it, one Escape hands it back to the
          // rail, and only the NEXT closes the board drill-in or drops the selection.
          if (readerSession && target?.closest(".cdetail")) {
            e.preventDefault();
            setConsoleZone("rail");
            focusReaderRail(readerSession.id);
            return;
          }
          if (layout === "board" && boardOpen) {
            e.preventDefault();
            setBoardOpen(false);
            return;
          }
          if (!selectedId) return;
          e.preventDefault();
          handle()?.cancel();
          setSelectedId(null);
          return;
        case "ArrowRight":
        case "ArrowLeft":
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          // Preview owns vertical arrows before focus enters its rendered page, using them
          // to walk files. Other tabs claim them only with focus inside the reader. Anything
          // unclaimed falls through to `moveSelection` and walks the session rail.
          if (
            readerSession &&
            (e.key === "ArrowUp" || e.key === "ArrowDown")
          ) {
            const detailScroll = detailScrollers.current.get(readerSession.id);
            const fromReader = Boolean(target?.closest(".cdetail"));
            if (detailScroll?.(e.key === "ArrowUp" ? -1 : 1, fromReader)) return;
          }
          const nextId = moveSelection({
            mode: layout,
            key: e.key as ArrowKey,
            ids,
            currentId: selectedId,
            columns: boardColumns,
          });
          if (nextId) {
            setSelectedId(nextId);
            // Walking the console rail: focus follows to the new row (we only reach here
            // when the keyboard was NOT in the reader - that path returned above).
            if (layout === "console") focusReaderRail(nextId);
            // Once drilled in, the board is a console rail: arrows switch the open detail
            // too, which `boardOpenId` gets for free. In the overview they only move the
            // tile cursor - and take DOM focus with them, so Enter opens what you see.
            if (layout === "board" && !boardOpen) pendingTileFocus.current = nextId;
          }
          return;
        }
        case "Enter":
          // A MODIFIED Enter is an ordinary bindable chord and must reach the matching
          // below - the switch keys off `e.key`, so it lands here too and used to be
          // eaten by the key it merely shares.
          if (chord !== "Enter") break;
          if (!selectedId) break;
          if (layout === "board" && !boardOpen) {
            e.preventDefault();
            setBoardOpen(true);
            return;
          }
          break;
      }

      // Actions on the selected session.
      if (chord === bindings.expand) {
        // This action is the Board card's in-place workflow disclosure only. It never
        // opens Conversation (Enter owns the drill-in), never closes an open drill-in,
        // and stays unclaimed where there is no selected session with a bound workflow.
        if (layout !== "board" || boardOpen || !selectedId) return;
        const disclosure = workflowDisclosureHandles.current.get(selectedId);
        if (!disclosure) return;
        e.preventDefault();
        disclosure.toggle();
        return;
      }
      // "Show me this session's conversation" - which is a different action in each
      // layout, so WHICH one is decided by `conversationReveal` and only performed here.
      // The decision is pure and lives in lib/ because nothing in test/ can dispatch a
      // keydown into this handler; see that module's comment.
      if (chord === bindings.conversation) {
        const sel = selectedId ? visible.find((s) => s.id === selectedId) : null;
        const reveal = conversationReveal({
          layout,
          hasSelection: sel != null,
          boardDetailOpen: boardOpen,
        });
        if (reveal === "none" || !sel) return;
        e.preventDefault();
        if (reveal === "drill-in") setBoardOpen(true);
        else if (reveal === "tab") requestConversationTab(sel.id);
        return;
      }
      // Find in the selected session's conversation. Reuses `conversationReveal` rather
      // than requiring the transcript to be on screen already: asking to search a
      // conversation is asking to see it, so an unrevealed one is revealed first and the
      // open is replayed by `registerFind` when that panel mounts. A transcript already
      // mounted takes the direct path and opens on this keystroke.
      if (chord === bindings.findInConversation) {
        const sel = selectedId ? visible.find((s) => s.id === selectedId) : null;
        if (!sel) return;
        e.preventDefault();
        const mounted = findHandles.current.get(sel.id);
        if (mounted) {
          mounted.open();
          return;
        }
        const reveal = conversationReveal({
          layout,
          hasSelection: true,
          boardDetailOpen: boardOpen,
        });
        if (reveal === "none") return;
        pendingFind.current = sel.id;
        if (reveal === "drill-in") setBoardOpen(true);
        else if (reveal === "tab") requestConversationTab(sel.id);
        return;
      }
      if (chord === bindings.diff) {
        if (!selectedId) return;
        e.preventDefault();
        openDiff(selectedId); // the shortcut means the whole branch, not a stale fix
        return;
      }
      if (chord === bindings.files) {
        const sel = selectedId ? visible.find((s) => s.id === selectedId) : null;
        if (!sel?.cwd) return;
        const detailOpen = layout === "console" || (layout === "board" && boardOpen);
        if (!detailOpen) return;
        e.preventDefault();
        requestFilesTab(sel.id);
        return;
      }
      // "Show me how this session's run is going" - the Workflows tab, which holds both the
      // workflow ladder.
      if (chord === bindings.sessionWorkflows) {
        const sel = selectedId ? visible.find((s) => s.id === selectedId) : null;
        if (!sel) return;
        e.preventDefault();
        // The board's overview shows tiles, not the detail that owns the tab, so drill in
        // first - the same reveal-then-act `openDiff` performs for the Diff tab.
        if (layout === "board") setBoardOpen(true);
        requestWorkflowsTab(sel.id);
        return;
      }
      if (chord === bindings.filePicker) {
        const sel = selectedId ? visible.find((s) => s.id === selectedId) : null;
        if (!sel?.cwd) return;
        e.preventDefault();
        files.ensure(sel.id);
        setFilePickerSessionId(sel.id);
        return;
      }
      if (chord === bindings.rename) {
        if (!selectedId) return;
        const sel = visible.find((s) => s.id === selectedId);
        // Only renameable sessions (a live terminal pane) open the editor.
        if (!sel || !canRenameSession(sel)) return;
        e.preventDefault();
        setRenamingId(selectedId);
        return;
      }
      // Hard-resets the selected session's checkout to origin's default branch and
      // clears its context - a "start this checkout over" chord, confirmed first by
      // ResetModal. Needs a session with a working dir; without one we leave the chord
      // alone, so the default Ctrl+R still falls through to a harmless browser reload.
      if (chord === bindings.reset) {
        const sel = selectedId ? visible.find((s) => s.id === selectedId) : null;
        if (!sel?.cwd) return;
        e.preventDefault();
        setResetSessionId(sel.id);
        return;
      }
      // The review queue. The same click the attention-toned badge on the card performs,
      // and deliberately the same TARGET rule: the selected session when it is the one
      // asking, otherwise the first session in fleet order that is. Unclaimed - no
      // `preventDefault` - when nothing anywhere is waiting, so a bare `e` on a quiet
      // fleet stays the browser's.
      if (chord === bindings.review) {
        const target = reviewShortcutTarget(visible, selectedId);
        if (!target) return;
        e.preventDefault();
        if (target.refocus) focusSession(target.sessionId);
        setReviewSessionId(target.sessionId);
        return;
      }
      const launcher = LAUNCHER_ACTIONS.find(([id]) => chord === bindings[id]);
      if (launcher) {
        const sel = selectedId ? visible.find((session) => session.id === selectedId) : null;
        if (!sel) return;
        e.preventDefault();
        const run = launcher[1];
        const mounted = launcherHandles.current.get(sel.id);
        if (mounted) {
          mounted[run]();
          return;
        }
        if (run === "openAgent") {
          const action = agentLaunchAction(sel);
          if (!action) return;
          if (action === "focus") {
            void api.focus(sel.id).then((result) => {
              if (!result.ok) {
                showLauncherFocusError(result.error ?? "could not focus");
              }
            });
            return;
          }
        }

        // The Board overview mounts the toolbar only after it drills in. Console and an
        // already-open Board detail may be sitting on another
        // tab. Reveal Conversation in the appropriate vocabulary, then registration runs
        // the exact button action rather than choosing a terminal backend on the user's
        // behalf.
        pendingLauncherAction.current = { id: sel.id, run };
        if (layout === "board" && !boardOpen) {
          setBoardOpen(true);
        } else {
          requestConversationTab(sel.id);
        }
        return;
      }
      const bar = BAR_ACTIONS.find(([id]) => chord === bindings[id]);
      if (!bar) return;
      const run = bar[1];
      const h = handle();
      if (h) {
        e.preventDefault();
        h[run]();
        return;
      }
      // No bar registered for the selection. On the board's overview that is structural
      // rather than an absence: only the drill-in draws an action bar, so a tile the
      // arrows merely landed on has none - which made `s`/`⇧F`/`q`/`k` silent no-ops
      // there and broke "every shortcut works in every layout". Drill in and run against
      // the bar that mounts with it, one render later.
      if (layout !== "board" || !selectedId || boardOpen) return;
      const overviewSel = visible.find((s) => s.id === selectedId);
      // Shift+Tab is the exception: cycling the permission mode is a live control on the
      // session's pane, not a reveal inside the detail, so run it in place. Drilling in for
      // it opened the detail for a keystroke that never needed it - the reported bug. If the
      // session cannot cycle, it does nothing (and still swallows the key, so the board keeps
      // its cursor) rather than opening.
      if (run === "cycleMode") {
        e.preventDefault();
        if (overviewSel && canCycleMode(overviewSel)) void api.cycleMode(overviewSel.id);
        return;
      }
      // Interrupt is the second of those, for the identical reason: stopping an agent is a
      // live control, not a reveal, and drilling into a detail nobody asked for while the
      // agent goes on working is the bug the arm above was added to fix. The shared
      // `canInterruptSession` is the same gate the ActionBar button reads, so a tile and a
      // card cannot disagree about whether the key does anything - and the optimistic badge
      // is raised here too, or the board would show nothing at all until the driver replied.
      if (run === "requestInterrupt") {
        e.preventDefault();
        if (overviewSel && canInterruptSession(overviewSel)) {
          markInterrupting(overviewSel.id);
          void api.interrupt(overviewSel.id).then((r) => {
            // `stoppedTurn: false` alongside it: the turn ended on its own before the request
            // landed, so there is no stop for the badge to be describing. The overview draws
            // no flash, so retiring the badge is the whole of what this surface can say - and
            // the tile's own state, which is about to read `idle`, is the honest answer.
            if (!r.ok || r.stoppedTurn === false) clearInterrupting(overviewSel.id);
          });
        }
        return;
      }
      e.preventDefault();
      pendingBarAction.current = { id: selectedId, run };
      setBoardOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // No `overlays` entry: the guards read `overlaysRef`, so this listener does not need
    // re-subscribing when an overlay opens - and, more to the point, its correctness no
    // longer depends on that re-subscription having happened yet. This dependency array
    // was the third place a new overlay used to have to be remembered, and the one with no
    // visible symptom when it was missed.
    // No `lineDrawer` entry either, for the same reason: the guard reads `lineDrawerRef`.
    // No `focusSession` entry: it is a plain function, so listing it would re-subscribe on
    // every render. It is safe to close over because everything it reads that can go stale
    // - `navigate` and `layout` - is already a dependency here, so the copy this listener
    // holds is rebuilt whenever either of them moves.
  }, [visible, foldedIds, selectedId, selected, consoleZone, boardOpen, renamingId, bindings, layout, files.ensure, requestFilesTab, requestConversationTab, requestWorkflowsTab, showLauncherFocusError, openDiff, route.page, navigate, focusReaderRail, focusReaderBody, closeLineDrawer]);

  // Run the chord the board's overview had to open a detail for. Deferred for the same
  // reason as the reply focus below - the action bar it drives mounts on the render this
  // effect trails - and reconciled against what actually opened, so a selection that moved
  // in between doesn't get an action aimed at its neighbour.
  useEffect(() => {
    const pending = pendingBarAction.current;
    pendingBarAction.current = null;
    if (!pending || pending.id !== boardOpenId) return;
    actionHandles.current.get(pending.id)?.[pending.run]();
  }, [boardOpenId]);

  /**
   * Record which asset a Library surface has open, in the address bar, without a history
   * entry and without waking the dirty-draft gate.
   *
   * The surface owns the selection and has already asked its own discard question by the
   * time this runs, so `replace` rather than `navigate`: routing it would raise the router's
   * "leave anyway?" dialog on top of the editor's, about a draft the operator just answered
   * for, on a page they are not leaving.
   */
  const replaceLibrarySelection = useCallback(
    (shelf: LibrarySurface, assetId: string | null): void => {
      replace({
        page: "library",
        shelf,
        // No asset open on a surface that was asked for a blank draft means the draft IS what
        // is open, so `/new` stays in the address bar rather than being replaced by the bare
        // shelf - which would have reloaded into somebody else's first Persona. It gives way
        // the moment a real asset is selected or the draft is saved.
        ...(assetId ? { assetId } : creatingRef.current ? { creating: true as const } : {}),
      });
    },
    [replace],
  );
  // Per-shelf and memoized, because each is a dependency of the effect inside its surface
  // that reports the selection: a callback rebuilt every render would re-run that effect on
  // every render.
  const onWorkflowSelected = useCallback(
    (id: string | null) => replaceLibrarySelection("workflows", id),
    [replaceLibrarySelection],
  );
  const onPersonaSelected = useCallback(
    (id: string | null) => replaceLibrarySelection("personas", id),
    [replaceLibrarySelection],
  );
  const onActionSelected = useCallback(
    (id: string | null) => replaceLibrarySelection("actions", id),
    [replaceLibrarySelection],
  );
  const onCommandSelected = useCallback(
    (id: string | null) => replaceLibrarySelection("commands", id),
    [replaceLibrarySelection],
  );

  /**
   * The way out of an authoring surface, for its back row and its Escape ladder alike.
   *
   * `navigate`, not `replace` and not `history`: the surfaces report their own SELECTION
   * through `replace` precisely because that bypasses the dirty gate, and leaving the page
   * is the opposite case - the gate is what turns Escape from a way to lose a draft into a
   * question about one. One callback for both exits, so there is one path to keep honest.
   */
  const leaveLibrary = useCallback(() => {
    navigate({ page: "library" });
  }, [navigate]);

  const libraryShelf = route.page === "library" ? route.shelf ?? null : null;
  const libraryAssetId = route.page === "library" ? route.assetId ?? null : null;
  const libraryCreating = route.page === "library" && route.creating === true;
  // Mirrored so `replaceLibrarySelection` can read it without becoming a new function on
  // every route change - it is a dependency of the effect inside each surface that reports
  // the selection, and rebuilding it would re-run that effect on every render.
  const creatingRef = useRef(libraryCreating);
  creatingRef.current = libraryCreating;
  /**
   * The Library page: the shelves, or one authoring surface one level deeper.
   *
   * The surfaces are the same components the Workflows page used to mount by tab id, moved
   * rather than reimplemented. They learned exactly two things on the way: which asset the
   * route named as they mount, and how to say which one they have open. Selection itself,
   * and the discard question that guards it, stayed where the draft is.
   */
  const libraryBody = libraryShelf === "workflows"
    ? (
      <main className="lib-surface">
        <WorkflowLibrary
          summaries={workflowSummaries}
          personas={personas}
          sessionActions={sessionActions}
          workflowCommands={workflowCommands}
          hasSnapshot={hasSnapshot}
          initialWorkflowId={libraryAssetId}
          startNew={libraryCreating}
          isOverlayOpen={isOverlayOpen}
          onLeave={leaveLibrary}
          onDirtyChange={setWorkflowDirty}
          onSelectionChange={onWorkflowSelected}
          onBindVersion={(version) => setWorkflowBindingTarget({
            workflowVersionId: version.id,
            workflowId: version.workflowId,
            bindingDefaults: version.bindingDefaults,
          })}
          onBindWorkflow={(workflow) => setWorkflowBindingTarget({
            workflowId: workflow.id,
            // Null only while a draft has never been published, and the button that reaches
            // here is not offered for one. Passing it through regardless keeps the dialog's
            // "choose a version" state reachable instead of inventing a selection.
            workflowVersionId: workflow.currentVersionId ?? undefined,
          })}
        />
      </main>
    )
    : libraryShelf === "commands"
    ? (
      // The one Library surface with a CLOSED catalog: four built-in slots, no New, and the
      // live views straight off the snapshot rather than a second fetch of the same rows.
      <main className="lib-surface">
        <CommandLibrary
          commands={workflowCommands}
          hasSnapshot={hasSnapshot}
          initialSlot={libraryAssetId}
          isOverlayOpen={isOverlayOpen}
          onLeave={leaveLibrary}
          onDirtyChange={setWorkflowDirty}
          onSelectionChange={onCommandSelected}
        />
      </main>
    )
    : libraryShelf === "personas"
      ? (
        <main className="lib-surface">
          <PersonaLibrary
            personas={personas}
            workflowSummaries={workflowSummaries}
            workflowRuns={workflowRuns}
            hasSnapshot={hasSnapshot}
            providers={llm.status?.runners ?? []}
            defaults={llm.personaDefaults}
            foremanSummary={{
              runner: foreman.status?.runner ?? null,
              models: foreman.status?.models ?? null,
              roleRunners: foreman.status?.roleRunners ?? null,
            }}
            upstream={personaDrift.upstream}
            onCheckUpstream={personaDrift.refresh}
            onOpenForemanModels={() => openSettingsAnchor("models", "models/foreman")}
            onOpenForemanPosture={() => openSettingsAnchor("foreman", "foreman/cheap-tier")}
            onOpenForemanTrust={openForemanTrust}
            onOpenForemanControl={() => setForemanOpenRequest((request) => request + 1)}
            initialPersonaId={libraryAssetId}
            startNew={libraryCreating}
            isOverlayOpen={isOverlayOpen}
            onLeave={leaveLibrary}
            onDirtyChange={setWorkflowDirty}
            onSelectionChange={onPersonaSelected}
          />
        </main>
      )
      : libraryShelf === "actions"
        ? (
          <main className="lib-surface">
            <SessionActionLibrary
              sessionActions={sessionActions}
              workflowSummaries={workflowSummaries}
              workflowRuns={workflowRuns}
              hasSnapshot={hasSnapshot}
              initialActionId={libraryAssetId}
              startNew={libraryCreating}
              isOverlayOpen={isOverlayOpen}
              onLeave={leaveLibrary}
              onDirtyChange={setWorkflowDirty}
              onSelectionChange={onActionSelected}
            />
          </main>
        )
        : (
          <LibraryPage
            workflowSummaries={workflowSummaries}
            personas={personas}
            foremanSummary={{
              runner: foreman.status?.runner ?? null,
              models: foreman.status?.models ?? null,
              roleRunners: foreman.status?.roleRunners ?? null,
            }}
            personaUpstream={personaDrift.upstream}
            sessionActions={sessionActions}
            workflowCommands={workflowCommands}
            hasSnapshot={hasSnapshot}
            workflowRuns={workflowRuns}
            ensembleSummaries={ensembleSummaries}
            ensembleAttentionCount={ensembleAttentionCount}
            schedules={schedules}
            onOpenAsset={(shelf, assetId) => navigate({ page: "library", shelf, assetId })}
            onCreateAsset={(shelf) => navigate({ page: "library", shelf, creating: true })}
            onLaunchEnsemble={launchEnsemble}
            onOpenRuns={() => navigate({ page: "runs" })}
            onOpenEnsembles={() => navigate({ page: "ensembles" })}
            onOpenMissions={openMissions}
            onOpenTaskSources={() => navigate({ page: "settings", category: "task-sources" })}
          />
        );

  return (
    <OverlayHost value={overlays}>
      <TourTargetHost
        registry={tourTargets}
        activeTaskId={activeTourBinding?.activeTaskId ?? null}
        activeRunId={activeTourBinding?.activeRunId ?? null}
      >
      <ContextMenuHost ref={contextMenuRef} />
      <div className={`app app-${layout}`}>
        <header className="topbar" ref={topbarRef}>
          <div className="brand">
            <img className="brand-mark" src="/favicon.svg" alt="" width={20} height={20} />
            <h1>Mission Control</h1>
          </div>
          {/* The three primary pages as one control: sessions, reusable authoring, and run
              history. Each segment has its own direct chord, so its label and keycap keep
              the same meaning from every page. `aria-current` rather than `aria-pressed`:
              these are navigation, and only one of them is where you are. */}
          <nav className="page-seg" aria-label="Pages">
            {PAGE_SEGMENTS.map(({ id, action, label, glyph, hint }) => {
              const current = route.page === id;
              const chord = formatChord(bindings[action]);
              return (
                <Tooltip
                  key={id}
                  label={chord ? `${hint} (${chord})` : hint}
                >
                  <button
                    className={`page-seg-btn${current ? " is-current" : ""}`}
                    {...(current ? { "aria-current": "page" as const } : {})}
                    onClick={() => navigate({ page: id })}
                  >
                    <span aria-hidden>{glyph}</span>
                    <span className="tb-label">{label}</span>
                    <Keycap action={action} />
                  </button>
                </Tooltip>
              );
            })}
          </nav>
          {/* A <label>, not a <div>: at narrow widths the input collapses to zero and the
              box is just its ⌕, so the click that opens it lands on the glyph rather than
              on the field. An implicit label makes that click focus the input, which is
              what makes the collapse a control instead of a dead icon. */}
          <label className="filter-box">
            <span className="filter-icon" aria-hidden>
              ⌕
            </span>
            <input
              ref={filterRef}
              className="filter-input"
              type="text"
              placeholder={`Filter (${formatChord(bindings.filter)})`}
              aria-label="Filter sessions by title, status, agent, or PR number"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  if (filter) setFilter("");
                  else e.currentTarget.blur();
                }
              }}
            />
            {filter && (
              <Tooltip label="Clear the filter">
                <button
                  className="filter-clear"
                  aria-label="Clear filter"
                  onClick={() => {
                    setFilter("");
                    filterRef.current?.focus();
                  }}
                >
                  ✕
                </button>
              </Tooltip>
            )}
          </label>
          <FleetPulse
            connected={connected}
            keepAwake={keepAwakeStatus}
            sessions={sessions.length}
            attention={counts.attention}
            working={counts.working}
            inbox={attention.total}
            onOpenInbox={() => setInboxOpen(true)}
          />
          {launcherFocusError && (
            <span className="launch-flash is-error" role="status">
              {launcherFocusError}
            </span>
          )}
          {/* A READOUT, so it sits with the pulse rather than inside the action cluster
              below - which is three ranked groups of CONTROLS, and a figure dropped into
              them would break the rank it teaches. The bar's whole right-hand side is
              this phase's; the page segment arriving on the left is another's. */}
          <SpendChip
            fleet={fleetCost}
            view={cost.status?.config.view ?? "usd"}
            onOpenCostSettings={() => navigate({ page: "settings", category: "cost" })}
          />
          {/* Twelve peers at one weight is what made this bar unreadable, so the
              cluster is THREE groups with a rank, not one rhythm: destinations you
              navigate to, the two controls that act on the fleet (Foreman's posture and
              the primary Dispatch), and the glyph tools. The groups sit at 16px from each
              other and 8px within, which is what lets the eye find four things instead of
              counting twelve. `live` is no longer stranded past the end of it - it moved
              into the pulse, where the rest of the status lives.

              Each degradable label is a `.tb-label`: at narrow container widths it goes
              visually-hidden rather than `display: none`, so the button keeps its
              accessible name and only its glyph is drawn. Dispatch has no `.tb-label` -
              the one control you would hunt for keeps its word at every width. */}
          <div className="topbar-actions">
            <div className="tb-group">
              <Tooltip label="Recurring missions - schedule tasks on a cadence, preview, and audit run history">
                <button
                  className="ghost-btn missions-btn"
                  onClick={openMissions}
                  aria-label={
                    scheduleAttentionCount > 0
                      ? `Recurring missions - ${scheduleAttentionCount} need attention`
                      : "Recurring missions"
                  }
                >
                  <span aria-hidden>◷</span> <span className="tb-label">Missions</span>
                  {scheduleAttentionCount > 0 && (
                    <span className="ghost-badge">{scheduleAttentionCount}</span>
                  )}
                </button>
              </Tooltip>
            </div>
            <div className="tb-group">
              <ForemanBar
                state={foreman}
                openRequest={foremanOpenRequest}
                onOpenSettings={() => navigate({ page: "settings", category: "foreman" })}
              />
              <Tooltip label={`Dispatch a new agent (${formatChord(bindings.dispatch)})`}>
                <button className="dispatch-btn" onClick={openDispatch} ref={dispatchTourRef}>
                  {/* The keycap REPLACES the decorative glyph rather than sitting beside
                      it: the default chord is "+", so drawing both put a ＋ on each end of
                      one word and read as a rendering fault. Any other chord takes the
                      same slot, which is the one place on this button an operator is
                      already looking. */}
                  {keybindingHints ? <Keycap action="dispatch" /> : <span aria-hidden>＋</span>}
                  Dispatch
                </button>
              </Tooltip>
            </div>
            <div className="tb-group tb-tools">
              {/* Glyph-only, like its two peers, and so it adds the same ~30px at every rung
                  rather than a word that has to be shed. The accessible name is the same
                  phrase the palette row uses, at every width, because this button is the
                  one an unhappy person hunts for and it must not go quiet. */}
              <Tooltip label="Report product feedback - file a public GitHub issue about Mission Control">
                <button
                  className="ghost-btn glyph-btn feedback-btn"
                  onClick={openFeedback}
                  aria-label="Report product feedback"
                >
                  <span aria-hidden>☺</span>
                </button>
              </Tooltip>
              <Tooltip
                label={
                  route.page === "settings"
                    ? "Return to the fleet of running sessions"
                    : gearPhrase
                      ? `Settings (⌘,) - ${gearPhrase}`
                      : "Settings (⌘,)"
                }
              >
                <button
                  className={`ghost-btn glyph-btn gear-btn${route.page === "settings" ? " is-active" : ""}`}
                  onClick={() =>
                    navigate(
                      route.page === "settings"
                        ? { page: "fleet" }
                        : { page: "settings", category: DEFAULT_SETTINGS_CATEGORY },
                    )
                  }
                  // The label changes with what the click will do, the way the Workflows
                  // button's does. No `aria-pressed` beside it: a toggle button that
                  // renames itself and reports a pressed state announces the same fact
                  // twice, and the second telling contradicts the first ("Return to Fleet,
                  // pressed"). The worst-status phrase rides the label so the dot's meaning
                  // is not carried by colour alone.
                  aria-label={
                    route.page === "settings"
                      ? "Return to Fleet"
                      : gearPhrase
                        ? `Settings - ${gearPhrase}`
                        : "Settings"
                  }
                >
                  <span aria-hidden>⚙</span>
                  {/* The gear inherits the worst rail dot, so a subsystem needing attention
                      is visible without opening Settings. Purely visual - the phrase above
                      carries it to assistive tech. */}
                  {gearDot && <span className={`gear-dot settings-dot-${gearDot}`} aria-hidden />}
                </button>
              </Tooltip>
              <AlertBar
                settings={alertSettings}
                update={updateAlerts}
                away={away}
                setAway={setAway}
                buffered={buffered}
              />
            </div>
          </div>
        </header>

        <UpdateBanner
          snapshot={desktopUpdates.snapshot}
          onApply={desktopUpdates.apply}
          onDefer={desktopUpdates.defer}
          onCheck={desktopUpdates.check}
          onDismiss={desktopUpdates.dismiss}
        />
        <SettingsRestoredBanner
          event={settingsRestoreNotice}
          onReload={() => window.location.reload()}
        />
        <SetupBanner view={setup.view} onDismiss={setup.dismissBanner} />

        <AppPageShell
          page={route.page}
          library={libraryBody}
          runs={(
            <ExecutionPage
              title={runsKind === "pipelines" ? "Pipelines" : "Workflow runs"}
              blurb={runsKind === "pipelines"
                ? "Features an external SDLC engine is driving, in the repositories you observe."
                : "Every review a workflow has run over a session's work, live and finished."}
              actions={runsKind === "pipelines" ? (
                <Tooltip label="Which repositories are observed, and whether the engine was found, in Settings">
                  <button
                    className="btn btn-ghost wf-settings-link"
                    onClick={() => navigate({ page: "settings", category: "conductor" })}
                  >
                    Conductor settings
                    <span aria-hidden>→</span>
                  </button>
                </Tooltip>
              ) : (
                <Tooltip label="Live delivery, its allowed repositories, retention and health, in Settings">
                  <button
                    className="btn btn-ghost wf-settings-link"
                    onClick={() => navigate({ page: "settings", category: "workflows" })}
                  >
                    Workflow settings
                    <span aria-hidden>→</span>
                  </button>
                </Tooltip>
              )}
            >
              {/* The kind tab, and the ONLY change this page's chrome takes for pipelines.
                  It sits above both surfaces rather than inside either, so the workflow
                  rail and its reader below are the components that shipped before this
                  feature - unmodified, and pinned that way by
                  `e2e/specs/runs-workflows-unchanged.spec.ts`.

                  Absent unless something is actually being observed, which is what makes
                  "with the integration off, this page is byte-for-byte today's" a property
                  of the markup rather than a promise. */}
              {pipelinesObserving > 0 && (
                <RunsKindTabs
                  kind={runsKind}
                  workflowRuns={workflowRuns.length}
                  pipelineRuns={pipelineRuns.length + pipelineCommissions.length}
                  onKind={(kind) => navigate(
                    kind === "pipelines" ? { page: "runs", kind } : { page: "runs" },
                  )}
                />
              )}
              {runsKind === "pipelines" ? (
                <PipelineRuns
                  runs={pipelineRuns}
                  commissions={pipelineCommissions}
                  selectedCommissionId={pipelineCommissionSelection}
                  onSelectCommission={setPipelineCommissionSelection}
                  selected={route.page === "runs" ? route.pipelineRun ?? null : null}
                  onSelect={openPipelineRun}
                  onOpenSettings={() => navigate({ page: "settings", category: "conductor" })}
                />
              ) : (
                <WorkflowRuns
                  runs={workflowRuns}
                  sessions={sessions}
                  selectedRunId={route.page === "runs" ? route.runId ?? null : null}
                  filters={route.page === "runs" ? route.filters : undefined}
                  onSelectRun={openWorkflowRun}
                  onFilters={(filters) => navigate({
                    page: "runs",
                    ...(route.page === "runs" && route.runId ? { runId: route.runId } : {}),
                    filters,
                  })}
                  onOpenSession={openSessionOnFleet}
                  // The worklist's "Open file" on a change that cites one, through the same
                  // reveal the diff's "Open in Files" uses, so one path opens one way.
                  onOpenSessionPath={openSessionPath}
                  onOpenInspectorSettings={() => {
                    navigate({ page: "settings", category: "inspector" });
                  }}
                  // No session and no version pinned: the dialog already supports being opened
                  // empty and asking for both.
                  onBindWorkflow={() => setWorkflowBindingTarget({})}
                />
              )}
            </ExecutionPage>
          )}
          ensembles={(
            <ExecutionPage
              title="Ensembles"
              blurb="Multi-agent runs racing one goal: their evidence, their judges, and your decision."
            >
              <EnsembleRuns
                summaries={ensembleSummaries}
                sessions={sessions}
                reviews={pendingReviews}
                selectedId={route.page === "ensembles" ? route.ensembleId ?? null : null}
                hasSnapshot={hasSnapshot}
                onSelect={(ensembleId) => navigate({
                  page: "ensembles",
                  ...(ensembleId ? { ensembleId } : {}),
                })}
                onOpenSession={openSessionOnFleet}
                onOpenTask={(taskId) => {
                  const task = tasks.find((candidate) => candidate.id === taskId);
                  if (!task) return;
                  const liveSession = task.sessionId
                    ? sessions.find((session) => session.id === task.sessionId)
                    : sessions.find((session) => session.task?.id === taskId);
                  if (liveSession) {
                    navigate({ page: "fleet" });
                    setFilter("");
                    setSelectedId(liveSession.id);
                    if (layout === "board") setBoardOpen(true);
                    return;
                  }
                  if (task.status === "backlog") {
                    openTaskEditor(taskId);
                    return;
                  }
                  navigate({ page: "fleet" });
                  setReportOpen(true);
                }}
                onOpenWorkflowRun={openWorkflowRun}
              />
            </ExecutionPage>
          )}
          scouts={
            // Mounted only when the route IS Scouts, like every other slot, so the archive
            // list and detail fetches never run while somebody is on the fleet. The page
            // owns its own header rather than an `ExecutionPage` frame: its search rail is
            // the first thing on screen and has no page blurb above it.
            route.page === "scouts" ? (
              <ScoutsPage
                route={route}
                navigate={navigate}
                replace={replace}
                revision={archivesRevision}
                overlayOpen={overlays.anyOpen}
              />
            ) : null
          }
          shipped={
            // The Ship log owns its own `ExecutionPage` frame, unlike the two above: the
            // header's trailing slot holds its range chips, which are the page's own state,
            // and lifting that state up here would park a page's filter in App for the
            // lifetime of the session. Still only CONSTRUCTED here, so the ledger fetch
            // inside it happens the first time `#/shipped` is the route and never before.
            <ShipLogPage fleetCost={fleetCost} now={Date.now()} />
          }
          settings={(
            <SettingsPage
              category={route.page === "settings" ? route.category : DEFAULT_SETTINGS_CATEGORY}
              onNavigate={(cat) => navigate({ page: "settings", category: cat })}
              // The return leg of the Workflows page's own "Workflow settings →" button:
              // the settings panel's health tiles open the real run list rather than
              // growing a second one. Through `navigate`, like every other route change,
              // so the dirty-draft gate and history behave the same.
              onOpenRuns={(filters) => navigate({
                page: "runs",
                ...(Object.keys(filters).length > 0 ? { filters } : {}),
              })}
              // The return leg of the Pipelines tab's own "Conductor settings" button.
              onOpenPipelines={() => navigate({ page: "runs", kind: "pipelines" })}
              onLeave={() => navigate({ page: "fleet" })}
              foreman={foreman}
              cost={cost}
              llm={llm}
              setup={setup}
              layout={layout}
              onLayoutChange={setLayout}
              settingsStatus={settingsStatus}
              harnessesRevision={harnessesRevision}
              worktreesRevision={worktreesRevision}
              workflowSummaries={workflowSummaries}
              onOpenPalette={openPalette}
              onStartTour={(tourId) => {
                startTour(tourId, captureFocusBookmark(document.activeElement));
              }}
              onOpenForemanProfile={() => navigate({
                page: "library",
                shelf: "personas",
                assetId: "foreman",
              })}
              jump={settingsJump}
            />
          )}
          fleet={(
            <>

        {/* The Line. Above every layout and outside the `layoutHasContent` gate below, on
            purpose: it is the one thing on this page that is worth reading when the board
            is empty. A fleet with no sessions still has a backlog, sources due to sweep and
            pull requests that shipped this week, and the strip is where that is said. */}
        <LineStrip
          summary={lineSummary}
          density={lineDensity}
          openStage={lineDrawer}
          stageRef={registerLineStage}
          onStage={onLineStage}
          onDensity={setLineDensity}
        />

        {/* A dispatched task with no session now renders inside the fleet, at the top of the
            Working group where its real row will land. Both layouts own that placement through
            `PendingDispatch`, and `layoutHasContent` keeps the fleet mounted for a first
            dispatch onto a quiet fleet. */}

        {/* The drawer, between the Line and the layouts and a sibling of both. It pushes
            the board down and hands the space back on close; the cards below are the same
            cards at the same size in every state, which is the one thing this whole surface
            was not allowed to change. Mounted only while open, so the two drawers that fetch
            - Intake's task sources, Shipped's adoption ledger - each make their single read
            on the click that asks for it and never otherwise. The other three, Backlog
            included, are pure projections of state this page already holds. */}
        {lineDrawer === "review" && (
          <ReviewDrawer
            runs={workflowRuns}
            sessions={sessions}
            onClose={closeLineDrawer}
            onOpenRun={openWorkflowRun}
            onOpenAllRuns={() => navigate({ page: "runs" })}
            onBindWorkflow={() => setWorkflowBindingTarget({})}
            onOpenEnsemble={openEnsembleRun}
          />
        )}
        {lineDrawer === "decide" && (
          <DecideDrawer
            summaries={ensembleSummaries}
            attentionCount={ensembleAttentionCount}
            now={Date.now()}
            onClose={closeLineDrawer}
            onOpenEnsemble={openEnsembleRun}
            onOpenAllEnsembles={() => navigate({ page: "ensembles" })}
          />
        )}
        {lineDrawer === "intake" && (
          <IntakeDrawer
            schedules={schedules}
            now={Date.now()}
            onClose={closeLineDrawer}
            onOpenMissions={openMissions}
            onOpenTaskSources={() => navigate({ page: "settings", category: "task-sources" })}
          />
        )}
        {lineDrawer === "backlog" && (
          <BacklogDrawer
            // Every task, not `visibleBacklog`: the fleet filter narrows the BOARD, and a
            // queue that answered "what would autopilot take next" out of a filtered list
            // would contradict the count on the button that opened it. Dependencies also
            // point at tasks that have already left the backlog.
            tasks={tasks}
            backlogPlan={foreman.backlogPlan}
            now={Date.now()}
            // The same three values the Foreman popover reads, from the same hook: the
            // config the switch writes, the derived readout, and the gate that decides
            // whether an armed autopilot actually launches anything (`worker.ts` takes
            // `enabled && mode === "live"`). Threaded rather than re-fetched, so the two
            // surfaces cannot disagree about a switch they both write.
            autoBacklog={foreman.config?.autoBacklog ?? null}
            autopilot={foreman.status?.autopilot ?? null}
            autopilotLaunches={foremanEnabled && foremanMode === "live"}
            onSetAutoBacklog={(next) => foreman.update({ autoBacklog: next })}
            backlogTrust={backlogTrust}
            onManageTrust={openForemanTrust}
            onClose={closeLineDrawer}
            onEditTask={openTaskEditor}
            onOpenSitrep={() => {
              // Closed, not swapped behind: the Sitrep is a modal panel over the fleet, and
              // a drawer still pushing the board down under it is a surface the operator
              // came back to without asking for it. This is also the one gesture that has
              // to move the keyboard, which `closeLineDrawer` is exactly for.
              closeLineDrawer();
              setReportOpen(true);
            }}
          />
        )}
        {lineDrawer === "shipped" && (
          <ShippedDrawer
            now={Date.now()}
            onClose={closeLineDrawer}
            // No `closeLineDrawer()` beside it: leaving the fleet already drops the drawer
            // through the route effect above, and calling both would move the keyboard back
            // onto a stage button on a page we are navigating off.
            onOpenShipLog={() => navigate({ page: "shipped" })}
          />
        )}

        {/* Nothing to arrange means no layout: one of the two empty states below says why,
            and every layout would otherwise dress that silence up as furniture - an empty
            rail beside a "no session selected" pane, five empty board columns.

            "Nothing" is per-layout, though. The board draws the Backlog column, which is
            content the other two have no place for, so a filter matching only backlog
            items leaves the board with something to arrange and Console with none.
            Reading `visible` alone here is what hid a task named "P5: Ghostty terminal
            emulator adapter" the moment you typed "ghostty". */}
        {layoutHasContent && (
          <>
            {layout === "console" && <ConsoleView {...viewProps} />}
            {layout === "board" && <BoardView {...viewProps} />}
          </>
        )}

        {filesSession && (
          <FileWindow
            session={filesSession}
            controller={files}
            fileCommentThreads={fileCommentThreads}
            fileCommentReviews={fileCommentReviews}
            fileLineRequest={fileLineRequest}
            onClose={closeFiles}
          />
        )}

        {filePickerSession && (
          <FilePicker
            session={filePickerSession}
            controller={files}
            onClose={closeFilePicker}
            onChoose={(path) => {
              files.select(filePickerSession.id, path);
              closeFilePicker();
              if (layout === "board") setBoardOpen(true);
              requestFilesTab(filePickerSession.id);
            }}
          />
        )}

        {resetSession && (
          <ResetModal
            session={resetSession}
            unsavedFiles={Object.values(files.sessions[resetSession.id]?.buffers ?? {}).filter(
              (buffer) => buffer.saveState !== "saved" && buffer.saveState !== "readonly",
            ).length}
            onReset={() => onSessionReset(resetSession.id)}
            onClose={() => setResetSessionId(null)}
          />
        )}

        {completeSession && (
          <CompleteModal
            session={completeSession}
            tasks={tasks}
            tourOutcome={
              completeSession.task?.id === seeWorkTourTaskId ? "Tour demo" : undefined
            }
            onCompleted={() => onKilled(completeSession.id)}
            onClose={closeComplete}
          />
        )}

        {killSession && (
          <KillModal
            session={killSession}
            onKilled={() => onKilled(killSession.id)}
            // Offered only where there is something to complete, so the dialog never
            // points at a door that opens on "nothing to mark done".
            onComplete={
              killSession.task ? () => setCompleteSessionId(killSession.id) : undefined
            }
            onClose={closeKill}
          />
        )}

        {/* Not while something is starting. A dispatch that has been accepted but has not
            bound its session yet is already drawn as a placeholder in the fleet below, and
            this screen would sit directly over it saying the opposite - "No agent sessions
            detected", telling the operator to go start one by hand in the seconds after they
            asked for exactly that. `layoutHasContent` counts these tasks so the layout holding
            the placeholder remains mounted even when there are no sessions yet. */}
        {sessions.length === 0 &&
          (layout !== "board" || restoringSessions.length === 0) &&
          dispatchingTasks.length === 0 && (
          hasSnapshot ? (
            <div className="empty">
              <p className="empty-title">No agent sessions detected</p>
              {/* Names the harnesses off the union, not by hand: an operator running an
                  agent this build can discover but this sentence never mentioned would
                  read it as "that one isn't supported" and stop looking. */}
              <p className="empty-sub">
                Start a {agentList(AGENT_TYPES)} session in a terminal pane and it will appear
                here.
              </p>
              {/* The stream can be reconnecting behind this screen, which looks identical to
                  "nothing is running" - so the way out of a stale view is printed here rather
                  than left for the operator to guess. */}
              <p className="empty-sub empty-hint">
                Already running one? Press <kbd>⌘R</kbd> or <kbd>Ctrl+R</kbd> to refresh.
              </p>
            </div>
          ) : (
            // Before the first snapshot lands, "No agent sessions detected" is not a fact -
            // it is a guess dressed as one, and on a cold daemon or a slow disk it can sit on
            // screen long enough to read as the fleet genuinely having nothing, or as the app
            // having failed to start, rather than as data still arriving. `workflowCommandFact`
            // already draws this exact line for the Library shelves ("Not configured" vs
            // "waiting for the daemon"); this is the same distinction for the page that reads
            // it first.
            <div className="empty" role="status" aria-label="Loading sessions">
              <span className="empty-spinner" aria-hidden="true" />
              <p className="empty-title">Waiting for the daemon…</p>
              <p className="empty-sub">The fleet's session list has not arrived yet.</p>
            </div>
          )
        )}

        {/* Only when the layout drew nothing - on the board a filter that matched only
            backlog items has already rendered them, and telling the operator nothing
            matched while the match is on screen is the bug this replaced. */}
        {filterableSessionCount > 0 && !layoutHasContent && (
          <div className="empty">
            <p className="empty-title">Nothing matches "{filter}"</p>
            <p className="empty-sub">
              No {layout === "board" ? "session row or backlog task" : "session"} matches that
              search.{" "}
              <Tooltip label="Clear the filter">
                <button className="link-btn" onClick={() => setFilter("")}>
                  Clear the filter
                </button>
              </Tooltip>{" "}
              to see all {filterableSessionCount} {filterableSessionNoun}.
            </p>
          </div>
        )}

            </>
          )}
          overlays={(
            <>
              {/* The everything-palette lives in the slot every page shares, because it
                  indexes every page: it opens over the fleet, the Library, a run reader and
                  Settings alike, and a row's navigation must not unmount the surface that
                  performed it. */}
              <Palette
                open={paletteOpen}
                onClose={() => setPaletteOpen(false)}
                onActivate={onPaletteActivate}
                stores={paletteStores}
              />

              {/* One overlay slot for one active tour, whichever tour is running. */}
              {activeTourBinding && (
                <OverlayRegistration id={OVERLAY_IDS.tour}>
                  {(isTop) => activeTourBinding.mount({ isTop, onFinish: finishTour })}
                </OverlayRegistration>
              )}

              {inboxOpen && (
                <AttentionInbox
                  fold={attention}
                  onClose={() => setInboxOpen(false)}
                  onOpenEnsemble={openEnsembleRun}
                  onOpenSession={focusSession}
                />
              )}

              {modalSession && modalReviews.length > 0 && (
                <ReviewModal
                  session={modalSession}
                  reviews={modalReviews}
                  onClose={() => {
                    delete document.documentElement.dataset.mcTourReview;
                    setReviewSessionId(null);
                  }}
                />
              )}

              <DispatchLayer
                open={dispatchOpen || editingTask != null}
                editTask={editingTask}
                tasks={tasks}
                sessions={sessions}
                personas={personas}
                workflowSummaries={workflowSummaries}
                foremanEnabled={foreman.config?.enabled ?? false}
                harnessesRevision={harnessesRevision}
                pipelinesRevision={
                  settingsStatus?.pipelines.observedRepoKeys
                    ? JSON.stringify({
                        repos: settingsStatus.pipelines.observedRepoKeys,
                        launchRuntime: settingsStatus.pipelines.launchRuntime ?? null,
                      })
                    : `count:${settingsStatus?.pipelines.observing ?? 0}`
                }
                launchIntent={dispatchIntent}
                tourDemo={seeWorkTourDispatchPreview}
                onClose={closeDispatch}
                onOpenSchedule={onOpenSchedule}
                onEnsembleLaunched={openEnsembleRun}
              />

              <ProductIssueLayer open={feedbackOpen} onClose={closeFeedback} />

              {reportOpen && (
                <ReportPanel
                  sessions={sessions}
                  tasks={tasks}
                  backlogPlan={foreman.backlogPlan}
                  backlogTrust={backlogTrust}
                  onManageTrust={openForemanTrust}
                  onClose={() => setReportOpen(false)}
                  onOpenReviews={(id) => {
                    setReportOpen(false);
                    setReviewSessionId(id);
                  }}
                  onEditTask={(id) => {
                    setReportOpen(false);
                    openTaskEditor(id);
                  }}
                  onOpenSchedule={onOpenSchedule}
                  scheduleNameById={scheduleNameById}
                />
              )}

              {missionsOpen && (
                <RecurringMissionsPanel
                  schedules={schedules}
                  connected={connected}
                  hasSnapshot={hasSnapshot}
                  initialScheduleId={missionsTarget?.scheduleId ?? null}
                  initialOccurrenceId={missionsTarget?.occurrenceId ?? null}
                  initialScheduledFor={missionsTarget?.scheduledFor ?? null}
                  onClose={closeMissions}
                  onOpenTask={(taskId) => {
                    const task = tasks.find((candidate) => candidate.id === taskId);
                    if (!task) return;
                    if (task.status === "backlog") {
                      closeMissions();
                      openTaskEditor(taskId);
                      return;
                    }
                    const liveSession = task.sessionId
                      ? sessions.find((session) => session.id === task.sessionId)
                      : null;
                    if (liveSession) {
                      closeMissions();
                      navigate({ page: "fleet" });
                      setFilter("");
                      setSelectedId(liveSession.id);
                      if (layout === "board") setBoardOpen(true);
                      return;
                    }
                    if (task.outcomeUrl) {
                      window.open(task.outcomeUrl, "_blank", "noopener");
                    }
                  }}
                  // History renders a generated-task link as clickable only when it leads
                  // somewhere - a live backlog task to edit, a live bound session to focus,
                  // or an outcome URL to open. A finished task with none of those has no live
                  // surface (its result is already in the occurrence audit), so this returns
                  // a reason and the link is shown disabled with that explanation rather than
                  // as a dead click. Kept in lockstep with onOpenTask above.
                  resolveTaskLink={(taskId) => {
                    const task = tasks.find((candidate) => candidate.id === taskId);
                    if (!task) return { openable: false, blockedReason: "This task no longer exists." };
                    if (task.status === "backlog") return { openable: true, blockedReason: null };
                    if (task.sessionId && sessions.some((s) => s.id === task.sessionId)) {
                      return { openable: true, blockedReason: null };
                    }
                    if (task.outcomeUrl) return { openable: true, blockedReason: null };
                    return {
                      openable: false,
                      blockedReason: "This task has finished; its outcome is shown in the audit here.",
                    };
                  }}
                />
              )}

              {digest && (
                <AwayDigestCard
                  digest={digest}
                  onDismiss={dismissDigest}
                  onOpenReport={() => {
                    dismissDigest();
                    setReportOpen(true);
                  }}
                />
              )}

              <WorkflowBindingDialogHost
                target={workflowBindingTarget}
                sessions={sessions}
                workflows={workflowSummaries}
                foremanEnabled={foreman.config?.enabled ?? false}
                promptedWrapupEnabled={foreman.config?.wrapupTriggers.includes("prompted") ?? false}
                onClose={() => setWorkflowBindingTarget(null)}
                onRun={openWorkflowRun}
              />
            </>
          )}
        />

        {/* The dirty-draft gate, outside the page slots because it is raised by LEAVING one:
            back/forward can fire it while the Workflows page is already unmounting, and a
            dialog rendered inside that page would have gone with it. */}
        {pendingRoute && (
          <WorkflowConfirmModal
            request={{
              title: "Leave with unsaved changes",
              body:
                "The workflow or Persona open in the editor has changes that have not been "
                + "saved. Leaving this page discards them.",
              confirmLabel: "Discard and leave",
              confirmHint: "Throw the unsaved edits away and go to the page you asked for",
              danger: true,
              onConfirm: confirmPending,
            }}
            onClose={cancelPending}
          />
        )}
      </div>
      </TourTargetHost>
    </OverlayHost>
  );
}

/** The restoring-row counterpart of `matchesSessionFilter`, with its only truthful state label. */
function matchesRestoringFilter(session: RestoringSession, q: string): boolean {
  const haystack = `${session.name} restoring ${session.agent ?? ""}`.toLowerCase();
  return haystack.includes(q);
}

/**
 * True when a backlog task matches the nav-bar filter - the task-shaped counterpart of
 * `matchesSessionFilter`, matching the same three core things a session does (title, status, agent)
 * so one query reads the board across both.
 *
 * `status` is the literal here, not a display label, and that is not the inconsistency
 * it looks like: a backlog task's status IS "backlog", the word already on the column
 * header, whereas a session's raw state lies (see `matchesSessionFilter`). Labels join the
 * haystack because they exist to be searched - they are the operator's own tags, and a
 * filter that could not see them would make them decorative.
 */
function matchesTaskFilter(t: Task, q: string): boolean {
  const haystack = `${t.title} ${t.status} ${t.agent} ${t.labels.join(" ")}`.toLowerCase();
  return haystack.includes(q);
}

/** A launch failure can be terminal, or safely returned to Backlog with its reason. */
function taskLaunchStopped(task: Task | null): boolean {
  return Boolean(
    task &&
      (task.status === "failed" ||
        task.status === "cancelled" ||
        (task.status === "backlog" && task.error !== null)),
  );
}

/**
 * One segment of the fleet pulse: a tone dot, a figure, and a word.
 *
 * The word is a `.tb-label`, so the narrow ladder can take it away and leave a dot and a
 * number - which is why every segment carries a Tooltip whether or not it is clickable.
 * Tooltip always renders its label into a hidden `aria-describedby` node, so the meaning
 * survives the collapse for a screen reader as well as for a pointer.
 */
function PulseStat({
  n,
  label,
  tip,
  tone,
  onClick,
}: {
  n: number;
  label: string;
  tip: string;
  tone?: Tone;
  onClick?: () => void;
}): React.JSX.Element {
  const cls = `pulse-seg${tone ? ` pulse-${tone}` : ""}`;
  const body = (
    <>
      <span className="pulse-dot" aria-hidden />
      <span className="pulse-n">{n}</span>
      <span className="tb-label">{label}</span>
    </>
  );
  return (
    <Tooltip label={tip}>
      {onClick ? (
        <button type="button" className={`${cls} pulse-btn`} onClick={onClick}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </Tooltip>
  );
}

/**
 * The fleet's state as ONE readout.
 *
 * This was four separately-bordered pills plus a `live` indicator stranded on the far side
 * of the action cluster - five bordered boxes for one idea, at the same visual weight as
 * the seven buttons beside them, and the widest thing in the bar. One container with
 * hairline-separated segments says the same in roughly two thirds the width and one
 * border, which is most of what buys the single row at half screen.
 *
 * The connection state leads the readout rather than trailing the actions, because that is
 * what it qualifies: every figure to its right came over the stream, so when the stream is
 * down they are stale and `.is-down` dims them to say so. That is also why the down state
 * keeps its word while the counts give theirs up on the narrow ladder - a lone red dot is
 * the one thing here you cannot afford to have to hover.
 */
function FleetPulse({
  connected,
  keepAwake,
  sessions,
  attention,
  working,
  inbox,
  onOpenInbox,
}: {
  connected: boolean;
  /** The daemon's Keep Awake observation; null while unknown (pre-snapshot, or SSE down). */
  keepAwake: KeepAwakeStatus | null;
  sessions: number;
  attention: number;
  working: number;
  /**
   * How many answers the operator owes - the attention fold's total, not a review count.
   *
   * A separate segment from `attention`, which counts SESSIONS in an attention tone. The two
   * are different UNITS of one set, not different sets: `attention` is how many agents are
   * blocked, `inbox` is how many replies it takes to unblock them, so one session holding
   * three questions reads `1 need you` beside `3 to answer`. It reads "to answer" rather than
   * borrowing "need you" because two segments carrying the same word in one readout is a
   * figure nobody can attribute.
   *
   * `inbox >= attention` always, and `attention-pill-invariant.test.ts` holds the fold to it.
   * The reverse used to be reachable - a session parked on a permission prompt, or one whose
   * `awaiting_input` came from a hook that files no review, counted in `attention` and
   * produced no inbox row - which put `1 need you` next to a click that opened an empty list.
   */
  inbox: number;
  onOpenInbox: () => void;
}): React.JSX.Element {
  return (
    <div className={`pulse${connected ? "" : " is-down"}`}>
      {/* The connection segment, now the Keep Awake control. It keeps the leading
          position and the live/reconnecting word because the connection fact still
          qualifies every figure to its right; the dropdown it opens is the one place
          host power state is controlled from. */}
      <KeepAwakeControl connected={connected} status={keepAwake} />
      <PulseStat
        n={sessions}
        label={sessions === 1 ? "session" : "sessions"}
        tip={`${sessions} session${sessions === 1 ? "" : "s"} on the fleet`}
      />
      {attention > 0 && (
        <PulseStat
          n={attention}
          label="need you"
          tone="attention"
          tip={`${attention} session${attention === 1 ? " is" : "s are"} waiting on you`}
        />
      )}
      {working > 0 && (
        <PulseStat
          n={working}
          label="working"
          tone="working"
          tip={`${working} session${working === 1 ? " is" : "s are"} working`}
        />
      )}
      {inbox > 0 && (
        <PulseStat
          n={inbox}
          label="to answer"
          tone="attention"
          onClick={onOpenInbox}
          tip={`${inbox} thing${inbox === 1 ? " is" : "s are"} waiting on you - agents' questions, ensemble decisions and parked gates. Open the inbox`}
        />
      )}
    </div>
  );
}

function summarize(sessions: Session[]): { attention: number; working: number } {
  let attention = 0;
  let working = 0;
  for (const s of sessions) {
    const tone = stateDisplay(s).tone;
    if (tone === "attention") attention++;
    else if (tone === "working") working++;
  }
  return { attention, working };
}
