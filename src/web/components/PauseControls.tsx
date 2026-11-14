import { useState } from "react";
import { canPause, pauseAge, pauseFlagLabel, pauseFreezes, type SessionPauseMode } from "@shared/pause.ts";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { isPrioritySession, sessionCount, useFleetPause, type FleetPauseView } from "../lib/fleet-pause.ts";
import { useNow } from "../useNow.ts";
import { SessionToolbarMenu } from "./SessionToolbarMenu.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Every pause control the dashboard draws, as small leaves the card, the console and the
 * settings previews mount (issue #1471). Which of them appear is the operator's choice
 * (`lib/pause-controls.ts`); what they say and do is decided here, once, so the six
 * placements cannot drift on wording or on which action a click sends.
 */

type GlyphKind = "pause" | "play" | "star" | "star-outline" | "after-turn" | "resume-all";

export function PauseGlyph({ kind, size = 11 }: { kind: GlyphKind; size?: number }): React.JSX.Element {
  return (
    <svg className="pause-glyph" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      {kind === "pause" && (
        <>
          <rect x="2.4" y="1.8" width="2.5" height="8.4" rx=".7" fill="currentColor" />
          <rect x="7.1" y="1.8" width="2.5" height="8.4" rx=".7" fill="currentColor" />
        </>
      )}
      {kind === "play" && (
        <path d="M3.4 1.9v8.2a.55.55 0 0 0 .83.47l6.6-4.1a.55.55 0 0 0 0-.94l-6.6-4.1a.55.55 0 0 0-.83.47z" fill="currentColor" />
      )}
      {kind === "star" && (
        <path d="M6 .9l1.55 3.2 3.5.45-2.57 2.42.66 3.48L6 8.75l-3.14 1.7.66-3.48L.95 4.55l3.5-.45z" fill="currentColor" />
      )}
      {kind === "star-outline" && (
        <path
          d="M6 1.6l1.3 2.7 2.95.38-2.17 2.04.56 2.93L6 8.22l-2.64 1.43.56-2.93L1.75 4.68l2.95-.38z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      )}
      {kind === "after-turn" && (
        <>
          <path d="M1.5 6h5.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M5 3.4L7.6 6 5 8.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="8.6" y="2.4" width="1.6" height="7.2" rx=".5" fill="currentColor" />
        </>
      )}
      {kind === "resume-all" && <path d="M1.6 2.2v7.6l5-3.8zM6.4 2.2v7.6l5-3.8z" fill="currentColor" />}
    </svg>
  );
}

/** Where a session stands, as every control branches on it. */
type Standing = "running" | "pending" | "paused" | "priority";

function standing(session: Session, fleet: FleetPauseView): Standing {
  if (isPrioritySession(fleet, session.id)) return "priority";
  if (session.pause?.phase === "pending") return "pending";
  if (session.pause) return "paused";
  return "running";
}

type PauseAction =
  | { kind: "pause"; mode: SessionPauseMode }
  | { kind: "resume" }
  | { kind: "priority" }
  | { kind: "end-priority" };

/**
 * One action at a time, with the daemon's refusal kept to say. Every control routes through
 * this, so a failure reads the same wherever it was clicked.
 */
export function usePauseActions(session: Session): {
  busy: boolean;
  error: string | null;
  run: (action: PauseAction) => Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: PauseAction): Promise<boolean> {
    setBusy(true);
    setError(null);
    const result =
      action.kind === "pause" ? await api.pauseSession(session.id, action.mode)
        : action.kind === "resume" ? await api.resumeSession(session.id)
          : action.kind === "priority" ? await api.setPriority(session.id)
            : await api.endPriority();
    setBusy(false);
    if (!result.ok) setError(result.error ?? "Mission Control could not change this session's pause");
    return result.ok;
  }
  return { busy, error, run };
}

/** The sentence a paused session's tooltip and band say about itself. */
export function pausedSentence(session: Session, now: number): string {
  const pause = session.pause;
  if (!pause) return "";
  if (pause.phase === "pending") return "Pausing once this turn ends. Nothing new will start.";
  const why = pause.reason === "priority" ? "for the priority session"
    : pause.reason === "fleet" ? "with everything else"
      : "by you";
  const what = pause.interrupted ? ` while it was ${lowerFirst(pause.interrupted)}` : "";
  const when = now - pause.since < 60_000 ? "just now" : `${pauseAge(pause.since, now)} ago`;
  return `Paused ${why} ${when}${what}. It resumes exactly where it stopped.`;
}

/** `just now` for a fresh pause, else its compact age - for prose, where `<1m` reads badly. */
function pausedFor(since: number, now: number): string {
  return now - since < 60_000 ? "just now" : pauseAge(since, now);
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/**
 * The menu every placement with a menu opens: chip, card ⋯ and toolbar. Its rows follow the
 * session's standing, so a paused session is offered Resume first and never Pause again.
 */
function PauseMenuRows({ session, close }: { session: Session; close: () => void }): React.JSX.Element {
  const fleet = useFleetPause();
  const { busy, error, run } = usePauseActions(session);
  const at = standing(session, fleet);
  const others = fleet.pausable - (session.pause ? 0 : 1);
  const freezes = pauseFreezes(session);
  const act = (action: PauseAction) => async () => {
    if (await run(action)) close();
  };
  const row = (
    key: string,
    glyph: GlyphKind,
    label: string,
    sub: string,
    action: PauseAction,
    disabledReason: string | null = null,
  ) => (
    <Tooltip key={key} label={disabledReason ?? sub}>
      <button
        type="button"
        role="menuitem"
        className="session-toolbar-option pause-menu-row"
        disabled={busy || disabledReason !== null}
        onClick={act(action)}
      >
        <PauseGlyph kind={glyph} />
        <span className="pause-menu-text">
          <span className="pause-menu-label">{label}</span>
          <span className="pause-menu-sub">{sub}</span>
        </span>
      </button>
    </Tooltip>
  );
  const fleetPaused = fleet.state.fleet !== null;
  return (
    <>
      {at === "priority" &&
        row("end-priority", "resume-all", "End priority", `Resume the ${sessionCount(fleet.pausedForPriority)} paused for this one.`, { kind: "end-priority" })}
      {(at === "paused" || at === "pending") &&
        row("resume", "play", "Resume", "Thaw the agent where it stopped, and let automation reach it again.", { kind: "resume" })}
      {at === "pending" &&
        row("pause-now", "pause", "Pause now", "Freeze it now instead of waiting for the turn to end.", { kind: "pause", mode: "now" })}
      {at === "running" && (
        <>
          {freezes
            ? row("pause-now", "pause", "Pause now", "Freezes the agent where it is. Its network goes quiet at once.", { kind: "pause", mode: "now" })
            : row("pause-now", "pause", "Pause now", "Holds it: this agent runs inside Mission Control, so its current turn finishes first, then nothing new is sent.", { kind: "pause", mode: "now" })}
          {row("pause-after", "after-turn", "Pause after this turn", freezes ? "Lets the current turn finish, then freezes it." : "Lets the current turn finish, then holds it.", { kind: "pause", mode: "after-turn" })}
        </>
      )}
      {at !== "priority" &&
        row(
          "priority",
          "star",
          "Make priority",
          others > 0
            ? `Pause the ${sessionCount(others)} still running so this one has the machine and the network.`
            : "Nothing else is running. Automatic launches are held while it is the priority session.",
          { kind: "priority" },
          fleetPaused ? "Everything is paused. Resume all before choosing a priority session." : null,
        )}
      <p className="session-toolbar-note session-toolbar-foot">
        A paused session keeps its place and resumes exactly where it stopped.
      </p>
      {error && <p className="session-toolbar-error" role="alert">{error}</p>}
    </>
  );
}

/** Stops a click inside a card control from also opening the session. */
function CardControl({ children, className = "" }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <span className={`pause-card-control ${className}`} onClick={(event) => event.stopPropagation()}>
      {children}
    </span>
  );
}

// ---- board card -------------------------------------------------------------------------

/** Card A: pause and priority buttons in the head, drawn when you point at the card. */
export function PauseCornerButtons({ session }: { session: Session }): React.JSX.Element | null {
  const fleet = useFleetPause();
  const { busy, error, run } = usePauseActions(session);
  if (!canPause(session)) return null;
  const at = standing(session, fleet);
  return (
    <CardControl className={`pause-corner${at !== "running" ? " is-set" : ""}`}>
      {at === "priority" ? (
        <Tooltip label={error ?? `End priority and resume the ${sessionCount(fleet.pausedForPriority)} paused for it`}>
          <button type="button" className="pause-corner-btn is-priority" aria-label="End priority" disabled={busy}
            onClick={() => void run({ kind: "end-priority" })}>
            <PauseGlyph kind="star" />
          </button>
        </Tooltip>
      ) : at === "running" ? (
        <>
          <Tooltip label={fleet.state.fleet ? "Everything is paused. Resume all before choosing a priority session." : (error ?? "Make priority - pause every other running session")}>
            <button type="button" className="pause-corner-btn" aria-label="Make priority" disabled={busy || fleet.state.fleet !== null}
              onClick={() => void run({ kind: "priority" })}>
              <PauseGlyph kind="star-outline" />
            </button>
          </Tooltip>
          <Tooltip label={error ?? "Pause this session"}>
            <button type="button" className="pause-corner-btn" aria-label="Pause" disabled={busy}
              onClick={() => void run({ kind: "pause", mode: "now" })}>
              <PauseGlyph kind="pause" size={10} />
            </button>
          </Tooltip>
        </>
      ) : (
        <Tooltip label={error ?? "Resume this session"}>
          <button type="button" className="pause-corner-btn is-paused" aria-label="Resume" disabled={busy}
            onClick={() => void run({ kind: "resume" })}>
            <PauseGlyph kind="play" size={10} />
          </button>
        </Tooltip>
      )}
    </CardControl>
  );
}

/** Card B: the run chip leading the runtime row, opening the pause menu. */
export function PauseRunChip({ session }: { session: Session }): React.JSX.Element | null {
  const fleet = useFleetPause();
  const now = useNow(session.pause != null);
  if (!canPause(session)) return null;
  const at = standing(session, fleet);
  const text = at === "priority" ? "Priority"
    : at === "pending" ? "Pausing"
      : at === "paused" ? (session.pause!.reason === "operator" ? `Paused ${pauseAge(session.pause!.since, now)}` : pauseFlagLabel(session.pause!, now))
        : "Running";
  const glyph: GlyphKind | null = at === "priority" ? "star" : at === "paused" || at === "pending" ? "pause" : null;
  return (
    <CardControl>
      <SessionToolbarMenu
        bare
        label={`Pause controls: ${text}`}
        title="Pause"
        className={`pause-chip is-${at}`}
        icon={
          <>
            {glyph ? <PauseGlyph kind={glyph} size={9} /> : <span className="pause-chip-dot" aria-hidden />}
            <span>{text}</span>
            <span className="pause-chip-caret" aria-hidden>▾</span>
          </>
        }
      >
        {(close) => <PauseMenuRows session={session} close={close} />}
      </SessionToolbarMenu>
    </CardControl>
  );
}

/** Card E, first half: the ⋯ menu in the head. */
export function PauseCardMenu({ session }: { session: Session }): React.JSX.Element | null {
  if (!canPause(session)) return null;
  return (
    <CardControl>
      <SessionToolbarMenu bare label="Session actions" title="Pause" className="pause-more" icon={<span aria-hidden>⋯</span>}>
        {(close) => <PauseMenuRows session={session} close={close} />}
      </SessionToolbarMenu>
    </CardControl>
  );
}

/** Card E, second half: the one-click way back, in the flag row of a paused or priority card. */
export function PauseResumePill({ session }: { session: Session }): React.JSX.Element | null {
  const fleet = useFleetPause();
  const { busy, error, run } = usePauseActions(session);
  const at = standing(session, fleet);
  if (at === "running") return null;
  const priority = at === "priority";
  return (
    <CardControl>
      <Tooltip label={error ?? (priority ? `Resume the ${sessionCount(fleet.pausedForPriority)} paused for this one` : "Resume this session")}>
        <button type="button" className="pause-pill" disabled={busy}
          onClick={() => void run(priority ? { kind: "end-priority" } : { kind: "resume" })}>
          {!priority && <PauseGlyph kind="play" size={8} />}
          {priority ? "End priority" : "Resume"}
        </button>
      </Tooltip>
    </CardControl>
  );
}

/** The flag every paused or priority card wears, whichever controls are on. */
export function PauseTileFlag({ session }: { session: Session }): React.JSX.Element | null {
  const fleet = useFleetPause();
  const now = useNow(session.pause != null);
  if (isPrioritySession(fleet, session.id)) {
    return (
      <Tooltip label={`The priority session. ${sessionCount(fleet.pausedForPriority)} paused so it has the machine and the network.`}>
        <span className="tile-flag tf-priority"><PauseGlyph kind="star" size={9} /> Priority · {fleet.pausedForPriority} paused</span>
      </Tooltip>
    );
  }
  if (!session.pause) return null;
  return (
    <Tooltip label={pausedSentence(session, now)}>
      <span className="tile-flag tf-paused"><PauseGlyph kind="pause" size={8} /> {pauseFlagLabel(session.pause, now)}</span>
    </Tooltip>
  );
}

/** The activity line a frozen card shows instead of the live ticker. */
export function PausedActivityLine({ session }: { session: Session }): React.JSX.Element | null {
  const pause = session.pause;
  if (!pause || pause.phase !== "frozen") return null;
  const when = new Date(pause.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <span className="tile-activity pause-frozen-line">
      <span className="ta-glyph"><PauseGlyph kind="pause" size={10} /></span>
      <span className="ta-txt">
        Paused at {when}
        {pause.interrupted ? ` · was ${lowerFirst(pause.interrupted)}` : ""}
      </span>
    </span>
  );
}

// ---- console ----------------------------------------------------------------------------

/** Console B: the tab-row toolbar button, beside session control. */
export function PauseToolbarButton({ session }: { session: Session }): React.JSX.Element | null {
  const fleet = useFleetPause();
  const now = useNow(session.pause != null);
  if (!canPause(session)) return null;
  const at = standing(session, fleet);
  const label = at === "priority" ? "Pause controls: priority session"
    : at === "running" ? "Pause controls: running"
      : `Pause controls: ${pauseFlagLabel(session.pause!, now)}`;
  return (
    <SessionToolbarMenu
      label={label}
      title="Pause"
      className={`pause-toolbar-btn is-${at}`}
      icon={
        at === "priority" ? (
          <><PauseGlyph kind="star" size={11} /><span className="pause-toolbar-text">Priority · {fleet.pausedForPriority} paused</span></>
        ) : at === "running" ? (
          <PauseGlyph kind="pause" size={11} />
        ) : (
          <><PauseGlyph kind="play" size={10} /><span className="pause-toolbar-text">{pauseAge(session.pause!.since, now)}</span></>
        )
      }
    >
      {(close) => <PauseMenuRows session={session} close={close} />}
    </SessionToolbarMenu>
  );
}

/** Console C, the button beside Send. */
export function ComposerPauseButton({ session }: { session: Session }): React.JSX.Element | null {
  const fleet = useFleetPause();
  const { busy, error, run } = usePauseActions(session);
  if (!canPause(session) || isPrioritySession(fleet, session.id)) return null;
  const paused = session.pause != null;
  return (
    <Tooltip label={error ?? (paused ? "Resume this session" : "Pause this session")}>
      <button type="button" className={`btn composer-pause-btn${paused ? " is-paused" : ""}`} aria-label={paused ? "Resume session" : "Pause session"}
        disabled={busy} onClick={() => void run(paused ? { kind: "resume" } : { kind: "pause", mode: "now" })}>
        <PauseGlyph kind={paused ? "play" : "pause"} size={11} />
      </button>
    </Tooltip>
  );
}

/** Console C, the band above the message box: what pausing means for what you type. */
export function ComposerPausedBand({ session }: { session: Session }): React.JSX.Element | null {
  const fleet = useFleetPause();
  const { busy, error, run } = usePauseActions(session);
  const now = useNow(session.pause != null);
  if (isPrioritySession(fleet, session.id)) {
    return (
      <div className="pause-band is-inline is-priority" role="status">
        <PauseGlyph kind="star" size={11} />
        <span className="pause-band-lead">Priority</span>
        <span className="pause-band-sub">{sessionCount(fleet.pausedForPriority)} paused while you work here.</span>
        <Tooltip label={error ?? "End priority and resume them"}>
          <button type="button" className="btn" disabled={busy} onClick={() => void run({ kind: "end-priority" })}>End priority</button>
        </Tooltip>
      </div>
    );
  }
  if (!session.pause) return null;
  return (
    <div className="pause-band is-inline" role="status">
      <PauseGlyph kind="pause" size={11} />
      <span className="pause-band-lead">{session.pause.phase === "pending" ? "Pausing after this turn" : `Paused ${pausedFor(session.pause.since, now)}`}</span>
      <span className="pause-band-sub">Messages you send now wait in the queue and are delivered when it resumes.</span>
      <Tooltip label={error ?? "Resume this session"}>
        <button type="button" className="btn pause-band-primary" disabled={busy} onClick={() => void run({ kind: "resume" })}>
          <PauseGlyph kind="play" size={9} /> Resume
        </button>
      </Tooltip>
    </div>
  );
}

/** Console D, the state badge's pause half, sitting flush against the badge. */
export function BadgePauseHalf({ session }: { session: Session }): React.JSX.Element | null {
  const fleet = useFleetPause();
  const { busy, error, run } = usePauseActions(session);
  if (!canPause(session) || isPrioritySession(fleet, session.id)) return null;
  const paused = session.pause != null;
  return (
    <Tooltip label={error ?? (paused ? "Resume this session" : "Pause this session")}>
      <button type="button" className={`badge-pause-half${paused ? " is-paused" : ""}`} aria-label={paused ? "Resume this session" : "Pause this session"}
        disabled={busy} onClick={() => void run(paused ? { kind: "resume" } : { kind: "pause", mode: "now" })}>
        <PauseGlyph kind={paused ? "play" : "pause"} size={9} />
      </button>
    </Tooltip>
  );
}

/** Console D, the band under the header while paused or while this is the priority session. */
export function PausedBand({ session }: { session: Session }): React.JSX.Element | null {
  const fleet = useFleetPause();
  const { busy, error, run } = usePauseActions(session);
  const now = useNow(session.pause != null);
  if (isPrioritySession(fleet, session.id)) {
    return (
      <div className="pause-band is-priority" role="status">
        <PauseGlyph kind="star" size={12} />
        <span className="pause-band-lead">Priority</span>
        <span className="pause-band-sub">{sessionCount(fleet.pausedForPriority)} paused so this one has the machine and the network.</span>
        <Tooltip label={error ?? "End priority and resume the sessions it paused"}>
          <button type="button" className="btn pause-band-primary" disabled={busy} onClick={() => void run({ kind: "end-priority" })}>
            End priority · resume {fleet.pausedForPriority}
          </button>
        </Tooltip>
      </div>
    );
  }
  if (!session.pause) return null;
  const pending = session.pause.phase === "pending";
  return (
    <div className="pause-band" role="status">
      <PauseGlyph kind="pause" size={12} />
      <span className="pause-band-lead">{pending ? "Pausing after this turn" : `Paused ${pausedFor(session.pause.since, now)}`}</span>
      <span className="pause-band-sub">{pausedSentence(session, now)}</span>
      {fleet.state.fleet === null && (
        <Tooltip label={error ?? "Resume this one and pause every other running session instead"}>
          <button type="button" className="btn pause-band-ghost" disabled={busy} onClick={() => void run({ kind: "priority" })}>
            <PauseGlyph kind="star-outline" size={10} /> Make priority instead
          </button>
        </Tooltip>
      )}
      <Tooltip label={error ?? "Resume this session"}>
        <button type="button" className="btn pause-band-primary" disabled={busy} onClick={() => void run({ kind: "resume" })}>
          <PauseGlyph kind="play" size={9} /> Resume
        </button>
      </Tooltip>
    </div>
  );
}
