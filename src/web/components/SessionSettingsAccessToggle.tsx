import { useCallback, useEffect, useRef, useState } from "react";
import { SESSION_SETTINGS_DESKTOP_REQUIRED } from "@shared/session-control-authorization.ts";
import { SESSION_SETTINGS_ACCESS } from "@shared/session-settings-metadata.ts";
import { api, fetchSessionSettingsAccess } from "../lib/api.ts";
import { newRequestId } from "../lib/request-id.ts";
import { authorizeSessionSettings, canAuthorizeSessionSettings } from "../lib/session-control-authorization.ts";
import { onSessionSettingsAccessChanged } from "../lib/session-settings-access.ts";
import { Tooltip } from "./Tooltip.tsx";

export function SessionSettingsAccessToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const read = useRef<AbortController | null>(null);
  const editable = canAuthorizeSessionSettings();
  const refresh = useCallback(async () => {
    read.current?.abort();
    const request = new AbortController();
    read.current = request;
    const access = await fetchSessionSettingsAccess(AbortSignal.any([request.signal, AbortSignal.timeout(5000)]));
    if (request.signal.aborted) return;
    setReadFailed(!access);
    if (access) setEnabled(access.enabled);
  }, []);
  useEffect(() => {
    const unsubscribe = onSessionSettingsAccessChanged(() => { void refresh(); });
    void refresh();
    return () => {
      unsubscribe();
      read.current?.abort();
    };
  }, [refresh]);

  async function change(next: boolean) {
    const input = { enabled: next, requestId: newRequestId() };
    if (!authorizeSessionSettings(input)) {
      setSaveError(SESSION_SETTINGS_DESKTOP_REQUIRED);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = await api.setSessionSettingsAccess(input);
    if (result.ok) await refresh();
    else setSaveError("Could not save session settings access.");
    setSaving(false);
  }

  const error = saveError ?? (readFailed ? "Could not read session settings access." : null);
  return (
    <div data-anchor={SESSION_SETTINGS_ACCESS.anchor}>
      <label className={`settings-toggle${enabled ? " is-on" : ""}`}>
        <Tooltip label={SESSION_SETTINGS_ACCESS.description}>
          <input
            type="checkbox"
            aria-label={SESSION_SETTINGS_ACCESS.label}
            aria-describedby="session-settings-access-description"
            checked={enabled === true}
            disabled={!editable || enabled === null || saving}
            onChange={event => void change(event.target.checked)}
          />
        </Tooltip>
        <span className="settings-toggle-text">
          <span className="settings-toggle-label">{SESSION_SETTINGS_ACCESS.label}</span>
          <span className="settings-toggle-desc" id="session-settings-access-description">
            {SESSION_SETTINGS_ACCESS.description}
            {!editable && ` ${SESSION_SETTINGS_DESKTOP_REQUIRED}`}
          </span>
        </span>
      </label>
      {error && <p className="settings-warn" role="alert">{error}</p>}
    </div>
  );
}
