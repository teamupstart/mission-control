import { useEffect, useState } from "react";
import {
  ACTIONS,
  type ActionId,
  chordFromEvent,
  findConflicts,
  formatChord,
  isReservedChord,
  resetAll,
  resetBinding,
  setBinding,
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
 * keys are refused and duplicate bindings are flagged inline.
 *
 * This panel owns everything about recording a shortcut - the target being recorded, the
 * inline error, and the capture listener. The listener runs in the CAPTURE phase and
 * calls `stopPropagation`, so while a key is being recorded no other keydown handler
 * fires: not the grid's global keys, and not an overlay's or the settings page's
 * Escape. That is what lets `SettingsPage` keep a plain bubble-phase Escape listener
 * (Escape returns to the fleet) without having to know whether a shortcut is mid-capture -
 * the same contract `Overlay.tsx` relies on.
 */
export function KeyboardPanel(): React.JSX.Element {
  const { bindings, hasCustom } = useKeybindings();
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const conflicts = findConflicts(bindings);

  // Capture the next keystroke for the action being recorded. Capture phase +
  // stopPropagation so we intercept before the grid's global handler (and the overlay's
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
      if (isReservedChord(chord)) {
        setError(`${formatChord(chord)} is reserved for grid navigation.`);
        return;
      }
      setBinding(id, chord);
      setRecording(null);
      setError(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

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

      {GROUPS.map((group) => (
        <div className="settings-group" key={group.key}>
          <p className="settings-group-label">{group.label}</p>
          {ACTIONS.filter((a) => a.group === group.key).map((a) => {
            const chord = bindings[a.id];
            const custom = chord !== a.defaultBinding;
            const conflict = conflicts.get(a.id);
            const isRec = recording === a.id;
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
                          : `Change shortcut for ${a.label} (currently ${formatChord(chord)})`
                      }
                    >
                      {isRec ? <span className="kb-recording">Press a key…</span> : <kbd>{formatChord(chord)}</kbd>}
                    </button>
                  </Tooltip>
                  <Tooltip
                    label={custom ? `Reset ${a.label} to ${formatChord(a.defaultBinding)}` : "Already the default"}
                  >
                    <button
                      className="kb-reset"
                      disabled={!custom}
                      onClick={() => resetBinding(a.id)}
                      aria-label={`Reset ${a.label} to default`}
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
        layout navigation and can't be reassigned; modified Tab chords remain available.
      </p>
    </section>
  );
}
