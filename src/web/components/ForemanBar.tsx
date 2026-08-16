import { useEffect, useRef, useState } from "react";
import { wrapupTriggerOn } from "@shared/queue.ts";
import type { WrapupTrigger } from "@shared/queue.ts";
import type { ForemanState } from "../useForeman.ts";
import { api } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

// Topbar control for Foreman, the auto-responder. Shows whether it's off /
// drafting (dry-run) / acting (live), how deep its queue is, and whether the
// worker is running; the popover flips the in-the-moment knobs - the mode, the
// access-approval switch, the work queues, and the wrap-up triggers + action. The
// set-once posture (cheap tier - off / shadow / on, completion safeguards, see
// docs/plans/foreman-watcher/plan.md - and the live repo allowlist) lives in
// Settings → Foreman, which the popover deep-links. Mirrors AlertBar's popover pattern.

const MODE_LABEL: Record<string, string> = {
  "dry-run": "dry-run",
  "semi-auto": "semi-auto",
  live: "live",
};

/* What each radio actually commits you to, spelled out for its tooltip. The row's own
   text is the short form; these are the consequence, which is what you want on hover. */
const MODE_HINT: Record<"dry-run" | "semi-auto" | "live", string> = {
  "dry-run": "Foreman drafts a reply and shows it to you. It never types into a pane.",
  "semi-auto": "Foreman drafts a reply and waits for your click before sending it.",
  live: "Foreman sends on your behalf, in the repos you have trusted.",
};

const WRAPUP_HINT: Record<"ask" | "pr", string> = {
  ask: "Show the Ship it? card and let you choose what happens next",
  pr: "When no Workflow is bound, commit, push, open a PR, then wait for green CI",
};

function plannerRetryCopy(nextRetryAt: number | null, now = Date.now()): string {
  if (nextRetryAt === null || nextRetryAt <= now) return "Retry is ready now";
  const seconds = Math.ceil((nextRetryAt - now) / 1000);
  if (seconds < 60) return `Automatic retry in ${seconds}s`;
  return `Automatic retry in ${Math.ceil(seconds / 60)}m`;
}

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
 * The value a number field should commit for `draft`, or `null` when it must not: empty
 * (`Number("") === 0`), non-integer, out of range, or unchanged. Every NumberSetting write
 * passes this one gate, so "never persist a half-typed or refused value" is decided in a
 * single tested place rather than re-derived at each call. Test: `foreman-number-setting.test.ts`.
 */
export function pendingCommit(draft: string, value: number, min: number, max: number): number | null {
  // Guard the empty string BEFORE `Number("") === 0`: with auto-save on, an emptied field
  // that coerced to 0 would silently persist 0 the instant the debounce fired - and where
  // 0 is a legal value (the Shipping soak window's "no soak"), clearing to retype would
  // disarm the setting rather than wait for a real number. Blur reverts it instead.
  if (draft.trim() === "") return null;
  const n = Number(draft);
  if (!Number.isInteger(n) || n < min || n > max || n === value) return null;
  return n;
}

export interface NumberFieldSaver {
  /** A draft changed. Arm a debounced commit of it - or disarm, if it is not committable. */
  edit: (draft: string, value: number, min: number, max: number) => void;
  cancel: () => void;
  /** Commit the armed value NOW (blur, Enter, unmount) and cancel the debounce. No-op when
   *  nothing is armed, so an idle blur or an unmount after a settled edit sends nothing. */
  flush: () => void;
}

/**
 * The debounce-and-flush half of a number field's auto-save, pulled out of the component so
 * the timing is deterministic and testable WITHOUT a DOM - the reason the popover's fields
 * can be trusted to save on their own. A change arms a single delayed write (`edit`); another
 * change before it fires resets the timer, so a multi-digit entry is one write of the final
 * value, not one per keystroke. `flush` commits whatever is armed at once, which is what lets
 * blur, Enter and - the bug this fixes - closing the popover mid-edit all persist the change
 * instead of dropping it. The timer is injectable so a test can advance it by hand.
 */
