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
import { ReportPanel } from "./components/ReportPanel.tsx";
import { AwayDigestCard } from "./components/AwayDigestCard.tsx";
import { DiffViewer } from "./components/DiffViewer.tsx";
import { AlertBar } from "./components/AlertBar.tsx";
import { SettingsModal, type SettingsCategoryId } from "./components/SettingsModal.tsx";
import { ForemanBar } from "./components/ForemanBar.tsx";
import { AgentDot } from "./components/session-bits.tsx";
import { FleetStrip, fleetStripHasContent } from "./components/FleetStrip.tsx";
import { Tooltip } from "./components/Tooltip.tsx";
import { GridView } from "./components/layouts/GridView.tsx";
import { ConsoleView } from "./components/layouts/ConsoleView.tsx";
import { BoardView } from "./components/layouts/BoardView.tsx";
import type { SessionViewProps } from "./components/layouts/types.ts";
import { dropMessageDrafts } from "./lib/drafts.ts";
import { useNotifier } from "./useNotifier.ts";
import { useForeman } from "./useForeman.ts";
import { useCost } from "./useCost.ts";
import { useAlertSettings } from "./lib/alertSettings.ts";
import { useAwayMode } from "./lib/awayMode.ts";
import { useStalls } from "./lib/stalls.ts";
import { detailLayer, useLayoutMode } from "./lib/layout.ts";
import { useUsageBarCollapsed } from "./lib/usageBar.ts";
import { moveSelection, type ArrowKey } from "./lib/layoutNav.ts";
import { groupByTone, TONE_ORDER } from "./lib/tone.ts";
import { useKeybindings, chordFromEvent, formatChord } from "./lib/keybindings.ts";
import type { ActionId } from "./lib/keybindings.ts";
import { canRenameSession, fmtUsd, stateDisplay, type Tone } from "./lib/format.ts";
import { OverlayHost, OVERLAY_IDS, useOverlayHost } from "./components/Overlay.tsx";

