import { useEffect, useRef, useState } from "react";
import type { ResidentProfile, ResidentRunSummary } from "@shared/residents.ts";
import type { Session } from "@shared/types.ts";
import { stateDisplay } from "../lib/format.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { ResidentChip } from "./ResidentChip.tsx";
import { launchResident } from "./launch.ts";
import { residentMarkTitle, residentProfileMark, residentSessionMark } from "./marker.ts";

/** How often a still-starting launch is replayed - the same request id - to read its outcome. */
const PENDING_REPLAY_MS = 1_500;
/**
 * How long the dock keeps replaying a launch that is still starting before it stops and hands
 * the choice back. A stalled startup must not leave Launch disabled for as long as the dock is
 * mounted; the request id is kept, so the next Launch checks the same launch.
 */
export const DOCK_PENDING_LIMIT_MS = 60_000;

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
  /** Open Dispatch > Resident on a profile, for a launch that needs a repository chosen. */
  onOpenLaunch: (profileId: string) => void;
  /** Open `#/residents`. */
  onManage: () => void;
}

/** One profile's launch from the dock, kept while the panel is shut so a retry replays it. */
interface DockLaunch {
  requestId: string;
  busy: boolean;
  error: string | null;
  /** The launch reached its session; cleared on the next launch. */
  launched: boolean;
  /**
   * Still starting when the dock stopped replaying it (`DOCK_PENDING_LIMIT_MS`). The request id
   * is kept, so Launch checks this same launch again rather than starting another.
   */
  stillStarting: boolean;
}

/**
 * The Residents button beside Foreman, and the dock it opens: the live residents with their
 * state and an Open, the live profiles with a Launch, and a way to `#/residents`.
 *
 * A launch here goes through `launchResident()`, the one browser launch call, with the profile's
 * default repository. A profile with none opens Dispatch > Resident on it instead, because a
 * launch needs a repository and the dock has no room to choose one well.
 *
 * Launch state lives on this component rather than the panel, so closing the dock while a
 * launch is starting keeps its request id: launching again replays that launch, never a second.
 */
