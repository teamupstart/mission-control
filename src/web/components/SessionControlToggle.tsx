import { useState } from "react";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { authorizeSessionControl, canAuthorizeSessionControl } from "../lib/session-control-authorization.ts";
import { Tooltip } from "./Tooltip.tsx";

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
      <Tooltip label={canAuthorizeSessionControl()
        ? "Allow this session to message and steer other live sessions on your behalf. Resets when this conversation changes or Mission Control restarts."
        : "Open the desktop app to change session control. Resets when this conversation changes or Mission Control restarts."}>
        <label>
          <input type="checkbox" checked={session.sessionControlEnabled === true} disabled={busy || !canAuthorizeSessionControl()}
            onChange={(event) => void change(event.target.checked, event.nativeEvent.isTrusted)} />
          Control other sessions
        </label>
      </Tooltip>
      <p>{session.sessionControlEnabled ? "On" : "Off"}</p>
      {!canAuthorizeSessionControl() && <p>Open the desktop app to change session control.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
