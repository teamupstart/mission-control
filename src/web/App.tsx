import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AGENT_TYPES, type KeepAwakeStatus, type Session, type Task } from "@shared/types.ts";
import { agentList } from "@shared/agent.ts";
import { backlogTasks, canCycleMode, canInterruptSession } from "@shared/session.ts";
import { agentLaunchAction } from "@shared/session-launch.ts";
import { api } from "./lib/api.ts";
import { useEventStream } from "./useEventStream.ts";
import { fitTopbar, observeTopbar } from "./topbarLadder.ts";
import type { ActionBarHandle } from "./components/ActionBar.tsx";
import type { SessionLaunchersHandle } from "./components/LaunchMenu.tsx";
import type { TranscriptFindHandle } from "./components/TranscriptPanel.tsx";
import { ReviewModal } from "./components/ReviewModal.tsx";
import { AttentionInbox } from "./components/AttentionInbox.tsx";
import { DispatchLayer } from "./components/DispatchModal.tsx";
import { ResetModal } from "./components/ResetModal.tsx";
import { CompleteModal } from "./components/CompleteModal.tsx";
import { KillModal } from "./components/KillModal.tsx";
import { ReportPanel } from "./components/ReportPanel.tsx";
import { RecurringMissionsPanel } from "./components/RecurringMissionsPanel.tsx";
import { AwayDigestCard } from "./components/AwayDigestCard.tsx";
import { DiffViewer } from "./components/DiffViewer.tsx";
import { AlertBar } from "./components/AlertBar.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { DEFAULT_SETTINGS_CATEGORY } from "./lib/settings-registry.ts";
import { settingsGearDot } from "./lib/settings-dots.ts";
import { ForemanBar } from "./components/ForemanBar.tsx";
import { AgentDot } from "./components/session-bits.tsx";
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
import { GridView } from "./components/layouts/GridView.tsx";
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
import { detailLayer, useLayoutMode } from "./lib/layout.ts";
import { moveSelection, type ArrowKey } from "./lib/layoutNav.ts";
import { conversationReveal } from "./lib/conversationReveal.ts";
import { orderSessions } from "./lib/fleet-order.ts";
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
} from "./lib/keybindings.ts";
import type { ActionId } from "./lib/keybindings.ts";
import { canRenameSession, stateDisplay, type Tone } from "./lib/format.ts";
import { clearInterrupting, markInterrupting } from "./lib/interrupting.ts";
import { OverlayHost, OVERLAY_IDS, useOverlayHost } from "./components/Overlay.tsx";
import { FileWindow } from "./components/FileWindow.tsx";
import { FilePicker } from "./components/FilePicker.tsx";
import { useSessionFilesStore } from "./lib/sessionFiles.ts";
import { workspaceFileTarget } from "./lib/workspaceLinks.ts";
import { WorkflowRuns } from "./workflows/WorkflowRuns.tsx";
import { EnsembleRuns } from "./workflows/EnsembleRuns.tsx";
import { pageShortcutRoute, useWorkflowRoute } from "./workflows/useWorkflowRoute.ts";
import type { LibrarySurface } from "./workflows/useWorkflowRoute.ts";
import { LibraryPage } from "./library/LibraryPage.tsx";
import type { EnsembleStrategyId } from "@shared/ensemble.ts";
import { PersonaLibrary } from "./workflows/PersonaLibrary.tsx";
import { personaDriftSurface, usePersonaDrift } from "./workflows/usePersonaDrift.ts";
import { SessionActionLibrary } from "./workflows/SessionActionLibrary.tsx";
import { CommandLibrary } from "./workflows/CommandLibrary.tsx";
import { WorkflowLibrary } from "./workflows/WorkflowLibrary.tsx";
import { AppPageShell } from "./components/AppPageShell.tsx";
import { ExecutionPage } from "./workflows/ExecutionPage.tsx";
import { WorkflowConfirmModal } from "./workflows/WorkflowConfirmModal.tsx";
import {
  WorkflowBindingDialog,
  type WorkflowBindingTarget,
} from "./workflows/WorkflowBindingDialog.tsx";
import { Palette } from "./components/Palette.tsx";
import { ContextMenuHost, type ContextMenuHandle } from "./components/ContextMenu.tsx";
import type { PaletteStores, PaletteTarget } from "./lib/palette-index.ts";
import { buildSettingsBindings } from "./lib/settings-search.ts";
import { useRichText } from "./lib/rich-text.ts";
import { useGuidedDispatch } from "./lib/guided-dispatch.ts";

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
      return "the Inspector is live";
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

