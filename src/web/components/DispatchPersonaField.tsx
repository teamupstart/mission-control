import { TASK_KIND_BEHAVIOR, taskKindPersonaRefusal } from "@shared/task.ts";
import type { TaskKind } from "@shared/types.ts";
import {
  personaChoiceLabel,
  personaChoicesForDisplay,
  type PersonaView,
} from "@shared/workflow.ts";
import { Tooltip } from "./Tooltip.tsx";

const PERSONA_FIELD_TIP =
  "The Library Persona whose guidance this agent receives as standing instructions when it launches";

/** "a pipeline task cannot ..." as the sentence a hint prints. */
function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * What the Advanced fold's summary says about the Persona while it is closed. Names what the
 * draft will actually send, so a Persona kept for a kind that cannot carry one reads as off.
 */
export function dispatchPersonaSummary(
  personas: readonly PersonaView[],
  kind: TaskKind,
  personaId: string,
): string {
  if (taskKindPersonaRefusal(kind)) return "Persona: from the resident profile";
  if (!personaId) return "Persona: none";
  const persona = personas.find((candidate) => candidate.id === personaId);
  return `Persona: ${persona?.name ?? "unavailable"}`;
}

/**
 * The dispatch form's Persona choice, in the Advanced fold.
 *
 * Offers the same list every other Persona picker offers (`personaChoicesForDisplay`), with
 * the stored choice kept visible when it has since been archived or shadowed, so reopening a
 * shelved task never silently reads as "No Persona". A kind that takes its Persona from elsewhere
 * (a resident, from its profile) cannot carry one: the select is disabled there and says why.
 */
export function DispatchPersonaField({
  personas,
  kind,
  personaId,
  className = "",
  onChange,
}: {
  personas: readonly PersonaView[];
  kind: TaskKind;
  /** The draft's Persona id, or "" for none. */
  personaId: string;
  className?: string;
  onChange: (personaId: string) => void;
}): React.JSX.Element {
  const refusal = taskKindPersonaRefusal(kind);
  const choices = personaChoicesForDisplay(personas, personaId ? [personaId] : []);
  const selected = personaId ? personas.find((persona) => persona.id === personaId) ?? null : null;
  const listed = !personaId || choices.some(({ persona }) => persona.id === personaId);
  const hint = refusal
    ? sentence(refusal)
    : !personaId
      ? "The agent launches with no Persona."
      : !selected
        ? "This Persona no longer exists, so the task cannot launch with it. Choose another, or No Persona."
        : selected.archivedAt !== null
          ? `${selected.name} is archived, so the task cannot launch with it. Choose another, or No Persona.`
          : selected.description || `The agent launches as ${selected.name}.`;
  // A provider-launched kind hands work to agents Mission Control never starts, so the hint says
  // which session the Persona actually reaches.
  const reach = !refusal && TASK_KIND_BEHAVIOR[kind].launch === "pipeline"
    ? " Only the managed Engineer host receives it; agents Conductor starts later do not, and the Terminal host refuses it."
    : "";
  return (
    <label className={`field ${className}`.trim()}>
      <span className="field-label">Persona</span>
      <Tooltip label={PERSONA_FIELD_TIP}>
        <select
          aria-label="Persona"
          className="field-input"
          value={refusal ? "" : personaId}
          disabled={refusal !== null}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">No Persona</option>
          {!listed && <option value={personaId}>Unavailable Persona</option>}
          {choices.map(({ persona, retained }) => (
            <option key={persona.id} value={persona.id}>
              {personaChoiceLabel(persona, retained)}
              {persona.builtin && !retained ? " · built-in" : ""}
            </option>
          ))}
        </select>
      </Tooltip>
      <span className="field-hint">{hint}{reach}</span>
    </label>
  );
}
