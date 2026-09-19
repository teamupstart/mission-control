import type { PendingTurn, Session } from "./types.ts";
import { canInterrupt, capabilitiesFor } from "./harness-capabilities.ts";

/** Persisted identifiers: append only. Next-turn delivery remains the default. */
export const MESSAGE_DELIVERY_MODES = [
  "after-turn", "steer", "steer-after-wait", "interrupt-after-wait",
] as const;
export type MessageDeliveryMode = (typeof MESSAGE_DELIVERY_MODES)[number];
export const MESSAGE_DELIVERY: Record<MessageDeliveryMode, { label: string; delayMs: number | null }> = {
  "after-turn": { label: "After this turn", delayMs: null },
  steer: { label: "Steer now", delayMs: 0 },
  "steer-after-wait": { label: "Steer after 1 minute", delayMs: 60_000 },
  "interrupt-after-wait": { label: "Interrupt after 2 minutes", delayMs: 120_000 },
};

export function canSteerMessage(session: Pick<Session, "agent" | "runtime">): boolean {
  return capabilitiesFor(session.agent).steering?.runtimes.includes(session.runtime) ?? false;
}

export function supportsMessageDelivery(
  session: Pick<Session, "agent" | "runtime">,
  mode: MessageDeliveryMode,
): boolean {
  if (mode === "after-turn") return true;
  if (mode === "interrupt-after-wait") return canInterrupt(session.agent, session.runtime);
  return canSteerMessage(session);
}

export function messageDeliveryMode(turn: PendingTurn): MessageDeliveryMode {
  return turn.deliveryMode ?? "after-turn";
}

export const MESSAGE_WAIT_NOTICE_MS = 30_000;
export const MESSAGE_INTERRUPT_WATCHDOG_MS = 10_000;
