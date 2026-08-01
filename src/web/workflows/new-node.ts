import { WORKFLOW_CHECK_SLOTS, type WorkflowCheckSlot } from "@shared/workflow.ts";

// What the palette asks for when a node is added, whether by button or by drag.
//
// One shape for both routes, because they used to disagree by construction: the button
// passed `(kind, personaId)` while the drop handler re-parsed a JSON blob against its own
// hand-written allowlist of kinds. A kind added to the palette and not to that allowlist is
// a button that works and a drag that silently does nothing, which reads as a broken drag
// rather than as missing code.
//
// Deliberately NOT `WorkflowDraftNode`: a palette entry has no id and no position yet, and
// giving it placeholders would let one reach the graph.

export type NewWorkflowNode =
  | { kind: "persona"; personaId: string }
  | { kind: "all_pass" }
  | { kind: "check"; slot: WorkflowCheckSlot }
  | { kind: "session_action"; sessionActionId: string }
  | { kind: "end" };

/** The `dataTransfer` type the palette writes and the canvas reads. */
export const NEW_NODE_MIME = "application/mission-workflow-node";

/**
 * Read a dropped payload, or null when it is not one of ours.
 *
 * Every failure is a null rather than a throw: a drop carrying another application's data is
 * an ordinary thing for a canvas to be handed, not an error to report.
 */
export function parseDroppedNode(raw: string): NewWorkflowNode | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const spec = value as {
    kind?: unknown;
    personaId?: unknown;
    sessionActionId?: unknown;
    slot?: unknown;
  };
  if (spec.kind === "all_pass" || spec.kind === "end") return { kind: spec.kind };
  if (spec.kind === "persona") {
    return typeof spec.personaId === "string" && spec.personaId
      ? { kind: "persona", personaId: spec.personaId }
      : null;
  }
  if (spec.kind === "session_action") {
    // The id is checked for shape and nothing else, exactly as a Persona's is. WHICH actions
    // may be dropped is the palette's question and it has already answered it by only
    // offering addable ones; re-deciding it here from a payload would need the catalog and
    // the daemon's capability answer, neither of which a parser should hold.
    return typeof spec.sessionActionId === "string" && spec.sessionActionId
      ? { kind: "session_action", sessionActionId: spec.sessionActionId }
      : null;
  }
  if (spec.kind === "check") {
    // A slot this build does not know is refused rather than defaulted: a check silently
    // dropped onto the wrong gate is worse than a drag that does nothing.
    return WORKFLOW_CHECK_SLOTS.includes(spec.slot as WorkflowCheckSlot)
      ? { kind: "check", slot: spec.slot as WorkflowCheckSlot }
      : null;
  }
  return null;
}
