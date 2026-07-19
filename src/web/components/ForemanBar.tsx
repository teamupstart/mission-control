import { useEffect, useRef, useState } from "react";
import { wrapupTriggerOn } from "@shared/queue.ts";
import type { WrapupTrigger } from "@shared/queue.ts";
import type { ForemanState } from "../useForeman.ts";

// Topbar control for Foreman, the auto-responder. Shows whether it's off /
// drafting (dry-run) / acting (live), how deep its queue is, and whether the
// worker is running; the popover flips the in-the-moment knobs - the mode, the
// access-approval switch, the work queues, and the wrap-up triggers + action. The
// set-once posture (cheap tier - off / shadow / on, see docs/plans/foreman-watcher/plan.md -
// and the live repo allowlist) lives in Settings → Foreman, which the popover
// deep-links. Mirrors AlertBar's popover pattern.

const MODE_LABEL: Record<string, string> = {
  "dry-run": "dry-run",
  "semi-auto": "semi-auto",
  live: "live",
};

/**
 * Add or remove one wrap-up trigger, preserving the rest.
 *
 * Filter-then-append rather than a toggle on the existing array, so the result is
 * order-stable and free of duplicates no matter what the server last stored - the
 * config is a plain persisted array, and a patch that appended blindly would grow
 * `["drain","drain"]` on a double-click round trip.
 */
function toggleTrigger(
  current: readonly WrapupTrigger[],
  which: WrapupTrigger,
  on: boolean,
): WrapupTrigger[] {
  const rest = current.filter((t) => t !== which);
  return on ? [...rest, which] : rest;
}

/**
 * A bounded number setting that commits on BLUR, not per keystroke.
 *
 * Typing "50" over "3" passes through "5" on the way - a valid value - so a
 * per-keystroke commit silently persists a setting the human never chose, then
 * sends the rejected one. Nor do HTML min/max constrain typed input, and an emptied
 * field reads as `Number("") === 0`, which the schema refuses. So: hold the text
 * locally, send only a value that is actually in range, and otherwise snap back to
 * what's in force rather than firing a patch we know the server will refuse.
 */
function NumberSetting({
  value,
  min,
  max,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit: (n: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value));

  // Follow the setting whenever it actually moves - a commit landing, a rejected
  // edit reverting, another tab changing it. Keyed on `value` alone, so a poll that
  // returns the same number doesn't fire and typing is never yanked out from under.
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit(): void {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < min || n > max) return setDraft(String(value));
    if (n !== value) onCommit(n);
  }

  return (
    <label className="alert-row">
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {label}
    </label>
  );
}

