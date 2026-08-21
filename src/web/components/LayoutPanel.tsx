import { LAYOUTS, type LayoutMode } from "../lib/layout.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The layout's shape, drawn rather than described: a rail plus pane, or columns of
 * descending height. Faster to tell apart than the words are, and it
 * survives the descriptions being skipped, which they will be.
 */
function LayoutGlyph({ mode }: { mode: LayoutMode }): React.JSX.Element {
  const rects: [number, number, number, number][] = mode === "console"
      ? [
          [0, 0, 5, 4],
          [0, 4.7, 5, 4],
          [0, 9.4, 5, 3.6],
          [6.2, 0, 9.3, 13],
        ]
      : [
          [0, 0, 3.3, 13],
          [4.1, 0, 3.3, 9],
          [8.2, 0, 3.3, 6],
          [12.3, 0, 3.3, 4],
        ];
  return (
    <svg className="layout-glyph" viewBox="0 0 15.6 13" width="16" height="13" aria-hidden focusable="false">
      {rects.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="1.5" fill="currentColor" />
      ))}
    </svg>
  );
}

/**
 * Which shape the dashboard takes: the split-pane Console or the state Board. The same
 * sessions and actions are available either way; only the
 * arrangement changes - so this is a preference about this screen, persisted per machine
 * through the daemon's UI configuration.
 *
 * A radio group, not a segmented control: these are two exclusive answers to one
 * question, and the description is the point. The labels alone don't say what you'd
 * be trading, and this is the rare setting where the wrong pick isn't obviously
 * wrong - it just quietly doesn't suit how you work. Applies live behind the settings
 * page, which is the fastest way to find that out.
 */
export function LayoutPanel({
  layout,
  onLayoutChange,
}: {
  layout: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;
}): React.JSX.Element {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Layout</h3>
      </div>
      <div
        className="layout-picker"
        role="radiogroup"
        aria-label="Dashboard layout"
        data-anchor="display/layout"
      >
        {LAYOUTS.map((l) => (
          <label key={l.id} className={`layout-option${layout === l.id ? " is-on" : ""}`}>
            <Tooltip label={l.description}>
              <input
                type="radio"
                name="layout"
                value={l.id}
                checked={layout === l.id}
                onChange={() => onLayoutChange(l.id)}
              />
            </Tooltip>
            <span className="layout-option-text">
              <span className="layout-option-label">
                <LayoutGlyph mode={l.id} />
                {l.label}
              </span>
              <span className="layout-option-desc">{l.description}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="settings-hint">
        Every layout reaches the same sessions and actions, so only their arrangement changes.
        Console opens the selected session's detail as you move. Board keeps selection and detail
        apart: the arrow keys move a cursor over tiles and <kbd>Enter</kbd> opens the selected one.
      </p>
    </section>
  );
}
