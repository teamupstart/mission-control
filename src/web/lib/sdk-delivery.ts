import type { MessageSendDisposition } from "@shared/types.ts";

/**
 * Turn an embedded driver's acknowledgement into the feedback the composer shows.
 *
 * Terminal sends return no disposition and keep their existing behavior. SDK sends say
 * where the message went, because an accepted Claude follow-up may not appear in the
 * transcript until the active turn finishes.
 */
export function sdkDeliveryConfirmation(
  disposition: MessageSendDisposition | undefined,
): string | null {
  switch (disposition) {
    case "pending":
      return "Queued. Press Up Arrow in an empty reply box to edit.";
    case "started":
      return "Sent — the agent started a new turn.";
    case "steered":
      return "Sent — added to the agent’s current turn.";
    case "queued":
      return "Accepted — queued behind the agent’s current turn.";
    case undefined:
      return null;
  }
}
