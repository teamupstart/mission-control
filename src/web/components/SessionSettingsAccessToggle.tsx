import { useEffect, useState } from "react";
import { SESSION_SETTINGS_ACCESS } from "@shared/session-settings-metadata.ts";
import { api, fetchSessionSettingsAccess } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

export function SessionSettingsAccessToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const request = new AbortController();
    void fetchSessionSettingsAccess(request.signal).then(access => {
      if (request.signal.aborted) return;
      if (access) setEnabled(access.enabled);
      else setError("Could not read session settings access.");
    });
    return () => request.abort();
  }, []);

  async function change(next: boolean) {
    setSaving(true);
    setError(null);
    const result = await api.setSessionSettingsAccess(next);
    if (result.ok) setEnabled(next);
    else setError("Could not save session settings access.");
    setSaving(false);
  }

  return (
    <div data-anchor={SESSION_SETTINGS_ACCESS.anchor}>
      <label className={`settings-toggle${enabled ? " is-on" : ""}`}>
        <Tooltip label={SESSION_SETTINGS_ACCESS.description}>
          <input
            type="checkbox"
            aria-label={SESSION_SETTINGS_ACCESS.label}
            aria-describedby="session-settings-access-description"
            checked={enabled === true}
            disabled={enabled === null || saving}
            onChange={event => void change(event.target.checked)}
          />
        </Tooltip>
        <span className="settings-toggle-text">
          <span className="settings-toggle-label">{SESSION_SETTINGS_ACCESS.label}</span>
          <span className="settings-toggle-desc" id="session-settings-access-description">{SESSION_SETTINGS_ACCESS.description}</span>
        </span>
      </label>
      {error && <p className="settings-warn" role="alert">{error}</p>}
    </div>
  );
}
