import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { gateParked } from "@shared/session.ts";
import { useEventStream } from "./useEventStream.ts";
import { SessionCard } from "./components/SessionCard.tsx";
import type { ActionBarHandle } from "./components/ActionBar.tsx";
import { ReviewModal } from "./components/ReviewModal.tsx";
import { DispatchLayer } from "./components/DispatchModal.tsx";
import { ResetModal } from "./components/ResetModal.tsx";
import { ReportPanel } from "./components/ReportPanel.tsx";
import { DiffViewer } from "./components/DiffViewer.tsx";
import { AlertBar } from "./components/AlertBar.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { ForemanBar } from "./components/ForemanBar.tsx";
import { useNotifier } from "./useNotifier.ts";
import { useForeman } from "./useForeman.ts";
import { useAlertSettings } from "./lib/alertSettings.ts";
import { useKeybindings, chordFromEvent, formatChord } from "./lib/keybindings.ts";
import type { ActionId } from "./lib/keybindings.ts";
import { stateDisplay, type Tone } from "./lib/format.ts";

// Sort priority: things needing you first, then busy, then calm, then
// unconfirmed (uninstrumented "running"), then gone.
const TONE_ORDER: Record<Tone, number> = {
  attention: 0,
  working: 1,
  idle: 2,
  neutral: 3,
  exited: 4,
};