export function ResidentsDock(props: ResidentsDockProps): React.JSX.Element {
  const { runs, profiles, sessions, compact = false, openRequest, defaultOpen = false } = props;
  const [open, setOpen] = useState(defaultOpen);
  const [launches, setLaunches] = useState<Record<string, DockLaunch>>({});
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const handledOpenRequest = useRef(openRequest);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Set by a keyboard or palette open, and consumed once the panel has rendered. */
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (openRequest === handledOpenRequest.current) return;
    handledOpenRequest.current = openRequest;
    focusOnOpen.current = true;
    setOpen(true);
  }, [openRequest]);
  // Opened from the keyboard: put focus inside, so Tab walks the dock rather than the page.
  // After the render that mounted the panel, which is the first moment it has a button.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    panelRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [open]);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    // Escape closes the dock and stops there: this popover is not a registered overlay, so
    // App's global Escape would otherwise also drop the fleet selection behind it.
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

  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const sessionByTask = new Map<string, Session>();
  for (const session of sessions) if (session.task) sessionByTask.set(session.task.id, session);
  const live = runs.length;
  const accessibleName = `Residents - ${live} live`;

  const patchLaunch = (profileId: string, patch: Partial<DockLaunch>): void =>
    setLaunches((prev) => {
      const current = prev[profileId] ?? freshLaunch();
      return { ...prev, [profileId]: { ...current, ...patch } };
    });

  async function launch(profile: ResidentProfile): Promise<void> {
    const repoRoot = profile.settings.workspace.defaultRepoRoot?.trim();
    if (!repoRoot) {
      setOpen(false);
      props.onOpenLaunch(profile.id);
      return;
    }
    const requestId = launches[profile.id]?.requestId ?? crypto.randomUUID();
    patchLaunch(profile.id, { requestId, busy: true, error: null, launched: false, stillStarting: false });
    const input = { repoRoot, requestId };
    const startedAt = Date.now();
    let answer = await launchResident(profile.id, input);
    // Still starting: replay the SAME request id until it settles. A replay reads the one run
    // this id reserved and never starts another. Bounded, so a stalled startup gives Launch
    // back - with the id kept - instead of holding the row busy indefinitely.
    while (answer.state === "pending") {
      if (!mounted.current) return;
      if (Date.now() - startedAt >= DOCK_PENDING_LIMIT_MS) {
        patchLaunch(profile.id, { requestId, busy: false, error: null, launched: false, stillStarting: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, PENDING_REPLAY_MS));
      if (!mounted.current) return;
      answer = await launchResident(profile.id, input);
    }
    if (!mounted.current) return;
    switch (answer.state) {
      case "launched":
        patchLaunch(profile.id, { ...freshLaunch(), launched: true });
        return;
      case "failed":
        // Definitive: the next attempt is a new launch.
        patchLaunch(profile.id, { ...freshLaunch(), error: `Did not start: ${answer.error}` });
        return;
      case "refused":
        // No answer at all keeps the id, so a retry replays a launch the daemon may hold; a
        // refusal created nothing, and reusing its id would be a conflict.
        patchLaunch(profile.id, {
          ...(answer.code === "unavailable" ? { requestId } : { requestId: crypto.randomUUID() }),
          busy: false,
          error: answer.error,
        });
        return;
    }
  }

  return (
    <div className="residents-dock" ref={ref}>
      <Tooltip label="Residents - long-running agents: open a live one, or launch one from its profile">
        <button
          className={`ghost-btn residents-btn${live > 0 ? " on" : ""}${compact ? " tb-compact" : ""}`}
          onClick={() => setOpen((o) => !o)}
          // Named explicitly because the word is a `.tb-label` the narrow ladder takes away;
          // the count survives the collapse and the name has to as well.
          aria-label={accessibleName}
          aria-expanded={open}
        >
          <span className="residents-glyph" aria-hidden>⌂</span>
          <span className="tb-label">Residents</span>
          {live > 0 && <span className="residents-count">{live}</span>}
        </button>
      </Tooltip>

      {open && (
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
                  const state = session ? stateDisplay(session).label : "starting";
                  return (
                    <li key={run.id} className="residents-pop-row">
                      <ResidentChip mark={mark} title={residentMarkTitle(mark)} />
                      <span className="residents-pop-name">{mark.name}</span>
                      <span className="residents-pop-state">{state}</span>
                      <Tooltip label={session ? `Open ${mark.name}'s session` : "Its session has not started yet"}>
                        <button
                          type="button"
                          className="btn btn-ghost residents-pop-action"
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
              <ul className="residents-pop-list">
                {profiles.map((profile) => {
                  const state = launches[profile.id];
                  const mark = residentProfileMark(profile);
                  const repo = profile.settings.workspace.defaultRepoRoot;
                  return (
                    <li key={profile.id} className="residents-pop-row">
                      <ResidentChip mark={mark} />
                      <span className="residents-pop-name">{profile.name}</span>
                      <span className="residents-pop-state" role="status">
                        {state?.busy
                          ? "starting…"
                          : state?.stillStarting ? "still starting" : state?.launched ? "launched" : ""}
                      </span>
                      <Tooltip
                        label={repo
                          ? `Launch ${profile.name} in ${repo}`
                          : `Choose a repository for ${profile.name} in Dispatch`}
                      >
                        <button
                          type="button"
                          className="btn residents-pop-action"
                          aria-label={`Launch ${profile.name}`}
                          disabled={state?.busy}
                          onClick={() => void launch(profile)}
                        >
                          {repo ? "Launch" : "Launch…"}
                        </button>
                      </Tooltip>
                      {/* Its own line across the row, not the state cell: a reason is a
                          sentence, and an ellipsized one says nothing. */}
                      {state?.error && (
                        <p className="residents-pop-error" role="alert">{state.error}</p>
                      )}
                      {state?.stillStarting && (
                        <p className="residents-pop-note">
                          Taking longer than usual to start. Launch checks on this same launch; it
                          never starts a second resident.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
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

function freshLaunch(): DockLaunch {
  return { requestId: crypto.randomUUID(), busy: false, error: null, launched: false, stillStarting: false };
}
