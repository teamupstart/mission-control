import { useState } from "react";
import type { TelemetrySettingsSummary } from "@shared/telemetry.ts";

import { Tooltip } from "./Tooltip.tsx";

export function OrganizationTelemetryNotice({
  notice,
  onDismiss,
}: {
  notice: TelemetrySettingsSummary["organizationNotice"] | null;
  onDismiss: () => Promise<string | null>;
}): React.JSX.Element | null {
  if (notice === null) return null;
  return <VisibleNotice key={notice.label} notice={notice} onDismiss={onDismiss} />;
}

function VisibleNotice({
  notice,
  onDismiss,
}: {
  notice: NonNullable<TelemetrySettingsSummary["organizationNotice"]>;
  onDismiss: () => Promise<string | null>;
}): React.JSX.Element | null {
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const dismiss = async (): Promise<void> => {
    setDismissing(true);
    setError(null);
    try {
      const nextError = await onDismiss();
      setError(nextError);
      if (nextError === null) setAcknowledged(true);
    } catch {
      setError("Could not dismiss the notice. Try again.");
    } finally {
      setDismissing(false);
    }
  };

  if (acknowledged) return null;

  return (
    <section className="app-banner app-banner-organization" role="status" aria-label="Organization telemetry notice">
      <div className="app-banner-copy">
        <strong>Telemetry is enabled by your organization for Claude and Codex.</strong>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
      <div className="app-banner-actions">
        <Tooltip label="See the managed telemetry settings">
          <a className="btn btn-primary" href="#/settings/telemetry">View telemetry</a>
        </Tooltip>
        <Tooltip label="Dismiss managed telemetry notice">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={dismissing}
            onClick={() => void dismiss()}
            aria-label="Dismiss managed telemetry notice"
          >
            {dismissing ? "Dismissing..." : "Dismiss"}
          </button>
        </Tooltip>
      </div>
    </section>
  );
}
