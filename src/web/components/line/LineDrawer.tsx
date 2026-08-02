import { useEffect, useRef, type ReactNode } from "react";
import { LINE_STAGE_LABELS } from "@shared/line.ts";
import type { LineDrawerStage } from "../../lib/line-drawer.ts";
import { LINE_DRAWER_DOM_ID } from "../LineStrip.tsx";
import { Tooltip } from "../Tooltip.tsx";

/**
 * The drawer frame: everything true of all three drawers, and nothing about any of them.
 *
 * It sits BETWEEN the strip and the layouts, as a sibling of both, and that placement is the
 * whole feature. An overlay would have covered the board; a panel inside a layout would have
 * had to be built three times and would have resized the cards in at least one of them. This
 * pushes the board down and hands the space back on close, and the cards under it are the
 * same cards at the same size in every state.
 *
 * Two things it enforces on every body, because "the drawer is triage" is a promise the frame
 * has to keep rather than each body remembering to:
 *
 *  1. The BODY scrolls, not the page. The cap lives on `.line-drawer-body` in the stylesheet
 *     (three rows, or 38vh on a short window, whichever is less), so a drawer listing forty
 *     runs is exactly as tall as one listing three.
 *  2. There is one way in and three ways out - the stage button toggles, `esc` closes, and
 *     the ✕ closes - and all three land the keyboard back on the stage button that opened it.
 *     `esc` is App's, because it has to lose to any overlay above it; the other two are here.
 */

/** The glyphs the strip uses, repeated in the drawer head so the two read as one surface. */
const DRAWER_GLYPHS: Record<LineDrawerStage, string> = {
  intake: "⇊",
  review: "⌁",
  decide: "⧉",
};

export function LineDrawer({
  stage,
  /** The mono line beside the title: how many, and how many of those want a person. */
  count,
  /** Amber half of `count`, stated separately so it can be toned. Empty for none. */
  attention = "",
  /** Header controls, right-aligned before the ✕. Each body supplies its own. */
  actions = null,
  onClose,
  children,
}: {
  stage: LineDrawerStage;
  count: string;
  attention?: string;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null);

  // Focus moves INTO the drawer as it opens, and onto the region rather than onto the first
  // control: the drawer's job is to be read, and landing on "Bind a workflow…" would announce
  // a button before the thing it belongs to. The region is `tabIndex={-1}` so it can take
  // programmatic focus without joining the tab order. App puts the keyboard back on the stage
  // button when this unmounts, which is the half that cannot be done from in here.
  //
  // Keyed on `stage`, so swapping drawers re-announces: the strip's other button was clicked
  // and the content changed under a keyboard that never moved.
  useEffect(() => {
    frame.current?.focus({ preventScroll: true });
  }, [stage]);

  const title = LINE_STAGE_LABELS[stage];
  return (
    <section
      className="line-drawer"
      // One id, because there is only ever one drawer - the open stage's button points at it
      // with `aria-controls`, and a per-stage id would have made that a lookup rather than a
      // constant.
      id={LINE_DRAWER_DOM_ID}
      ref={frame}
      tabIndex={-1}
      aria-label={`${title} drawer`}
    >
      <header className="line-drawer-head">
        <h2 className="line-drawer-title">
          <span className="line-drawer-glyph" aria-hidden>{DRAWER_GLYPHS[stage]}</span>
          {title}
        </h2>
        <p className="line-drawer-count">
          {count}
          {attention && <span className="line-drawer-att">{attention}</span>}
        </p>
        <span className="line-drawer-spacer" />
        {actions}
        <Tooltip label={`Close the ${title} drawer - the board slides back up`}>
          <button
            type="button"
            className="btn btn-ghost line-drawer-close"
            onClick={onClose}
            aria-label={`Close the ${title} drawer`}
          >
            <span aria-hidden>✕</span>
            <kbd>esc</kbd>
          </button>
        </Tooltip>
      </header>
      {/* The cap and the scrollbar are this element's, in the stylesheet. Bodies render rows
          and never a height. */}
      <div className="line-drawer-body">{children}</div>
    </section>
  );
}

/** What a drawer says when the thing it triages is not happening. One line, never a panel. */
export function LineDrawerEmpty({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="line-drawer-empty">{children}</p>;
}
