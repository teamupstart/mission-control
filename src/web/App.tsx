import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AGENT_TYPES, type FleetCost, type Session, type Task } from "@shared/types.ts";
import { agentList } from "@shared/agent.ts";
import { backlogTasks, gateParked } from "@shared/session.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { canWriteTo } from "@shared/pane.ts";
import { useEventStream } from "./useEventStream.ts";
import type { ActionBarHandle } from "./components/ActionBar.tsx";
import { ReviewModal } from "./components/ReviewModal.tsx";
import { DispatchLayer } from "./components/DispatchModal.tsx";
import { ResetModal } from "./components/ResetModal.tsx";
import { CompleteModal } from "./components/CompleteModal.tsx";
import { KillModal } from "./components/KillModal.tsx";
import { ReportPanel } from "./components/ReportPanel.tsx";
import { AwayDigestCard } from "./components/AwayDigestCard.tsx";
import { DiffViewer } from "./components/DiffViewer.tsx";
import { AlertBar } from "./components/AlertBar.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { DEFAULT_SETTINGS_CATEGORY } from "./lib/settings-registry.ts";
import { settingsGearDot } from "./lib/settings-dots.ts";
import { ForemanBar } from "./components/ForemanBar.tsx";
import { AgentDot } from "./components/session-bits.tsx";
import { compactFleetCost, FleetStrip, fleetStripHasContent } from "./components/FleetStrip.tsx";
import { Tooltip } from "./components/Tooltip.tsx";
import { GridView } from "./components/layouts/GridView.tsx";
import { ConsoleView } from "./components/layouts/ConsoleView.tsx";
import { BoardView } from "./components/layouts/BoardView.tsx";
import type { SessionViewProps } from "./components/layouts/types.ts";
import { dropMessageDrafts } from "./lib/drafts.ts";
import { useNotifier } from "./useNotifier.ts";
import { useForeman } from "./useForeman.ts";
import { useCost } from "./useCost.ts";
import { useLlm } from "./useLlm.ts";
import { useAlertSettings } from "./lib/alertSettings.ts";
import { useAwayMode } from "./lib/awayMode.ts";
import { useStalls } from "./lib/stalls.ts";
import { detailLayer, useLayoutMode } from "./lib/layout.ts";
import { useUsageBarCollapsed } from "./lib/usageBar.ts";
import { moveSelection, type ArrowKey } from "./lib/layoutNav.ts";
import { groupByTone, TONE_ORDER } from "./lib/tone.ts";
import { useKeybindings, chordFromEvent, formatChord } from "./lib/keybindings.ts";
import type { ActionId } from "./lib/keybindings.ts";
import { canRenameSession, stateDisplay, type Tone } from "./lib/format.ts";
import { OverlayHost, OVERLAY_IDS, useOverlayHost } from "./components/Overlay.tsx";
import { FileWindow } from "./components/FileWindow.tsx";
import { FilePicker } from "./components/FilePicker.tsx";
import { useSessionFilesStore } from "./lib/sessionFiles.ts";
import { workspaceFileTarget } from "./lib/workspaceLinks.ts";
import { WorkflowPage } from "./workflows/WorkflowPage.tsx";
import { useWorkflowRoute } from "./workflows/useWorkflowRoute.ts";
import { AppPageShell } from "./components/AppPageShell.tsx";
import {
  WorkflowBindingDialog,
  type WorkflowBindingTarget,
} from "./workflows/WorkflowBindingDialog.tsx";

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
  ["queue", "toggleQueue"],
  ["mode", "cycleMode"],
  ["complete", "requestComplete"],
  ["kill", "requestKill"],
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

