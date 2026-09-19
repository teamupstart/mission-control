import { useEffect, useState, useSyncExternalStore } from "react";
import type { PendingTurn, Session } from "@shared/types.ts";
import { canInterrupt } from "@shared/harness-capabilities.ts";
import {
  MESSAGE_DELIVERY, MESSAGE_DELIVERY_MODES, MESSAGE_WAIT_NOTICE_MS,
  canSteerMessage, messageDeliveryMode, supportsMessageDelivery, type MessageDeliveryMode,
} from "@shared/message-delivery.ts";
import { activePaneDialog } from "@shared/session.ts";
import { readDraft, subscribeDeliveryChoice, writeDraft } from "../lib/drafts.ts";
import { Tooltip } from "./Tooltip.tsx";

export function useMessageDeliveryChoice(session: Session): [MessageDeliveryMode, (mode: MessageDeliveryMode) => void] {
  const stored = useSyncExternalStore(subscribeDeliveryChoice,
    () => readDraft(session.id, "delivery"), () => "");
  const mode = MESSAGE_DELIVERY_MODES.find(value => value === stored) ?? "after-turn";
  return [supportsMessageDelivery(session, mode) ? mode : "after-turn",
    next => writeDraft(session.id, "delivery", next)];
}

export function MessageDeliveryChoice({ session, value, onChange, disabled = false }: {
  session: Session; value: MessageDeliveryMode; onChange: (mode: MessageDeliveryMode) => void; disabled?: boolean;
}): React.JSX.Element {
  return <label className="message-delivery-choice">
    Delivery
    <Tooltip label="Choose when this message may reach the agent; automatic interruption is optional">
    <select aria-label="Message delivery" value={value} disabled={disabled}
      onChange={event => onChange(event.currentTarget.value as MessageDeliveryMode)}>
      {MESSAGE_DELIVERY_MODES.filter(mode => supportsMessageDelivery(session, mode)).map(mode =>
        <option key={mode} value={mode}>{MESSAGE_DELIVERY[mode].label}</option>)}
    </select>
    </Tooltip>
    <span>{value === "interrupt-after-wait" ? "May stop a running tool. Other messages are kept."
      : value === "after-turn" ? "Waits for the current turn to finish."
      : "Joins the current turn; acceptance does not mean it has been read."}</span>
  </label>;
}

/** A local clock updates age text only. Delivery deadlines are owned by the daemon. */
export function PendingMessageDelivery({ session, turn, busy, onDeliver }: {
  session: Session; turn: PendingTurn; busy: boolean; onDeliver: (action: "steer" | "interrupt") => void;
}): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (turn.state !== "queued") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turn.state]);
  if (turn.state !== "queued") return null;
  const age = Math.max(0, now - turn.createdAt);
  const blocked = activePaneDialog(session) !== null ||
    !session.stateConfirmed || !["working", "idle"].includes(session.state) ||
    session.pendingTurns.some(row => row.state !== "queued");
  const mode = messageDeliveryMode(turn);
  const reason = activePaneDialog(session) ? "Waiting for your review answer"
    : session.state === "stopping" || session.state === "exited" ? "This session is ending"
    : session.pendingTurns.some(row => row.state !== "queued") ? "Resolve the earlier delivery first"
    : turn.lastError ? "Automatic delivery needs attention"
    : mode === "after-turn" ? "Waiting for this turn to finish"
    : MESSAGE_DELIVERY[mode].label;
  return <span className="pending-message-delivery">
    {age >= MESSAGE_WAIT_NOTICE_MS && <span className="pending-message-age">Waiting {Math.floor(age / 1000)}s · {reason}</span>}
    {age < MESSAGE_WAIT_NOTICE_MS && mode !== "after-turn" && <span>{MESSAGE_DELIVERY[mode].label}</span>}
    {canSteerMessage(session) && <Tooltip label="Send this correction into the current turn, ahead of messages waiting for the next turn">
      <button type="button" className="pending-turn-action" disabled={busy || blocked}
        onClick={() => onDeliver("steer")}>Steer now</button>
    </Tooltip>}
    {canInterrupt(session.agent, session.runtime) && <Tooltip label="Stop the current turn and send this message. Keep all other queued messages.">
      <button type="button" className="pending-turn-action" disabled={busy || blocked}
        onClick={() => onDeliver("interrupt")}>Interrupt and deliver</button>
    </Tooltip>}
  </span>;
}
