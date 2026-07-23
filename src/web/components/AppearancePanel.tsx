import { useRichText } from "../lib/rich-text.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * How messages are drawn. Applies live behind the modal, which is the fastest way to
 * see what you'd be trading - the transcript reflows the moment you toggle it.
 */
export function AppearancePanel(): React.JSX.Element {
  const [richText, setRichText] = useRichText();
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Appearance</h3>
      </div>
      <label className={`settings-toggle${richText ? " is-on" : ""}`}>
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
