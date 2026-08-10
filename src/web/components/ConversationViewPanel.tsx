import { CONVERSATION_VIEW_OPTIONS, useConversationView } from "../lib/conversation-view.ts";
import type { ConversationView } from "@shared/protocol.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A thumbnail per rendering, drawn rather than lettered: the two options differ in SHAPE
 * more than in words, and a picture of stacked bubbles beside a picture of a framed stream
 * says the difference faster than either description does. Same role as `LayoutGlyph`, at
 * the larger size the drawings need - a titlebar, a status bar and three lines of output do
 * not survive being shrunk to a 16px icon, which is the whole thing the picture is for.
 *
 * `width` and `height` are stated on the element and again in CSS, deliberately. An inline
 * `<svg>` carrying a viewBox and NEITHER resolves its width to 100% of the line and scales
 * its height by the aspect ratio: this picker shipped that way, and each glyph drew at the
 * width of its row rather than at icon size. `fill` is stated for the same class of reason -
 * an unfilled rect paints SVG-default black, not the `currentColor` the row's
 * selected/unselected tinting is built on.
 *
 * The sizes it laid out at are measured in `e2e/specs/settings-conversation-picker.spec.ts`
 * and recorded there rather than repeated here, because they are a browser's answer and not
 * a fact about this file.
 */
function ViewThumb({ mode }: { mode: ConversationView }): React.JSX.Element {
  const art =
    mode === "terminal"
      ? [
          // A framed stream: a titlebar, three flush-left lines, a status bar.
          <rect key="bar" x="1" y="1" width="42" height="5" rx="3" fillOpacity="0.45" />,
          <rect key="l1" x="6" y="11" width="18" height="2.5" rx="1.25" />,
          <rect key="l2" x="6" y="16" width="26" height="2.5" rx="1.25" />,
          <rect key="l3" x="6" y="21" width="12" height="2.5" rx="1.25" />,
          <rect key="foot" x="1" y="26" width="42" height="5" rx="3" fillOpacity="0.45" />,
        ]
      : [
          // Alternating bubbles: the shipped chat log. The middle one is the agent's, drawn
          // lighter for the same reason the log itself distinguishes them.
          <rect key="a" x="6" y="7" width="20" height="5" rx="2.5" />,
          <rect key="b" x="18" y="14.5" width="20" height="5" rx="2.5" fillOpacity="0.55" />,
          <rect key="c" x="6" y="22" width="14" height="5" rx="2.5" />,
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
          <label key={o.id} className={`layout-option view-option${view === o.id ? " is-on" : ""}`}>
            <Tooltip label={o.description}>
              <input
                type="radio"
                name="conversation-view"
                value={o.id}
                checked={view === o.id}
                onChange={() => setView(o.id)}
              />
            </Tooltip>
            {/* Outside the label text rather than inside it: at 44px this is a preview
                sitting in the row's gutter, not a bullet in front of a word. */}
            <ViewThumb mode={o.id} />
            <span className="layout-option-text">
              <span className="layout-option-label">{o.label}</span>
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
