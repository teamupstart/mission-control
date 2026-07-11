import { useMemo, useState } from "react";
import type { Session } from "@shared/types.ts";
import { useEventStream } from "./useEventStream.ts";
import { SessionCard } from "./components/SessionCard.tsx";
import { ReviewModal } from "./components/ReviewModal.tsx";
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
  const { sessions, reviews, connected } = useEventStream();
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);

  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const ta = TONE_ORDER[stateDisplay(a).tone];
      const tb = TONE_ORDER[stateDisplay(b).tone];
      return ta - tb || a.name.localeCompare(b.name) || a.pid - b.pid;
    });
  }, [sessions]);

  const counts = useMemo(() => summarize(sessions), [sessions]);
  const pendingReviews = reviews.filter((r) => r.status === "pending");

  const modalSession = reviewSessionId ? sessions.find((s) => s.id === reviewSessionId) : null;
  const modalReviews = modalSession
    ? pendingReviews.filter((r) => r.sessionId === modalSession.id)
    : [];

  function openReviews(): void {
    const first = pendingReviews[0];
    if (first) setReviewSessionId(first.sessionId);
  }

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
        <div className={`link ${connected ? "up" : "down"}`}>
          <span className="link-dot" />
          {connected ? "live" : "reconnecting"}
        </div>
      </header>

      <main className="grid">
        {sorted.map((s) => (
          <SessionCard key={s.id} session={s} onOpenReviews={() => setReviewSessionId(s.id)} />
        ))}
      </main>

      {modalSession && modalReviews.length > 0 && (
        <ReviewModal
          session={modalSession}
          reviews={modalReviews}
          onClose={() => setReviewSessionId(null)}
        />
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
    </div>
  );
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
