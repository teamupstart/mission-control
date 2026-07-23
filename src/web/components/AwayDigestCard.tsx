import type { AwayDigest } from "@shared/away-buffer.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** "12 minutes" / "1 hour 5 minutes" - how long you were away. */
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
    <Overlay
      id={OVERLAY_IDS.digest}
      onClose={onDismiss}
      as="aside"
      className="away-digest"
      role="dialog"
      ariaLabel="While you were away"
    >
      <header className="away-digest-head">
        <h2>While you were away</h2>
        <span className="away-digest-span">{span(digest.awayMs)}</span>
        <Tooltip label="Dismiss this digest">
          <button className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
            ✕
          </button>
        </Tooltip>
      </header>

      <div className="away-digest-body">
        {/* The model's prose when it landed; the deterministic rollup is always
            there beneath it, so a missing or logged-out claude costs the wording,
            never the summary. Without the prose the rollup IS the summary, so it
            is promoted out of its micro-label styling rather than left as a
            caption with nothing to caption. */}
        {digest.narrative && <p className="away-digest-narrative">{digest.narrative}</p>}
        <p className={`away-digest-rollup${digest.narrative ? "" : " is-lead"}`}>{digest.rollup}</p>

        <ul className="away-digest-list">
          {digest.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>

      <footer className="away-digest-foot">
        <Tooltip label="Open the full sitrep - every session and the backlog">
          <button className="btn" onClick={onOpenReport}>
            Open sitrep
          </button>
        </Tooltip>
        <Tooltip label="Dismiss this digest">
          <button className="btn btn-primary" onClick={onDismiss}>
            Got it
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
