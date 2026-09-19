import { useEffect, useState } from "react";
import type { PendingTurn, Session } from "@shared/types.ts";
import { canInterrupt } from "@shared/harness-capabilities.ts";
import {
  MESSAGE_WAIT_NOTICE_MS, canSteerMessage, deliveryStage,
} from "@shared/message-delivery.ts";
import { activePaneDialog } from "@shared/session.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A local clock updates age text only. Delivery deadlines are owned by the daemon, and the
 * composer offers no choice to make: every message follows the same policy, so what is worth
 * showing is what is about to happen to THIS message and why it has not happened yet.
 */
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
  const stage = deliveryStage(session, turn, now);
  const reason = activePaneDialog(session) ? "Waiting for your review answer"
    : session.state === "stopping" || session.state === "exited" ? "This session is ending"
    : session.pendingTurns.some(row => row.state !== "queued") ? "Resolve the earlier delivery first"
    : turn.lastError ? "Automatic delivery needs attention"
    : stage?.action === "interrupt" ? "Interrupting this turn to deliver it"
    : stage ? "Steering it into this turn"
    : "Waiting for this turn to finish";
  return <span className="pending-message-delivery">
    {age >= MESSAGE_WAIT_NOTICE_MS && <span className="pending-message-age">Waiting {Math.floor(age / 1000)}s · {reason}</span>}
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
