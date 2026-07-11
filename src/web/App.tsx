import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { gateParked } from "@shared/session.ts";
import { useEventStream } from "./useEventStream.ts";
import { SessionCard } from "./components/SessionCard.tsx";
import type { ActionBarHandle } from "./components/ActionBar.tsx";
import { ReviewModal } from "./components/ReviewModal.tsx";
import { DispatchModal } from "./components/DispatchModal.tsx";
import { ReportPanel } from "./components/ReportPanel.tsx";
import { DiffViewer } from "./components/DiffViewer.tsx";
import { stateDisplay, type Tone } from "./lib/format.ts";

// Sort priority: things needing you first, then busy, then calm, then gone.
const TONE_ORDER: Record<Tone, number> = {
  attention: 0,
  working: 1,
  neutral: 2,
  idle: 3,
  exited: 4,
};

export function App(): React.JSX.Element {
  const { sessions, reviews, tasks, connected } = useEventStream();
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [diffSessionId, setDiffSessionId] = useState<string | null>(null);

  // Live element + imperative-handle maps for the keyboard-selected card.
  const cardEls = useRef<Map<string, HTMLElement>>(new Map());
  const actionHandles = useRef<Map<string, ActionBarHandle>>(new Map());
  const gridRef = useRef<HTMLElement>(null);

  const registerEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  }, []);

  const registerActions = useCallback((id: string, handle: ActionBarHandle | null) => {
    if (handle) actionHandles.current.set(id, handle);
    else actionHandles.current.delete(id);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const ta = TONE_ORDER[stateDisplay(a).tone];
      const tb = TONE_ORDER[stateDisplay(b).tone];
      return ta - tb || a.name.localeCompare(b.name) || a.pid - b.pid;
    });
  }, [sessions]);

  const counts = useMemo(() => summarize(sessions), [sessions]);
  // Which sessions have a parked no-mistakes gate that actually needs you - a
  // run being driven by any same-worktree/branch session is left to that agent
  // (see gateParked). Computed once so each card just reads a boolean.
  const gateAlerts = useMemo(
    () => new Set(sessions.filter((s) => gateParked(s, sessions)).map((s) => s.id)),
    [sessions],
  );
  const pendingReviews = reviews.filter((r) => r.status === "pending");

  // Repo suggestions for the dispatch form: distinct cwds of live sessions. The
  // daemon resolves each to its git top-level, so a pane path is a fine starting point.
  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) if (s.cwd) set.add(s.cwd);
    return [...set].sort();
  }, [sessions]);

  const backlogCount = useMemo(() => tasks.filter((t) => t.status === "queued").length, [tasks]);

  const modalSession = reviewSessionId ? sessions.find((s) => s.id === reviewSessionId) : null;
  const modalReviews = modalSession
    ? pendingReviews.filter((r) => r.sessionId === modalSession.id)
    : [];
  const modalOpen = Boolean(modalSession && modalReviews.length > 0);

  const selected = selectedId ? sorted.find((s) => s.id === selectedId) ?? null : null;
  const diffSession = diffSessionId ? sessions.find((s) => s.id === diffSessionId) ?? null : null;

  function openReviews(): void {
    const first = pendingReviews[0];
    if (first) setReviewSessionId(first.sessionId);
  }

  // Drop selection / close the diff if the session disappears (exited + reaped, etc.).
  useEffect(() => {
    if (selectedId && !sessions.some((s) => s.id === selectedId)) setSelectedId(null);
    if (diffSessionId && !sessions.some((s) => s.id === diffSessionId)) setDiffSessionId(null);
  }, [sessions, selectedId, diffSessionId]);

  // Forget expand state for sessions that are gone so the set can't grow unbounded.
  useEffect(() => {
    setExpandedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(sessions.map((s) => s.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

  // Keep the keyboard-selected card in view as selection moves.
  useEffect(() => {
    if (!selectedId) return;
    cardEls.current.get(selectedId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

  // Global keyboard driving: Tab toggles selection, arrows move it (row-aware),
  // s/f/k act on the selected card, Esc deselects. Typing fields and the review
  // modal keep their own keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));

      // "r" toggles the fleet report - works whether it's open or closed. Held
      // back only while a review/dispatch overlay owns the screen or you're typing.
      if (
        !typing &&
        !modalOpen &&
        !dispatchOpen &&
        !diffSession &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.toLowerCase() === "r"
      ) {
        e.preventDefault();
        setReportOpen((v) => !v);
        return;
      }

      // Stand down while any overlay owns the screen, so grid shortcuts (s/f/k/
      // arrows/Tab/Esc) don't drive a background card behind the panel/modal.
      if (modalOpen || dispatchOpen || reportOpen || diffSession || typing) return;

      const ids = sorted.map((s) => s.id);
      if (ids.length === 0) return;
      const idx = selectedId ? ids.indexOf(selectedId) : -1;
      const handle = (): ActionBarHandle | undefined =>
        selectedId ? actionHandles.current.get(selectedId) : undefined;

      switch (e.key) {
        case "Tab":
          e.preventDefault();
          setSelectedId((cur) => (cur ? null : ids[0] ?? null));
          return;
        case "Escape":
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
        default: {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const k = e.key.toLowerCase();
          if (k === "e") {
            if (!selectedId) return;
            e.preventDefault();
            toggleExpand(selectedId);
            return;
          }
          if (k === "d") {
            if (!selectedId) return;
            e.preventDefault();
            setDiffSessionId(selectedId);
            return;
          }
          if (k !== "s" && k !== "f" && k !== "k") return;
          const h = handle();
          if (!h) return;
          e.preventDefault();
          if (k === "s") h.startSend();
          else if (k === "f") h.focusPane();
          else h.requestKill();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sorted, selectedId, modalOpen, dispatchOpen, reportOpen, diffSession, toggleExpand]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◆
          </span>
          <h1>AI Harness</h1>
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
        <button className="ghost-btn" onClick={() => setReportOpen(true)} title="Fleet report (bearings) - press r">
          Report
          <kbd className="ghost-key" aria-hidden>
            r
          </kbd>
          {backlogCount > 0 && <span className="ghost-badge">{backlogCount}</span>}
        </button>
        <button className="dispatch-btn" onClick={() => setDispatchOpen(true)} title="Dispatch a new crewmate">
          <span aria-hidden>＋</span> Dispatch
        </button>
        <div className={`link ${connected ? "up" : "down"}`}>
          <span className="link-dot" />
          {connected ? "live" : "reconnecting"}
        </div>
      </header>

      <main className="grid" ref={gridRef}>
        {sorted.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            gateNeedsYou={gateAlerts.has(s.id)}
            selected={s.id === selectedId}
            onSelect={() => setSelectedId(s.id)}
            expanded={expandedIds.has(s.id)}
            onToggleExpand={() => toggleExpand(s.id)}
            onOpenReviews={() => setReviewSessionId(s.id)}
            onOpenDiff={() => setDiffSessionId(s.id)}
            registerEl={registerEl}
            registerActions={registerActions}
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

      {dispatchOpen && <DispatchModal repos={repos} onClose={() => setDispatchOpen(false)} />}

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

      {sessions.length === 0 && (
        <div className="empty">
          <p className="empty-title">No agent sessions detected</p>
          <p className="empty-sub">
            Start a <code>claude</code> or <code>codex</code> session in a wezterm tab or tmux
            session and it will appear here.
          </p>
        </div>
      )}

      {selected && (
        <CommandBar
          session={selected}
          expanded={expandedIds.has(selected.id)}
          onToggleExpand={() => toggleExpand(selected.id)}
          onAction={(a) => actionHandles.current.get(selected.id)?.[a]()}
          onDiff={() => setDiffSessionId(selected.id)}
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
  expanded,
  onToggleExpand,
  onAction,
  onDiff,
  onDeselect,
}: {
  session: Session;
  expanded: boolean;
  onToggleExpand: () => void;
  onAction: (action: "startSend" | "focusPane" | "requestKill") => void;
  onDiff: () => void;
  onDeselect: () => void;
}): React.JSX.Element {
  const live = session.state !== "exited";
  return (
    <div className="cmdbar" role="toolbar" aria-label="Selected session actions">
      <span className="cmdbar-name">
        <span className={`agent-dot agent-${session.agent}`} aria-hidden />
        {session.name || "(unnamed)"}
      </span>
      <span className="cmdbar-keys">
        {live && (
          <>
            <button className="keycap-btn" onClick={() => onAction("startSend")}>
              <kbd>s</kbd> send
            </button>
            <button className="keycap-btn" onClick={() => onAction("focusPane")}>
              <kbd>f</kbd> focus
            </button>
            <button className="keycap-btn" onClick={() => onAction("requestKill")}>
              <kbd>k</kbd> kill
            </button>
          </>
        )}
        {session.cwd && (
          <button className="keycap-btn" onClick={onDiff}>
            <kbd>d</kbd> diff
          </button>
        )}
        <button className="keycap-btn" onClick={onToggleExpand}>
          <kbd>e</kbd> {expanded ? "collapse" : "expand"}
        </button>
        <span className="cmdbar-hint">
          <kbd>↑↓←→</kbd> move
          <button className="keycap-btn" onClick={onDeselect}>
            <kbd>esc</kbd> deselect
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