export function createNumberFieldSaver(
  onCommit: (n: number) => void,
  options: {
    delayMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): NumberFieldSaver {
  const delayMs = options.delayMs ?? 400;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let handle: unknown = null;
  let armed: number | null = null;

  function disarm(): void {
    if (handle !== null) clearTimer(handle);
    handle = null;
    armed = null;
  }

  return {
    edit(draft, value, min, max) {
      disarm();
      armed = pendingCommit(draft, value, min, max);
      if (armed === null) return;
      handle = setTimer(() => {
        const n = armed;
        handle = null;
        armed = null;
        if (n !== null) onCommit(n);
      }, delayMs);
    },
    cancel() {
      disarm();
    },
    flush() {
      const n = armed;
      disarm();
      if (n !== null) onCommit(n);
    },
  };
}

/**
 * A bounded number setting that AUTO-SAVES a valid change - debounced, and also on blur and
 * on unmount - so Enter is never required, while never persisting a value the human did not
 * choose.
 *
 * Typing "50" over "3" passes through "5" on the way - a valid value - so a
 * per-keystroke commit silently persists a setting the human never chose, then
 * sends the rejected one. Nor do HTML min/max constrain typed input, and an emptied
 * field reads as `Number("") === 0`, which the schema refuses. So: hold the text
 * locally, send only a value that is actually in range, and otherwise snap back to
 * what's in force rather than firing a patch we know the server will refuse.
 *
 * Exported because the Shipping panel's soak window needs exactly this, and needs it
 * MORE: there, `Number("") === 0` is not a value the schema refuses but a legal one
 * meaning "no soak at all", so clearing the field to retype would quietly disarm the
 * safety valve rather than fail loudly. One implementation, so that stays impossible.
 */
export function NumberSetting({
  value,
  min,
  max,
  label,
  disabled = false,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  /** Pre-poll, when the panel has no answer from the daemon to edit. */
  disabled?: boolean;
  onCommit: (n: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value));

  // One auto-save controller for the life of the field. `onCommit` is a fresh closure each
  // parent render, so the saver (created once) reaches it through a ref rather than capturing
  // a stale one. `edit` debounces a change; `flush` commits the pending value now.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const saverRef = useRef<NumberFieldSaver | null>(null);
  const saver = saverRef.current ?? (saverRef.current = createNumberFieldSaver((n) => onCommitRef.current(n)));

  // Follow the setting whenever it actually moves - a commit landing, a rejected
  // edit reverting, another tab changing it. Keyed on `value` alone, so a poll that
  // returns the same number doesn't fire and typing is never yanked out from under.
  useEffect(() => {
    saver.cancel();
    setDraft(String(value));
  }, [saver, value]);

  const legal = draft.trim() !== "" && Number.isInteger(Number(draft)) &&
    Number(draft) >= min && Number(draft) <= max;

  // Closing the popover unmounts this field and kills the debounce timer, so flush the
  // pending edit on the way out - a change made and immediately dismissed was the "you have
  // to press Enter to save it" bug.
  useEffect(() => () => saver.flush(), [saver]);

  return (
    <label className="alert-row">
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          saver.edit(e.target.value, value, min, max);
        }}
        onBlur={() => {
          saver.flush();
          if (!legal) setDraft(String(value));
        }}
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
  /** Open Settings on the Foreman category, where the cheap tier, completion safeguards,
   *  and trusted-repo list now live. The popover keeps only the in-the-moment knobs. */
  onOpenSettings: () => void;
}): React.JSX.Element {
  const { config, status } = state;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    // Escape closes the popover the same way a click outside does. It stops there rather
    // than bubbling to App's global Escape, which would ALSO collapse the expanded card or
    // drop the fleet selection behind it - this popover is not a registered overlay, so
    // nothing else knows to swallow the key on its behalf.
    function onKey(e: KeyboardEvent): void {
      if (open && e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const enabled = config?.enabled ?? false;
  const mode = config?.mode ?? "dry-run";
  const chip = !enabled ? "off" : MODE_LABEL[mode] ?? mode;
  const running = status?.running ?? false;
  const queue = status?.queueDepth ?? 0;

  return (
    <div className="foremanbar" ref={ref}>
      <Tooltip label={`Foreman - the auto-responder (${enabled ? chip : "off"})`}>
        <button
          className={`ghost-btn foreman-btn${enabled ? " on" : ""}`}
          onClick={() => setOpen((o) => !o)}
          // Named explicitly because the word below is a `.tb-label`, which the topbar's
          // narrow ladder takes away: the dot and the mode chip survive the collapse, the
          // accessible name has to survive it too.
          aria-label={`Foreman - the auto-responder (${enabled ? chip : "off"})`}
        >
          <span className={`foreman-dot${enabled && running ? " live" : ""}`} aria-hidden />
          <span className="tb-label">Foreman</span>
          <span className="foreman-chip">{chip}</span>
          {enabled && queue > 0 && <span className="ghost-badge">{queue}</span>}
        </button>
      </Tooltip>

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
  const planner = status?.planner;
  const [plannerRetry, setPlannerRetry] = useState<"idle" | "requesting" | "requested" | "failed">("idle");
  const requestedPlannerBasis = useRef<string | null>(null);
  const plannerBasis = planner
    ? [planner.state, planner.runner, planner.model, planner.failureCount, planner.lastError].join("\n")
    : "";

  useEffect(() => {
    if (
      plannerRetry === "requested" &&
      requestedPlannerBasis.current !== null &&
      plannerBasis !== requestedPlannerBasis.current
    ) {
      requestedPlannerBasis.current = null;
      setPlannerRetry("idle");
    }
  }, [plannerBasis, plannerRetry]);

  async function retryPlanner(): Promise<void> {
    setPlannerRetry("requesting");
    const result = await api.retryForemanPlanner();
    if (result.ok) requestedPlannerBasis.current = plannerBasis;
    setPlannerRetry(result.ok ? "requested" : "failed");
  }

  if (!config) return null;
  const { enabled, mode, wrapup } = config;
  const triggers = config.wrapupTriggers;
  const running = status?.running ?? false;

  return (
    <div className="alert-pop foreman-pop" role="dialog" aria-label="Foreman settings">
      <Tooltip label="Let Foreman watch sessions and answer them for you">
        <label className="alert-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void update({ enabled: e.target.checked })}
          />
          Enable Foreman
        </label>
      </Tooltip>

      <fieldset className="foreman-modes" disabled={!enabled}>
        <legend>Mode</legend>
        {(["dry-run", "semi-auto", "live"] as const).map((m) => (
          <Tooltip label={MODE_HINT[m]} key={m}>
            <label className="alert-row">
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
          </Tooltip>
        ))}
      </fieldset>

      <Tooltip label="Let Foreman clear read-only permission prompts without asking you">
        <label className="alert-row">
          <input
            type="checkbox"
            checked={config.autoApproveAccess}
            disabled={!enabled}
            onChange={(e) => void update({ autoApproveAccess: e.target.checked })}
          />
          Auto-approve non-destructive access
        </label>
      </Tooltip>

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
        The backlog autopilot: Foreman scheduling the fleet's backlog rather than one
        session's queue (docs/plans/backlog-autopilot/plan.md).

        Sits below the work-queue knobs because it is the same kind of knob one level
        up - and, like the automated wrap-up actions above it, it is gated on live +
        allowlist in the machine. The hint says so out loud rather than letting a ticked
        box quietly do nothing, and the readout below it answers the question a stalled
        backlog always raises: is it the ceiling, or is everything blocked?
      */}
      <fieldset className="foreman-knobs" disabled={!enabled}>
        <legend>Backlog</legend>
        <Tooltip label="Let Foreman hand backlog tasks to idle agents on its own">
          <label className="alert-row">
            <input
              type="checkbox"
              checked={config.autoBacklog}
              onChange={(e) => void update({ autoBacklog: e.target.checked })}
            />
            Auto-schedule the backlog
          </label>
        </Tooltip>
        <NumberSetting
          value={config.maxSessions}
          min={1}
          max={20}
          label="Max agents running at once"
          onCommit={(n) => void update({ maxSessions: n })}
        />
        {/*
          Nested under the autopilot switch because it only ever narrows what THAT does -
          the board's own drag-onto-an-agent gesture is unaffected either way, and a knob
          that looked like it governed both would be lying about the one place it applies.
        */}
        <Tooltip label="Hold an agent back from new work while its pull request is still open">
          <label className="alert-row">
          {/*
            `!== false`, not the value itself: a web build newer than the daemon it is
            talking to gets no such key, and `undefined` would render an unticked box over
            a server that is applying the guard. That is the one wrong answer this control
            must not give - it would send someone hunting for why an agent is not being
            picked up while the panel swears the guard is off. The daemon parses through
            the schema, so the field is only ever absent, never false-by-omission.
          */}
            <input
              type="checkbox"
              checked={config.backlogRespectOpenPrs !== false}
              onChange={(e) => void update({ backlogRespectOpenPrs: e.target.checked })}
            />
            Open PRs keep an idle agent off the backlog
          </label>
        </Tooltip>
        {enabled && config.autoBacklog && config.backlogRespectOpenPrs === false && (
          <p className="alert-hint dim">
            An agent whose PR is still open can be handed the next task - its checkout is
            reset to the default branch first, so the PR is left where it is.
          </p>
        )}
        {enabled && config.autoBacklog && status && (
          <p className="alert-hint dim">
            {status.autopilot.active}/{status.autopilot.max} agents ·{" "}
            {status.autopilot.ready} ready
            {status.autopilot.blocked > 0 && ` · ${status.autopilot.blocked} blocked`}
            {/* Reported separately from `blocked`, and only when there are some: an
                autopilot with nothing to do reads as broken unless the line can say
                that the items it can see were switched off deliberately. */}
            {status.autopilot.disabled > 0 && ` · ${status.autopilot.disabled} disabled`}
          </p>
        )}
        {enabled && config.autoBacklog && planner && (
          <div
            className={`foreman-planner-health is-${planner.state}`}
            role="status"
            aria-label="Backlog dependency planner health"
          >
            <div className="foreman-planner-head">
              <span className="foreman-planner-pulse" aria-hidden />
              <strong>Dependency planner</strong>
              <span>{planner.state}</span>
            </div>
            <p className="foreman-planner-runtime">
              {planner.runner} · <code>{planner.model}</code>
              {planner.failureCount > 0 && ` · ${planner.failureCount} failures`}
            </p>
            {planner.lastError && (
              <p className="foreman-planner-error">{planner.lastError}</p>
            )}
            {planner.state === "degraded" && (
              <div className="foreman-planner-recovery">
                <span>{plannerRetryCopy(planner.nextRetryAt)}</span>
                <Tooltip label="Ask the dependency planner to try again immediately">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={plannerRetry === "requesting" || plannerRetry === "requested"}
                    onClick={() => void retryPlanner()}
                  >
                    {plannerRetry === "requesting"
                      ? "Requesting…"
                      : plannerRetry === "requested"
                      ? "Retry requested"
                      : "Retry planner now"}
                  </button>
                </Tooltip>
              </div>
            )}
            {plannerRetry === "failed" && (
              <p className="foreman-planner-error">Could not request a retry. Try again.</p>
            )}
          </div>
        )}
        {enabled && config.autoBacklog && mode !== "live" && (
          <p className="alert-hint dim">
            Only launches in Live mode on an allowlisted repo - until then it just works out
            the order.
          </p>
        )}
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
          <Tooltip
            key={t}
            label={
              t === "drain"
                ? "Wrap up once every queued item has finished"
                : "Wrap up once the work you prompted for is verifiably done"
            }
          >
            <label className="alert-row">
              <input
                type="checkbox"
                checked={wrapupTriggerOn(triggers, t)}
                onChange={(e) => void update({ wrapupTriggers: toggleTrigger(triggers, t, e.target.checked) })}
              />
              {t === "drain" && "Queue drain - every queued item finished"}
              {t === "prompted" && "Prompted work complete - you asked, the agent finished"}
            </label>
          </Tooltip>
        ))}
        {enabled && wrapupTriggerOn(triggers, "prompted") && (
          <p className="alert-hint dim">Verified against your prompt before it acts.</p>
        )}

        <fieldset className="foreman-wrapup-action" disabled={triggers.length === 0}>
          <legend>Then</legend>
          {(["ask", "pr"] as const).map((w) => (
            <Tooltip label={WRAPUP_HINT[w]} key={w}>
              <label className="alert-row">
                <input
                  type="radio"
                  name="foreman-wrapup"
                  checked={wrapup === w}
                  onChange={() => void update({ wrapup: w })}
                />
                {w === "ask" && "Ask me - show the Ship it? card"}
                {w === "pr" && (
                  "Straight to PR - when no Workflow is bound, commit, push, open a PR, then green CI"
                )}
              </label>
            </Tooltip>
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
        What happens after a PR exists. Review comments and CI are separate permissions: an
        operator may automate either one without granting the other. Neither setting creates
        the PR. Like direct wrap-up, both only TYPE in live mode on an allowlisted repo.
      */}
      <fieldset className="foreman-modes" disabled={!enabled}>
        <legend>Pull requests</legend>
        <Tooltip label="Nudge a parked session back onto its open PR to resolve GitHub Inspector comments">
          <label className="alert-row">
            {/*
              `!== false`, not the value itself: a web build newer than the daemon it is
              talking to gets no such key, and `undefined` must render as on - the daemon
              defaults it to on, so an unticked box would swear the feature is off while it
              is running. Same reasoning as the backlog open-PR guard.
            */}
            <input
              type="checkbox"
              checked={config.trackReviewFeedback !== false}
              onChange={(e) => void update({ trackReviewFeedback: e.target.checked })}
            />
            Keep sessions on track with review comments
          </label>
        </Tooltip>
        <Tooltip label="Once a pull request exists, nudge its parked session to fix failing CI on the same branch">
          <label className="alert-row">
            <input
              type="checkbox"
              checked={config.trackCiFailures !== false}
              onChange={(e) => void update({ trackCiFailures: e.target.checked })}
            />
            Keep sessions on track with CI
          </label>
        </Tooltip>
        <p className="alert-hint dim">
          Does not create a PR. Once one exists, sends failing CI back to its session.
        </p>
        {enabled &&
          (config.trackReviewFeedback !== false || config.trackCiFailures !== false) &&
          mode !== "live" && (
            <p className="alert-hint dim">
              Only types in Live mode on an allowlisted repo - until then a parked PR is left
              for you.
            </p>
          )}
      </fieldset>

      {/*
        The trusted-repo list moved to Settings → Foreman (a picker, not a paste box).
        Live mode still needs the at-a-glance "am I actually acting here", so it keeps a
        read-only count that deep-links to where you edit it - not an editor itself.
      */}
      {mode === "live" && (
        <Tooltip label="Open Settings → Foreman to choose which repos Foreman may act in">
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
        </Tooltip>
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