export function ForemanBar({
  state,
  onOpenSettings,
}: {
  state: ForemanState;
  /** Open Settings on the Foreman category, where the cheap tier and the trusted-repo
   *  list now live. The popover keeps only the in-the-moment knobs. */
  onOpenSettings: () => void;
}): React.JSX.Element {
  const { config, status } = state;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const enabled = config?.enabled ?? false;
  const mode = config?.mode ?? "dry-run";
  const chip = !enabled ? "off" : MODE_LABEL[mode] ?? mode;
  const running = status?.running ?? false;
  const queue = status?.queueDepth ?? 0;

  return (
    <div className="foremanbar" ref={ref}>
      <button
        className={`ghost-btn foreman-btn${enabled ? " on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Foreman - the auto-responder"
      >
        <span
          className={`foreman-dot${enabled && running ? " live" : ""}`}
          aria-hidden
          title={running ? "worker running" : "worker not running"}
        />
        Foreman
        <span className="foreman-chip">{chip}</span>
        {enabled && queue > 0 && <span className="ghost-badge">{queue}</span>}
      </button>

      {open && (
        <ForemanPopover
          state={state}
          onOpenSettings={() => {
            setOpen(false);
            onOpenSettings();
          }}
        />
      )}
    </div>
  );
}

/**
 * The Foreman settings popover body. Split from the trigger button so it can be rendered
 * on its own in a test: the SSE stream behind the live app hangs headless automation, so
 * structure (which knobs are here, which moved to Settings) is asserted from static markup
 * rather than a driven click. Renders nothing until the first config poll lands.
 */
export function ForemanPopover({
  state,
  onOpenSettings,
}: {
  state: ForemanState;
  onOpenSettings: () => void;
}): React.JSX.Element | null {
  const { config, status, update, error } = state;
  if (!config) return null;
  const { enabled, mode, wrapup } = config;
  const triggers = config.wrapupTriggers;
  const running = status?.running ?? false;

  return (
    <div className="alert-pop foreman-pop" role="dialog" aria-label="Foreman settings">
      <label className="alert-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void update({ enabled: e.target.checked })}
        />
        Enable Foreman
      </label>

      <fieldset className="foreman-modes" disabled={!enabled}>
        <legend>Mode</legend>
        {(["dry-run", "semi-auto", "live"] as const).map((m) => (
          <label className="alert-row" key={m}>
            <input
              type="radio"
              name="foreman-mode"
              checked={mode === m}
              onChange={() => void update({ mode: m })}
            />
            {m === "dry-run" && "Dry-run - draft only, never send"}
            {m === "semi-auto" && "Semi-auto - draft + one-click send"}
            {m === "live" && "Live - send on my behalf"}
          </label>
        ))}
      </fieldset>

      <label className="alert-row">
        <input
          type="checkbox"
          checked={config.autoApproveAccess}
          disabled={!enabled}
          onChange={(e) => void update({ autoApproveAccess: e.target.checked })}
        />
        Auto-approve non-destructive access
      </label>

      {/*
        The queue's two policy knobs. Timings (settle, pickup, lease) are
        deliberately module constants with env overrides - these are the only
        two a human should actually reason about.
      */}
      <fieldset className="foreman-knobs" disabled={!enabled}>
        <legend>Work queues</legend>
        <NumberSetting
          value={config.maxFixAttempts}
          min={1}
          max={10}
          label="Fix attempts per issue before escalating"
          onCommit={(n) => void update({ maxFixAttempts: n })}
        />
        <NumberSetting
          value={config.maxFixRounds}
          min={1}
          max={50}
          label="Max fix rounds per item"
          onCommit={(n) => void update({ maxFixRounds: n })}
        />
      </fieldset>

      {/*
        WHEN a wrap-up fires, then WHAT it does. Two fieldsets rather than one because
        they are two independent choices - any number of triggers, exactly one action -
        and a single group would imply the radios belong to whichever box was last
        ticked. The action group is nested and dimmed while nothing is armed, so the
        subordination reads visually: with no trigger, there is no moment for an action
        to happen at, and the radios genuinely do nothing.

        Unlike every other knob here, the two automated actions make Foreman TYPE
        something that pushes - so they are gated on live + allowlist in the machine,
        and the hint says so out loud rather than letting a selected radio quietly do
        nothing.
      */}
      <fieldset className="foreman-modes" disabled={!enabled}>
        <legend>Trigger on</legend>
        {(["drain", "prompted"] as const).map((t) => (
          <label className="alert-row" key={t}>
            <input
              type="checkbox"
              checked={wrapupTriggerOn(triggers, t)}
              onChange={(e) => void update({ wrapupTriggers: toggleTrigger(triggers, t, e.target.checked) })}
            />
            {t === "drain" && "Queue drain - every queued item finished"}
            {t === "prompted" && "Prompted work complete - you asked, the agent finished"}
          </label>
        ))}
        {enabled && wrapupTriggerOn(triggers, "prompted") && (
          <p className="alert-hint dim">Verified against your prompt before it acts.</p>
        )}

        <fieldset className="foreman-wrapup-action" disabled={triggers.length === 0}>
          <legend>Then</legend>
          {(["ask", "no-mistakes", "pr"] as const).map((w) => (
            <label className="alert-row" key={w}>
              <input
                type="radio"
                name="foreman-wrapup"
                checked={wrapup === w}
                onChange={() => void update({ wrapup: w })}
              />
              {w === "ask" && "Ask me - show the Ship it? card"}
              {w === "no-mistakes" && "Run /no-mistakes automatically"}
              {w === "pr" && "Straight to PR - commit, push, open a PR"}
            </label>
          ))}
        </fieldset>

        {enabled && triggers.length === 0 && (
          <p className="alert-hint dim">
            No triggers - Foreman never wraps up on its own. Ship your work yourself.
          </p>
        )}
        {enabled && triggers.length > 0 && wrapup !== "ask" && mode !== "live" && (
          <p className="alert-hint dim">
            Only fires in Live mode on an allowlisted repo - until then Foreman asks.
          </p>
        )}
      </fieldset>

      {/*
        The trusted-repo list moved to Settings → Foreman (a picker, not a paste box).
        Live mode still needs the at-a-glance "am I actually acting here", so it keeps a
        read-only count that deep-links to where you edit it - not an editor itself.
      */}
      {mode === "live" && (
        <button
          type="button"
          className={`foreman-live-repos${enabled ? "" : " is-off"}`}
          onClick={onOpenSettings}
        >
          {config.repoAllowlist.length === 0
            ? "Live, but no repos trusted yet - add them in Settings →"
            : `Live in ${config.repoAllowlist.length} repo${
                config.repoAllowlist.length === 1 ? "" : "s"
              } · manage in Settings →`}
        </button>
      )}

      {error && <p className="foreman-error">{error}</p>}

      <p className="alert-hint">
        {running ? "Worker running." : "Worker not running - start it with "}
        {!running && <code>npm run foreman</code>}
        {status &&
          ` ${status.counts.answered} answered · ${status.counts.escalated} escalated · ${status.counts.pending} drafts`}
      </p>
    </div>
  );
}
