import { DEFAULT_LLM_RUNNER_ID, type LlmRunnerId } from "@shared/llm.ts";
import type { PersonaSnapshot, PersonaView, WorkflowNodeExecutionOverride } from "@shared/workflow.ts";

// What a Persona NODE runs under, as the two surfaces that draw it and the one form that
// edits it all need it. Pure, and deliberately apart from the component: the rules worth
// pinning here - which of two values wins, what an incomplete form is allowed to commit,
// what a provider change does to the model beside it - are decisions, and a decision inside
// a React component is a decision only a browser can check.
//
// The vocabulary is fixed by the feature: a Persona RECOMMENDS a provider and model, and a
// workflow may OVERRIDE that for one occurrence. Every string below says which of those two
// an operator is looking at, because the whole point of the feature is that a reviewer's
// routing is no longer a property of the reviewer alone.

/** The word an operator reads for each source. Said once, so the two views cannot disagree. */
export const NODE_ROUTING_SOURCE_LABEL = {
  workflow: "this workflow",
  persona: "Persona default",
} as const;

/**
 * What the Persona itself resolves to, for a DRAFT node pointing at a live catalog row.
 *
 * `execution` rather than `runner`/`model`, for `personaRoutingLabel`'s reason: those two are
 * the operator's stored overrides and are null on most Personas, while `execution` is what the
 * daemon resolved and therefore what an inheriting node will actually spawn.
 */
export function personaNodeRouting(
  persona: Pick<PersonaView, "execution"> | undefined,
): { runner: LlmRunnerId; model: string } | null {
  return persona ? { runner: persona.execution.runner.id, model: persona.execution.model.id } : null;
}

/**
 * What a PUBLISHED node's frozen snapshot recommends, in words rather than nulls.
 *
 * A snapshot's null means "whatever the app resolves at attempt time", and that is genuinely
 * unknowable from a version: the app default and the environment are read when the attempt
 * starts, which for a version published months ago has not happened yet and may never. Naming
 * the fallback rather than guessing a model id is the only honest answer.
 */
export function snapshotRoutingLabel(snapshot: Pick<PersonaSnapshot, "runner" | "model">): string {
  return `${snapshot.runner ?? "App provider"} · ${snapshot.model ?? "Provider default"}`;
}

/**
 * The `runner · model · source` line one node prints, wherever it is drawn.
 *
 * `inherited` is null when the node names a Persona this build cannot resolve - a draft
 * pointing at a deleted row. The answer there is that there is nothing to inherit, not a
 * guessed provider: the node cannot publish until it is repointed, and saying so is more use
 * than printing the app default as though it were this reviewer's.
 */
export function nodeRoutingLabel(
  override: WorkflowNodeExecutionOverride | null,
  inherited: string | null,
): string {
  if (override) {
    return `${override.runner} · ${override.model} · ${NODE_ROUTING_SOURCE_LABEL.workflow}`;
  }
  return inherited === null
    ? "no reviewer this build can resolve"
    : `${inherited} · ${NODE_ROUTING_SOURCE_LABEL.persona}`;
}

/** Whether two saved choices are the same choice. Used to resync a form after a reload. */
export function sameNodeExecutionOverride(
  left: WorkflowNodeExecutionOverride | null,
  right: WorkflowNodeExecutionOverride | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.runner === right.runner && left.model === right.model;
}

export type NodeExecutionMode = "inherit" | "override";

/**
 * What the routing form holds while it is being edited.
 *
 * `model` is kept beside `runner` rather than derived, because a provider change deliberately
 * empties it: the previous provider's id is not a model the new provider has, and quietly
 * carrying it across is exactly the cross-provider mismatch a paired override exists to
 * prevent.
 */
export interface NodeExecutionFormState {
  mode: NodeExecutionMode;
  runner: LlmRunnerId;
  model: string;
}

/**
 * What a form state means for the durable node: inherit, this exact pair, or not yet.
 *
 * `incomplete` is a first-class answer and not an error. An operator who has just changed the
 * provider has said something true and unfinished, and the honest response is to leave the
 * saved node alone until they finish - not to write half a pair, and not to fall back to a
 * model the Persona happens to name under a provider it does not.
 */
export type NodeExecutionCommit =
  | { kind: "inherit" }
  | { kind: "override"; override: WorkflowNodeExecutionOverride }
  | { kind: "incomplete" };

export function nodeExecutionCommit(state: NodeExecutionFormState): NodeExecutionCommit {
  if (state.mode === "inherit") return { kind: "inherit" };
  const model = state.model.trim();
  if (!model) return { kind: "incomplete" };
  return { kind: "override", override: { runner: state.runner, model } };
}

/**
 * The form's opening state for one node.
 *
 * A node that already carries a choice opens on it. One that does not opens on `inherit`,
 * with the resolved routing loaded behind the mode switch so that turning the override on
 * produces a complete pair immediately rather than an empty form the operator has to fill in
 * before anything they can see changes.
 */
export function nodeExecutionFormState(
  override: WorkflowNodeExecutionOverride | null,
  seed: { runner: LlmRunnerId; model: string } | null,
): NodeExecutionFormState {
  if (override) return { mode: "override", runner: override.runner, model: override.model };
  return {
    mode: "inherit",
    // The shipped runner only when nothing resolved at all, which means the node names a
    // Persona that no longer exists. The form is still openable there - the operator may well
    // be repointing that node - and the model stays empty, so an override cannot be committed
    // by accident against a reviewer that is not there.
    runner: seed?.runner ?? DEFAULT_LLM_RUNNER_ID,
    model: seed?.model ?? "",
  };
}

/** Turning the switch, with the seed applied on the way in and dropped on the way out. */
export function withNodeExecutionMode(
  state: NodeExecutionFormState,
  mode: NodeExecutionMode,
  seed: { runner: LlmRunnerId; model: string } | null,
): NodeExecutionFormState {
  if (mode === state.mode) return state;
  return mode === "inherit"
    ? { ...state, mode: "inherit" }
    : { ...nodeExecutionFormState(null, seed), mode: "override" };
}

/** Changing the provider clears the model, which is the deliberate choice this feature makes. */
export function withNodeExecutionRunner(
  state: NodeExecutionFormState,
  runner: LlmRunnerId,
): NodeExecutionFormState {
  return runner === state.runner ? state : { ...state, runner, model: "" };
}
