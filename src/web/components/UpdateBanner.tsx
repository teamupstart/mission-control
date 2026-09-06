import { updatePrepareProgress, type UpdateSnapshot } from "@shared/update.ts";
import { UPDATE_COPY } from "@shared/update-copy.ts";
import { Tooltip } from "./Tooltip.tsx";

interface UpdateBannerProps {
  snapshot: UpdateSnapshot | null;
  onApply: () => void;
  onInstall: () => void;
  onCancel: () => void;
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

  if (!snapshot) return null;

  if (snapshot.phase === "preparing" && snapshot.cancelling) {
    return (
      <section className="app-banner app-banner-update" role="status" aria-label="Mission Control update">
        <div className="app-banner-copy">
          <strong>{UPDATE_COPY.cancelling.title(snapshot.newVersion)}</strong>
          <p>{UPDATE_COPY.cancelling.detail}</p>
        </div>
      </section>
    );
  }

  if (snapshot.phase === "preparing") {
    const { label, percent, step, steps } = updatePrepareProgress(snapshot.stage);
    return (
      <section className="app-banner app-banner-update" role="status" aria-label="Mission Control update">
        <div className="app-banner-copy">
          {/* Same words as the native dialog, from the one owner both read. */}
          <strong>{UPDATE_COPY.preparing.title(snapshot.newVersion)}</strong>
          {/*
            A real bar with a real value, and the stage beside it. The whole point of building
            before the quit is that this is visible at all, so it says what is happening and
            how far along it is rather than spinning.
          */}
          <div
            className="app-banner-progress"
            role="progressbar"
            aria-label={`Preparing Mission Control ${snapshot.newVersion}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${label}, step ${step} of ${steps}`}
          >
            <span className="app-banner-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p>
            {label} · step {step} of {steps}. {UPDATE_COPY.preparing.detail}
          </p>
        </div>
        <div className="app-banner-actions">
          <Tooltip label="Stop preparing this update">
            <button type="button" className="btn btn-ghost" onClick={props.onCancel}>Cancel</button>
          </Tooltip>
        </div>
      </section>
    );
  }

  if (snapshot.phase === "ready") {
    return (
      <section className="app-banner app-banner-success" role="status" aria-label="Mission Control update">
        <div className="app-banner-copy">
          <strong>{UPDATE_COPY.ready.title(snapshot.newVersion)}</strong>
          <p>{UPDATE_COPY.ready.detail}</p>
        </div>
        <div className="app-banner-actions">
          <Tooltip label={`Restart into Mission Control ${snapshot.newVersion}`}>
            <button type="button" className="btn btn-primary" onClick={props.onInstall}>Restart and Install</button>
          </Tooltip>
          <Tooltip label="Keep the prepared update and install it later">
            <button type="button" className="btn btn-ghost" onClick={props.onDefer}>Later</button>
          </Tooltip>
        </div>
      </section>
    );
  }

  if (snapshot.phase === "applying") {
    return (
      <section className="app-banner app-banner-update" role="status" aria-label="Mission Control update">
        <div className="app-banner-copy">
          <strong>{UPDATE_COPY.applying.title(snapshot.newVersion)}</strong>
          <p>{UPDATE_COPY.applying.detail}</p>
        </div>
      </section>
    );
  }

  if (snapshot.phase === "error") {
    return (
      <section className="app-banner app-banner-error" role="status" aria-label="Mission Control update">
        <div className="app-banner-copy">
          <strong>The update check failed.</strong>
          <p>{snapshot.message}</p>
        </div>
        <div className="app-banner-actions">
          {/*
            Retry follows `retryable` alone, not `manual && retryable`. The error phase is now
            reachable from a background check for a standing, user-actionable failure - a lapsed
            `gh` credential - and that is precisely the state where someone runs `gh auth login`
            and wants to re-check from here. Gating on `manual` would leave the one error we
            chose to interrupt them with as the only one offering no way forward.
          */}
          {snapshot.retryable && (
            <Tooltip label="Check for the update again">
              <button type="button" className="btn btn-primary" onClick={props.onCheck}>Retry</button>
            </Tooltip>
          )}
          <Tooltip label="Hide this update error">
            <button type="button" className="btn btn-ghost" onClick={props.onDismiss}>Dismiss</button>
          </Tooltip>
        </div>
      </section>
    );
  }

  if (snapshot.phase === "available") {
    return (
      <section className="app-banner app-banner-update" role="status" aria-label="Mission Control update">
        <div className="app-banner-copy">
          <strong>Mission Control {snapshot.newVersion} is available</strong>
          <p>{releaseSummary(snapshot.releaseNotes)}</p>
        </div>
        <div className="app-banner-actions">
          <Tooltip label={`Build Mission Control ${snapshot.newVersion} now, then restart when it is ready`}>
            <button type="button" className="btn btn-primary" onClick={props.onApply}>Update Now</button>
          </Tooltip>
          <Tooltip label="Hide this update until the next check">
            <button type="button" className="btn btn-ghost" onClick={props.onDefer}>Later</button>
          </Tooltip>
        </div>
      </section>
    );
  }

  if ((snapshot.phase === "idle" || snapshot.phase === "disabled")
    && snapshot.lastOutcome?.result === "failure") {
    return (
      <section className="app-banner app-banner-error" role="status" aria-label="Mission Control update">
        <div className="app-banner-copy">
          <strong>Mission Control {snapshot.lastOutcome.targetVersion} could not be installed.</strong>
          <p>{snapshot.lastOutcome.message}</p>
        </div>
        <div className="app-banner-actions">
          <Tooltip label="Check for the update again">
            <button type="button" className="btn btn-primary" onClick={props.onCheck}>Retry</button>
          </Tooltip>
          <Tooltip label="Hide this update failure">
            <button type="button" className="btn btn-ghost" onClick={props.onDismiss}>Dismiss</button>
          </Tooltip>
        </div>
      </section>
    );
  }

  if ((snapshot.phase === "idle" || snapshot.phase === "disabled")
    && snapshot.lastOutcome?.result === "success") {
    return (
      <section className="app-banner app-banner-success" role="status" aria-label="Mission Control update">
        <strong>Mission Control updated successfully to {snapshot.lastOutcome.targetVersion}.</strong>
        <div className="app-banner-actions">
          <Tooltip label="Hide this update confirmation">
            <button type="button" className="btn btn-ghost" onClick={props.onDismiss}>Dismiss</button>
          </Tooltip>
        </div>
      </section>
    );
  }

  return null;
}
