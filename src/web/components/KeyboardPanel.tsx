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
 * fires: not the grid's global keys, and not the modal's own Escape-to-close. That is
 * what lets `SettingsModal` keep a plain bubble-phase Escape handler without having to
 * know whether a shortcut is mid-capture.
 */
export function KeyboardPanel(): React.JSX.Element {
  const { bindings, hasCustom } = useKeybindings();
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const conflicts = findConflicts(bindings);

  // Capture the next keystroke for the action being recorded. Capture phase +
  // stopPropagation so we intercept before the grid's global handler (and the modal's
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
      <div className="settings-section-head">
        <h3>Keyboard shortcuts</h3>
        {hasCustom && (
          <button className="btn btn-ghost" onClick={() => resetAll()}>
            Reset all
          </button>
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
              <div className={`kb-row${conflict ? " has-conflict" : ""}`} key={a.id}>
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
                  <button
                    className="kb-reset"
                    disabled={!custom}
                    onClick={() => resetBinding(a.id)}
                    title="Reset to default"
                    aria-label={`Reset ${a.label} to default`}
                  >
                    ↺
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      <p className="settings-hint">
        Click a shortcut, then press the new key. Esc and the arrow keys drive grid
        navigation and can't be reassigned.
      </p>
    </section>
  );
}
