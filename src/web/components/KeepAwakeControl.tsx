import { useEffect, useRef, useState } from "react";
import type { KeepAwakeStatus } from "@shared/types.ts";
import { setKeepAwake } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The live indicator, now a control: the fleet pulse's leading connection segment plus
 * the Keep Awake dropdown anchored to it.
 *
 * The segment keeps its connection meaning - `live` / `reconnecting` still qualifies
 * every streamed figure beside it - and gains the one host-power mode the daemon offers.
 * The word is required: `live · awake` and `live · awake failed` are spelled out because
 * color alone must not carry the mode, and `awake` never REPLACES `live` because the
 * connection fact is still the thing the segment leads the readout with.
 *
 * Truthfulness contract, the same one the daemon's manager keeps: nothing here renders
 * `awake` from a request. The trigger and the switch read only the OBSERVED status the
 * SSE stream carries, so `on` appears when the OS child spawned and disappears when it
 * exited - and while the stream is down the status is null, the switch disables, and
 * `reconnecting` takes precedence over any stale claim.
 *
 * Dismissal follows the Foreman/Alerts/Spend popovers (outside mousedown, Escape that
 * stops before App's global handler - see `topbar-popover-dismiss.test.ts`), and adds
 * focus restoration to the trigger on Escape, since unlike those three this trigger is
 * a first-class keyboard stop in the pulse.
 */

/** The dropdown's visible copy, shared with the render test so the two cannot drift. */
export const KEEP_AWAKE_COPY = {
  title: "Keep awake",
  sub: "Keep this Mac awake",
  lock: "The screen can dim and lock normally. Prevents idle sleep.",
  lid: "Lid close and manual Sleep still work. Uses more battery power.",
  lifecycle: "On until Mission Control quits or restarts.",
  reconnecting: "Mission Control is reconnecting - the switch is disabled until the live state returns.",
} as const;

/**
 * The trigger's accessible name. Stateful so a screen reader hears what the purple dot
 * says, and exported for the render test.
 */
export function keepAwakeTriggerName(connected: boolean, status: KeepAwakeStatus | null): string {
  if (!connected) return "Keep awake - Mission Control is reconnecting";
  if (status == null) return "Keep awake - state unknown";
  if (!status.supported) return "Keep awake - unavailable on this system";
  switch (status.state) {
    case "on":
      return "Keep awake - on";
    case "error":
      return "Keep awake - failed";
    case "starting":
    case "stopping":
      return "Keep awake - switching";
    case "off":
      return "Keep awake - off";
  }
}

export function KeepAwakeControl({
  connected,
  status,
}: {
  connected: boolean;
  status: KeepAwakeStatus | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  /** A PUT in flight. Renders as pending, never as the requested end state. */
  const [pending, setPending] = useState(false);
  /** The last write's refusal, shown inline until the next attempt or dismissal. */
  const [writeError, setWriteError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (open && e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        // Escape is a keyboard dismissal, so the keyboard must land somewhere real:
        // back on the trigger, the way a dialog returns focus to its opener. The
        // outside-click path deliberately does not do this - it would steal focus
        // from whatever the pointer just chose.
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const busy = pending || status?.state === "starting" || status?.state === "stopping";
  const mode = !connected
    ? ""
    : status?.state === "on"
      ? " is-awake"
      : status?.state === "error"
        ? " is-awake-failed"
        : busy
          ? " is-awake-pending"
          : "";
  const label = !connected
    ? "reconnecting"
    : status?.state === "on"
      ? "live · awake"
      : status?.state === "error"
        ? "live · awake failed"
        : "live";

  const toggle = async (): Promise<void> => {
    if (!connected || status == null || !status.supported || busy) return;
    const want = status.state !== "on";
    setPending(true);
    setWriteError(null);
    const result = await setKeepAwake(want);
    setPending(false);
    // The SSE frame is what flips the switch; the response only has to carry a refusal.
    if (!result.ok) setWriteError(result.error);
  };

  return (
    <div className="ka-wrap" ref={ref}>
      <Tooltip
        label={
          connected
            ? "Live - these figures are streaming from the daemon. Open the Keep awake menu"
            : "Reconnecting to the daemon - these figures may be stale"
        }
      >
        <button
          type="button"
          ref={triggerRef}
          className={`pulse-seg pulse-link${mode}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={keepAwakeTriggerName(connected, status)}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="pulse-dot" aria-hidden />
          <span className="pulse-link-label">{label}</span>
        </button>
      </Tooltip>
      {open && (
        <KeepAwakePanel
          connected={connected}
          status={status}
          pending={pending}
          writeError={writeError}
          onToggle={() => void toggle()}
        />
      )}
    </div>
  );
}

/**
 * The dropdown: the indicator opening to explain itself. Presentational and fully driven
 * by props, so every state - off, on, pending, unavailable, reconnecting, failed - can be
 * rendered and asserted with `renderToStaticMarkup`, no DOM and no popover to open first.
 */
export function KeepAwakePanel({
  connected,
  status,
  pending,
  writeError,
  onToggle,
}: {
  connected: boolean;
  status: KeepAwakeStatus | null;
  pending: boolean;
  writeError: string | null;
  onToggle: () => void;
}): React.JSX.Element {
  const on = connected && status?.state === "on";
  const failed = connected && status?.state === "error";
  const unavailable = connected && status != null && !status.supported;
  const unknown = !connected || status == null;
  const busy = pending || status?.state === "starting" || status?.state === "stopping";
  return (
    <div
      className="ka-pop"
      role="dialog"
      aria-label="Keep awake"
      data-state={on ? "on" : failed ? "failed" : "off"}
    >
      <div className="ka-head">
        <div className="ka-words">
          <span className="ka-title">{KEEP_AWAKE_COPY.title}</span>
          <span className="ka-sub">{KEEP_AWAKE_COPY.sub}</span>
        </div>
        <div className="ka-side">
          <span className="ka-reading">{busy ? "…" : on ? "On" : failed ? "Failed" : "Off"}</span>
          {/* ONE short line, for the reason SpendChip's tooltip is one line: this close to
              the viewport top the bubble opens DOWNWARD, over the panel's own copy - which
              already carries the full explanation this tooltip must not repeat. */}
          <Tooltip label="Prevent idle system sleep - on until Mission Control quits or restarts">
            <button
              type="button"
              role="switch"
              className="ka-switch"
              aria-checked={on}
              aria-label={KEEP_AWAKE_COPY.sub}
              disabled={unknown || unavailable || busy}
              onClick={onToggle}
            >
              <span className="ka-knob" aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="ka-body">
        <p>{KEEP_AWAKE_COPY.lock}</p>
        <p>{KEEP_AWAKE_COPY.lid}</p>
        <p className="ka-life">{KEEP_AWAKE_COPY.lifecycle}</p>
        {!connected && (
          <p className="ka-note is-warn" role="status">
            {KEEP_AWAKE_COPY.reconnecting}
          </p>
        )}
        {unavailable && (
          <p className="ka-note is-warn">
            {status.unavailableReason ?? "Keep awake is unavailable on this system."}
          </p>
        )}
        {failed && (
          <p className="ka-note is-error" role="status">
            Keep awake failed{status?.error ? ` - ${status.error}` : ""}. The switch retries it.
          </p>
        )}
        {writeError && connected && !failed && (
          <p className="ka-note is-error" role="status">
            {writeError}
          </p>
        )}
      </div>
    </div>
  );
}
