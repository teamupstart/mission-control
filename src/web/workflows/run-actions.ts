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

/**
 * Whether this run can take a resubmission, and why not when it cannot.
 *
 * `refusal` carries the reason so a disabled control can say it; `null` means the header's own
 * per-button copy applies, because a live resubmission invites two different things - fresh
 * evidence or the snapshot already taken - and that wording belongs beside the buttons.
 */
export interface ResubmitAvailability {
  /** A blocked run resumes the round it stalled in; a waiting run opens the next one. */
  resuming: boolean;
  refusal: string | null;
}

/**
 * Whether the header may offer a resubmission.
 *
 * `blocked` belongs here because `manager.resubmit` has always accepted it while the header
 * offered the control to `waiting_for_session` alone. That left a run blocked on a fault which
 * has since cleared - `check_cleanup_unresolved` once its pooled worktree came back - showing
 * nothing but Cancel run, with the one call that revives it a route away and unreachable.
 *
 * The refusals mirror `manager.resubmit`'s own, in its order, so the control never promises a
 * call the server will reject. An Inspector-only repair is excluded rather than disabled: it
 * owns Restart full workflow, and two competing recoveries side by side is how an operator
 * picks the wrong one.
 */
export function resubmitAvailability(
  detail: WorkflowRunDetail,
  liveInspectorRepair: boolean,
): ResubmitAvailability | null {
  const { status } = detail.run;
  if (status !== "waiting_for_session" && status !== "blocked") return null;
  const resuming = status === "blocked";
  if (resuming && liveInspectorRepair) return null;
  if (detail.binding.state !== "active") {
    return { resuming, refusal: "The bound session is gone, so no further round can be prepared" };
  }
  if (detail.externalSource) {
    return { resuming, refusal: "An externally sourced run cannot take a manual round" };
  }
  if (detail.summary.round > detail.summary.maxRepairRounds) {
    return { resuming, refusal: "This run has used every repair round its binding allows" };
  }
  return { resuming, refusal: null };
}

export function runActionTooltip(
  descriptor: RunActionDescriptor,
  pending: boolean,
): string {
  return pending ? "This action is already running" : descriptor.tooltip;
}