export function App(): React.JSX.Element {
  const { sessions, reviews, tasks, fleetCost, connected, hasSnapshot } = useEventStream();
  const [alertSettings, updateAlerts] = useAlertSettings();
  const { away, setAway, digest, dismissDigest } = useAwayMode();
  // Stalls come from the daemon (only it has the clock), but only the browser can
  // raise a notification - so they are polled back in here to give the `stuck` alert
  // a delivery path instead of leaving it to the return digest.
  const stalls = useStalls();
  const alertScope = useMemo(() => ({ sessions, tasks, stalls }), [sessions, tasks, stalls]);
  useNotifier(alertScope, alertSettings, hasSnapshot);
  const { bindings } = useKeybindings();
  const [layout, setLayout] = useLayoutMode();
  const [usageBarCollapsed, setUsageBarCollapsed] = useUsageBarCollapsed();
  const foreman = useForeman();
  // Owned here rather than by SettingsModal, on the `foreman` precedent: the topbar strip
  // and the Cost panel read the same `view` setting, so a local copy in the modal would
  // leave the strip showing the old choice until the next reload - and double-poll.
  const cost = useCost();
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Only one card expands at a time - opening a new one collapses the previous.
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which category Settings opens on. The gear and ⌘, land on Keyboard; the ForemanBar
  // "manage in Settings" link deep-links Foreman. Applied via SettingsModal's
  // initialCategory, which re-reads on each open because the modal remounts.
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategoryId>("keyboard");
  const [diffSessionId, setDiffSessionId] = useState<string | null>(null);
  /** When set, the diff viewer shows just this commit (a no-mistakes fix). */
  const [diffCommit, setDiffCommit] = useState<string | null>(null);
  const [resetSessionId, setResetSessionId] = useState<string | null>(null);
  // Bumped for a session each time it's reset. The compose boxes are uncontrolled
  // (their text is parked in the draft map, not React state), so clearing the map
  // alone leaves a box that's OPEN at reset still showing the old text - the same
  // way clearing the queue wouldn't empty an open panel if the panel weren't driven
  // by pushed state. This nonce is the reply box's remount key, so a reset re-hydrates
  // it from the now-empty draft, matching how reset visibly clears the queue.
  const [resetNonces, setResetNonces] = useState<Record<string, number>>({});

  // A session was reset: forget its half-written send and reply text (the reset
  // discarded the task they were about), and bump its nonce so an open reply box
  // remounts empty rather than keeping stale text behind the closing modal.
  const onSessionReset = useCallback((id: string) => {
    dropMessageDrafts(id);
    setResetNonces((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
  }, []);
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

  // The native "Settings…" menu item (⌘,) pushes here over IPC; the topbar gear
  // sets the same state directly. No-op in a plain browser (no preload bridge).
  useEffect(
    () =>
      window.missionDesktop?.onOpenSettings(() => {
        setSettingsCategory("keyboard");
        setSettingsOpen(true);
      }),
    [],
  );

  // Live element + imperative-handle maps for the keyboard-selected card.
  const cardEls = useRef<Map<string, HTMLElement>>(new Map());
  const actionHandles = useRef<Map<string, ActionBarHandle>>(new Map());
  // Set to the id a keyboard expand should drop the cursor into once its send box
  // mounts (see the `expand` chord and the effect that consumes it). A ref, not
  // state: it arms a one-shot side effect, and must not itself cause a render.
  const pendingReplyFocus = useRef<string | null>(null);
  const gridRef = useRef<HTMLElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const topbarRef = useRef<HTMLElement>(null);

  const registerEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  }, []);

  const registerActions = useCallback((id: string, handle: ActionBarHandle | null) => {
    if (handle) actionHandles.current.set(id, handle);
    else actionHandles.current.delete(id);
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
      const drop = detailLayer(layout) === "expanded" ? setExpandedId : setSelectedId;
      drop((cur) => (cur === id ? null : cur));
    },
    [layout],
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
    ],
    [diffSessionId, resetSessionId, closeDiff, closeReset],
  );

  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const ta = TONE_ORDER[stateDisplay(a).tone];
      const tb = TONE_ORDER[stateDisplay(b).tone];
      return ta - tb || a.name.localeCompare(b.name) || a.pid - b.pid;
    });
  }, [sessions]);

  // Nav-bar filter: live substring match over each card's title, status, and
  // agent. Empty filter shows everything; keyboard nav and the grid both read
  // this list so they stay in lockstep with what's on screen.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((s) => matchesFilter(s, q));
  }, [sorted, filter]);

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
  // Which sessions have a parked no-mistakes gate that actually needs you - a
  // run being driven by any same-worktree/branch session is left to that agent
  // (see gateParked). Computed once so each card just reads a boolean.
  const gateAlerts = useMemo(
    () => new Set(sessions.filter((s) => gateParked(s, sessions)).map((s) => s.id)),
    [sessions],
  );
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
    () => groupByTone(visible).map((g) => g.sessions.map((s) => s.id)),
    [visible],
  );

  // What "expanded" means depends on the layout, so App resolves it once here rather
  // than leaving each view to force the prop:
  //   grid    - focus mode: at most one card, toggled, usually none.
  //   console - the detail pane IS the expanded card, so it's whatever is selected.
  //   board   - same: selecting drills into the console detail, so it's whatever is selected.
  // Keeping the state honest (rather than overriding `expanded` at the call site) is
  // what lets Escape, the expand chord and the card's own toggle all agree.
  const expandedForView = layout === "grid" ? expandedId : selectedId;

  const modalSession = reviewSessionId ? sessions.find((s) => s.id === reviewSessionId) : null;
  const modalReviews = modalSession
    ? pendingReviews.filter((r) => r.sessionId === modalSession.id)
    : [];
  const modalOpen = Boolean(modalSession && modalReviews.length > 0);

  const selected = selectedId ? visible.find((s) => s.id === selectedId) ?? null : null;
  const diffSession = diffSessionId ? sessions.find((s) => s.id === diffSessionId) ?? null : null;
  const resetSession = resetSessionId ? sessions.find((s) => s.id === resetSessionId) ?? null : null;

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
    onSelect: setSelectedId,
    onDeselect: () => setSelectedId(null),
    expandedId: expandedForView,
    onToggleExpand: toggleExpand,
    onOpenReviews: setReviewSessionId,
    onOpenDiff: (id, commit) => {
      setDiffCommit(commit ?? null);
      setDiffSessionId(id);
    },
    onReset: setResetSessionId,
    onKilled,
    resetNonces,
    registerEl,
    registerActions,
    renamingId,
    onRenameStart: setRenamingId,
    onRenameClose: () => setRenamingId(null),
    foremanMode,
    foremanEnabled,
    foremanAllowlist,
    inputReviewBySession,
    pendingReviewIds,
    onEditTask: openTaskEditor,
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
    if (selectedId && !sessions.some((s) => s.id === selectedId)) setSelectedId(null);
    if (expandedId && !sessions.some((s) => s.id === expandedId)) setExpandedId(null);
    for (const bound of sessionBoundOverlays) {
      if (bound.sessionId && !sessions.some((s) => s.id === bound.sessionId)) bound.close();
    }
    if (renamingId && !visible.some((s) => s.id === renamingId)) setRenamingId(null);
  }, [sessions, visible, selectedId, expandedId, sessionBoundOverlays, renamingId]);

  // Keep the keyboard-selected card in view as selection moves.
  useEffect(() => {
    if (!selectedId) return;
    cardEls.current.get(selectedId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
      if (overlaysRef.current.anyOpen || renamingId || typing) return;

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
          // Grid-only, because only the grid has a layer to peel: in the console and
          // the board, "expanded" is just what the detail pane is, so collapsing would
          // change nothing on screen while eating the Escape that should have closed
          // the drawer. (`expandedId` can also be a leftover from a visit to the grid.)
          if (layout === "grid" && expandedId) {
            e.preventDefault();
            setExpandedId(null);
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
          const nextId = moveSelection({
            mode: layout,
            key: e.key as ArrowKey,
            ids,
            currentId: selectedId,
            cols: columnCount(gridRef.current),
            columns: boardColumns,
          });
          if (nextId) setSelectedId(nextId);
          return;
        }
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
        setDiffCommit(null); // the shortcut means the whole branch, not a stale fix
        setDiffSessionId(selectedId);
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
      const h = handle();
      if (!h) return;
      if (chord === bindings.send) {
        e.preventDefault();
        h.startSend();
      } else if (chord === bindings.focus) {
        e.preventDefault();
        h.focusPane();
      } else if (chord === bindings.queue) {
        e.preventDefault();
        h.toggleQueue();
      } else if (chord === bindings.mode) {
        e.preventDefault();
        h.cycleMode();
      } else if (chord === bindings.kill) {
        e.preventDefault();
        h.requestKill();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // No `overlays` entry: the guards read `overlaysRef`, so this listener does not need
    // re-subscribing when an overlay opens - and, more to the point, its correctness no
    // longer depends on that re-subscription having happened yet. This dependency array
    // was the third place a new overlay used to have to be remembered, and the one with no
    // visible symptom when it was missed.
  }, [visible, selectedId, expandedId, renamingId, toggleExpand, bindings, layout]);

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
            )}
          </div>
          <div className="summary">
            <Stat n={sessions.length} label="sessions" />
            {counts.attention > 0 && <Stat n={counts.attention} label="need you" tone="attention" />}
            {counts.working > 0 && <Stat n={counts.working} label="working" tone="working" />}
            {pendingReviews.length > 0 && (
              <button className="stat-btn" onClick={openReviews}>
                <Stat n={pendingReviews.length} label="reviews" tone="attention" />
              </button>
            )}
          </div>
          {/* Every action shares one rhythm, tighter than the gap separating them
              from the filter/stats, so they read as one cluster and wrap as a
              unit. `live` stays outside it: that is status, not an action. */}
          <div className="topbar-actions">
            <ForemanBar
              state={foreman}
              onOpenSettings={() => {
                setSettingsCategory("foreman");
                setSettingsOpen(true);
              }}
            />
            <button
              className="dispatch-btn"
              onClick={openDispatch}
              title={`Dispatch a new agent (${formatChord(bindings.dispatch)})`}
            >
              <span aria-hidden>＋</span> Dispatch
            </button>
            <button
              className="ghost-btn glyph-btn"
              onClick={() => setReportOpen(true)}
              title={`Sitrep - press ${formatChord(bindings.roundup)}`}
              aria-label="Sitrep"
            >
              <span aria-hidden>📡</span>
              {backlogCount > 0 && <span className="ghost-badge">{backlogCount}</span>}
            </button>
            <button
              className="ghost-btn glyph-btn gear-btn"
              onClick={() => {
                setSettingsCategory("keyboard");
                setSettingsOpen(true);
              }}
              title="Settings (⌘,)"
              aria-label="Settings"
            >
              <span aria-hidden>⚙</span>
            </button>
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
          onClose={closeDispatch}
        />

        {reportOpen && (
          <ReportPanel
            sessions={sessions}
            tasks={tasks}
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

        {diffSession && (
          <DiffViewer session={diffSession} commit={diffCommit} onClose={closeDiff} />
        )}

        {settingsOpen && (
          <SettingsModal
            onClose={() => setSettingsOpen(false)}
            foreman={foreman}
            cost={cost}
            initialCategory={settingsCategory}
            layout={layout}
            onLayoutChange={setLayout}
          />
        )}

        {resetSession && (
          <ResetModal
            session={resetSession}
            onReset={() => onSessionReset(resetSession.id)}
            onClose={() => setResetSessionId(null)}
          />
        )}

        {sessions.length === 0 && (
          <div className="empty">
            <p className="empty-title">No agent sessions detected</p>
            {/* Names the harnesses off the union, not by hand: an operator running an
                agent this build can discover but this sentence never mentioned would
                read it as "that one isn't supported" and stop looking. */}
            <p className="empty-sub">
              Start a {agentList(AGENT_TYPES)} session in a wezterm tab or tmux session and it
              will appear here.
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
              <button className="link-btn" onClick={() => setFilter("")}>
                Clear the filter
              </button>{" "}
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
            onDiff={() => {
              setDiffCommit(null);
              setDiffSessionId(selected.id);
            }}
            onReset={() => setResetSessionId(selected.id)}
            onRename={() => setRenamingId(selected.id)}
            onDeselect={() => setSelectedId(null)}
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
            <button className="keycap-btn" onClick={() => onAction("startSend")}>
              <kbd>{formatChord(bindings.send)}</kbd> send
            </button>
            <button className="keycap-btn" onClick={() => onAction("focusPane")}>
              <kbd>{formatChord(bindings.focus)}</kbd> focus
            </button>
            <button
              className="keycap-btn"
              onClick={() => onAction("toggleQueue")}
              title="Show or hide this session's work queue"
            >
              <kbd>{formatChord(bindings.queue)}</kbd> queue
            </button>
            {canCycleMode && (
              <button className="keycap-btn" onClick={() => onAction("cycleMode")}>
                <kbd>{formatChord(bindings.mode)}</kbd> mode
              </button>
            )}
            {canRename && (
              <button className="keycap-btn" onClick={onRename} title="Rename this session's tab">
                <kbd>{formatChord(bindings.rename)}</kbd> rename
              </button>
            )}
            <button className="keycap-btn" onClick={() => onAction("requestKill")}>
              <kbd>{formatChord(bindings.kill)}</kbd> kill
            </button>
          </>
        )}
        {session.cwd && (
          <button className="keycap-btn" onClick={onDiff}>
            <kbd>{formatChord(bindings.diff)}</kbd> diff
          </button>
        )}
        {live && session.cwd && (
          <button className="keycap-btn" onClick={onReset} title="Reset to origin & clear context">
            <kbd>{formatChord(bindings.reset)}</kbd> reset
          </button>
        )}
        <button className="keycap-btn" onClick={onToggleExpand}>
          <kbd>{formatChord(bindings.expand)}</kbd> {expanded ? "collapse" : "expand"}
        </button>
        <span className="cmdbar-hint">
          <kbd>↑↓←→</kbd> move
          <button className="keycap-btn" onClick={expanded ? onToggleExpand : onDeselect}>
            <kbd>esc</kbd> {expanded ? "collapse" : "deselect"}
          </button>
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
 * The fold mirrors `WorkQueue`'s `Header`: the caret is the button, and today's spend
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
  return (
    <div className={`topbar-usage${collapsed ? " collapsed" : ""}`}>
      <button
        type="button"
        className="topbar-usage-toggle"
        aria-expanded={!collapsed}
        title={collapsed ? "Show fleet cost and usage" : "Fold fleet cost and usage away"}
        onClick={onToggleCollapsed}
      >
        <span className="topbar-usage-caret" aria-hidden>
          {collapsed ? "▸" : "▾"}
        </span>
        Usage
        {collapsed && fleet.spendToday > 0 && (
          <span className="topbar-usage-compact">{fmtUsd(fleet.spendToday)}</span>
        )}
      </button>
      {!collapsed && <FleetStrip fleet={fleet} view={view} />}
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
