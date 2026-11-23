import { useState, type ReactNode } from "react";
import type { SessionControlRequestView } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { authorizeSessionControl, canAuthorizeSessionControl } from "../lib/session-control-authorization.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A session's own ask for Control other sessions, raised by its `request_session_control` call
 * and answered here. It reads like a `request_input` card but is not one: a review can be
 * resolved by any local HTTP caller, Foreman or another session, so Accept arms the same
 * private trusted-click authorization as the session control menu and sends the existing grant.
 * Outside the desktop app Accept cannot arm anything and is disabled; Decline only removes
 * the ask, so it works anywhere.
 */
export function SessionControlRequestCard({ sessionId, subject, request }: {
  sessionId: string;
  subject: ReactNode;
  request: SessionControlRequestView;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = canAuthorizeSessionControl();

  async function accept(trusted: boolean): Promise<void> {
    // Synchronous, inside the click's own dispatch: the preload refuses once it has ended.
    const requestId = crypto.randomUUID();
    if (!trusted || !authorizeSessionControl({ requestId, sessionId, enabled: true })) {
      setError("Click Accept yourself in the Mission Control desktop app to grant this.");
      return;
    }
    setBusy(true);
    const result = await api.setSessionControl(sessionId, true, requestId, request.id);
    setError(result.ok ? null : (result.error ?? "Could not grant session control"));
    setBusy(false);
  }

  async function decline(): Promise<void> {
    setBusy(true);
    const result = await api.declineSessionControlRequest(sessionId, request.id);
    setError(result.ok ? null : (result.error ?? "Could not decline the request"));
    setBusy(false);
  }

  return (
    <section className="session-control-request" aria-label="Session control request">
      <div className="review-head">
        <span className="kind-tag kind-input">permission</span>
        <h3>{subject} asks to control your other sessions</h3>
      </div>
      <div className="review-content">
        <p className="question">{request.reason}</p>
      </div>
      <p className="session-control-request-note">
        Accepting lets this session read, message and steer your other live sessions on your behalf. Turn it off
        from Session control at any time. It resets when this conversation changes or Mission Control restarts.
      </p>
      <div className="review-actions">
        <span className="actions-spacer" />
        <Tooltip label="Tell the session no. Nothing is granted.">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void decline()}>Decline</button>
        </Tooltip>
        <Tooltip label={available
          ? "Allow this session to control your other live sessions"
          : "Open the desktop app to accept this request"}>
          <button type="button" className="btn btn-approve" disabled={busy || !available}
            onClick={(event) => void accept(event.nativeEvent.isTrusted)}>
            Accept
          </button>
        </Tooltip>
      </div>
      {!available && (
        <p className="session-control-request-note">Open the Mission Control desktop app to accept. You can decline here.</p>
      )}
      {error && <p className="review-err" role="alert">{error}</p>}
    </section>
  );
}