export function App(): React.JSX.Element {
  const {
    sessions,
    reviews,
    tasks,
    personas,
    workflowSummaries,
    workflowRunSummaries: workflowRuns,
    fleetCost,
    settingsStatus,
    connected,
    hasSnapshot,
  } = useEventStream();
  const [workflowDirty, setWorkflowDirty] = useState(false);
  const { route, navigate } = useWorkflowRoute(workflowDirty);
  const [alertSettings, updateAlerts] = useAlertSettings();
  const { away, setAway, digest, dismissDigest } = useAwayMode();
  // Stalls come from the daemon (only it has the clock), but only the browser can
  // raise a notification - so they are polled back in here to give the `stuck` alert
  // a delivery path instead of leaving it to the return digest.
  const stalls = useStalls();
  const alertScope = useMemo(
    () => ({ sessions, tasks, stalls, workflowRuns }),
    [sessions, tasks, stalls, workflowRuns],
  );
  useNotifier(alertScope, alertSettings, hasSnapshot);
  const { bindings } = useKeybindings();
  const [layout, setLayout] = useLayoutMode();
  const [usageBarCollapsed, setUsageBarCollapsed] = useUsageBarCollapsed();
  const foreman = useForeman();
  // Owned here rather than by SettingsPage, on the `foreman` precedent: the topbar strip
  // and the Cost panel read the same `view` setting, so a local copy in the page would
  // leave the strip showing the old choice until the next reload - and double-poll.
  const cost = useCost();
  const llm = useLlm();
  // The worst subsystem status, inherited by the topbar gear from the settings rail dots.
  // Null status ("unknown", pre-snapshot) and an all-clear both render no dot.
  const gearDot = settingsGearDot(settingsStatus);
  const gearPhrase = gearDotPhrase(gearDot);
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
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
  const [reportOpen, setReportOpen] = useState(false);
  const [diffSessionId, setDiffSessionId] = useState<string | null>(null);
  const [filesSessionId, setFilesSessionId] = useState<string | null>(null);
  const [filePickerSessionId, setFilePickerSessionId] = useState<string | null>(null);
  const [fileTabRequest, setFileTabRequest] = useState<{
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
  /** When set, the diff viewer shows just this commit (a no-mistakes fix). */
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

  // A session was reset: forget its half-written send and reply text (the reset
  // discarded the task they were about), and bump its nonce so an open reply box
  // remounts empty rather than keeping stale text behind the closing modal.
  const onSessionReset = useCallback((id: string) => {
    dropMessageDrafts(id);
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
  const detailScrollers = useRef<Map<string, (direction: -1 | 1) => void>>(new Map());
  // Set to the id a keyboard expand should drop the cursor into once its send box
  // mounts (see the `expand` chord and the effect that consumes it). A ref, not
  // state: it arms a one-shot side effect, and must not itself cause a render.
  const pendingReplyFocus = useRef<string | null>(null);
  // The board's arrow cursor, armed to take DOM focus once the tile it names has
  // rendered. Same one-shot ref as above, for the same reason.
  const pendingTileFocus = useRef<string | null>(null);
  // A selection chord the board's overview had no action bar to run yet: it opens the
  // drill-in and this holds what to do against the bar that mounts with it.
  const pendingBarAction = useRef<{ id: string; run: keyof ActionBarHandle } | null>(null);
  const gridRef = useRef<HTMLElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const topbarRef = useRef<HTMLElement>(null);

  const registerEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  }, []);

  const focusConsoleRail = useCallback((id: string) => {
    const active = document.activeElement as HTMLElement | null;
    const activeEditor = active?.closest("input, textarea, select, [contenteditable='true']");
    if (activeEditor && !active?.closest(".console-detail")) return;
    cardEls.current.get(id)?.focus({ preventScroll: true });
  }, []);

  const focusConsoleDetail = useCallback(() => {
    document.querySelector<HTMLElement>(".console-detail")?.focus({ preventScroll: true });
  }, []);

  const registerActions = useCallback((id: string, handle: ActionBarHandle | null) => {
    if (handle) actionHandles.current.set(id, handle);
    else actionHandles.current.delete(id);
  }, []);

  const registerDetailScroll = useCallback((id: string, scroll: ((direction: -1 | 1) => void) | null) => {
    if (scroll) detailScrollers.current.set(id, scroll);
    else detailScrollers.current.delete(id);
  }, []);

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
    setDispatchOpen(true);
  }, []);
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
    files.ensure(sessionId);
    files.select(sessionId, target.path);
    if (layout === "grid") {
      setFilesSessionId(sessionId);
    } else {
      setSelectedId(sessionId);
      if (layout === "board") setBoardOpen(true);
      requestFilesTab(sessionId);
    }
    return true;
  }, [files.ensure, files.probe, files.select, layout, requestFilesTab, sessions]);

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

  // Which sessions have a parked no-mistakes gate that actually needs you - a
  // run being driven by any same-run session is left to that agent (see gateParked).
  // Computed once and consumed by every display classifier below.
  const gateAlerts = useMemo(
    () => new Set(sessions.filter((s) => gateParked(s, sessions)).map((s) => s.id)),
    [sessions],
  );
  const workflowRunBySession = useMemo(() => {
    const bySession = new Map<string, (typeof workflowRuns)[number]>();
    for (const run of workflowRuns) {
      if (!run.sessionId) continue;
      const current = bySession.get(run.sessionId);
      if (!current || run.updatedAt > current.updatedAt) bySession.set(run.sessionId, run);
    }
    return bySession;
  }, [workflowRuns]);

  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const ta = TONE_ORDER[stateDisplay(a, gateAlerts.has(a.id)).tone];
      const tb = TONE_ORDER[stateDisplay(b, gateAlerts.has(b.id)).tone];
      return ta - tb || a.name.localeCompare(b.name) || a.pid - b.pid;
    });
  }, [sessions, gateAlerts]);

  // Nav-bar filter: live substring match over each card's title, status, and
  // agent. Empty filter shows everything; keyboard nav and the grid both read
  // this list so they stay in lockstep with what's on screen.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((s) => matchesFilter(s, q, gateAlerts.has(s.id)));
  }, [sorted, filter, gateAlerts]);

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

  const counts = useMemo(() => summarize(sessions, gateAlerts), [sessions, gateAlerts]);
  const pendingReviews = reviews.filter((r) => r.status === "pending");
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

  const backlogCount = useMemo(() => tasks.filter((t) => t.status === "backlog").length, [tasks]);

  // The board's columns as ids, so the arrow keys can cross between them. Derived from
  // the same `groupByTone` the board renders, so navigation can't disagree with what's
  // on screen.
  const boardColumns = useMemo(
    () => groupByTone(visible, gateAlerts).map((g) => g.sessions.map((s) => s.id)),
    [visible, gateAlerts],
  );

  // What "expanded" means depends on the layout, so App resolves it once here rather
  // than leaving each view to force the prop:
  //   grid    - focus mode: at most one card, toggled, usually none.
  //   console - the detail pane IS the expanded card, so it's whatever is selected.
  //   board   - the console detail is separate from the arrow-key cursor; Enter or a
  //             click opens it, and what it opens is the cursor's session.
  // Keeping the state honest (rather than overriding `expanded` at the call site) is
  // what lets Escape, the expand chord and the card's own toggle all agree.
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

  const modalSession = reviewSessionId ? sessions.find((s) => s.id === reviewSessionId) : null;
  const modalReviews = modalSession
    ? pendingReviews.filter((r) => r.sessionId === modalSession.id)
    : [];
  const modalOpen = Boolean(modalSession && modalReviews.length > 0);

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

  function openReviews(): void {
    const first = pendingReviews[0];
    if (first) setReviewSessionId(first.sessionId);
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
    gateAlerts,
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
    fileTabRequest,
    diffTabRequest,
    files,
    onReset: setResetSessionId,
    onComplete: setCompleteSessionId,
    onKill: setKillSessionId,
    onKilled,
    resetNonces,
    registerEl,
    registerActions,
    registerDetailScroll,
    renamingId,
    onRenameStart: setRenamingId,
    onRenameClose: () => setRenamingId(null),
    foremanMode,
    foremanEnabled,
    foremanAllowlist,
    inputReviewBySession,
    pendingReviewIds,
    onEditTask: openTaskEditor,
    workflowRunBySession,
    onOpenWorkflowRun: (runId) => navigate({ page: "workflows", tab: "runs", runId }),
    onBindWorkflow: (sessionId) => setWorkflowBindingTarget({ sessionId }),
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

  // Publish the live topbar height so a focus-expanded card can size itself to
  // exactly fill the screen beneath the sticky bar (which wraps taller on narrow
  // viewports). Measured, not hard-coded, so the fit stays right on any width.
  useEffect(() => {
    const bar = topbarRef.current;
    if (!bar) return;
    const root = document.documentElement;
    const apply = (): void => root.style.setProperty("--topbar-h", `${bar.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--topbar-h");
    };
  }, []);

  // When a card enters focus mode, lift it to the top of the viewport (just under
  // the sticky topbar) so its now-full-screen conversation and reply box land
  // fully in view. Collapsing (expandedId -> null) leaves the scroll position alone.
  useEffect(() => {
    if (!expandedId) return;
    cardEls.current.get(expandedId)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [expandedId]);

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

      // Preserve the native activation of a focused link or button - including the
      // selected tile's own open button, which the arrow keys put the cursor on.
      if (chord === "Enter" && target?.closest("button, a[href]")) return;

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

      // Console focus zones. Tab hands the keyboard from the rail selector to the open
      // conversation so the vertical arrows scroll it; Shift+Tab (and Escape) hand it back.
      // The gate is the logical zone, NOT where DOM focus happens to sit: once a session is
      // open the operator's one Tab has to reach the reader whether the last click left
      // focus on a rail row, on the body, or nowhere. Gating instead on the focused
      // element's rail/detail ancestry was the regression that made a bare Tab fall through
      // to native browser tabbing unless focus already sat on a rail button, walking the
      // buttons rather than the conversation. `!typing` keeps native Tab in the topbar filter
      // and the reply composer; Shift+Tab from the rail zone falls through to the `mode`
      // binding below, so that shortcut still works in Console like every other layout.
      if (layout === "console" && selected && !typing) {
        if (chord === "Tab" && consoleZone === "rail") {
          e.preventDefault();
          setConsoleZone("detail");
          focusConsoleDetail();
          return;
        }
        if (chord === "shift+Tab" && consoleZone === "detail") {
          e.preventDefault();
          setConsoleZone("rail");
          focusConsoleRail(selected.id);
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
          if (layout === "board" && boardOpen) {
            e.preventDefault();
            setBoardOpen(false);
            return;
          }
          // Console's reader zone sits above its selection the way grid focus and the
          // board drill-in do: hand the keyboard back to the rail first, and only drop
          // the selection on the next press.
          if (layout === "console" && selected && consoleZone === "detail") {
            e.preventDefault();
            setConsoleZone("rail");
            focusConsoleRail(selected.id);
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
          // In Console the vertical arrows do one of two things by focus zone. Once the
          // operator has Tabbed into the detail it is a reader, so they scroll its active
          // content; the detail owns the actual scroll node because Conversation and Files
          // use different nested containers. In the rail zone (the default) they fall
          // through to `moveSelection`, which walks the rail a row at a time.
          if (layout === "console" && selected && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            if (consoleZone === "detail") {
              const detailScroll = detailScrollers.current.get(selected.id);
              if (detailScroll) {
                detailScroll(e.key === "ArrowUp" ? -1 : 1);
                return;
              }
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
            if (layout === "console" && consoleZone === "rail") focusConsoleRail(nextId);
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
          if (layout !== "board" || !selectedId || boardOpen) break;
          e.preventDefault();
          setBoardOpen(true);
          return;
      }

      // Actions on the selected card.
      if (chord === bindings.expand) {
        // Focus mode is a grid idea. The console and the board already show the selected
        // session expanded, so there is nothing here to toggle - and we leave the chord
        // unclaimed rather than swallowing it to no effect.
        if (!selectedId || layout !== "grid") return;
        e.preventDefault();
        // Expanding via the keyboard is an explicit "I want to type here", so arm the
        // send box to take the cursor once it mounts. Collapsing (this card is already
        // the expanded one) arms nothing. The focus itself is deferred to the effect
        // below because the reply box only exists after the next render.
        pendingReplyFocus.current = expandedId === selectedId ? null : selectedId;
        toggleExpand(selectedId);
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
      // arrows merely landed on has none - which made `s`/`f`/`q`/⇧⇥/`k` silent no-ops
      // there and broke "every shortcut works in every layout". Drill in and run against
      // the bar that mounts with it, one render later.
      if (layout !== "board" || !selectedId || boardOpen) return;
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
  }, [visible, selectedId, selected, consoleZone, expandedId, boardOpen, renamingId, toggleExpand, bindings, layout, files.ensure, requestFilesTab, openDiff, route.page, focusConsoleRail, focusConsoleDetail]);

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

  // Land the cursor in a keyboard-expanded card's send box. The panel that renders
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

  return (
    <OverlayHost value={overlays}>
      <div className={`app app-${layout}`}>
        <header className="topbar" ref={topbarRef}>
          <div className="brand">
            <img className="brand-mark" src="/favicon.svg" alt="" width={20} height={20} />
            <h1>Mission Control</h1>
          </div>
          <div className="filter-box">
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
          </div>
          <div className="summary">
            <Stat n={sessions.length} label="sessions" />
            {counts.attention > 0 && <Stat n={counts.attention} label="need you" tone="attention" />}
            {counts.working > 0 && <Stat n={counts.working} label="working" tone="working" />}
            {pendingReviews.length > 0 && (
              <Tooltip
                label={`${pendingReviews.length} agent${pendingReviews.length === 1 ? "" : "s"} waiting on your review - open the queue`}
              >
                <button className="stat-btn" onClick={openReviews}>
                  <Stat n={pendingReviews.length} label="reviews" tone="attention" />
                </button>
              </Tooltip>
            )}
          </div>
          {/* Every action shares one rhythm, tighter than the gap separating them
              from the filter/stats, so they read as one cluster and wrap as a
              unit. `live` stays outside it: that is status, not an action. */}
          <div className="topbar-actions">
            <Tooltip
              label={
                route.page === "fleet"
                  ? "Open Workflows - author and run the personas agents follow"
                  : "Return to the fleet of running sessions"
              }
            >
              <button
                className="ghost-btn workflow-nav-btn"
                onClick={() =>
                  navigate(
                    route.page === "fleet"
                      ? { page: "workflows", tab: "workflows" }
                      : { page: "fleet" },
                  )
                }
                aria-label={route.page === "fleet" ? "Open Workflows" : "Return to Fleet"}
              >
                <span aria-hidden>{route.page === "fleet" ? "⌘" : "←"}</span>
                {route.page === "fleet" ? "Workflows" : "Fleet"}
              </button>
            </Tooltip>
            <ForemanBar
              state={foreman}
              onOpenSettings={() => navigate({ page: "settings", category: "foreman" })}
            />
            <Tooltip label={`Dispatch a new agent (${formatChord(bindings.dispatch)})`}>
              <button className="dispatch-btn" onClick={openDispatch}>
                <span aria-hidden>＋</span> Dispatch
              </button>
            </Tooltip>
            <Tooltip
              label={`Sitrep - what every session is doing, and the backlog (${formatChord(bindings.roundup)})`}
            >
              <button
                className="ghost-btn glyph-btn"
                onClick={() => setReportOpen(true)}
                aria-label="Sitrep"
              >
                <span aria-hidden>📡</span>
                {backlogCount > 0 && <span className="ghost-badge">{backlogCount}</span>}
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
            <AlertBar settings={alertSettings} update={updateAlerts} away={away} setAway={setAway} />
          </div>
          <div className={`link ${connected ? "up" : "down"}`}>
            <span className="link-dot" />
            {connected ? "live" : "reconnecting"}
          </div>
          <UsageBar
            fleet={fleetCost}
            view={cost.status?.config.view ?? "usd"}
            collapsed={usageBarCollapsed}
            onToggleCollapsed={() => setUsageBarCollapsed(!usageBarCollapsed)}
          />
        </header>

        <AppPageShell
          page={route.page}
          workflows={(
            <WorkflowPage
              tab={route.page === "workflows" ? route.tab : "workflows"}
              personas={personas}
              workflowSummaries={workflowSummaries}
              workflowRuns={workflowRuns}
              selectedRunId={
                route.page === "workflows" && route.tab === "runs"
                  ? route.runId ?? null
                  : null
              }
              runFilters={
                route.page === "workflows" && route.tab === "runs"
                  ? route.filters
                  : undefined
              }
              llm={llm}
              isOverlayOpen={isOverlayOpen}
              onTab={(tab) => navigate({ page: "workflows", tab })}
              onRun={(runId) => navigate({
                page: "workflows",
                tab: "runs",
                runId,
                ...(route.page === "workflows" && route.tab === "runs" && route.filters
                  ? { filters: route.filters }
                  : {}),
              })}
              onRunFilters={(filters) => navigate({
                page: "workflows",
                tab: "runs",
                ...(route.page === "workflows" && route.tab === "runs" && route.runId
                  ? { runId: route.runId }
                  : {}),
                filters,
              })}
              onOpenSession={(sessionId) => {
                navigate({ page: "fleet" });
                setSelectedId(sessionId);
                if (layout === "board") setBoardOpen(true);
              }}
              onOpenInspectorSettings={() => {
                navigate({ page: "settings", category: "inspector" });
              }}
              onBindVersion={(version) => setWorkflowBindingTarget({
                workflowVersionId: version.id,
                workflowId: version.workflowId,
                workflowVersion: version.version,
                bindingDefaults: version.bindingDefaults,
              })}
              onDirtyChange={setWorkflowDirty}
            />
          )}
          settings={(
            <SettingsPage
              category={route.page === "settings" ? route.category : DEFAULT_SETTINGS_CATEGORY}
              onNavigate={(cat) => navigate({ page: "settings", category: cat })}
              onLeave={() => navigate({ page: "fleet" })}
              foreman={foreman}
              cost={cost}
              llm={llm}
              layout={layout}
              onLayoutChange={setLayout}
              settingsStatus={settingsStatus}
            />
          )}
          fleet={(
            <>

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
          <DiffViewer session={diffSession} commit={diffCommit} onClose={closeDiff} />
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
                onClose={closeDispatch}
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
                  onRun={(runId) => navigate({ page: "workflows", tab: "runs", runId })}
                />
              )}
            </>
          )}
        />
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
  onAction: (action: "startSend" | "focusPane" | "toggleQueue" | "cycleMode" | "requestKill") => void;
  onDiff: () => void;
  onFiles: () => void;
  onFilePicker: () => void;
  onReset: () => void;
  onRename: () => void;
  onDeselect: () => void;
}): React.JSX.Element {
  const live = session.state !== "exited";
  // Cycling a mode needs a harness that has any, and a pane to send the keystroke into.
  const canCycleMode =
    live && Boolean(capabilitiesFor(session.agent).permissionModes) && canWriteTo(session);
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
            <Tooltip label="Bring this session's terminal pane to the front">
              <button className="keycap-btn" onClick={() => onAction("focusPane")}>
                <kbd>{formatChord(bindings.focus)}</kbd> focus
              </button>
            </Tooltip>
            <Tooltip label="Show or hide this session's work queue">
              <button className="keycap-btn" onClick={() => onAction("toggleQueue")}>
                <kbd>{formatChord(bindings.queue)}</kbd> queue
              </button>
            </Tooltip>
            {canCycleMode && (
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
        <Tooltip label={expanded ? "Collapse this session's detail" : "Expand this session's detail"}>
          <button className="keycap-btn" onClick={onToggleExpand}>
            <kbd>{formatChord(bindings.expand)}</kbd> {expanded ? "collapse" : "expand"}
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
function matchesFilter(s: Session, q: string, gateNeedsYou: boolean): boolean {
  const haystack = `${s.name} ${stateDisplay(s, gateNeedsYou).label} ${s.agent}`.toLowerCase();
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

function Stat({ n, label, tone }: { n: number; label: string; tone?: Tone }): React.JSX.Element {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
      <span className="stat-n">{n}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/**
 * The topbar's second row: the fleet strip, foldable.
 *
 * A row of its own rather than living among the session-count pills - mixed content there
 * used to wrap element-by-element (a pill here, a meter dangling on the next line there)
 * because both `.summary` and the strip wrap independently. `flex-basis: 100%` on
 * `.topbar-usage` forces this onto its own line unconditionally, so it never interleaves
 * with the pills again regardless of width.
 *
 * Still rendered INSIDE `<header className="topbar">`: `--topbar-h` is measured live off
 * `topbarRef` with a ResizeObserver, so anything inside the header is accounted for
 * automatically while a sibling after `</header>` is not - focus mode would then overflow
 * by exactly this row's height. The strip is the tallest thing the topbar can grow, which
 * is the whole reason it folds.
 *
 * The fold mirrors `WorkQueue`'s `Header`: the caret is the button, and today's estimate
 * stays visible even collapsed (the work queue's precedent is its `count`) so folding the
 * strip away never hides the one figure worth a glance.
 */
function UsageBar({
  fleet,
  view,
  collapsed,
  onToggleCollapsed,
}: {
  fleet: FleetCost | null;
  view: "usd" | "plan";
  collapsed: boolean;
  onToggleCollapsed: () => void;
}): React.JSX.Element | null {
  if (!fleetStripHasContent(fleet) || !fleet) return null;
  const compactCost = compactFleetCost(fleet);
  return (
    <div className={`topbar-usage${collapsed ? " collapsed" : ""}`}>
      <Tooltip label={collapsed ? "Show fleet cost and usage" : "Fold fleet cost and usage away"}>
        <button
          type="button"
          className="topbar-usage-toggle"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <span className="topbar-usage-caret" aria-hidden>
            {collapsed ? "▸" : "▾"}
          </span>
          Usage
          {collapsed && compactCost && (
            <span className="topbar-usage-compact">{compactCost}</span>
          )}
        </button>
      </Tooltip>
      {!collapsed && <FleetStrip fleet={fleet} view={view} />}
    </div>
  );
}

function summarize(
  sessions: Session[],
  gateAlerts: ReadonlySet<string>,
): { attention: number; working: number } {
  let attention = 0;
  let working = 0;
  for (const s of sessions) {
    const tone = stateDisplay(s, gateAlerts.has(s.id)).tone;
    if (tone === "attention") attention++;
    else if (tone === "working") working++;
  }
  return { attention, working };
}
