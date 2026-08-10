import { CONVERSATION_VIEW_OPTIONS, useConversationView } from "../lib/conversation-view.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A glyph per rendering, drawn rather than lettered: the two options differ in SHAPE more
 * than in words, and a picture of stacked bubbles beside a picture of a framed stream says
 * the difference faster than either description does. Same role as `LayoutGlyph`.
 */
function ViewGlyph({ mode }: { mode: string }): React.JSX.Element {
  const cells =
    mode === "terminal"
      ? [
          // A framed stream: a titlebar, three flush-left lines, a status bar.
          <rect key="bar" x="1" y="1" width="30" height="4" rx="1" />,
          <rect key="l1" x="4" y="9" width="18" height="2" rx="1" />,
          <rect key="l2" x="4" y="13" width="24" height="2" rx="1" />,
          <rect key="l3" x="4" y="17" width="14" height="2" rx="1" />,
          <rect key="foot" x="1" y="23" width="30" height="4" rx="1" />,
        ]
      : [
          // Alternating bubbles: the shipped chat log.
          <rect key="a" x="2" y="4" width="18" height="6" rx="3" />,
          <rect key="b" x="12" y="12" width="18" height="6" rx="3" />,
          <rect key="c" x="2" y="20" width="14" height="6" rx="3" />,
        ];
  return (
    <svg className="layout-glyph" viewBox="0 0 32 28" aria-hidden="true" focusable="false">
      {cells}
    </svg>
  );
}

/**
 * How a Conversation is READ: the shipped chat log, or the Native PTY terminal stream.
 *
 * The same transcript, the same composer and the same actions either way - only the
 * drawing changes - so this is a preference about this screen, sitting between the layout
 * (how sessions are arranged) and the appearance (how messages are formatted inside a
 * turn). A radio group for the reason the layout picker is one: two exclusive answers to
 * one question, where the label alone does not say what you would be trading.
 *
 * This is the DEFAULT. Any single session can be flipped from the control above its
 * conversation, and that choice wins for that session until the tab closes - see
 * `lib/conversation-view.ts` for why the per-session half is deliberately not persisted.
 */
export function ConversationViewPanel(): React.JSX.Element {
  const [view, setView] = useConversationView();
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Conversation</h3>
      </div>
      <div
        className="layout-picker"
        role="radiogroup"
        aria-label="Conversation rendering"
        data-anchor="display/conversation-view"
      >
        {CONVERSATION_VIEW_OPTIONS.map((o) => (
          <label key={o.id} className={`layout-option${view === o.id ? " is-on" : ""}`}>
            <Tooltip label={o.description}>
              <input
                type="radio"
                name="conversation-view"
                value={o.id}
                checked={view === o.id}
                onChange={() => setView(o.id)}
              />
            </Tooltip>
            <span className="layout-option-text">
              <span className="layout-option-label">
                <ViewGlyph mode={o.id} />
                {o.label}
              </span>
              <span className="layout-option-desc">{o.description}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="settings-hint">
        Both renderings read the same transcript and send through the same box, so nothing is
        hidden by the choice. This sets the default; the control above any conversation flips
        that one session for as long as the tab is open.
      </p>
    </section>
  );
}
