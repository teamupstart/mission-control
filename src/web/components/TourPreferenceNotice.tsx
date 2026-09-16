import { Tooltip } from "./Tooltip.tsx";

export const TOUR_PREFERENCE_ERROR = "Could not save your tour preference. Your previous setting still applies.";

export function TourPreferenceNotice({ onBrowse, onDismiss }: {
  onBrowse: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="app-banner app-banner-error">
      <div className="app-banner-copy"><p role="alert">{TOUR_PREFERENCE_ERROR}</p></div>
      <div className="app-banner-actions">
        <Tooltip label="Reopen the tour picker to retry saving your preference">
          <button className="btn" onClick={onBrowse}>Browse tours</button>
        </Tooltip>
        <Tooltip label="Dismiss this notice without changing your saved preference">
          <button className="btn btn-ghost" onClick={onDismiss}>Dismiss</button>
        </Tooltip>
      </div>
    </div>
  );
}
