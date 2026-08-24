import type { SettingsRestoredEvent } from "@shared/settings-backups.ts";
import { Tooltip } from "./Tooltip.tsx";

export function SettingsRestoredBanner({
  event,
  onReload,
}: {
  event: SettingsRestoredEvent | null;
  onReload: () => void;
}): React.JSX.Element | null {
  if (!event) return null;
  const restoredAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(event.restoredAt));
  return (
    <section className="app-banner app-banner-restore" role="status">
      <div className="app-banner-copy">
        <strong>Settings were restored in another window.</strong>
        <p>Committed {restoredAt}. Reload when you are ready to adopt them here. Unsaved drafts remain untouched until then.</p>
      </div>
      <div className="app-banner-actions">
        <Tooltip label="Reload this window and adopt the restored settings">
          <button type="button" className="btn btn-primary" onClick={onReload}>Reload now</button>
        </Tooltip>
      </div>
    </section>
  );
}
