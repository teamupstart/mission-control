import { ResidentLoopControls, ResidentLoopStatusLine } from "./ResidentLoopControls.tsx";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ResidentProfile, ResidentRunSummary } from "@shared/residents.ts";
import type { Session } from "@shared/types.ts";
import { stateDisplay } from "../lib/format.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { ResidentChip } from "./ResidentChip.tsx";
import { ResidentControlStatus } from "./ResidentControlStatus.tsx";
import { ResidentProfileLaunchList } from "./ResidentProfileLaunchList.tsx";
import { useResidentLaunches, type ResidentLaunches } from "./useResidentLaunches.ts";
import { residentAccentStyle, residentMarkTitle, residentSessionMark } from "./marker.ts";

export interface ResidentsDockProps {
  /** Live runs, oldest launch first - the `residentRuns` collection. */
  runs: readonly ResidentRunSummary[];
  /** Live profiles, by name - the `residentProfiles` collection. */
  profiles: readonly ResidentProfile[];
  /** Every session, to read each live resident's state and to open it. */
  sessions: readonly Session[];
  /** Always drawn minimized - glyph and count - by the operator's Top bar choice. */
  compact?: boolean;
  /** A changed value opens the dock: the keyboard chord and the palette command. */
  openRequest?: number;
  /**
   * Start with the dock open. For a static rendering, which has no click to open it with: the
   * Electron geometry test measures the open panel against the real top bar this way.
   */
  defaultOpen?: boolean;
  onOpenSession: (sessionId: string) => void;
  /**
   * App's one launch state, shared with the Residents drawer. A static rendering has no App, so
   * the dock falls back to its own.
   */
  launcher?: ResidentLaunches;
  /**
   * Drawer placement: the button opens the Residents drawer instead of this dock, and the dock's
   * popover never opens. The button keeps its element, class and accessible name.
   */
  onToggleDrawer?: () => void;
  /** Whether the drawer the button opens is on screen, for `aria-expanded`. */
  drawerOpen?: boolean;
  /** Open Dispatch > Resident on a profile, for a launch that needs a repository chosen. */
  onOpenLaunch: (profileId: string) => void;
  /** Open `#/residents`. */
  onManage: () => void;
}

/**
 * The Residents button beside Foreman, and the dock it opens: the live residents with their
 * state and an Open, the live profiles with a Launch, and a way to `#/residents`.
 *
 * A launch here goes through `launchResident()`, the one browser launch call, with the profile's
 * default repository. A profile with none opens Dispatch > Resident on it instead, because a
 * launch needs a repository and the dock has no room to choose one well.
 *
 * Launch state lives in `useResidentLaunches`, owned by App and shared with the Residents
 * drawer, so closing the dock while a launch is starting keeps its request id: launching again
 * replays that launch, never a second.
 */
