export const TOUR_PREFERENCE_ERROR = "Could not save your tour preference. Your previous setting still applies.";

export function TourPreferenceNotice({ onBrowse, onDismiss }: {
  onBrowse: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="app-banner app-banner-error">
      <div className="app-banner-copy"><p role="alert">{TOUR_PREFERENCE_ERROR}</p></div>
      <div className="app-banner-actions">
        <button className="btn" onClick={onBrowse}>Browse tours</button>
        <button className="btn btn-ghost" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
