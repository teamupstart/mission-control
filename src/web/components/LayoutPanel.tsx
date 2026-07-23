import { LAYOUTS, type LayoutMode } from "../lib/layout.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The layout's shape, drawn rather than described - four tiles, a rail + pane, or
 * columns of descending height. Faster to tell apart than the words are, and it
 * survives the descriptions being skipped, which they will be.
 */
function LayoutGlyph({ mode }: { mode: LayoutMode }): React.JSX.Element {
  const rects: [number, number, number, number][] =
    mode === "grid"
      ? [
          [0, 0, 7, 6],
          [8.5, 0, 7, 6],
          [0, 7, 7, 6],
          [8.5, 7, 7, 6],
        ]
      : mode === "console"
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
 * Which shape the dashboard takes: the card grid, the split-pane console, or the
 * state board. The same sessions and the same cards either way - only the
 * arrangement changes - so this is a preference about this screen, and it lives in
 * localStorage next to the keybindings rather than going near the daemon.
 *
 * A radio group, not a segmented control: these are three exclusive answers to one
 * question, and the description is the point. The labels alone don't say what you'd
 * be trading, and this is the rare setting where the wrong pick isn't obviously
 * wrong - it just quietly doesn't suit how you work. Applies live behind the modal,
 * which is the fastest way to find that out.
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
      <div className="layout-picker" role="radiogroup" aria-label="Dashboard layout">
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
        Every layout reaches the same sessions and the same actions, so nothing is hidden by the
        choice - only the shape around them changes. Only the card grid has a focus mode; the
        console opens the selected session's detail as you move, so <kbd>e</kbd> and the floating
        command bar don't apply there. The board keeps the two apart: the arrow keys move a
        cursor over the tiles and <kbd>Enter</kbd> opens the one it's on.
      </p>
    </section>
  );
}
