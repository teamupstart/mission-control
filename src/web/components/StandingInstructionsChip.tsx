import { useEffect, useState } from "react";
import type { StandingInstructionsDelivery } from "@shared/standing-instructions.ts";
import { fetchSessionStandingInstructions } from "../lib/api.ts";
import { MECHANISM_PROSE, deliverySummary } from "../lib/standing-instructions-view.ts";
import { StandingInstructionsDeliveryView } from "./StandingInstructionsDelivery.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * What THIS session was actually sent, read from its immutable launch snapshot.
 *
 * It MUST NEVER call the resolved route, and that is the whole design of this component. A
 * session outlives the setting that launched it: the operator edits the rule, or removes the
 * repository's override entirely, and a chip resolving live configuration would then quote
 * that session new text it never saw - or vanish from a session that did receive one. That
 * is worse than having no chip at all. The chip exists so nobody debugs an instruction they
 * cannot see, and a chip that lies sends them looking for the cause of a behaviour in a rule
 * that was never in effect.
 *
 * `null` covers the route's 404, which is the ordinary case: most sessions have no standing
 * instructions and this renders nothing at all.
 *
 * It names the mechanism IT RECORDED AT LAUNCH, not the one the harness would use today.
 */
export function StandingInstructionsChip({
  sessionId,
}: {
  sessionId: string;
}): React.JSX.Element | null {
  const [delivery, setDelivery] = useState<StandingInstructionsDelivery | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    setDelivery(null);
    setOpen(false);
    void fetchSessionStandingInstructions(sessionId, abort.signal).then((d) => {
      if (!abort.signal.aborted) setDelivery(d);
    });
    return () => abort.abort();
  }, [sessionId]);

  if (!delivery?.text) return null;
  const summary = deliverySummary(delivery.text, delivery.mechanism);
  const prose = MECHANISM_PROSE[delivery.mechanism];

  return (
    <>
      <Tooltip
        label={`This session launched with standing instructions - ${summary}${
          prose.inTranscript ? "" : ", which never appear in the conversation"
        }`}
      >
        <button
          type="button"
          className="si-session-chip"
          aria-label={`Standing instructions this session received - ${summary}`}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(true);
          }}
        >
          <span className="si-glyph" aria-hidden>&#9998;</span>
          <span className="si-session-chip-label">standing instructions</span>
        </button>
      </Tooltip>
      {open && (
        <Overlay
          id={OVERLAY_IDS.standingInstructions}
          onClose={() => setOpen(false)}
          className="modal si-session-modal"
          role="dialog"
          ariaLabel="Standing instructions this session received"
        >
          <>
            <h3>Standing instructions this session received</h3>
            <p className="settings-hint">
              Recorded at launch and never re-resolved. Editing the rule in Settings changes
              what the <em>next</em> session gets, not this one.
            </p>
            <StandingInstructionsDeliveryView
              delivery={delivery}
              heading="Sent at launch"
            />
            <div className="modal-foot">
              <Tooltip label="Close">
                <button type="button" className="btn" onClick={() => setOpen(false)}>
                  Close
                </button>
              </Tooltip>
            </div>
          </>
        </Overlay>
      )}
    </>
  );
}