export function ResidentsDock(props: ResidentsDockProps): React.JSX.Element {
  const { runs, profiles, sessions, compact = false, openRequest, defaultOpen = false } = props;
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const handledOpenRequest = useRef(openRequest);
  const ownLauncher = useResidentLaunches();
  const { launches, launch: launchProfile } = props.launcher ?? ownLauncher;
  const drawer = props.onToggleDrawer !== undefined;

  /** Set by a keyboard or palette open, and consumed once the panel has rendered. */
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (openRequest === handledOpenRequest.current) return;
    handledOpenRequest.current = openRequest;
    if (drawer) return;
    focusOnOpen.current = true;
    setOpen(true);
  }, [openRequest, drawer]);
  // Switching to the drawer placement while the dock is open puts it away: its popover is no
  // longer drawn, and an `open` left behind would keep claiming Escape.
  useEffect(() => {
    if (drawer) setOpen(false);
  }, [drawer]);
  // Opened from the keyboard: put focus inside, so Tab walks the dock rather than the page.
  // After the render that mounted the panel, which is the first moment it has a button.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    panelRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [open]);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      // A live row's session control menu opens in a portal outside the panel; using it is
      // still using the dock.
      if ((e.target as Element | null)?.closest?.(".session-toolbar-menu")) return;
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    // Escape closes the dock and stops there: this popover is not a registered overlay, so
    // App's global Escape would otherwise also drop the fleet selection behind it.
    function onKey(e: KeyboardEvent): void {
      if (open && e.key === "Escape") {
        e.stopPropagation();
        // Closing unmounts whatever inside the panel held focus, which would drop it on
        // <body>. Hand it back to the button the dock hangs off, where the keyboard was.
        if (panelRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
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

  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const sessionByTask = new Map<string, Session>();
  for (const session of sessions) if (session.task) sessionByTask.set(session.task.id, session);
  const live = runs.length;
  const accessibleName = `Residents - ${live} live`;

  async function launch(profile: ResidentProfile): Promise<void> {
    if ((await launchProfile(profile)) !== "needs-repository") return;
    setOpen(false);
    props.onOpenLaunch(profile.id);
  }

  return (
    <div className="residents-dock" ref={ref}>
      <Tooltip label="Residents - long-running agents: open a live one, or launch one from its profile">
        <button
          ref={buttonRef}
          className={`ghost-btn residents-btn${live > 0 ? " on" : ""}${compact ? " tb-compact" : ""}`}
          onClick={() => (props.onToggleDrawer ? props.onToggleDrawer() : setOpen((o) => !o))}
          // Named explicitly because the word is a `.tb-label` the narrow ladder takes away;
          // the count survives the collapse and the name has to as well.
          aria-label={accessibleName}
          aria-expanded={drawer ? props.drawerOpen === true : open}
        >
          <span className="residents-glyph" aria-hidden>⌂</span>
          <span className="tb-label">Residents</span>
          {live > 0 && <span className="residents-count">{live}</span>}
        </button>
      </Tooltip>

      {open && !drawer && (
        <div className="alert-pop residents-pop" role="dialog" aria-label="Residents" ref={panelRef}>
          <section className="residents-pop-section" aria-labelledby="residents-pop-live">
            <h3 className="alert-sec" id="residents-pop-live">Live</h3>
            {runs.length === 0 ? (
              <p className="alert-hint dim">No residents are running. Launch one from a profile below.</p>
            ) : (
              <ul className="residents-pop-list">
                {runs.map((run) => {
                  const mark = residentSessionMark(run, profileById.get(run.profileId) ?? null);
                  const session = sessionByTask.get(run.taskId) ?? null;
                  const state = session ? stateDisplay(session) : { label: "starting", tone: "neutral" as const };
                  return (
                    // A card in the resident's own color, so a live run reads as a different
                    // kind of thing from the profiles under it: the name, state and Open, the
                    // loop's facts, then a footer with the run controls and the control status
                    // on one line. Open heads the card rather than joining the footer: with it,
                    // the footer's five controls overran a 340px card in a wider system font
                    // (Linux) and Open wrapped onto a line of its own.
                    <li key={run.id} className="residents-pop-row residents-pop-card" style={residentAccentStyle(mark.colorId)}>
                      <div className="residents-pop-card-head">
                        <ResidentChip mark={mark} title={residentMarkTitle(mark)} />
                        <span className="residents-pop-name"><span className="residents-pop-name-text">{mark.name}</span></span>
                        <span className="residents-pop-state residents-pop-pill" style={{ "--tone": `var(--${state.tone})` } as CSSProperties}>
                          <span className="residents-pop-dot" aria-hidden />
                          {state.label}
                        </span>
                        <Tooltip label={session ? `Open ${mark.name}'s session` : "Its session has not started yet"}>
                          <button
                            type="button"
                            className="btn residents-pop-action"
                            aria-label={`Open ${mark.name}`}
                            disabled={!session}
                            onClick={() => {
                              if (!session) return;
                              setOpen(false);
                              props.onOpenSession(session.id);
                            }}
                          >
                            Open
                          </button>
                        </Tooltip>
                      </div>
                      <ResidentLoopStatusLine loop={run} session={session} tags />
                      <div className="residents-pop-card-foot">
                        <ResidentLoopControls mark={mark} />
                        <span className="residents-pop-spacer" aria-hidden />
                        {session && (mark.controlOtherSessions || session.sessionControlEnabled === true) && (
                          <ResidentControlStatus session={session} name={mark.name} badge />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="residents-pop-section" aria-labelledby="residents-pop-profiles">
            <h3 className="alert-sec" id="residents-pop-profiles">Profiles</h3>
            {profiles.length === 0 ? (
              <p className="alert-hint dim">No resident profiles yet. Author one on the Residents page.</p>
            ) : (
              <ResidentProfileLaunchList profiles={profiles} launches={launches} onLaunch={(profile) => void launch(profile)} />
            )}
          </section>
          <Tooltip label="Author, edit and archive resident profiles on the Residents page">
            <button
              type="button"
              className="btn btn-ghost residents-pop-manage"
              onClick={() => {
                setOpen(false);
                props.onManage();
              }}
            >
              Manage residents <span aria-hidden>→</span>
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
