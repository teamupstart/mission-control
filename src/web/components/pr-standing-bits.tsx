import type { PrStanding } from "../lib/pr-standing.ts";

// Where an adopted pull request stands, DRAWN - the one mark two surfaces now put beside a
// ledger row.
//
// A sibling of `pr-standing.ts` rather than a part of it: that file is browser-safe, React-free
// arithmetic that the folds and the tests all import, and a `.tsx` in its place would make
// every consumer of "did this land" pull in React to ask the question.
//
// It exists as a module at all for the reason `session-bits.tsx` and `pipeline-bits.tsx` do.
// The Ship log page drew these three shapes first; the Line's Shipped drawer draws the same
// three beside the same rows, one click shallower. Copied, they would be two answers to
// "what does merged look like" that agree only until somebody edits one - and the surface
// that would disagree first is the drawer and the page it escalates to, which an operator
// crosses in a single click and reads as one thing.
//
// Two rules travel with the drawing and are the reason it is worth sharing:
//
//  1. The mark is `aria-hidden`, ALWAYS, and every caller prints the standing as a word
//     beside it (`PR_STANDING_LABELS`). The three states differ by hue, and a hue is not a
//     reading anyone is required to have.
//  2. The paths are the three shapes GitHub itself uses, which is what an operator's eye is
//     already trained on from the pull request page these rows link to. That is why they are
//     hand-drawn rather than spelled with an emoji, whose glyph is the font's business and
//     whose colour cannot be toned to the row.

/** The merge-state mark. Decoration: the caller says the word. */
export function StandingIcon({
  standing,
  size = 15,
}: {
  standing: PrStanding;
  /** The drawer's rows are tighter than the page's feed, and only the box changes. */
  size?: number;
}): React.JSX.Element {
  return (
    <svg
      className={`pr-ic is-${standing}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="4" cy="3.5" r="1.9" />
        {standing === "merged" ? (
          <>
            <circle cx="4" cy="12.5" r="1.9" />
            <circle cx="12" cy="8" r="1.9" />
            <path d="M4 5.5v5M4 5.8c0 2.2 2.6 2.2 6 2.2" />
          </>
        ) : standing === "open" ? (
          <>
            <circle cx="4" cy="12.5" r="1.9" />
            <circle cx="12" cy="12.5" r="1.9" />
            <path d="M4 5.5v5M6 3.5h3.5A2.5 2.5 0 0 1 12 6v4.5" />
          </>
        ) : (
          <>
            <circle cx="4" cy="12.5" r="1.9" />
            <circle cx="12" cy="12.5" r="1.9" />
            <path d="M4 5.5v5M10.2 3.2l3 3M13.2 3.2l-3 3" />
          </>
        )}
      </g>
    </svg>
  );
}
