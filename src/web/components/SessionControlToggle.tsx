import { useState } from "react";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { authorizeSessionControl, canAuthorizeSessionControl } from "../lib/session-control-authorization.ts";

export function SessionControlToggle({ session }: { session: Session }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (session.state === "exited" || session.state === "stopping") return null;
  async function change(enabled: boolean, trusted: boolean): Promise<void> {
    const requestId = crypto.randomUUID();
    if (!trusted || !authorizeSessionControl({ requestId, sessionId: session.id, enabled })) {
      setError("Use the session control checkbox in the desktop app to authorize this change.");
      return;
    }
    setBusy(true);
    const result = await api.setSessionControl(session.id, enabled, requestId);
    setError(result.ok ? null : (result.error ?? "Could not change session control"));
    setBusy(false);
  }
  return (
    <div className="session-control-setting">
      <label>
        <input type="checkbox" checked={session.sessionControlEnabled === true} disabled={busy || !canAuthorizeSessionControl()}
          onChange={(event) => void change(event.target.checked, event.nativeEvent.isTrusted)} />
        Control other sessions
      </label>
      <p>{session.sessionControlEnabled
        ? "This session can message and answer prompts for other sessions."
        : "Off. Enable to let this session steer other sessions on your behalf."}</p>
      <p>Resets with this conversation or a Mission Control restart.</p>
      {!canAuthorizeSessionControl() && <p>Open the desktop app to change session control.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