export function App(): React.JSX.Element {
  const { sessions, reviews, tasks, connected, hasSnapshot } = useEventStream();
  const [alertSettings, updateAlerts] = useAlertSettings();
  useNotifier({ sessions, tasks }, alertSettings, hasSnapshot);
  const { bindings } = useKeybindings();
  const foreman = useForeman();
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Only one card expands at a time - opening a new one collapses the previous.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Only whether the dispatch modal is open. The draft it edits belongs to
  // DispatchLayer, deliberately out of this component: App re-renders the whole
  // session grid, and the draft has to survive a close without dragging every
  // keystroke through it.
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diffSessionId, setDiffSessionId] = useState<string | null>(null);
  const [resetSessionId, setResetSessionId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // The native "Settings…" menu item (⌘,) pushes here over IPC; the topbar gear
  // sets the same state directly. No-op in a plain browser (no preload bridge).
  useEffect(() => window.fleetDesktop?.onOpenSettings(() => setSettingsOpen(true)), []);

  // Live element + imperative-handle maps for the keyboard-selected card.
  const cardEls = useRef<Map<string, HTMLElement>>(new Map());
  const actionHandles = useRef<Map<string, ActionBarHandle>>(new Map());
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

  const closeDispatch = useCallback(() => setDispatchOpen(false), []);

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

  const backlogCount = useMemo(() => tasks.filter((t) => t.status === "queued").length, [tasks]);

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

  // Drop selection / collapse / close the diff if the session disappears
  // (exited + reaped, etc.).
  useEffect(() => {
    if (selectedId && !sessions.some((s) => s.id === selectedId)) setSelectedId(null);
    if (expandedId && !sessions.some((s) => s.id === expandedId)) setExpandedId(null);
    if (diffSessionId && !sessions.some((s) => s.id === diffSessionId)) setDiffSessionId(null);
    if (resetSessionId && !sessions.some((s) => s.id === resetSessionId)) setResetSessionId(null);
  }, [sessions, selectedId, expandedId, diffSessionId, resetSessionId]);

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

      // Roundup toggles whether it's open or closed - held back only while a
      // review/dispatch/settings overlay owns the screen or you're typing.
      if (
        !typing &&
        !modalOpen &&
        !dispatchOpen &&
        !diffSession &&
        !settingsOpen &&
        !resetSession &&
        chord === bindings.roundup
      ) {
        e.preventDefault();
        setReportOpen((v) => !v);
        return;
      }

      // Stand down while any overlay owns the screen, so grid shortcuts don't
      // drive a background card behind the panel/modal.
      if (modalOpen || dispatchOpen || reportOpen || settingsOpen || diffSession || resetSession || typing)
        return;

      // Global chords that don't need a selected card. Kept above the empty-grid
      // guard so dispatch still opens when there are no sessions yet.
      if (chord === bindings.dispatch) {
        e.preventDefault();
        setDispatchOpen(true);
        return;
      }
      if (chord === bindings.filter) {
        e.preventDefault();
        filterRef.current?.focus();
        return;
      }

      const ids = visible.map((s) => s.id);
      if (ids.length === 0) return;
      const idx = selectedId ? ids.indexOf(selectedId) : -1;
      const handle = (): ActionBarHandle | undefined =>
        selectedId ? actionHandles.current.get(selectedId) : undefined;

      // Fixed structural navigation (not rebindable).
      switch (e.key) {
        case "Escape":
          // Peel back one layer at a time: collapse an expanded card first, then
          // (on a second press) cancel any pending action and drop the selection.
          if (expandedId) {
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
          const cols = columnCount(gridRef.current);
          let next: number;
          if (idx === -1) next = 0;
          else if (e.key === "ArrowRight") next = idx + 1;
          else if (e.key === "ArrowLeft") next = idx - 1;
          else if (e.key === "ArrowDown") next = idx + cols;
          else next = idx - cols;
          const nextId = ids[next];
          if (nextId) setSelectedId(nextId);
          return;
        }
      }

      // Actions on the selected card.
      if (chord === bindings.expand) {
        if (!selectedId) return;
        e.preventDefault();
        toggleExpand(selectedId);
        return;
      }
      if (chord === bindings.diff) {
        if (!selectedId) return;
        e.preventDefault();
        setDiffSessionId(selectedId);
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
  }, [
    visible,
    selectedId,
    expandedId,
    modalOpen,
    dispatchOpen,
    reportOpen,
    settingsOpen,
    diffSession,
    resetSession,
    toggleExpand,
    bindings,
  ]);

  return (
    <div className="app">
      <header className="topbar" ref={topbarRef}>
        <div className="brand">
          <img className="brand-mark" src="/favicon.svg" alt="" width={20} height={20} />
          <h1>Agent Wrangler</h1>
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
        <AlertBar settings={alertSettings} update={updateAlerts} />
        <ForemanBar state={foreman} />
        <button
          className="ghost-btn settings-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings (⌘,)"
          aria-label="Settings"
        >
          <span aria-hidden>⚙</span>
        </button>
        <button
          className="ghost-btn"
          onClick={() => setReportOpen(true)}
          title={`Roundup - press ${formatChord(bindings.roundup)}`}
        >
          Roundup
          <kbd className="ghost-key" aria-hidden>
            {formatChord(bindings.roundup)}
          </kbd>
          {backlogCount > 0 && <span className="ghost-badge">{backlogCount}</span>}
        </button>
        <button
          className="dispatch-btn"
          onClick={() => setDispatchOpen(true)}
          title={`Dispatch a new agent (${formatChord(bindings.dispatch)})`}
        >
          <span aria-hidden>＋</span> Dispatch
        </button>
        <div className={`link ${connected ? "up" : "down"}`}>
          <span className="link-dot" />
          {connected ? "live" : "reconnecting"}
        </div>
      </header>

      <main className="grid" ref={gridRef}>
        {visible.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            gateNeedsYou={gateAlerts.has(s.id)}
            selected={s.id === selectedId}
            onSelect={() => setSelectedId(s.id)}
            expanded={expandedId === s.id}
            onToggleExpand={() => toggleExpand(s.id)}
            onOpenReviews={() => setReviewSessionId(s.id)}
            onOpenDiff={() => setDiffSessionId(s.id)}
            onReset={() => setResetSessionId(s.id)}
            registerEl={registerEl}
            registerActions={registerActions}
            foremanMode={foremanMode}
            inputReviewId={inputReviewBySession.get(s.id) ?? null}
            pendingReviewIds={pendingReviewIds}
          />
        ))}
      </main>

      {modalSession && modalReviews.length > 0 && (
        <ReviewModal
          session={modalSession}
          reviews={modalReviews}
          onClose={() => setReviewSessionId(null)}
        />
      )}

      <DispatchLayer open={dispatchOpen} onClose={closeDispatch} />

      {reportOpen && (
        <ReportPanel
          sessions={sessions}
          tasks={tasks}
          onClose={() => setReportOpen(false)}
          onOpenReviews={(id) => {
            setReportOpen(false);
            setReviewSessionId(id);
          }}
        />
      )}

      {diffSession && (
        <DiffViewer session={diffSession} onClose={() => setDiffSessionId(null)} />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {resetSession && (
        <ResetModal session={resetSession} onClose={() => setResetSessionId(null)} />
      )}

      {sessions.length === 0 && (
        <div className="empty">
          <p className="empty-title">No agent sessions detected</p>
          <p className="empty-sub">
            Start a <code>claude</code> or <code>codex</code> session in a wezterm tab or tmux
            session and it will appear here.
          </p>
        </div>
      )}

      {sessions.length > 0 && visible.length === 0 && (
        <div className="empty">
          <p className="empty-title">No sessions match "{filter}"</p>
          <p className="empty-sub">
            Nothing matches that title or status.{" "}
            <button className="link-btn" onClick={() => setFilter("")}>
              Clear the filter
            </button>{" "}
            to see all {sessions.length} sessions.
          </p>
        </div>
      )}

      {selected && (
        <CommandBar
          session={selected}
          bindings={bindings}
          expanded={expandedId === selected.id}
          onToggleExpand={() => toggleExpand(selected.id)}
          onAction={(a) => actionHandles.current.get(selected.id)?.[a]()}
          onDiff={() => setDiffSessionId(selected.id)}
          onReset={() => setResetSessionId(selected.id)}
          onDeselect={() => setSelectedId(null)}
        />
      )}
    </div>
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
  onDeselect,
}: {
  session: Session;
  bindings: Record<ActionId, string>;
  expanded: boolean;
  onToggleExpand: () => void;
  onAction: (action: "startSend" | "focusPane" | "cycleMode" | "requestKill") => void;
  onDiff: () => void;
  onReset: () => void;
  onDeselect: () => void;
}): React.JSX.Element {
  const live = session.state !== "exited";
  // Permission modes are Claude-only, and cycling one needs a pane to send into.
  const canCycleMode = live && session.agent === "claude" && Boolean(session.tmux || session.wezterm);
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
        <span className={`agent-dot agent-${session.agent}`} aria-hidden />
        {session.name || "(unnamed)"}
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
            {canCycleMode && (
              <button className="keycap-btn" onClick={() => onAction("cycleMode")}>
                <kbd>{formatChord(bindings.mode)}</kbd> mode
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

function Stat({ n, label, tone }: { n: number; label: string; tone?: Tone }): React.JSX.Element {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
      <span className="stat-n">{n}</span>
      <span className="stat-label">{label}</span>
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
