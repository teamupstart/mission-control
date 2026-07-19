import type { AwayDigest } from "@shared/away-buffer.ts";

/** "12 minutes" / "1 hour 5 minutes" - how long the window covered. */
function span(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hours = `${h} hour${h === 1 ? "" : "s"}`;
  return m === 0 ? hours : `${hours} ${m} minute${m === 1 ? "" : "s"}`;
}

/**
 * What you come back to: one card summarising the away window, in place of the six
 * notifications the old AFK mode would have fired.
 *
 * Shown only when there is something to say - the daemon returns 204 for a quiet
 * window, so this never renders an empty "nothing happened" card. Dismissal is
 * explicit rather than timed: the whole promise is that you can read it in your own
 * time when you sit down, and a toast that faded while you were still walking back
 * would defeat the feature.
 */
export function AwayDigestCard({
  digest,
  onDismiss,
  onOpenReport,
}: {
  digest: AwayDigest;
  onDismiss: () => void;
  onOpenReport: () => void;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onDismiss}>
      <aside
        className="away-digest"
        role="dialog"
        aria-label="While you were away"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="away-digest-head">
          <h2>While you were away</h2>
          <span className="away-digest-span">{span(digest.until - digest.since)}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
            ✕
          </button>
        </header>

        <div className="away-digest-body">
          {/* The model's prose when it landed; the deterministic rollup is always
              there beneath it, so a missing or logged-out claude costs the wording,
              never the summary. */}
          {digest.narrative && <p className="away-digest-narrative">{digest.narrative}</p>}
          <p className="away-digest-rollup">{digest.rollup}</p>

          <ul className="away-digest-list">
            {digest.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>

        <footer className="away-digest-foot">
          <button className="btn" onClick={onOpenReport}>
            Open sitrep
          </button>
          <button className="btn btn-primary" onClick={onDismiss}>
            Got it
          </button>
        </footer>
      </aside>
    </div>
  );
}
