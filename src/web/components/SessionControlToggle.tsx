import { useState } from "react";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { authorizeSessionControl, canAuthorizeSessionControl } from "../lib/session-control-authorization.ts";
import { Tooltip } from "./Tooltip.tsx";
import { SessionToolbarIcon, SessionToolbarMenu } from "./SessionToolbarMenu.tsx";

export function SessionControlToggle({ session }: { session: Session }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (session.state === "exited" || session.state === "stopping") return null;
  async function change(enabled: boolean, trusted: boolean): Promise<void> {
    const requestId = crypto.randomUUID();
    if (!trusted || !authorizeSessionControl({ requestId, sessionId: session.id, enabled })) {
      setError("Use the session control menu in the desktop app to authorize this change.");
      return;
    }
    setBusy(true);
    const result = await api.setSessionControl(session.id, enabled, requestId);
    setError(result.ok ? null : (result.error ?? "Could not change session control"));
    setBusy(false);
  }
  const enabled = session.sessionControlEnabled === true;
  const available = canAuthorizeSessionControl();
  return (
    <SessionToolbarMenu label={`Session control: ${enabled ? "On" : "Off"}`} title="Control other sessions"
      icon={<SessionToolbarIcon kind="control" />} className={enabled ? "session-control-btn is-active" : "session-control-btn"}>
      {() => <>
        <p className="session-toolbar-note">Allow this session to message and steer other live sessions on your behalf.</p>
        {[false, true].map(value => <Tooltip key={String(value)} label={!available ? "Open the desktop app to change session control." : value ? "Allow this session to control other live sessions" : "Revoke this session’s control of other sessions"}><button type="button" role="menuitemradio"
          aria-label={value ? "On" : "Off"} aria-checked={enabled === value} className="session-toolbar-option"
          disabled={busy || !available} onClick={event => void change(value, event.nativeEvent.isTrusted)}>
          <span>{value ? "On" : "Off"}</span><span aria-hidden="true">{enabled === value ? "✓" : ""}</span>
        </button></Tooltip>)}
        <p className="session-toolbar-note session-toolbar-foot">{available
          ? "Resets when this conversation changes or Mission Control restarts."
          : "Open the desktop app to change session control."}</p>
        {error && <p className="session-toolbar-error" role="alert">{error}</p>}
      </>}
    </SessionToolbarMenu>
  );
}
