import { useEffect, useState } from "react";
import {
  ACTIONS,
  type ActionId,
  bindingValidationError,
  chordFromEvent,
  findConflicts,
  formatChord,
  resetAll,
  resetBinding,
  setBinding,
  useKeybindingHints,
  useKeybindings,
} from "../lib/keybindings.ts";
import { Tooltip } from "./Tooltip.tsx";

const GROUPS = [
  { key: "global", label: "Anywhere" },
  { key: "selection", label: "Selected session" },
] as const;

function labelOf(id: ActionId): string {
  return ACTIONS.find((a) => a.id === id)?.label ?? id;
}

/**
 * The keyboard-shortcut editor, a settings category. Click an action's key, press the
 * new one (with ⌘/⌃/⌥ if you like), and it persists immediately; reserved navigation
 * keys and chords already assigned to another action are refused inline.
 *
 * This panel owns everything about recording a shortcut - the target being recorded, the
 * inline error, and the capture listener. The listener runs in the CAPTURE phase and
 * calls `stopPropagation`, so while a key is being recorded no other keydown handler
 * fires: not the app's global keys, and not an overlay's or the settings page's
 * Escape. That is what lets `SettingsPage` keep a plain bubble-phase Escape listener
 * (Escape returns to the fleet) without having to know whether a shortcut is mid-capture -
 * the same contract `Overlay.tsx` relies on.
 */
export function KeyboardPanel(): React.JSX.Element {
  const { bindings, isCustom, hasCustom, previewReset } = useKeybindings();
  const [hints, setHints] = useKeybindingHints();
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const conflicts = findConflicts(bindings);

  // Capture the next keystroke for the action being recorded. Capture phase +
  // stopPropagation so we intercept before the app's global handler (and the overlay's
  // Escape-to-close) ever sees it.
  useEffect(() => {
    if (!recording) return;
    const id = recording;
    function onKey(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // a lone modifier - keep waiting
      const validationError = bindingValidationError(bindings, id, chord);
      if (validationError) {
        setError(validationError);
        return;
      }
      setBinding(id, chord);
      setRecording(null);
      setError(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [bindings, recording]);

  function startRecording(id: ActionId): void {
    setError(null);
    setRecording((cur) => (cur === id ? null : id));
  }

  return (
    <section className="settings-section">
      {/* "Shortcuts", not "Keyboard shortcuts": the settings page's own header already
          says Keyboard above this, and a heading that repeats its container reads as two
          things stacked rather than one. */}
      <div className="settings-section-head">
        <h3>Shortcuts</h3>
        {hasCustom && (
          <Tooltip label="Restore every shortcut to its default key">
            <button className="btn btn-ghost" onClick={() => resetAll()}>
              Reset all
            </button>
          </Tooltip>
        )}
      </div>

      {error && <p className="settings-error">{error}</p>}

      {/* Above the list, not inside a group: it is about how every shortcut below is
          PRESENTED, so it would read as one more binding if it sat among them. */}
      <label
        className={`settings-toggle${hints ? " is-on" : ""}`}
        data-anchor="keyboard/hints"
      >
        <Tooltip label="Print each shortcut on the buttons it also drives">
          <input
            type="checkbox"
            checked={hints}
            onChange={(e) => setHints(e.target.checked)}
          />
        </Tooltip>
        <span className="settings-toggle-text">
          <span className="settings-toggle-label">Show keybindings on buttons</span>
          <span className="settings-toggle-desc">
            Buttons a shortcut also drives - Terminal, Codex / Claude, Send, Focus,
            Conversation, Queue, Diff, Files, Delete, Reset, Complete, Kill, Dispatch, Fleet,
            Library and Runs - carry its key on their face. Small icon buttons and the
            command bar are unaffected.
          </span>
        </span>
      </label>

      {GROUPS.map((group) => (
        <div className="settings-group" key={group.key}>
          <p className="settings-group-label">{group.label}</p>
          {ACTIONS.filter((a) => a.group === group.key).map((a) => {
            const chord = bindings[a.id];
            const formattedChord = formatChord(chord);
            const custom = isCustom(a.id);
            const conflict = conflicts.get(a.id);
            const isRec = recording === a.id;
            const resetPreview = previewReset(a.id);
            const resetChord = formatChord(resetPreview.binding);
            const resetOwner = resetPreview.owner ? labelOf(resetPreview.owner) : null;
            const resetTooltip =
              custom && !resetChord && resetOwner
                ? `Clear ${formattedChord || "custom binding"} - ${formatChord(a.defaultBinding)} is taken by ${resetOwner}, so this stays unset`
                : custom
                  ? `Reset ${a.label} to ${resetChord}`
                  : formattedChord
                    ? "Already the default"
                    : "No custom binding";
            const resetAriaLabel =
              custom && !resetChord && resetOwner
                ? `Clear ${a.label} ${formattedChord || "custom binding"}; ${formatChord(a.defaultBinding)} is taken by ${resetOwner}, so ${a.label} stays unset`
                : `Reset ${a.label} to default`;
            return (
              <div
                className={`kb-row${conflict ? " has-conflict" : ""}`}
                key={a.id}
                data-anchor={`keyboard/${a.id}`}
              >
                <div className="kb-row-text">
                  <span className="kb-row-label">{a.label}</span>
                  <span className="kb-row-desc">{a.description}</span>
                  {conflict && (
                    <span className="kb-row-conflict">
                      Same key as {conflict.map(labelOf).join(", ")}
                    </span>
                  )}
                </div>
                <div className="kb-row-controls">
                  <Tooltip
                    label={isRec ? "Press the key you want" : `Click, then press a new key for ${a.label}`}
                  >
                    <button
                      className={`kb-capture${isRec ? " is-recording" : ""}`}
                      onClick={() => startRecording(a.id)}
                      aria-label={
                        isRec
                          ? `Recording new shortcut for ${a.label}`
                          : `Change shortcut for ${a.label} (currently ${formattedChord || "unset"})`
                      }
                    >
                      {isRec ? <span className="kb-recording">Press a key…</span> : <kbd>{formattedChord || "Unset"}</kbd>}
                    </button>
                  </Tooltip>
                  <Tooltip label={resetTooltip}>
                    <button
                      className="kb-reset"
                      disabled={!custom}
                      onClick={() => resetBinding(a.id)}
                      aria-label={resetAriaLabel}
                    >
                      ↺
                    </button>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      <p className="settings-hint">
        Click a shortcut, then press the new key. Esc, the arrow keys and bare Tab drive
        layout navigation and can't be reassigned; modified Tab chords remain available. The
        fleet's ⌘1 … ⌘0, ⌘-, ⌘= session jump keys are reserved too - they address a card's or
        rail row's position rather than an action, and are switched on and off under Display.
      </p>
    </section>
  );
}
