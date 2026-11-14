import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { sessionCount, useFleetPause } from "../lib/fleet-pause.ts";
import { PauseGlyph } from "./PauseControls.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Pause all, in the title bar, and the banner that says what it did (issue #1471).
 *
 * The button is glyph-only so it costs the bar what its glyph neighbours cost at every width:
 * the count and the state live on it, the explanation lives in the banner under the bar.
 * Pressing it opens a confirm rather than acting, because it stops every agent at once and
 * the two choices that matter - hold automatic launches, resume in the morning - are made
 * there or not at all.
 */

/** Hours from now an operator can pick for the automatic resume. */
const RESUME_CHOICES: readonly { id: string; label: string; at: (now: Date) => number | null }[] = [
  { id: "never", label: "Not automatically", at: () => null },
  { id: "1h", label: "In 1 hour", at: (now) => now.getTime() + 60 * 60 * 1000 },
  { id: "4h", label: "In 4 hours", at: (now) => now.getTime() + 4 * 60 * 60 * 1000 },
  {
    id: "morning",
    label: "Tomorrow at 8:00 am",
    at: (now) => {
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(8, 0, 0, 0);
      return next.getTime();
    },
  },
];

export function FleetPauseControl(): React.JSX.Element {
  const fleet = useFleetPause();
  const [open, setOpen] = useState(false);
  const [holdDispatch, setHoldDispatch] = useState(true);
  const [resumeChoice, setResumeChoice] = useState("never");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Opened: put the keyboard inside, as the Residents dock does, so the confirm can be worked
  // without a pointer. After the render that mounted it, the first moment it has a control.
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>("input, select, button:not(:disabled)")?.focus();
  }, [open]);

  // The other topbar popovers' dismissal, exactly: not an overlay, so it closes itself on an
  // outside press and on Escape, and stops that Escape before App's global handler moves the
  // selection behind it.
  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (open && e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
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

  const paused = fleet.state.fleet !== null;
  const priority = fleet.state.priority !== null;

  async function act(run: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await run();
    setBusy(false);
    if (!result.ok) setError(result.error ?? "Mission Control could not change the pause");
    else setOpen(false);
  }

  if (paused || priority) {
    const label = paused
      ? `Resume all - ${sessionCount(fleet.pausedForFleet)} paused with everything else`
      : `End priority - resume the ${sessionCount(fleet.pausedForPriority)} paused for it`;
    return (
      // In the same wrapper as the resting button, so the title bar's last rung sheds either one.
      <div className="fleet-pause-wrap">
        <Tooltip label={error ?? label}>
          <button
            type="button"
            className={`ghost-btn glyph-btn fleet-pause-btn ${paused ? "is-paused" : "is-priority"}`}
            aria-label={label}
            disabled={busy}
            onClick={() => void act(paused ? api.resumeFleet : api.endPriority)}
          >
            <PauseGlyph kind={paused ? "resume-all" : "star"} size={11} />
            <span className="fleet-pause-count">{paused ? fleet.pausedForFleet : fleet.pausedForPriority}</span>
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="fleet-pause-wrap" ref={ref}>
      <Tooltip label="Pause all - freeze every running agent">
        <button
          type="button"
          ref={triggerRef}
          className="ghost-btn glyph-btn fleet-pause-btn"
          aria-label="Pause all"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <PauseGlyph kind="pause" size={11} />
        </button>
      </Tooltip>
      {open && (
        <div
          ref={popRef}
          className="fleet-pause-pop"
          role="dialog"
          aria-label="Pause all"
          // Tab walks the confirm's own controls. Stopped here because App's window handler
          // otherwise takes Tab to walk the console reader whenever a session is open, and the
          // confirm's buttons are not text fields its typing guard would leave alone.
          onKeyDown={(e) => {
            if (e.key === "Tab") e.stopPropagation();
          }}
        >
          <span className="fleet-pause-title">Pause all {sessionCount(fleet.pausable)}</span>
          <p className="fleet-pause-sub">
            Every agent freezes where it is and its network goes quiet. Nothing is lost: each resumes exactly where
            it stopped. Sessions you paused yourself stay paused when this lifts.
          </p>
          {fleet.holdOnly > 0 && (
            // Said before the confirm, not after: a person pausing to free bandwidth decides on it.
            <p className="fleet-pause-sub fleet-pause-hold-note">
              {fleet.holdOnly === fleet.pausable ? "All of them run" : `${sessionCount(fleet.holdOnly)} of them ${fleet.holdOnly === 1 ? "runs" : "run"}`}{" "}
              inside Mission Control, so {fleet.holdOnly === 1 ? "it is" : "they are"} held instead: each finishes its current
              turn, using the network until it does, and then starts nothing new.
            </p>
          )}
          <label className="fleet-pause-check">
            <Tooltip label={holdDispatch ? "Let the backlog autopilot keep launching while paused" : "Hold every automatic launch until you resume"}>
              <input type="checkbox" checked={holdDispatch} onChange={(e) => setHoldDispatch(e.target.checked)} />
            </Tooltip>
            <span>
              Hold automatic launches too
              <small>The backlog autopilot starts nothing new until you resume.</small>
            </span>
          </label>
          <label className="fleet-pause-field">
            <span>Resume automatically</span>
            <Tooltip label="When Mission Control resumes what this pauses, without you">
              <select value={resumeChoice} onChange={(e) => setResumeChoice(e.target.value)} aria-label="Resume automatically">
                {RESUME_CHOICES.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </Tooltip>
          </label>
          {error && (
            <p className="fleet-pause-error" role="alert">
              {error}
            </p>
          )}
          <div className="fleet-pause-actions">
            <Tooltip label="Close without pausing anything">
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </Tooltip>
            <Tooltip label="Freeze every running agent now">
              <button
                type="button"
                className="btn fleet-pause-confirm"
                disabled={busy || fleet.pausable === 0}
                onClick={() =>
                  void act(() =>
                    api.pauseFleet({
                      holdDispatch,
                      resumeAt: RESUME_CHOICES.find((c) => c.id === resumeChoice)?.at(new Date()) ?? null,
                    }),
                  )
                }
              >
                <PauseGlyph kind="pause" size={10} /> Pause {sessionCount(fleet.pausable)}
              </button>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
}

/** The band under the title bar while Pause all or priority stands. Draws nothing otherwise. */
export function FleetPauseBanner(): React.JSX.Element | null {
  const fleet = useFleetPause();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { fleet: pause, priority } = fleet.state;
  if (!pause && !priority) return null;

  async function act(run: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await run();
    setBusy(false);
    if (!result.ok) setError(result.error ?? "Mission Control could not change the pause");
  }

  if (pause) {
    const since = new Date(pause.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const until = pause.resumeAt
      ? ` Resumes automatically at ${new Date(pause.resumeAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`
      : "";
    // Only what is actually frozen is called frozen. A session held but still running - a
    // process refused to stop - turns the banner into a partial one that names how many, because
    // the person who paused to free the network needs to know an agent is still using it.
    const running = fleet.pausedForFleet - fleet.frozenForFleet;
    const label = running > 0 ? "Paused, but not everything is frozen" : "Everything is paused";
    return (
      <div className={`app-banner fleet-pause-banner${running > 0 ? " is-partial" : ""}`} role="status" aria-label={label}>
        <PauseGlyph kind="pause" size={12} />
        <span className="fleet-pause-banner-lead">{label}</span>
        <span className="fleet-pause-banner-sub">
          since {since}. {sessionCount(fleet.frozenForFleet)} frozen
          {running > 0 ? `, ${sessionCount(running)} held but still running` : ""}
          {pause.holdDispatch ? ", and automatic launches are held" : ""}.
          {until}
        </span>
        {error && <span className="fleet-pause-error" role="alert">{error}</span>}
        <Tooltip label="Resume every session Pause all paused">
          <button type="button" className="btn fleet-pause-confirm" disabled={busy} onClick={() => void act(api.resumeFleet)}>
            <PauseGlyph kind="resume-all" size={10} /> Resume all now
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="app-banner fleet-pause-banner is-priority" role="status" aria-label="Priority session">
      <PauseGlyph kind="star" size={12} />
      <span className="fleet-pause-banner-lead">Priority{fleet.priorityName ? `: ${fleet.priorityName}` : " session"}</span>
      <span className="fleet-pause-banner-sub">
        {sessionCount(fleet.frozenForPriority)} frozen so it has the machine and the network
        {fleet.pausedForPriority > fleet.frozenForPriority
          ? `, ${sessionCount(fleet.pausedForPriority - fleet.frozenForPriority)} held but still running`
          : ""}
        . Ending priority resumes those, not sessions you paused yourself.
      </span>
      {error && <span className="fleet-pause-error" role="alert">{error}</span>}
      <Tooltip label="End priority and resume the sessions it paused">
        <button type="button" className="btn fleet-pause-confirm is-priority" disabled={busy} onClick={() => void act(api.endPriority)}>
          End priority · resume {fleet.pausedForPriority}
        </button>
      </Tooltip>
    </div>
  );
}
