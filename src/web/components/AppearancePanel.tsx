import { SKINS, type Skin, type SkinId } from "@shared/skins.ts";
import { useRichText } from "../lib/rich-text.ts";
import { updateUiConfig, useUiConfig } from "../lib/uiConfig.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A skin drawn in its own colours: its background, a panel on it, a text bar, and the three
 * state dots. The colours are the registry's swatches as inline paint, never tokens, because
 * the tile must show the skin it offers rather than the one in force.
 *
 * `width`/`height` on the element as well as in CSS, and an explicit `fill` on every shape,
 * for the reasons `ViewThumb` documents: a viewBox with neither resolves to the width of the
 * row, and an unfilled rect paints SVG-default black.
 */
function SkinThumb({ skin }: { skin: Skin }): React.JSX.Element {
  const s = skin.swatches;
  return (
    <svg
      className="skin-thumb"
      viewBox="0 0 44 32"
      width="44"
      height="32"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0" y="0" width="44" height="32" rx="4" fill={s.bg} />
      <rect x="5" y="5" width="34" height="22" rx="3" fill={s.panel} />
      <rect x="9" y="10" width="20" height="2.5" rx="1.25" fill={s.fg} />
      <circle cx="11" cy="20" r="2.5" fill={s.working} />
      <circle cx="18" cy="20" r="2.5" fill={s.idle} />
      <circle cx="25" cy="20" r="2.5" fill={s.attention} />
    </svg>
  );
}

/**
 * Which skin paints the dashboard. Built on the `LineDensityPanel` tile pattern, and it
 * applies the moment a tile is picked: `updateUiConfig` commits optimistically and
 * `lib/skin.ts`, which follows the store, repaints everything behind this page. There is no
 * Save, and a write the daemon refuses rolls the store back, which repaints it back too.
 */
function SkinPicker(): React.JSX.Element {
  const current = useUiConfig().skin;
  const choose = (id: SkinId): void => {
    void updateUiConfig({ skin: id });
  };
  return (
    <div
      className="layout-picker skin-picker"
      role="radiogroup"
      aria-label="Skin"
      data-anchor="display/skin"
    >
      {SKINS.map((skin) => (
        <label
          key={skin.id}
          className={`layout-option view-option${current === skin.id ? " is-on" : ""}`}
        >
          <Tooltip label={skin.description}>
            <input
              type="radio"
              name="skin"
              value={skin.id}
              aria-label={skin.label}
              aria-describedby={`skin-desc-${skin.id}`}
              checked={current === skin.id}
              onChange={() => choose(skin.id)}
            />
          </Tooltip>
          <SkinThumb skin={skin} />
          <span className="layout-option-text">
            <span className="layout-option-label">{skin.label}</span>
            <span className="layout-option-desc" id={`skin-desc-${skin.id}`}>{skin.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * How the dashboard looks and how messages are drawn. Both apply live behind the settings
 * page, which is the fastest way to see what you'd be trading.
 */
export function AppearancePanel(): React.JSX.Element {
  const [richText, setRichText] = useRichText();
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Appearance</h3>
      </div>
      <SkinPicker />
      <p className="settings-hint">
        Applies the moment you pick it - the dashboard behind this page repaints live.
      </p>
      <label
        className={`settings-toggle${richText ? " is-on" : ""}`}
        data-anchor="display/format-messages"
      >
        <Tooltip label="Render agent and human turns as markdown rather than literal text">
          <input type="checkbox" checked={richText} onChange={(e) => setRichText(e.target.checked)} />
        </Tooltip>
        <span className="settings-toggle-text">
          <span className="settings-toggle-label">Format messages</span>
          <span className="settings-toggle-desc">
            Render agent and human turns as markdown - headings, lists, tables, and code blocks
            with syntax highlighting. Turn this off to read the literal text an agent emitted,
            backticks and all.
          </span>
        </span>
      </label>
      <p className="settings-hint">
        Formatting is display-only. It never changes what the agent wrote or what gets sent when
        you reply - copying a code block still yields exactly the characters inside the fence.
      </p>
    </section>
  );
}
