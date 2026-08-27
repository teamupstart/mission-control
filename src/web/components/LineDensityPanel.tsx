import { LINE_DENSITY_OPTIONS, useLineDensity } from "../lib/line-density.ts";
import type { LineDensity } from "@shared/protocol.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A thumbnail per density, drawn rather than lettered - same role as `LayoutGlyph` and
 * `ViewThumb`, and at `ViewThumb`'s larger size for its reason: the difference between
 * these two is a BAND HEIGHT, and a picture of two stacked rows over a short pane beside a
 * picture of one row over a tall pane says that faster than any sentence does.
 *
 * The drawings are to scale against each other, which is the point. Expanded's strip takes
 * roughly a quarter of its frame and condensed's takes a tenth, in the same ratio the real
 * bands do (86px and 38.5px of a 900px window) - so the pane that grows underneath is the
 * thing the eye actually lands on.
 *
 * `width`/`height` on the element as well as in CSS, and an explicit `fill`, for the
 * reasons `ViewThumb` documents at length: a viewBox with neither resolves to the width of
 * the row, and an unfilled rect paints SVG-default black rather than `currentColor`.
 */
function DensityThumb({ mode }: { mode: LineDensity }): React.JSX.Element {
  const art =
    mode === "expanded"
      ? [
          // Six two-row stages: a name bar and a sentence bar inside each segment.
          ...[0, 7.3, 14.6, 21.9, 29.2, 36.5].flatMap((x) => [
            <rect key={`n${x}`} x={x + 1} y="3" width="4.6" height="2" rx="1" />,
            <rect key={`s${x}`} x={x + 1} y="6.4" width="5.6" height="1.6" rx="0.8" fillOpacity="0.5" />,
          ]),
          // The conversation it leaves room for.
          <rect key="c1" x="1" y="14" width="20" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c2" x="1" y="18" width="28" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c3" x="1" y="22" width="14" height="2" rx="1" fillOpacity="0.3" />,
        ]
      : [
          // One row of six segments, and no sentence line at all.
          ...[0, 7.3, 14.6, 21.9, 29.2, 36.5].map((x) => (
            <rect key={`n${x}`} x={x + 1} y="3" width="5.6" height="2" rx="1" />
          )),
          // Five lines where expanded fits three. This is the whole setting.
          <rect key="c1" x="1" y="9.5" width="20" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c2" x="1" y="13.5" width="28" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c3" x="1" y="17.5" width="14" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c4" x="1" y="21.5" width="24" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c5" x="1" y="25.5" width="18" height="2" rx="1" fillOpacity="0.3" />,
        ];
  return (
    <svg
      className="view-thumb"
      viewBox="0 0 44 32"
      width="44"
      height="32"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <rect
        x="0.5"
        y="0.5"
        width="43"
        height="31"
        rx="4"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.35"
      />
      {art}
    </svg>
  );
}

/**
 * How much the Line strip SAYS, and therefore how much of the window it keeps.
 *
 * A preference about this screen, beside the layout (how sessions are arranged) and the
 * conversation rendering (how one session is drawn) - so it is a radio group for their
 * reason: two exclusive answers to one question where the label alone does not say what is
 * being traded. It applies live behind the settings page, which is the fastest way to see
 * what 47.5px actually buys.
 *
 * The same control lives on the strip itself as a caret, and <kbd>Shift+L</kbd> steps it.
 * All three write the one `app_config.ui.lineDensity` through `useLineDensity`, so none of
 * them can disagree about the band.
 */
export function LineDensityPanel(): React.JSX.Element {
  const [density, setDensity] = useLineDensity();
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>The Line</h3>
      </div>
      <div
        className="layout-picker"
        role="radiogroup"
        aria-label="Line density"
        data-anchor="display/line-density"
      >
        {LINE_DENSITY_OPTIONS.map((o) => (
          <label
            key={o.id}
            className={`layout-option view-option${density === o.id ? " is-on" : ""}`}
          >
            <Tooltip label={o.description}>
              <input
                type="radio"
                name="line-density"
                value={o.id}
                checked={density === o.id}
                onChange={() => setDensity(o.id)}
              />
            </Tooltip>
            {/* Outside the label text, like the conversation picker: at 44px this is a
                preview in the row's gutter, not a bullet in front of a word. */}
            <DensityThumb mode={o.id} />
            <span className="layout-option-text">
              <span className="layout-option-label">{o.label}</span>
              <span className="layout-option-desc">{o.description}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="settings-hint">
        Condensing hides no facts: every stage keeps its count and its colour, all six still open
        their drawers, and anything waiting on you is promoted onto the row. The per-stage sentences
        move into each stage's tooltip. <kbd>Shift+L</kbd> folds and unfolds it from the fleet.
      </p>
    </section>
  );
}
