import { useLayoutEffect, useRef, useState } from "react";
import { LINE_DENSITY_OPTIONS, useLineDensity } from "../lib/line-density.ts";
import { PREVIEW_LINE_SUMMARY } from "../lib/line-preview.ts";
import type { LineDensity } from "@shared/protocol.ts";
import { LineStrip } from "./LineStrip.tsx";
import { Tooltip } from "./Tooltip.tsx";

const noop = (): void => {};

/**
 * The width the preview strip is laid out at before it is zoomed into the stage: a common
 * fleet window, so stages ellipsize their sentences the way they will on the page rather
 * than the way a 600px settings column would make them.
 */
const PREVIEW_NATURAL_WIDTH = 1200;

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
    mode === "hidden"
      ? [
          // No strip at all: the conversation starts at the top of the frame.
          <rect key="c1" x="1" y="3" width="20" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c2" x="1" y="7" width="28" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c3" x="1" y="11" width="14" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c4" x="1" y="15" width="24" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c5" x="1" y="19" width="18" height="2" rx="1" fillOpacity="0.3" />,
          <rect key="c6" x="1" y="23" width="22" height="2" rx="1" fillOpacity="0.3" />,
        ]
      : mode === "expanded"
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
 * The real `LineStrip`, against a fixture pipeline, at the chosen density - so the setting
 * shows what it changes instead of asking the operator to recognise the strip by name.
 *
 * Laid out at `PREVIEW_NATURAL_WIDTH` and zoomed down to the stage, as `TopbarPreview` does
 * for the bar: squeezing the strip into the settings column would ellipsize every sentence
 * Expanded exists to show. `inert` and `aria-hidden` for that preview's reason too - six
 * more stage buttons in the accessibility tree would be a second strip to find.
 *
 * Disabled has nothing to draw, so the stage says so in the space the strip would take.
 */
function LinePreview({ density }: { density: LineDensity }): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = (): void => {
      const room = stage.clientWidth;
      if (room <= 0) return;
      const next = Math.min(1, room / PREVIEW_NATURAL_WIDTH);
      setZoom((current) => (Math.abs(next - current) > 0.002 ? next : current));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="topbar-preview-wrap">
      <span className="board-card-preview-cap" aria-hidden>
        Preview
      </span>
      <div className="line-preview-stage" ref={stageRef} inert aria-hidden>
        {density === "hidden" ? (
          <p className="line-preview-off">
            Nothing is drawn here. The fleet starts directly under the top bar.
          </p>
        ) : (
          <div style={{ zoom, width: PREVIEW_NATURAL_WIDTH }}>
            <LineStrip summary={PREVIEW_LINE_SUMMARY} density={density} onStage={noop} preview />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * How much the Line strip SAYS, and therefore how much of the window it keeps.
 *
 * A block of Display > Top bar rather than a section of its own: the strip is the band
 * directly under the bar, and the operator looks for it there. `TopbarPanel` renders it
 * after the bar's own items, under an `h4` like the bar's two lists.
 *
 * A preference about this screen, beside the layout (how sessions are arranged) and the
 * conversation rendering (how one session is drawn) - so it is a radio group for their
 * reason: exclusive answers to one question where the label alone does not say what is
 * being traded. Above the choices sits the real strip at the chosen density, because "the
 * Line" is a name few people know the strip by. It applies live behind the settings page.
 *
 * The same fold lives on the strip itself as a caret, and <kbd>Shift+L</kbd> steps it;
 * neither reaches Disabled, nor leaves it. All three write the one
 * `app_config.ui.lineDensity` through `useLineDensity`, so none of them can disagree
 * about the band.
 */
export function LineDensityPanel(): React.JSX.Element {
  const [density, setDensity] = useLineDensity();
  return (
    <div className="topbar-line-setting">
      <h4 className="settings-subhead">The Line</h4>
      <p className="settings-hint settings-blurb">
        The pipeline strip under the top bar on the fleet: Intake, Backlog, Working, Review,
        Decide and Shipped, each with how many items are in it.
      </p>
      <LinePreview density={density} />
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
        Disabled removes the strip entirely; only this setting brings it back.
      </p>
    </div>
  );
}
