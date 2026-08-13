import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SessionNoteSummary } from "@shared/types.ts";
import type { RecommendationChoice } from "../lib/foreman-review.ts";
import { Markdown } from "./Markdown.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** The quiet disclosure beside a canonical review form. */
export function ForemanRecommendationButton({
  open,
  onToggle,
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  return (
    <Tooltip label={open ? "Hide Foreman's optional recommendation" : "Show Foreman's optional recommendation"}>
      <button
        ref={buttonRef}
        type="button"
        className="foreman-recommendation-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={onToggle}
      >
        <span className="frt-mark" aria-hidden>◆</span>
        {open ? "Hide Foreman recommendation" : "View Foreman recommendation"}
      </button>
    </Tooltip>
  );
}

/** The mark placed on the existing option, never a second selectable control. */
export function ForemanPickMark(): React.JSX.Element {
  return (
    <span className="foreman-pick-mark">
      <span aria-hidden>◆</span>
      Foreman&apos;s pick
    </span>
  );
}

/**
 * Optional context for an open review, portalled so card overflow can never clip it.
 *
 * It owns no answer action. The only controls are Close and the canonical form behind it;
 * this is what keeps one ask from becoming two competing decisions.
 */
export function ForemanRecommendationSidecar({
  note,
  picks,
  onClose,
  returnFocusRef,
}: {
  note: SessionNoteSummary;
  picks: readonly RecommendationChoice[];
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}): React.JSX.Element | null {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      queueMicrotask(() => returnFocusRef?.current?.focus());
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, returnFocusRef]);

  // The panel is fixed and portalled, so without this it paints OVER the review it is
  // explaining - and the review's Submit is on the side it covers. Reserving the width
  // instead is what makes this optional context rather than a thing in the way; it is the
  // same reflow the chosen mockup drew, and the class is the only way to reach layout that
  // lives outside this portal.
  useEffect(() => {
    document.body.classList.add("foreman-sidecar-open");
    return () => document.body.classList.remove("foreman-sidecar-open");
  }, []);

  if (typeof document === "undefined") return null;

  function close(): void {
    onClose();
    queueMicrotask(() => returnFocusRef?.current?.focus());
  }

  const context = note.brief?.trim();
  const recommendation = note.recommendation?.trim();

  return createPortal(
    <aside
      className="foreman-recommendation-sidecar"
      role="dialog"
      aria-modal="false"
      aria-label="Foreman recommendation"
    >
      <header className="frs-head">
        <span className="fn-badge">Foreman</span>
        <span className="frs-title">
          <strong>Recommendation</strong>
          <span>Optional context for the open review</span>
        </span>
        <Tooltip label="Close Foreman recommendation (Escape)">
          <button
            ref={closeRef}
            type="button"
            className="frs-close"
            aria-label="Close Foreman recommendation"
            onClick={close}
          >
            ×
          </button>
        </Tooltip>
      </header>

      <div className="frs-body">
        {picks.length > 0 && (
          <section className="frs-section">
            <h3>Foreman&apos;s {picks.length === 1 ? "pick" : "picks"}</h3>
            <ul className="frs-picks">
              {picks.map((pick) => (
                <li key={pick.key}>
                  <span className="frs-diamond" aria-hidden>◆</span>
                  <span>
                    <strong>{pick.label}</strong>
                    {pick.detail && <small>{pick.detail}</small>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {recommendation && (
          <section className="frs-section">
            <h3>{picks.length > 0 ? "Why" : "Foreman recommends"}</h3>
            <p className="frs-recommendation">{recommendation}</p>
          </section>
        )}

        {context && (
          <section className="frs-section">
            <h3>Decision context</h3>
            <div className="frs-context markdown">
              <Markdown>{context}</Markdown>
            </div>
          </section>
        )}
      </div>

      <footer className="frs-foot">
        Context only. Choose and submit through the original review.
      </footer>
    </aside>,
    document.body,
  );
}

