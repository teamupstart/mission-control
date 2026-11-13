import { useEffect, useState } from "react";
import { stopWorktreeClaim } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

// What both cards that show a running dependency claim share: its elapsed time, counting up
// between server events, and the Stop control. The slot card in Settings › Worktrees and the
// task card of the dispatch waiting on the claim draw the same claim, so they stop it the same
// way: by slot and by the claim's own id.

/** `m:ss`, or `h:mm:ss` past an hour. Never negative, whatever the two clocks say. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** The wall clock, ticking once a second while `active`, so an elapsed time counts up between events. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

const STOP_HELP =
  "Stop this dependency claim. Its step's processes are killed, the worktree is handed over " +
  "with a warning, and the dispatch continues.";

/**
 * Stop for one running claim. It stays "Stopping…" once the daemon accepted the stop: the
 * claim's end arrives as the ordinary task and worktree updates, which remove this control.
 */
export function ClaimStopButton({
  slotId,
  claimId,
  label,
}: {
  slotId: string;
  claimId: string;
  /** The accessible name, saying which claim this stops. */
  label: string;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A different claim is a different control: nothing about the last one's Stop carries over.
  useEffect(() => {
    setPending(false);
    setError(null);
  }, [slotId, claimId]);

  async function stop(): Promise<void> {
    setPending(true);
    setError(null);
    const result = await stopWorktreeClaim(slotId, claimId);
    if (result.ok) return;
    setPending(false);
    setError(result.status === 404
      ? "The claim had already finished."
      : `The claim could not be stopped: ${result.error}`);
  }

  return (
    <span className="claim-stop">
      <Tooltip label={STOP_HELP}>
        <button
          className="btn claim-stop-btn"
          type="button"
          aria-label={label}
          disabled={pending}
          onClick={(event) => {
            // A card may be clickable as a whole; Stop is never also "open this".
            event.stopPropagation();
            void stop();
          }}
        >
          {pending ? "Stopping…" : "Stop"}
        </button>
      </Tooltip>
      {error && <span className="claim-stop-error" role="alert">{error}</span>}
    </span>
  );
}
