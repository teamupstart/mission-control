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
 * How many sidecars are currently mounted, so the page-wide layout reservation they share
 * survives one of them closing. Module scope rather than context: the flag it guards is
 * `document.body`, which is equally global, and a provider would have to be threaded through
 * every surface that can host a review.
 */
let openSidecars = 0;

/** The half of `document.body` this reservation touches, so a test can supply its own. */
export interface LayoutFlagTarget {
  classList: { add(token: string): void; remove(token: string): void };
}

/**
 * Claim the page-wide layout reservation, returning the release for this claimant.
 *
 * Exported because the counting IS the behaviour: releasing while another sidecar is still
 * open drops `.app`'s reserved column and puts that sidecar back on top of the review's
 * Submit. That is only reachable with two sidecars mounted at once, which needs two sessions
 * and two dispatches to stage in a browser - so it is pinned here as the small piece of state
 * it actually is.
 */
export function acquireSidecarLayout(body: LayoutFlagTarget): () => void {
  openSidecars += 1;
  body.classList.add("foreman-sidecar-open");
  let released = false;
  return () => {
    // Idempotent: React may invoke a cleanup it has already run under StrictMode, and a
    // double decrement here would free the reservation with a sidecar still on screen.
    if (released) return;
    released = true;
    openSidecars = Math.max(0, openSidecars - 1);
    if (openSidecars === 0) body.classList.remove("foreman-sidecar-open");
  };
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

  // Mount-only, and deliberately NOT joined with the Escape handler below. Both call sites
  // pass an inline arrow for `onClose`, so its identity changes on every parent render -
  // and the parent re-renders on ordinary SSE session updates. Sharing one effect meant
  // every such tick re-ran this and snatched focus back to Close, out of the review form
  // the operator had already tabbed into.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
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
  //
  // Counted, because the class is one page-wide flag and sidecars are not a singleton: an
  // ensemble draws a card per candidate, each with its own trigger, so two can be open at
  // once. Removing the class on the first one's unmount would strip the reservation while
  // the second is still on screen, putting it straight back to covering Submit.
  useEffect(() => acquireSidecarLayout(document.body), []);

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
      // A portal moves the DOM node but not the React tree, so events still bubble to this
      // component's JSX ancestors - and one of those is the card's expand/collapse toggle.
      // `PaneDialogPrompt` renders this as a SIBLING of its own guarded `.pane-dialog`
      // section, so the caller's guard does not cover it: clicking Close on a collapsed card
      // would expand the card underneath. Guarded here rather than at the call sites so a
      // future host cannot forget it.
      onClick={(event) => event.stopPropagation()}
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

