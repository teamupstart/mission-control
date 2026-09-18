import { useEffect, useRef } from "react";
import { COMPOSER_EDITOR_KEYS_HINT, composerEditorStages } from "../lib/composer-editor.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The conversation's send box, full size. Text only - attachments stay on the composer.
 *
 * Holds no copy of the text: it seeds an uncontrolled textarea and hands the value back on
 * stage, because the draft's home is the composer's own map (`lib/drafts.ts`) and a second
 * copy here would be a second source of truth for the one string this is all about.
 */
export function ComposerEditorModal({
  text,
  reopenHint,
  activity,
  onStage,
  onClose,
}: {
  /** What the send box holds right now; the editor opens on exactly this. */
  text: string;
  /** The resolved expand chord, named in the body. Empty when the action has no chord. */
  reopenHint: string;
  /**
   * The composer's activity reporter, wired here exactly as the reply box wires it.
   *
   * Not optional, and not something this dialog can skip. Opening it moves focus off the
   * reply box, which BLURS that box - so the panel's own `onBlur` releases the lease and
   * stops the heartbeat before a word is typed here. Without these three handlers a person
   * spending five minutes writing in this editor reads as an idle composer, and Foreman
   * takes the conversation out from under them. The reply box has prevented exactly that
   * since composer activity shipped; a bigger box for the same message must not lose it.
   *
   * The panel passes its OWN `useComposerActivity` handle, so both boxes share one client
   * id and one heartbeat: focus moving between them renews a single lease rather than
   * opening a second.
   */
  activity: { onFocus: () => void; onBlur: () => void; onInput: () => void };
  /** Put this text in the send box, unsent, and close. */
  onStage: (next: string) => void;
  /** Close and leave the send box holding what it had. */
  onClose: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Caret at the END rather than the seeded text selected: this opens to CONTINUE a
  // message, and an editor that opens with everything selected is one keystroke away from
  // destroying the draft it was asked to enlarge.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  function stage(): void {
    onStage(inputRef.current?.value ?? "");
  }

  return (
    <Overlay
      id={OVERLAY_IDS.composerEditor}
      onClose={onClose}
      className="modal composer-editor"
      role="dialog"
      ariaModal
      ariaLabel="Edit the message"
    >
      <header className="modal-head">
        <h2>Edit the message</h2>
        <Tooltip label="Close without staging - the send box keeps what it had (Escape)">
          <button
            type="button"
            className="icon-btn"
            aria-label="Close the message editor"
            onClick={onClose}
          >
            ✕
          </button>
        </Tooltip>
      </header>

      <div className="modal-body composer-editor-body">
        <textarea
          ref={inputRef}
          className="composer-editor-input"
          aria-label="Message"
          placeholder="Write the message…"
          defaultValue={text}
          // The same three the reply box wires, in the same order. `onFocus` re-takes the
          // lease the reply box released when this dialog stole its focus, and restarts the
          // heartbeat that renews it; `onChange` is what makes a long silence in here read
          // as composing rather than as idle.
          onFocus={activity.onFocus}
          onBlur={activity.onBlur}
          onChange={activity.onInput}
          onKeyDown={(e) => {
            if (!composerEditorStages(e.nativeEvent)) return;
            e.preventDefault();
            stage();
          }}
        />
        <p className="composer-editor-note">
          Staging puts this text back in the send box without sending it
          {reopenHint ? `, and ${reopenHint} opens it here again` : ""}.
        </p>
      </div>

      <footer className="modal-foot">
        <span className="composer-editor-keys">{COMPOSER_EDITOR_KEYS_HINT}</span>
        <span className="actions-spacer" />
        <Tooltip label="Close without staging - the send box keeps what it had">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </Tooltip>
        <Tooltip label="Put this text in the send box, unsent (⌘Enter or ⌃Enter)">
          <button type="button" className="btn btn-send" onClick={stage}>
            Stage in the send box
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
