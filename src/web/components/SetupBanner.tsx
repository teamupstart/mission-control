import { useState } from "react";
import type { SetupChecksView } from "@shared/setup-catalog.ts";

import { Tooltip } from "./Tooltip.tsx";

export function SetupBanner({
  view,
  onDismiss,
}: {
  view: SetupChecksView | null;
  onDismiss: () => Promise<string | null>;
}): React.JSX.Element | null {
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!view?.banner.visible) return null;

  const count = view.banner.attentionCount;
  const label = count > 0 ? "Machine setup needs attention" : "Review machine setup";
  const summary = count > 0
    ? `${count} required setup ${count === 1 ? "check needs" : "checks need"} attention.`
    : "Take a quick look at what Mission Control can use on this machine.";

  const dismiss = async (): Promise<void> => {
    setDismissing(true);
    setError(null);
    const nextError = await onDismiss();
    setDismissing(false);
    setError(nextError);
  };

  return (
    <section className="app-banner app-banner-setup" role="status" aria-label={label}>
      <div className="app-banner-copy">
        <strong>{summary}</strong>
        <p>Setup explains what is missing, what it enables, and how to finish.</p>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
      <div className="app-banner-actions">
        <Tooltip label="Open the machine Setup panel">
          <a className="btn btn-primary" href="#/settings/setup">Open Setup</a>
        </Tooltip>
        <Tooltip label="Dismiss setup reminder">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={dismissing}
            onClick={() => void dismiss()}
            aria-label="Dismiss setup reminder"
          >
            {dismissing ? "Dismissing..." : "Dismiss"}
          </button>
        </Tooltip>
      </div>
    </section>
  );
}