export function App(): React.JSX.Element {
  const {
    sessions,
    reviews,
    tasks,
    personas,
    sessionActions,
    workflowCommands,
    workflowSummaries,
    workflowRunSummaries: workflowRuns,
    workflowBindingSummaries,
    ensembleSummaries,
    fleetCost,
    lineSummary,
    settingsStatus,
    keepAwakeStatus,
    harnessesRevision,
    // One counter, bumped per reconciled batch of archives and once per reconnect. It is
    // how the Scouts page learns to refetch its current window without the browser polling
    // and without unbounded history entering the SSE snapshot.
    scoutsRevision,
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
  const foreman = useForeman();
  // Owned here rather than by SettingsPage, on the `foreman` precedent: the topbar spend
  // popover and the Cost panel read the same `view` setting, so a local copy in the page
  // would leave the popover showing the old choice until the next reload - and double-poll.
  const cost = useCost();
  const llm = useLlm();
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
  // Only one card expands at a time - opening a new one collapses the previous.
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
  // session grid, and the draft has to survive a close without dragging every
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
  // Whether the ⌘K palette is open. Owned here, and rendered in the overlay slot that every
  // page shares, because it indexes BOTH homes: it opens over the fleet, the Library, a run,
  // an ensemble and Settings alike, and navigating from it must not close it out from under
  // the navigation it just performed.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The settings control the palette last asked to land on, if any.
  //
  // The anchor is deliberately not in the hash (the settings route is category-only), so it
  // travels as a prop to `SettingsPage`, which owns the one scroll-and-flash implementation.
  // The nonce is what makes asking twice for the same control flash twice - without it the
  // second request would be a prop that did not change, and nothing would happen.
  const [settingsJump, setSettingsJump] = useState<{ anchor: string; nonce: number } | null>(null);
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
  const [diffSessionId, setDiffSessionId] = useState<string | null>(null);
  const [filesSessionId, setFilesSessionId] = useState<string | null>(null);
  const [filePickerSessionId, setFilePickerSessionId] = useState<string | null>(null);
  const [fileTabRequest, setFileTabRequest] = useState<{
    sessionId: string;
    nonce: number;
  } | null>(null);
  const [conversationTabRequest, setConversationTabRequest] = useState<{
    sessionId: string;
    nonce: number;
  } | null>(null);
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
  /** When set, the diff viewer shows just this commit. */
  const [diffCommit, setDiffCommit] = useState<string | null>(null);
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
  // Which card's title is being edited (its inline rename box is open). App owns
  // this so the rename shortcut and a title click drive the same one card.
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
  // keydown arriving in that interval drives the card behind the overlay. Synced in a
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

  // Live element + imperative-handle maps for the keyboard-selected card.
  const cardEls = useRef<Map<string, HTMLElement>>(new Map());
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
  const detailScrollers = useRef<Map<string, (direction: -1 | 1) => void>>(new Map());
  // Tab cycles the open detail's tabs (Conversation -> Work queue -> Gate -> Diff -> Files);
  // ConsoleDetail owns that state, so it registers a stepper here that App's global key
  // handler drives. "edge" means there is no further tab that way - forward it clamps, back
  // it hands the keyboard to the rail. Shared by the console and the board drill-in, which
  // mount the same ConsoleDetail.
  const readerTabbers = useRef<Map<string, (dir: -1 | 1) => "moved" | "edge">>(new Map());
  // Set to the id a Cards Enter should drop the cursor into once its send box
  // mounts (see the structural Enter arm and the effect that consumes it). A ref, not
  // state: it arms a one-shot side effect, and must not itself cause a render.
  const pendingReplyFocus = useRef<string | null>(null);
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
  const gridRef = useRef<HTMLElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const topbarRef = useRef<HTMLElement>(null);

  const registerEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
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
    cardEls.current.get(id)?.focus({ preventScroll: true });
  }, []);

  const focusReaderBody = useCallback(() => {
    // Land on the reader body - the conversation pane the vertical arrows scroll - not the
    // whole detail section. That is what "Tab selects the conversation window" means: the
    // ring frames what is being read, and a later native Tab steps into the transcript and
    // reply box rather than the session title up in the header chrome. Only one detail is
    // open at a time (console beside the rail, or the board drill-in), so a bare query finds
    // the right one in either layout.
    document.querySelector<HTMLElement>(".detail-body")?.focus({ preventScroll: true });
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

  const registerDetailScroll = useCallback((id: string, scroll: ((direction: -1 | 1) => void) | null) => {
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

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
  }, []);

  /**
   * A kill landed: close whatever detail it was ordered from, straight away.
   *
   * The session does NOT leave the list when it dies - it is marked `exited` and lingers
   * ~8s before eviction, and only then does the reconciliation effect below drop the
   * selection. Until then the board stayed drilled into a transcript that can no longer
   * change, its action bar already gone, with Escape the only way out. Killing is the one
   * gesture that ends the reason the detail was open, so it takes the detail with it.
   *
   * Which layer that is is the layout's answer, not this callback's - `detailLayer`, the
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
      const drop = layer === "expanded" ? setExpandedId : setSelectedId;
      drop((cur) => (cur === id ? null : cur));
    },
    [layout, selectedId],
  );

  const closeDispatch = useCallback(() => {
    setDispatchOpen(false);
    setEditingTaskId(null);
    setDispatchIntent(null);
  }, []);
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
    [navigate, openDispatch, launchEnsemble, onOpenSchedule, paletteBindings],
  );
  /**
   * Which Line stage has its drawer open, or null. The one carrier of that fact: the strip
   * reads it for `aria-expanded`, the fleet body renders from it, and `esc` clears it.
   */
  const [lineDrawer, setLineDrawer] = useState<LineDrawerStage | null>(null);
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
   * Six surfaces reach it now - a session card's workflow chip, the board tile, the runs
   * rail, the ensembles detail's handoff link, the Review drawer, and the Library's
   * cross-link - and they used to spell the destination themselves. One opener, because the
   * FILTER rule is the part worth stating once: a run opened while the runs page is already
   * filtered keeps that filter, so Back returns to the list you were reading rather than to
   * an unfiltered one. Opened from anywhere else there is no filter to keep.
   */
  const keptRunFilters = route.page === "runs" ? route.filters : undefined;
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
  const closeDiff = useCallback(() => {
    setDiffSessionId(null);
    setDiffCommit(null);
  }, []);
  const closeReset = useCallback(() => setResetSessionId(null), []);
  const closeComplete = useCallback(() => setCompleteSessionId(null), []);
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
    if (layout === "grid") {
      setDiffCommit(commit ?? null);
      setDiffSessionId(sessionId);
      return;
    }
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
  const openSessionPath = useCallback((sessionId: string, path: string): void => {
    files.ensure(sessionId);
    files.select(sessionId, path);
    if (layout === "grid") {
      setFilesSessionId(sessionId);
    } else {
      setSelectedId(sessionId);
      if (layout === "board") setBoardOpen(true);
      requestFilesTab(sessionId);
    }
  }, [files.ensure, files.select, layout, requestFilesTab]);

  const openSessionFile = useCallback((
    sessionId: string,
    href: string,
    probe = false,
  ): boolean | Promise<boolean> => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    let ambiguousRoot = false;
    const target = session?.cwd ? workspaceFileTarget(href, session.cwd, () => {
      ambiguousRoot = true;
      return true;
    }) : null;
    if (!target) return false;
    if (probe) return ambiguousRoot ? files.probe(sessionId, target.path) : true;
    openSessionPath(sessionId, target.path);
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
      { sessionId: diffSessionId, close: closeDiff },
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
      diffSessionId,
      resetSessionId,
      completeSessionId,
      killSessionId,
      filesSessionId,
      filePickerSessionId,
      workflowBindingTarget,
      closeDiff,
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
   * The one run per session the surfaces that genuinely want one still read.
   *
   * Kept beside the list rather than replaced by it: the retro offer, the board tile's
   * ladder and the console's Workflows tab each speak about one run, and a multi-repo
   * session's newest is the right one for all three. Every surface that must not miss a
   * sibling - the held join, the bind affordance, the chips - reads the list.
   */
  const workflowRunBySession = useMemo(() => {
    const bySession = new Map<string, (typeof workflowRuns)[number]>();
    for (const [sessionId, runs] of workflowRunsBySession) {
      const newest = runs.reduce((best, run) => (run.updatedAt > best.updatedAt ? run : best));
      bySession.set(sessionId, newest);
    }
    return bySession;
  }, [workflowRunsBySession]);

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

  // Nav-bar filter: live substring match over each card's title, status, and agent. Empty
  // filter shows everything.
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

  const fleet = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q ? sessions.filter((s) => matchesFilter(s, q)) : sessions;
    return orderSessions(matched, heldIds);
  }, [sessions, filter, heldIds]);
  const visible = fleet.sessions;

  // The same filter over the board's Backlog column. A backlog item is a card the
  // operator is looking at, so the one filter box has to narrow it too - it used to
  // read straight off the unfiltered task list, which left "ghostty" showing all
  // fourteen items while the session grid beside it narrowed to none.
  const visibleBacklog = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const items = backlogTasks(tasks);
    if (!q) return items;
    return items.filter((t) => matchesTaskFilter(t, q));
  }, [tasks, filter]);

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
    () => foldAttention({ sessions, reviews: answerableReviews, ensembles: ensembleSummaries }),
    [sessions, answerableReviews, ensembleSummaries],
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

  // The board's columns as ids, so the arrow keys can cross between them. Read off the same
  // `orderSessions` result the board renders - not a second grouping pass - so navigation
  // can't disagree with what's on screen, cluster reordering included.
  const boardColumns = useMemo(
    () => fleet.groups.map((g) => g.sessions.map((s) => s.id)),
    [fleet],
  );

  // What "expanded" means depends on the layout, so App resolves it once here rather
  // than leaving each view to force the prop:
  //   grid    - focus mode: at most one card, toggled, usually none.
  //   console - the detail pane IS the expanded card, so it's whatever is selected.
  //   board   - the console detail is separate from the arrow-key cursor; Enter or a
  //             click opens it, and what it opens is the cursor's session.
  // Keeping the state honest (rather than overriding `expanded` at the call site) is
  // what lets Escape, Enter and the card's own toggle all agree.
  const boardOpenId = boardOpen ? selectedId : null;
  const expandedForView =
    layout === "grid" ? expandedId : layout === "board" ? boardOpenId : selectedId;

  // A tab request is an instruction for the detail currently on screen, not a saved tab
  // preference. Leaving that detail consumes it so returning to the session later starts
  // on Conversation as usual.
  useEffect(() => {
    setFileTabRequest((request) =>
      request && request.sessionId !== expandedForView ? null : request,
    );
  }, [expandedForView]);
  useEffect(() => {
    setDiffTabRequest((request) =>
      request && request.sessionId !== expandedForView ? null : request,
    );
  }, [expandedForView]);
  useEffect(() => {
    setWorkflowsTabRequest((request) =>
      request && request.sessionId !== expandedForView ? null : request,
    );
  }, [expandedForView]);

  const modalSession = reviewSessionId ? sessions.find((s) => s.id === reviewSessionId) : null;
  const modalReviews = modalSession
    ? pendingReviews.filter((r) => r.sessionId === modalSession.id)
    : [];
  const selected = selectedId ? visible.find((s) => s.id === selectedId) ?? null : null;
  const visibleSelectedId = selected?.id ?? null;
  const diffSession = diffSessionId ? sessions.find((s) => s.id === diffSessionId) ?? null : null;
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
  // Whether the CURRENT layout has anything to draw. Only the board renders tasks, so
  // only the board survives an empty session list - see the render gate below.
  const layoutHasContent = visible.length > 0 || (layout === "board" && visibleBacklog.length > 0);

  const viewProps: SessionViewProps = {
    sessions: visible,
    tasks,
    backlog: visibleBacklog,
    backlogPlan: foreman.backlogPlan,
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
    onDeselect: layout === "board" ? () => setBoardOpen(false) : () => setSelectedId(null),
    expandedId: expandedForView,
    onToggleExpand: toggleExpand,
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
  // The rename editor lives inside a card, so it reconciles against `visible` -
  // the list the grid actually renders - rather than every known session. A card
  // that leaves the filter (its status label is part of the haystack, so an agent
  // going idle is enough) unmounts its editor without an unmount-time onBlur, and
  // nothing else would ever clear `renamingId`; the stand-down guard below would
  // then swallow every grid shortcut for good. The overlay ids stay on `sessions`
  // because their modals are bound to a session, not to a mounted card.
  useEffect(() => {
    if (selectedId && !sessions.some((s) => s.id === selectedId)) {
      setSelectedId(null);
      // The board's drill-in goes with it. Left standing, the flag would silently
      // re-open on whatever the cursor landed on next.
      setBoardOpen(false);
    }
    if (expandedId && !sessions.some((s) => s.id === expandedId)) setExpandedId(null);
    for (const bound of sessionBoundOverlays) {
      if (bound.sessionId && !sessions.some((s) => s.id === bound.sessionId)) bound.close();
    }
    for (const id of Object.keys(files.sessions)) {
      if (!sessions.some((session) => session.id === id)) files.drop(id);
    }
    if (renamingId && !visible.some((s) => s.id === renamingId)) setRenamingId(null);
  }, [sessions, visible, selectedId, expandedId, sessionBoundOverlays, renamingId, files.sessions, files.drop]);

  // Keep the keyboard-selected card in view as selection moves.
  useEffect(() => {
    if (!selectedId) return;
    cardEls.current.get(selectedId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
    cardEls.current
      .get(id)
      ?.querySelector<HTMLElement>("button.tile-open")
      ?.focus({ preventScroll: true });
  }, [selectedId]);

  // Fit the topbar to one row, and publish the height it settles at as `--topbar-h` so a
  // focus-expanded card can size itself to exactly fill the screen beneath the sticky bar.
  // See `topbarLadder.ts` for why the rungs are measured rather than keyed on a width.
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

  // When a card enters focus mode, lift it to the top of the viewport (just under
  // the sticky topbar) so its now-full-screen conversation and reply box land
  // fully in view. Collapsing (expandedId -> null) leaves the scroll position alone.
  useEffect(() => {
    if (!expandedId) return;
    cardEls.current.get(expandedId)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [expandedId]);

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
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
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
        setPaletteOpen((v) => !v);
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

      // Stand down while any overlay owns the screen (or a card's title is being
      // edited), so grid shortcuts don't drive a background card behind it.
      if (overlaysRef.current.anyOpen || renamingId) return;

      // Escape closes the Line's drawer, but only while the keyboard is INSIDE it or on the
      // strip that opened it.
      //
      // Scoped by focus rather than taken unconditionally, because Escape on this page is
      // already a ladder that peels one layer at a time - expanded card, then reader, then
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
      // It runs against the selected card's own bar, which is the same handle the
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

      // Global chords that don't need a selected card. Kept above the empty-grid
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

      const ids = visible.map((s) => s.id);
      if (ids.length === 0) return;
      const handle = (): ActionBarHandle | undefined =>
        selectedId ? actionHandles.current.get(selectedId) : undefined;

      // Fixed structural navigation (not rebindable).
      switch (e.key) {
        case "Escape":
          // Peel back one layer at a time: collapse an expanded card first, then
          // (on a second press) cancel any pending action and drop the selection.
          //
          // Grid focus and the board drill-in each sit above selection. Closing either
          // leaves the keyboard cursor parked on the card it came from.
          if (layout === "grid" && expandedId) {
            e.preventDefault();
            setExpandedId(null);
            return;
          }
          // The reader (console detail or board drill-in) sits above the selection the way
          // grid focus does: if the keyboard is inside it, one Escape hands it back to the
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
          // With the keyboard in the reader (console detail or board drill-in), the vertical
          // arrows scroll the active tab's content - the detail owns the scroll node because
          // Conversation and Files use different nested containers. On the rail they fall
          // through to `moveSelection`, which walks the selection a row at a time.
          if (
            readerSession &&
            (e.key === "ArrowUp" || e.key === "ArrowDown") &&
            target?.closest(".cdetail")
          ) {
            const detailScroll = detailScrollers.current.get(readerSession.id);
            if (detailScroll) {
              detailScroll(e.key === "ArrowUp" ? -1 : 1);
              return;
            }
          }
          const nextId = moveSelection({
            mode: layout,
            key: e.key as ArrowKey,
            ids,
            currentId: selectedId,
            cols: columnCount(gridRef.current),
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
          // Cards keeps its conversation in an in-place focus expansion. Enter owns that
          // structural reveal now; the rebindable expand action is reserved for the Board
          // tile's workflow ladder below.
          if (layout === "grid") {
            e.preventDefault();
            pendingReplyFocus.current = expandedId === selectedId ? null : selectedId;
            toggleExpand(selectedId);
            return;
          }
          break;
      }

      // Actions on the selected card.
      if (chord === bindings.expand) {
        // This action is the Board card's in-place workflow disclosure only. It never
        // opens Conversation (Enter owns the drill-in), never closes an open drill-in,
        // and stays unclaimed where there is no selected card with a bound workflow.
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
          selectedIsExpanded: sel != null && expandedId === sel.id,
          boardDetailOpen: boardOpen,
        });
        if (reveal === "none" || !sel) return;
        e.preventDefault();
        // `already` deliberately falls through all three: the conversation is on screen,
        // and this chord reveals rather than toggles.
        if (reveal === "expand") toggleExpand(sel.id);
        else if (reveal === "drill-in") setBoardOpen(true);
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
          selectedIsExpanded: expandedId === sel.id,
          boardDetailOpen: boardOpen,
        });
        if (reveal === "none") return;
        pendingFind.current = sel.id;
        if (reveal === "expand") toggleExpand(sel.id);
        else if (reveal === "drill-in") setBoardOpen(true);
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
        // Cards has no tab strip, so its expanded editor is the extracted workspace.
        // Console and the Board drill-in reveal their shared integrated Files tab.
        const gridExpanded = layout === "grid" && expandedId === sel.id;
        const detailOpen = layout === "console" || (layout === "board" && boardOpen);
        if (!gridExpanded && !detailOpen) return;
        e.preventDefault();
        if (layout === "grid") {
          files.ensure(sel.id);
          setFilesSessionId(sel.id);
        } else {
          requestFilesTab(sel.id);
        }
        return;
      }
      // "Show me how this session's run is going" - the Workflows tab, which holds both the
      // workflow ladder. Unlike the conversation, this surface has
      // no Cards equivalent to fall back to (that layout draws no tab strip and never
      // mounted the ladder), so the chord is left unclaimed there rather than swallowed to
      // no effect - the fleet-wide Workflows page on `w` is what Cards has instead.
      if (chord === bindings.sessionWorkflows) {
        const sel = selectedId ? visible.find((s) => s.id === selectedId) : null;
        if (!sel || layout === "grid") return;
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
      // ResetModal. Needs a card with a working dir; without one we leave the chord
      // alone, so the default Ctrl+R still falls through to a harmless browser reload.
      if (chord === bindings.reset) {
        const sel = selectedId ? visible.find((s) => s.id === selectedId) : null;
        if (!sel?.cwd) return;
        e.preventDefault();
        setResetSessionId(sel.id);
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

        // Cards mount the toolbar only when expanded; the Board overview only after it
        // drills in; Console and an already-open Board detail may be sitting on another
        // tab. Reveal Conversation in the appropriate vocabulary, then registration runs
        // the exact button action rather than choosing a terminal backend on the user's
        // behalf.
        pendingLauncherAction.current = { id: sel.id, run };
        if (layout === "grid") {
          if (expandedId !== sel.id) toggleExpand(sel.id);
        } else if (layout === "board" && !boardOpen) {
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
  }, [visible, selectedId, selected, consoleZone, expandedId, boardOpen, renamingId, toggleExpand, bindings, layout, files.ensure, requestFilesTab, requestConversationTab, requestWorkflowsTab, showLauncherFocusError, openDiff, route.page, navigate, focusReaderRail, focusReaderBody, closeLineDrawer]);

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

  // Land the cursor in a card expanded with Enter. The panel that renders
  // it mounts on the render this effect trails, so a synchronous focus in the chord
  // handler would find no box - the wait is the whole reason this is deferred here.
  // Routed through the SAME `startSend` the `s` shortcut uses, so an unavailable
  // transcript falls back to the card's own compose box exactly as it does there,
  // and the panel still never grabs focus on its own.
  useEffect(() => {
    const id = pendingReplyFocus.current;
    pendingReplyFocus.current = null;
    if (id && expandedId === id) actionHandles.current.get(id)?.startSend();
  }, [expandedId]);

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
            providers={llm.status?.runners ?? []}
            defaults={llm.personaDefaults}
            upstream={personaDrift.upstream}
            onCheckUpstream={personaDrift.refresh}
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
              aria-label="Filter sessions by title or status"
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
                onOpenSettings={() => navigate({ page: "settings", category: "foreman" })}
              />
              <Tooltip label={`Dispatch a new agent (${formatChord(bindings.dispatch)})`}>
                <button className="dispatch-btn" onClick={openDispatch}>
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

        <AppPageShell
          page={route.page}
          library={libraryBody}
          runs={(
            <ExecutionPage
              title="Workflow runs"
              blurb="Every review a workflow has run over a session's work, live and finished."
              actions={(
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
              <WorkflowRuns
                runs={workflowRuns}
                selectedRunId={route.page === "runs" ? route.runId ?? null : null}
                filters={route.page === "runs" ? route.filters : undefined}
                onSelectRun={openWorkflowRun}
                onFilters={(filters) => navigate({
                  page: "runs",
                  ...(route.page === "runs" && route.runId ? { runId: route.runId } : {}),
                  filters,
                })}
                onOpenSession={openSessionOnFleet}
                onOpenInspectorSettings={() => {
                  navigate({ page: "settings", category: "inspector" });
                }}
                // No session and no version pinned: the dialog already supports being opened
                // empty and asking for both.
                onBindWorkflow={() => setWorkflowBindingTarget({})}
              />
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
                revision={scoutsRevision}
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
              onLeave={() => navigate({ page: "fleet" })}
              foreman={foreman}
              cost={cost}
              llm={llm}
              layout={layout}
              onLayoutChange={setLayout}
              settingsStatus={settingsStatus}
              harnessesRevision={harnessesRevision}
              workflowSummaries={workflowSummaries}
              onOpenPalette={() => setPaletteOpen(true)}
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
          openStage={lineDrawer}
          stageRef={registerLineStage}
          onStage={onLineStage}
        />

        {/* The drawer, between the strip and the layouts and a sibling of both. It pushes
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
            items leaves the board with something to arrange and grid/console with none.
            Reading `visible` alone here is what hid a task named "P5: Ghostty terminal
            emulator adapter" the moment you typed "ghostty". */}
        {layoutHasContent && (
          <>
            {layout === "grid" && <GridView {...viewProps} gridRef={gridRef} />}
            {layout === "console" && <ConsoleView {...viewProps} />}
            {layout === "board" && <BoardView {...viewProps} />}
          </>
        )}

        {diffSession && (
          <DiffViewer
            session={diffSession}
            commit={diffCommit}
            onClose={closeDiff}
            // Cards have no Files tab, so `openSessionPath` opens the Files WINDOW here.
            // The diff has to stand down first or it sits on top of the file it just
            // asked for - the one case where opening a file also closes something.
            onOpenInFiles={(path) => {
              const sessionId = diffSession.id;
              closeDiff();
              openSessionPath(sessionId, path);
            }}
          />
        )}

        {filesSession && (
          <FileWindow session={filesSession} controller={files} onClose={closeFiles} />
        )}

        {filePickerSession && (
          <FilePicker
            session={filePickerSession}
            controller={files}
            onClose={closeFilePicker}
            onChoose={(path) => {
              files.select(filePickerSession.id, path);
              closeFilePicker();
              if (layout === "grid") {
                setFilesSessionId(filePickerSession.id);
              } else {
                if (layout === "board") setBoardOpen(true);
                requestFilesTab(filePickerSession.id);
              }
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

        {sessions.length === 0 && (
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
        )}

        {/* Only when the layout drew nothing - on the board a filter that matched only
            backlog items has already rendered them, and telling the operator nothing
            matched while the match is on screen is the bug this replaced. */}
        {sessions.length > 0 && !layoutHasContent && (
          <div className="empty">
            <p className="empty-title">Nothing matches "{filter}"</p>
            <p className="empty-sub">
              No {layout === "board" ? "session or backlog task" : "session"} matches that title or
              status.{" "}
              <Tooltip label="Clear the filter">
                <button className="link-btn" onClick={() => setFilter("")}>
                  Clear the filter
                </button>
              </Tooltip>{" "}
              to see all {sessions.length} sessions.
            </p>
          </div>
        )}

        {/* Grid only. The bar floats fixed over the bottom of the page, which is empty
            space under a scrolling grid but is exactly where the console's detail pane and
            the board's drill-in keep their reply box - it would sit on top of the control it
            is advertising. Both of those layouts show the selected session's ActionBar
            permanently instead, and every shortcut still works. */}
        {selected && layout === "grid" && (
          <CommandBar
            session={selected}
            bindings={bindings}
            expanded={expandedId === selected.id}
            onToggleExpand={() => toggleExpand(selected.id)}
            onAction={(a) => actionHandles.current.get(selected.id)?.[a]()}
            onDiff={() => openDiff(selected.id)}
            onFiles={() => {
              files.ensure(selected.id);
              setFilesSessionId(selected.id);
            }}
            onFilePicker={() => {
              files.ensure(selected.id);
              setFilePickerSessionId(selected.id);
            }}
            onReset={() => setResetSessionId(selected.id)}
            onRename={() => setRenamingId(selected.id)}
            onDeselect={() => setSelectedId(null)}
          />
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
                  onClose={() => setReviewSessionId(null)}
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
                launchIntent={dispatchIntent}
                onClose={closeDispatch}
                onOpenSchedule={onOpenSchedule}
                onEnsembleLaunched={openEnsembleRun}
              />

              {reportOpen && (
                <ReportPanel
                  sessions={sessions}
                  tasks={tasks}
                  backlogPlan={foreman.backlogPlan}
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

              {workflowBindingTarget && (
                <WorkflowBindingDialog
                  target={workflowBindingTarget}
                  sessions={sessions}
                  workflows={workflowSummaries}
                  foremanEnabled={foreman.config?.enabled ?? false}
                  promptedWrapupEnabled={foreman.config?.wrapupTriggers.includes("prompted") ?? false}
                  onClose={() => setWorkflowBindingTarget(null)}
                  onRun={openWorkflowRun}
                />
              )}
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
    </OverlayHost>
  );
}

/**
 * Floating hint bar for the keyboard-selected session: names it and surfaces the
 * available shortcuts (also clickable). Actions are hidden for exited sessions,
 * which have no controls to drive.
 */
function CommandBar({
  session,
  bindings,
  expanded,
  onToggleExpand,
  onAction,
  onDiff,
  onFiles,
  onFilePicker,
  onReset,
  onRename,
  onDeselect,
}: {
  session: Session;
  bindings: Record<ActionId, string>;
  expanded: boolean;
  onToggleExpand: () => void;
  onAction: (
    action:
      | "startSend"
      | "focusPane"
      | "handoff"
      | "toggleQueue"
      | "cycleMode"
      | "requestInterrupt"
      | "requestKill",
  ) => void;
  onDiff: () => void;
  onFiles: () => void;
  onFilePicker: () => void;
  onReset: () => void;
  onRename: () => void;
  onDeselect: () => void;
}): React.JSX.Element {
  const live = session.state !== "exited" && session.state !== "stopping";
  // The shortcut represents Shift+Tab, so menu-based permission controls stay on their card
  // picker rather than receiving a keystroke their TUI gives another meaning - the shared
  // `canCycleMode` is the same gate the keydown handler and the ActionBar button use.
  const showCycleMode = canCycleMode(session);
  const canRename = canRenameSession(session);
  const barRef = useRef<HTMLDivElement>(null);

  // The bar floats fixed over the bottom of the page, so it hides whatever
  // scrolls underneath it - the tail of an expanded card, its compose box, etc.
  // Reserve exactly its footprint (height + its bottom offset + a little air) as
  // page-bottom padding so every card can always scroll clear of it. Measured
  // live because the bar wraps taller on narrow screens; cleared on deselect.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const root = document.documentElement;
    const apply = (): void => {
      root.style.setProperty("--cmdbar-clearance", `${bar.offsetHeight + 36}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--cmdbar-clearance");
    };
  }, []);

  return (
    <div ref={barRef} className="cmdbar" role="toolbar" aria-label="Selected session actions">
      <span className="cmdbar-name">
        <AgentDot agent={session.agent} />
        <span className="cmdbar-name-text">{session.name || "(unnamed)"}</span>
      </span>
      <span className="cmdbar-keys">
        {live && (
          <>
            <Tooltip label="Type a message into this session's prompt">
              <button className="keycap-btn" onClick={() => onAction("startSend")}>
                <kbd>{formatChord(bindings.send)}</kbd> send
              </button>
            </Tooltip>
            {/* One slot, two answers, because they are the same intent: get me to this
                session in a terminal. A pane-backed one is already there and only needs
                raising; an embedded one has no pane until this makes it one. */}
            {session.runtime === "sdk" ? (
              <Tooltip label="Stop the embedded driver and reopen this conversation in a terminal - one way">
                <button className="keycap-btn" onClick={() => onAction("handoff")}>
                  <kbd>{formatChord(bindings.handoff)}</kbd> terminal
                </button>
              </Tooltip>
            ) : (
              <Tooltip label="Bring this session's terminal pane to the front">
                <button className="keycap-btn" onClick={() => onAction("focusPane")}>
                  <kbd>{formatChord(bindings.focus)}</kbd> focus
                </button>
              </Tooltip>
            )}
            <Tooltip label="Show or hide this session's work queue">
              <button className="keycap-btn" onClick={() => onAction("toggleQueue")}>
                <kbd>{formatChord(bindings.queue)}</kbd> queue
              </button>
            </Tooltip>
            {showCycleMode && (
              <Tooltip label="Cycle this session's permission mode">
                <button className="keycap-btn" onClick={() => onAction("cycleMode")}>
                  <kbd>{formatChord(bindings.mode)}</kbd> mode
                </button>
              </Tooltip>
            )}
            {canRename && (
              <Tooltip label="Rename this session's tab">
                <button className="keycap-btn" onClick={onRename}>
                  <kbd>{formatChord(bindings.rename)}</kbd> rename
                </button>
              </Tooltip>
            )}
            {/* Conditional like `mode` and `rename` above rather than standing chrome: this
                strip is a row of offers, and a key that does nothing on an idle agent is
                worse here than absent, because there is no tooltip-carrying disabled state
                in a bar made entirely of keycaps. The shared gate is the same one the card's
                button reads. */}
            {canInterruptSession(session) && (
              <Tooltip label="Stop what this agent is doing now and drop its queued messages">
                <button className="keycap-btn" onClick={() => onAction("requestInterrupt")}>
                  <kbd>{formatChord(bindings.interrupt)}</kbd> interrupt
                </button>
              </Tooltip>
            )}
            <Tooltip label="Terminate this agent">
              <button className="keycap-btn" onClick={() => onAction("requestKill")}>
                <kbd>{formatChord(bindings.kill)}</kbd> kill
              </button>
            </Tooltip>
          </>
        )}
        {session.cwd && (
          <>
            <Tooltip label="View this checkout's changes vs its source branch">
              <button className="keycap-btn" onClick={onDiff}>
                <kbd>{formatChord(bindings.diff)}</kbd> diff
              </button>
            </Tooltip>
            {expanded && (
              <Tooltip label="Browse and edit this checkout's files">
                <button className="keycap-btn" onClick={onFiles}>
                  <kbd>{formatChord(bindings.files)}</kbd> files
                </button>
              </Tooltip>
            )}
            <Tooltip label="Jump to a file in this checkout by name">
              <button className="keycap-btn" onClick={onFilePicker}>
                <kbd>{formatChord(bindings.filePicker)}</kbd> find file
              </button>
            </Tooltip>
          </>
        )}
        {live && session.cwd && (
          <Tooltip label="Reset the checkout to origin's default branch and clear the agent's context">
            <button className="keycap-btn" onClick={onReset}>
              <kbd>{formatChord(bindings.reset)}</kbd> reset
            </button>
          </Tooltip>
        )}
        <Tooltip
          label={
            expanded
              ? "Collapse this session's detail (Enter)"
              : "Expand this session's detail (Enter)"
          }
        >
          <button className="keycap-btn" onClick={onToggleExpand}>
            <kbd>↵</kbd> {expanded ? "collapse" : "expand"}
          </button>
        </Tooltip>
        <span className="cmdbar-hint">
          <kbd>↑↓←→</kbd> move
          <Tooltip label={expanded ? "Collapse this session's detail" : "Clear the current selection"}>
            <button className="keycap-btn" onClick={expanded ? onToggleExpand : onDeselect}>
              <kbd>esc</kbd> {expanded ? "collapse" : "deselect"}
            </button>
          </Tooltip>
        </span>
      </span>
    </div>
  );
}

/** Live column count of the responsive card grid, read from resolved tracks. */
function columnCount(grid: HTMLElement | null): number {
  if (!grid) return 1;
  const tracks = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean);
  return Math.max(1, tracks.length);
}

/**
 * True when a session matches the nav-bar filter. Matches on the card's title,
 * its human status *label* ("running", "needs input", "working", …), and the
 * agent type - so typing "codex", "idle", or a repo name all narrow the grid.
 * Deliberately uses the display label, not the raw `state`: a passively-discovered
 * session's raw state is "working" even though its badge reads "running", so
 * matching raw state would make "working" hit every alive session.
 */
function matchesFilter(s: Session, q: string): boolean {
  const haystack = `${s.name} ${stateDisplay(s).label} ${s.agent}`.toLowerCase();
  return haystack.includes(q);
}

/**
 * True when a backlog task matches the nav-bar filter - the task-shaped counterpart of
 * `matchesFilter`, matching the same three things a session does (title, status, agent)
 * so one query reads the board across both.
 *
 * `status` is the literal here, not a display label, and that is not the inconsistency
 * it looks like: a backlog task's status IS "backlog", the word already on the column
 * header, whereas a session's raw state lies (see `matchesFilter`). Labels join the
 * haystack because they exist to be searched - they are the operator's own tags, and a
 * filter that could not see them would make them decorative.
 */
function matchesTaskFilter(t: Task, q: string): boolean {
  const haystack = `${t.title} ${t.status} ${t.agent} ${t.labels.join(" ")}`.toLowerCase();
  return haystack.includes(q);
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
