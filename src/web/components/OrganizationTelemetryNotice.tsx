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
  return <VisibleNotice notice={notice} onDismiss={onDismiss} />;
}

function VisibleNotice({
  notice,
  onDismiss,
}: {
  notice: NonNullable<TelemetrySettingsSummary["organizationNotice"]>;
  onDismiss: () => Promise<string | null>;
}): React.JSX.Element {
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dismiss = async (): Promise<void> => {
    setDismissing(true);
    setError(null);
    const nextError = await onDismiss();
    setDismissing(false);
    setError(nextError);
  };

  return (
    <section className="app-banner app-banner-organization" role="status" aria-label={`${notice.label} telemetry notice`}>
      <div className="app-banner-copy">
        <strong>Mission Control usage telemetry is on for this {notice.label}-managed Mac.</strong>
        <p>
          Because this Mac is enrolled in {notice.label}'s device management, Mission Control
          sends a minimized set of its own activity metrics and traces through
          {` ${notice.label}'s telemetry gateway to ${notice.label}'s Datadog`}. {notice.label}
          manages this setting. Prompts, code, file paths, terminal output and names are
          excluded. The gateway also copies metrics to a second destination managed by its owners.
        </p>
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
