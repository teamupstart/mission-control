import type { ModelChoiceSpec, ResolvedModel } from "@shared/model-choice.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import { modelChoicesFor } from "@shared/model.ts";

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
  runner,
  disabled,
  onCommit,
}: {
  /** DOM id for the label association. Unique within the panel. */
  id: string;
  spec: ModelChoiceSpec;
  value: string;
  resolved: ResolvedModel | undefined;
  runner: LlmRunnerId;
  disabled: boolean;
  onCommit: (next: string) => void;
}): React.JSX.Element {
  const note = modelSourceNote(resolved, spec.envVar);
  return (
    <div className="foreman-model-row">
      <label className="foreman-model-label" htmlFor={id}>
        {spec.label}
      </label>
      <select
        id={id}
        className="field-input mono foreman-model-input"
        value={value}
        disabled={disabled}
        onChange={(e) => onCommit(e.target.value)}
      >
        <option value="">Default - {resolved?.id ?? spec.fallback}</option>
        {modelChoicesFor(runner, value).map((model) => (
          <option key={model.id} value={model.id}>
            {model.label} - {model.hint}
          </option>
        ))}
      </select>
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
export function ModelSuggestions({ runner = "claude" }: { runner?: LlmRunnerId }): React.JSX.Element {
  return (
    <p className="settings-hint foreman-models-hint">
      Choose from the models supported by the selected {runner === "codex" ? "Codex" : "Claude Code"} provider.
    </p>
  );
}
