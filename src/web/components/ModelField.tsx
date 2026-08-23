import type { ModelChoiceSpec, ResolvedModel } from "@shared/model-choice.ts";
import type { AgentType } from "@shared/types.ts";
import {
  ModelCatalogNotice,
  ModelCatalogOptions,
  useHarnessModelCatalogs,
} from "../model-catalog.tsx";
import { Tooltip } from "./Tooltip.tsx";

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
  anchor,
  spec,
  value,
  resolved,
  runner,
  disabled,
  onCommit,
  blurb = "block",
  label = "block",
}: {
  /** DOM id for the label association. Unique within the panel. */
  id: string;
  /**
   * This row's settings anchor, `<category>/<slug>` - the stable id search jumps to - or
   * `null` for a field that is not on the settings page at all (the Persona editor).
   * Required rather than optional, and never defaulted, because only the CALLER knows
   * which category its row is in: the same widget serves three panels and one page that
   * is not Settings, and a silently absent anchor is a control search can never reach.
   * See `lib/settings-registry.ts`.
   */
  anchor: string | null;
  spec: ModelChoiceSpec;
  value: string;
  resolved: ResolvedModel | undefined;
  // `AgentType`, not `LlmRunnerId`: this drives the shared harness catalog and
  // `AGENT_IDENTITY`, both AgentType questions. Foreman's own model fields pass an
  // LlmRunnerId (claude|codex, a subset)
  // and the backlog-task field passes the task's harness - which can be pi, a harness that is
  // not a runner. Typing it as the runner axis conflated "which provider does Foreman's work"
  // with "which harness's model catalog"; pi surfaced it. See `todo/pi-harness.md`.
  runner: AgentType;
  disabled: boolean;
  onCommit: (next: string) => void;
  /**
   * Where the blurb is spent. `block` prints it under the field, as every panel but
   * Foreman's does; `hover` leaves it to the Tooltip, which already carries it on hover,
   * on focus, and in the hidden portal an assertion can reach.
   */
  blurb?: "block" | "hover";
  /**
   * Where the field's NAME is spent. `block` prints the spec's label above the select, as
   * every stacked panel does; `none` drops the visible label and moves it onto the select as
   * `<name> model`, for a caller whose own row heading already names the slot.
   *
   * Not the same knob as `blurb`, and both are needed: a matrix row wants the label off (the
   * `<th>` beside it already says "Goal") but must keep an accessible name, because a
   * `<select>` named only by a table header is a control no assertion and no screen-reader
   * user can address by itself.
   */
  label?: "block" | "none";
}): React.JSX.Element {
  const note = modelSourceNote(resolved, spec.envVar);
  const { resolve: resolveModels } = useHarnessModelCatalogs();
  const models = resolveModels(runner, value);
  const rowClass = label === "none" ? "foreman-model-row is-unlabelled" : "foreman-model-row";
  return (
    <div className={rowClass} data-anchor={anchor ?? undefined}>
      {label === "block" && (
        <label className="foreman-model-label" htmlFor={id}>
          {spec.label}
        </label>
      )}
      <Tooltip label={spec.blurb}>
        <select
          id={id}
          aria-label={label === "none" ? `${spec.label} model` : undefined}
          className="field-input mono foreman-model-input"
          value={value}
          disabled={disabled}
          onChange={(e) => onCommit(e.target.value)}
        >
          <option value="">Default - {resolved?.id ?? spec.fallback}</option>
          <ModelCatalogOptions catalog={models} />
        </select>
      </Tooltip>
      <ModelCatalogNotice agent={runner} />
      {blurb === "block" && <p className="settings-hint foreman-model-blurb">{spec.blurb}</p>}
      {note && <p className="foreman-model-source">{note}</p>}
    </div>
  );
}

/**
 * The line that sits above a group of fields, saying whose catalog the pickers below are
 * drawn from.
 *
 * It used to name three ids in prose because the fields were free text and a `<datalist>`
 * is browser chrome this theme can't touch. `ModelField` is a `<select>` over
 * the shared browser catalog now, so the ids are IN the picker and repeating them here
 * would be the same list twice - what is left to say is which provider's list it is.
 *
 */
export function ModelSuggestions({ providerLabel }: { providerLabel: string }): React.JSX.Element {
  return (
    <p className="settings-hint foreman-models-hint">
      Choose from the models supported by the selected {providerLabel} provider.
    </p>
  );
}
