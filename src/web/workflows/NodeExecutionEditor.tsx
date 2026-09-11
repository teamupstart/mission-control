import { useState } from "react";
import type { LlmRunnerId } from "@shared/llm.ts";
import type { LlmProviderView } from "@shared/types.ts";
import type { WorkflowNodeExecutionOverride } from "@shared/workflow.ts";
import { ModelCatalogNotice, ModelCatalogOptions, useHarnessModelCatalogs } from "../model-catalog.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import {
  nodeExecutionCommit,
  nodeExecutionFormState,
  nodeRoutingLabel,
  sameNodeExecutionOverride,
  withNodeExecutionMode,
  withNodeExecutionRunner,
  type NodeExecutionFormState,
} from "./node-execution.ts";

/**
 * One reviewer occurrence's provider and model, edited in one place for both editor views.
 *
 * Mounted from the Pipeline member row and from the Graph view's selected-node rail. One
 * component rather than a control in each, because the two views are two drawings of the same
 * draft and the rules here are not presentation: enabling an override seeds a complete pair,
 * changing the provider clears the model, and an unfinished pair is never written. Two copies
 * of that would agree until the first bug fix.
 *
 * ## State
 *
 * The form holds its own state and the caller holds the saved node. That split is what lets a
 * provider change sit on screen, model-less, without touching the draft - autosave never sees
 * a half-written pair, so no CAS revision is burned on one and no published version can freeze
 * one.
 *
 * It resyncs during render when the SUBJECT or the SAVED CHOICE changes underneath it, which
 * is React's documented way to adjust state to props without a second render pass. Three
 * things do that: the rail being pointed at a different node, the node being pointed at a
 * different Persona - which resets routing, so the form must fall back to Use Persona default
 * - and a reload or conflict resolution replacing the stored pair. A caller-supplied `key`
 * would do the same job, but only by making every caller spell the identity, and one that
 * forgot a part of it would leave a stale form on screen with no way to notice.
 *
 * The controls carry no `id`: each is wrapped in its own `<label>` and named by `aria-label`,
 * the same shape the Persona editor's provider control uses. That is also why nothing here
 * needs a node id - a DOM id built from one is exactly what `workflow-builder-a11y.test.ts`
 * refuses to let the editor spell.
 *
 * ## The model picker
 *
 * Deliberately NOT `ModelField`. That component's empty option reads "Default - <id>" and
 * means inherit, which is exactly the sentence this control must not say: an override with no
 * model is unfinished, not inheriting. It is built from the same shared catalog primitives
 * `ModelField` itself uses, so the ids offered are the ones every other picker in the app
 * offers, retained values included - a model id the catalog does not list stays selectable,
 * because model ids are free text under the persisted vocabulary everywhere else here.
 */
export function NodeExecutionEditor({
  subject,
  name,
  override,
  seed,
  inherited,
  providers,
  readOnly,
  onChange,
}: {
  /**
   * What this form is about, as the values that decide whether it is still about the same
   * thing: the node's id, and the Persona that node names.
   *
   * Two fields rather than one composed string, so a caller cannot get the composition wrong
   * and cannot be tempted to build an id out of a node id (see above).
   */
  subject: { nodeId: string | null; personaId: string | null };
  /** The reviewer this row is about, so every accessible name addresses one occurrence. */
  name: string;
  /** The occurrence's saved choice, or null when it inherits. */
  override: WorkflowNodeExecutionOverride | null;
  /** What the Persona resolves to today. Seeds a new override; null when the Persona is gone. */
  seed: { runner: LlmRunnerId; model: string } | null;
  /** The inherited routing as a line a person reads, or null when nothing resolves. */
  inherited: string | null;
  providers: readonly LlmProviderView[];
  readOnly: boolean;
  /** Called only with a complete pair, or with null to restore inheritance. */
  onChange: (override: WorkflowNodeExecutionOverride | null) => void;
}): React.JSX.Element {
  const [state, setState] = useState<NodeExecutionFormState>(
    () => nodeExecutionFormState(override, seed),
  );
  const [seen, setSeen] = useState({ subject, override });
  if (
    seen.subject.nodeId !== subject.nodeId
    || seen.subject.personaId !== subject.personaId
    || !sameNodeExecutionOverride(seen.override, override)
  ) {
    setSeen({ subject, override });
    setState(nodeExecutionFormState(override, seed));
  }
  const { resolve: resolveModels } = useHarnessModelCatalogs();

  const commit = (next: NodeExecutionFormState): void => {
    setState(next);
    const result = nodeExecutionCommit(next);
    if (result.kind === "incomplete") return;
    onChange(result.kind === "inherit" ? null : result.override);
  };

  const models = resolveModels(state.runner, state.model);
  const incomplete = state.mode === "override" && state.model.trim() === "";

  return (
    <div className="wf-node-execution">
      <label className="wf-node-execution-field">
        <span>Model routing</span>
        <Tooltip label={`Whether ${name} runs on its Persona's provider and model, or on this workflow's own choice`}>
          <select
            aria-label={`Model routing for ${name}`}
            value={state.mode}
            disabled={readOnly}
            onChange={(event) => commit(withNodeExecutionMode(
              state,
              event.target.value === "override" ? "override" : "inherit",
              seed,
            ))}
          >
            <option value="inherit">Use Persona default</option>
            <option value="override">Override for this workflow</option>
          </select>
        </Tooltip>
      </label>
      {state.mode === "override" && (
        <>
          <label className="wf-node-execution-field">
            <span>Provider</span>
            <Tooltip label={`Which model provider runs ${name} in this workflow`}>
              <select
                aria-label={`Provider for ${name}`}
                value={state.runner}
                disabled={readOnly}
                onChange={(event) => commit(
                  withNodeExecutionRunner(state, event.target.value as LlmRunnerId),
                )}
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                ))}
              </select>
            </Tooltip>
          </label>
          <label className="wf-node-execution-field">
            <span>Model</span>
            <Tooltip label={`Which model ${name} runs in this workflow`}>
              <select
                aria-label={`Model for ${name}`}
                className="mono"
                value={state.model}
                disabled={readOnly}
                onChange={(event) => commit({ ...state, model: event.target.value })}
              >
                {/* Never "Default - x": an override with no model is unfinished, and a row
                    that offered inheritance here would be a second, silent way to clear a
                    choice the mode switch above already owns. */}
                <option value="">Choose a model</option>
                <ModelCatalogOptions catalog={models} />
              </select>
            </Tooltip>
          </label>
          <ModelCatalogNotice agent={state.runner} />
        </>
      )}
      {incomplete && (
        <p className="wf-node-execution-incomplete" role="status">
          Choose a model to apply this override. Until then {name} keeps the routing below.
        </p>
      )}
      {/* The SAVED choice, never the half-finished form above it. An unfinished pair changes
          nothing about what runs, and a readout that moved with the form would report a model
          this workflow has not chosen. */}
      <p className="wf-node-execution-effective">
        Runs as {nodeRoutingLabel(override, inherited)}
      </p>
    </div>
  );
}
