import type { UpdateSnapshot } from "@shared/update.ts";

interface UpdateBannerProps {
  snapshot: UpdateSnapshot;
  onApply: () => void;
  onDefer: () => void;
  onCheck: () => void;
  onDismiss: () => void;
}

export function UpdateBanner(props: UpdateBannerProps): React.JSX.Element | null {
  if (props.snapshot.phase !== "available") return null;

  return (
    <section role="status">
      <strong>Mission Control {props.snapshot.newVersion} is available</strong>
      <p>{props.snapshot.releaseNotes}</p>
      <button type="button" onClick={props.onApply}>
        Update Now
      </button>
      <button type="button" onClick={props.onDefer}>
        Later
      </button>
    </section>
  );
}
