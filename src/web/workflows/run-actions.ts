import type {
  WorkflowDelivery,
  WorkflowRunDetail,
} from "@shared/workflow.ts";
import type { WorkflowConfirmRequest } from "./WorkflowConfirmModal.tsx";

export type RunActionId = string;
export type WorkflowDeliveryResolution =
  | "mark_delivered"
  | "discard_and_new_round";

export type WorkflowConfirmDescriptor = Omit<WorkflowConfirmRequest, "onConfirm">;

export interface RunActionDescriptor {
  id: RunActionId;
  label: string;
  tooltip: string;
  disabled: boolean;
}

export interface CopyFeedbackAction extends RunActionDescriptor {
  kind: "copy-feedback";
}

export type GateAction =
  | (RunActionDescriptor & { kind: "prepare-pr" })
  | (RunActionDescriptor & { kind: "recheck-inspector" })
  | (RunActionDescriptor & {
      kind: "open-pr";
      href: string | null;
    });

export interface DeliveryAction extends RunActionDescriptor {
  kind: "resolve-delivery";
  deliveryId: WorkflowDelivery["id"];
  resolution: WorkflowDeliveryResolution;
  confirm: WorkflowConfirmDescriptor;
}

export function copyFeedbackAction(
  detail: WorkflowRunDetail,
  copied = false,
): CopyFeedbackAction {
  const available = detail.deliveries.some((delivery) => delivery.payload.length > 0)
    || detail.attempts.some((attempt) => attempt.verdict);
  return {
    id: "copy-feedback",
    kind: "copy-feedback",
    label: copied ? "Copied" : "Copy feedback",
    tooltip: available
      ? "Copy every reviewer verdict to the clipboard"
      : detail.deliveries.some((delivery) => delivery.payloadPrunedAt != null)
        ? "Raw delivery feedback was pruned and no Persona verdict remains"
        : "No workflow feedback has been recorded yet",
    disabled: !available,
  };
}

/**
 * The Inspector gate's complete action vocabulary.
 *
 * Filtering lives here so the Runs page and the session detail cannot disagree about whether
 * a run's own immutable completion policy offers a PR handoff.
 */
export function inspectorGateActions(detail: WorkflowRunDetail): GateAction[] {
  const gate = detail.inspectorGate;
  const actions: GateAction[] = [];
  if (
    gate
    && detail.run.status === "waiting_for_pr"
    && (gate.state.waitReason === "missing_pr"
      || gate.state.waitReason === "unadopted_pr")
    && detail.version?.completionPolicy.kind === "inspector"
    && detail.version.completionPolicy.missingPrAction === "offer_prepare_pr"
  ) {
    actions.push({
      id: "prepare-pr",
      kind: "prepare-pr",
      label: "Prepare PR in session",
      tooltip: "Send the session an explicit commit, push, and PR handoff packet",
      disabled: false,
    });
  }
  if (gate && gate.state.waitReason !== null) {
    actions.push({
      id: "recheck-inspector",
      kind: "recheck-inspector",
      label: "Recheck Inspector",
      tooltip: "Evaluate the gate again from Inspector's current durable ledger",
      disabled: false,
    });
  }
  const href = gate?.state.prUrl ?? null;
  actions.push({
    id: "open-pr",
    kind: "open-pr",
    label: "Open PR",
    tooltip: href
      ? "Open this run's adopted pull request in a new tab"
      : "This run has no adopted pull request",
    disabled: href === null,
    href,
  });
  return actions;
}

/**
 * Recovery copy and guards for an uncertain delivery.
 *
 * `sessionBound` must be `detail.binding.sessionId !== null`. A rendered session is not proof
 * that the delivery's own binding still points at a live conversation.
 */
export function deliveryResolutionActions(
  delivery: WorkflowDelivery,
  sessionBound: boolean,
): DeliveryAction[] {
  return [
    {
      id: `delivery:${delivery.id}:mark_delivered`,
      kind: "resolve-delivery",
      deliveryId: delivery.id,
      resolution: "mark_delivered",
      label: "Mark delivered",
      tooltip: "Confirm the exact packet already reached the inspected pane",
      disabled: false,
      confirm: {
        title: "Mark this packet delivered",
        body: "Confirm you inspected the session's pane and this exact repair prompt is in it."
          + " Marking it delivered ends the recovery.",
        confirmLabel: "Mark delivered",
        confirmHint: "Records the packet as delivered without sending it again",
      },
    },
    {
      id: `delivery:${delivery.id}:discard_and_new_round`,
      kind: "resolve-delivery",
      deliveryId: delivery.id,
      resolution: "discard_and_new_round",
      label: "Discard and send new round",
      tooltip: sessionBound
        ? "Discard this ambiguous packet and create a replacement repair round"
        : "The bound session is gone, so no replacement round can be prepared",
      disabled: !sessionBound,
      confirm: {
        title: "Discard and send a new repair round",
        body: "The pane may already hold this packet. Discarding it prepares a fresh repair"
          + " round, which the session could receive twice.",
        confirmLabel: "Discard and send new round",
        confirmHint: "Discards the ambiguous packet and prepares a new repair round",
        danger: true,
        requirePhrase: "DISCARD AND SEND A NEW REPAIR ROUND",
      },
    },
  ];
}

export function runActionTooltip(
  descriptor: RunActionDescriptor,
  pending: boolean,
): string {
  return pending ? "This action is already running" : descriptor.tooltip;
}
