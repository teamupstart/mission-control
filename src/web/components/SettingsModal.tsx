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
import { SkillsPanel } from "./SkillsPanel.tsx";
import { useSkills } from "../useSkills.ts";
import { LAYOUTS, type LayoutMode } from "../lib/layout.ts";

const GROUPS = [
  { key: "global", label: "Anywhere" },
  { key: "selection", label: "Selected session" },
] as const;

function labelOf(id: ActionId): string {
  return ACTIONS.find((a) => a.id === id)?.label ?? id;
}

/**
 * The layout's shape, drawn rather than described - three tiles, a rail + pane, or
 * four columns. Faster to tell apart than the words are, and it survives the
 * descriptions being skipped, which they will be.
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
 * App settings, reached from the topbar gear or the native Settings… menu (⌘,).
 *
 * Three sections. The layout picker, which swaps the whole dashboard between the card
 * grid, the split-pane console and the state board - same sessions, same cards, same
 * actions, different shape. The keyboard-shortcut editor: click an action's key, press
 * the new one (with ⌘/⌃/⌥ if you like), and it persists immediately; reserved
 * navigation keys are refused and duplicate bindings are flagged inline. And the skills
 * catalog, which is the modal's first setting that leaves this machine's localStorage -
 * it writes to the daemon, and through it to `~/.claude/skills`, so it is also the first
 * thing here that can fail asynchronously. `SkillsPanel` owns that error path.
 */
export function SettingsModal({
  layout,
  onLayoutChange,
  onClose,
}: {
  layout: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { bindings, hasCustom } = useKeybindings();
  const skills = useSkills();
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const conflicts = findConflicts(bindings);

  // While *not* recording, Escape closes the modal. (During recording the capture
  // listener below owns Escape, using it to cancel the capture instead.)
  useEffect(() => {
    if (recording) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, onClose]);

  // Capture the next keystroke for the action being recorded. Capture phase +
  // stopPropagation so we intercept before the grid's global handler ever sees it.
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
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <div className="settings-section-head">
              <h3>Layout</h3>
            </div>
            {/* A radio group, not a segmented control: these are three exclusive answers to
                one question, and the description is the point - the labels alone don't say
                what you'd be trading. Applies live behind the modal, so you can see it. */}
            <div className="layout-picker" role="radiogroup" aria-label="Dashboard layout">
              {LAYOUTS.map((l) => (
                <label key={l.id} className={`layout-option${layout === l.id ? " is-on" : ""}`}>
                  <input
                    type="radio"
                    name="layout"
                    value={l.id}
                    checked={layout === l.id}
                    onChange={() => onLayoutChange(l.id)}
                  />
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
          </section>

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

          <SkillsPanel state={skills} />
        </div>
      </div>
    </div>
  );
}
