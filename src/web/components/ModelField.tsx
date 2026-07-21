import { useEffect, useRef, useState } from "react";
import { MODEL_SUGGESTIONS } from "@shared/model-choice.ts";
import type { ModelChoiceSpec, ResolvedModel } from "@shared/model-choice.ts";

// The one input in this app for "which model does this call spawn with?".
//
// It started inside the Foreman panel, where four of them sit in a row; the Inspector
// then needed a fifth. The typing behaviour below is subtle enough (a draft that resists
// the poll, a dirty flag so a click-in-click-out doesn't write) that a second copy would
// have drifted on the first bug fix, and both panels poll the same way for the same
// reason - so it lives here and takes a spec.
//
// Deliberately NOT tied to Foreman's role registry: this component knows a spec, a
// current value, and what the daemon resolved. Which subsystem the spec belongs to is
// the caller's business.

/**
 * The line under a model field saying WHERE the value in the box came from.
 *
 * Deliberately does not name the model: the id is already sitting in the input directly
 * above (as the placeholder, when the box is empty), and printing it twice inside 60px
 * reads as two facts when it is one. What an empty greyed box genuinely cannot tell you
 * is which of two very different things it means - a shipped default, or an env var set
 * outside the app that silently outranks anything you type here. That is this line's
 * whole job.
 *
 * Silent for `config`, where the box shows your own value and there is nothing to explain.
 */
export function modelSourceNote(
  resolved: ResolvedModel | undefined,
  envVar: string,
): string | null {
  if (!resolved || resolved.source === "config") return null;
  return resolved.source === "env"
    ? `From ${envVar} in the daemon's environment.`
    : "Shipped default.";
}

/**
 * One model field.
 *
 * Uncontrolled-with-a-draft rather than bound straight to config, because the panels
 * re-poll every few seconds: an input driven by that would drop a character every time a
 * poll landed mid-word. The draft is the truth while you are typing, and re-syncs from
 * config only when the box is not focused - so an edit made in another tab still shows up
 * here without ever fighting the keyboard.
 *
 * Commit is on blur and on Enter, and only when the value actually changed, so tabbing
 * through a row of fields doesn't write once per field.
 */
export function ModelField({
  id,
  spec,
  value,
  resolved,
  disabled,
  onCommit,
}: {
  /** DOM id for the label association. Unique within the panel. */
  id: string;
  spec: ModelChoiceSpec;
  value: string;
  resolved: ResolvedModel | undefined;
  disabled: boolean;
  onCommit: (next: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  // Whether this box has been TYPED IN since it was focused. Without it, blurring a box
  // you only clicked into would write its stale draft back: the poll can't refresh a
  // focused field, so a value changed elsewhere (another tab, the env, a direct PUT)
  // would be silently reverted by a click-in-click-out that changed nothing. Commit is
  // for edits, and "I put the cursor here" is not one.
  const dirty = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = (): void => {
    const next = draft.trim();
    setDraft(next);
    if (dirty.current && next !== value) onCommit(next);
    dirty.current = false;
  };

  const note = modelSourceNote(resolved, spec.envVar);
  return (
    <div className="foreman-model-row">
      <label className="foreman-model-label" htmlFor={id}>
        {spec.label}
      </label>
      <input
        id={id}
        className="field-input mono foreman-model-input"
        type="text"
        spellCheck={false}
        autoComplete="off"
        // The resolved id, not the shipped fallback: an empty box under a set env var
        // must not advertise a default that env var is overriding.
        placeholder={resolved?.id ?? spec.fallback}
        value={draft}
        disabled={disabled}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          dirty.current = true;
          setDraft(e.target.value);
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          // Escape abandons the edit rather than committing it, matching every other
          // compose box in the app.
          if (e.key === "Escape") {
            setDraft(value);
            dirty.current = false;
            focused.current = false;
            e.currentTarget.blur();
          }
        }}
      />
      <p className="settings-hint foreman-model-blurb">{spec.blurb}</p>
      {note && <p className="foreman-model-source">{note}</p>}
    </div>
  );
}

/**
 * The "common ids" line that sits above a group of fields.
 *
 * Named in prose rather than offered in a picker: a native `<datalist>` is browser chrome
 * this theme can't touch (which is why `RepoCombobox` exists), and a combobox is a lot of
 * widget for three ids. Any id the CLI accepts works.
 */
export function ModelSuggestions(): React.JSX.Element {
  return (
    <p className="settings-hint foreman-models-hint">
      Common ids:{" "}
      {MODEL_SUGGESTIONS.map((id, i) => (
        <span key={id}>
          {i > 0 && ", "}
          <code>{id}</code>
        </span>
      ))}
      . Any model your <code>claude</code> CLI accepts will do.
    </p>
  );
}
