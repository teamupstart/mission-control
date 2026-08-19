import type { UpdateSnapshot } from "@shared/update.ts";

interface UpdateBannerProps {
  snapshot: UpdateSnapshot;
  onApply: () => void;
  onDefer: () => void;
  onCheck: () => void;
  onDismiss: () => void;
}

const RELEASE_NOTES_LIMIT = 280;

function releaseSummary(notes: string): string {
  if (notes.length <= RELEASE_NOTES_LIMIT) return notes;
  return `${notes.slice(0, RELEASE_NOTES_LIMIT).trimEnd()}…`;
}

export function UpdateBanner(props: UpdateBannerProps): React.JSX.Element | null {
  const { snapshot } = props;

  if (snapshot.phase === "applying") {
    return (
      <section className="app-banner app-banner-update" role="status">
        <strong>Preparing to update Mission Control to {snapshot.newVersion}.</strong>
      </section>
    );
  }

  if (snapshot.phase === "error") {
    return (
      <section className="app-banner app-banner-error" role="status">
        <div className="app-banner-copy">
          <strong>The update check failed.</strong>
          <p>{snapshot.message}</p>
        </div>
        <div className="app-banner-actions">
          {snapshot.manual && snapshot.retryable && (
            <button type="button" className="btn btn-primary" onClick={props.onCheck}>Retry</button>
          )}
          <button type="button" className="btn btn-ghost" onClick={props.onDismiss}>Dismiss</button>
        </div>
      </section>
    );
  }

  if (snapshot.phase === "available") {
    return (
      <section className="app-banner app-banner-update" role="status">
        <div className="app-banner-copy">
          <strong>Mission Control {snapshot.newVersion} is available</strong>
          <p>{releaseSummary(snapshot.releaseNotes)}</p>
        </div>
        <div className="app-banner-actions">
          <button type="button" className="btn btn-primary" onClick={props.onApply}>Update Now</button>
          <button type="button" className="btn btn-ghost" onClick={props.onDefer}>Later</button>
        </div>
      </section>
    );
  }

  if (snapshot.lastOutcome?.result === "failure") {
    return (
      <section className="app-banner app-banner-error" role="status">
        <div className="app-banner-copy">
          <strong>Mission Control {snapshot.lastOutcome.targetVersion} could not be installed.</strong>
          <p>{snapshot.lastOutcome.message}</p>
        </div>
        <div className="app-banner-actions">
          <button type="button" className="btn btn-primary" onClick={props.onCheck}>Retry</button>
          <button type="button" className="btn btn-ghost" onClick={props.onDismiss}>Dismiss</button>
        </div>
      </section>
    );
  }

  if (snapshot.lastOutcome?.result === "success") {
    return (
      <section className="app-banner app-banner-success" role="status">
        <strong>Mission Control updated successfully to {snapshot.lastOutcome.targetVersion}.</strong>
        <div className="app-banner-actions">
          <button type="button" className="btn btn-ghost" onClick={props.onDismiss}>Dismiss</button>
        </div>
      </section>
    );
  }

  return null;
}
