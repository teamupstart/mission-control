import { useEffect, useRef, useState } from "react";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { RESIDENT_LIMITS, residentLaunchSummary, type ResidentProfile } from "@shared/residents.ts";
import type { DispatchMode } from "../lib/dispatch-mode.ts";
import { fetchRepos } from "../lib/api.ts";
import { DispatchModeToggle } from "../components/DispatchModeToggle.tsx";
import { Overlay, OVERLAY_IDS } from "../components/Overlay.tsx";
import { RepoCombobox } from "../components/RepoCombobox.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { chooseResidentRepo, residentDispatchRepo, selectResidentProfile } from "./dispatch-draft.ts";
import { launchResident } from "./launch.ts";
import { residentProfileFact } from "./ResidentsPage.tsx";

type ResidentMode = Extract<DispatchMode, { kind: "resident" }>;

/** How often a still-starting launch is replayed - the same request id - to read its outcome. */
const PENDING_REPLAY_MS = 1_500;

/**
 * Dispatch > Resident: choose a profile, a repository and optional run instructions, read
 * what the launch will carry, and launch it.
 *
 * The same dialog as Single and Ensemble - one overlay id, one accessible name, one mode
 * toggle - with a body of its own, because a resident launch has no task text, kind, crew or
 * after-work to choose: its profile decides them. The submit is `launchResident`, the one
 * browser launch call.
 */
export function ResidentDispatch({
  mode,
  onClose,
}: {
  mode: ResidentMode;
  onClose: () => void;
}): React.JSX.Element {
  const { resident: draft, profiles, personas } = mode;
  const [repos, setRepos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The launch was accepted and is still starting; the form replays it until it settles. */
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    void fetchRepos().then((list) => {
      if (live) setRepos(list);
    });
    return () => {
      live = false;
    };
  }, []);

  const profile = profiles.find((candidate) => candidate.id === draft.profileId) ?? null;
  const persona = profile
    ? personas.find((candidate) => candidate.id === profile.settings.persona.personaId) ?? null
    : null;
  const choose = (next: ResidentProfile): void => {
    setError(null);
    mode.onResidentChange(selectResidentProfile(draft, next));
  };
  const repoRoot = residentDispatchRepo(draft, profile);
  const blocked = busy
    ? "Waiting for the launch to answer"
    : !profile
      ? "Choose a resident profile"
      : !repoRoot.trim()
        ? "Choose a repository"
        : null;

  async function launch(): Promise<void> {
    if (!profile || blocked) return;
    setBusy(true);
    setError(null);
    const submitted = draft;
    const input = {
      repoRoot: repoRoot.trim(),
      ...(submitted.instructions.trim() ? { instructions: submitted.instructions } : {}),
      requestId: submitted.requestId,
    };
    let answer = await launchResident(profile.id, input);
    // Still starting: keep the SAME request id and replay it until the launch settles. The
    // replay is idempotent - it reads the one run this id reserved and never starts another -
    // so closing the form here keeps the id in the draft, and Launch again resumes this launch.
    while (answer.state === "pending") {
      if (!mounted.current) return;
      setStarting(true);
      await new Promise((resolve) => setTimeout(resolve, PENDING_REPLAY_MS));
      if (!mounted.current) return;
      answer = await launchResident(profile.id, input);
    }
    if (!mounted.current) return;
    setStarting(false);
    setBusy(false);
    switch (answer.state) {
      case "launched":
        mode.onResidentLaunched(submitted);
        return;
      case "failed":
        setError(`The resident did not start: ${answer.error}`);
        // A failed launch is definitive; the next attempt is a new launch.
        mode.onResidentChange({ ...submitted, requestId: crypto.randomUUID() });
        return;
      case "refused":
        setError(answer.error);
        // A refusal created nothing, and a reused id would be a conflict on the next try.
        // Only a launch that may have been received keeps its id for an idempotent retry.
        if (answer.code !== "unavailable") {
          mode.onResidentChange({ ...submitted, requestId: crypto.randomUUID() });
        }
        return;
    }
  }

  return (
    <Overlay
      id={OVERLAY_IDS.dispatch}
      onClose={onClose}
      ignoreBackdropDrag
      className="modal dispatch-modal dispatch-modal-resident"
      role="dialog"
      ariaLabel="Dispatch an agent"
      ariaModal
      // Closable while a launch is starting: nothing is lost, the draft keeps its request id.
      closable={!busy || starting}
    >
      <header className="modal-head">
        <h2>Dispatch an agent</h2>
        <DispatchModeToggle mode="resident" onChange={mode.onLaunchModeChange} />
        <Tooltip
          label={starting
            ? "Close; launching again resumes this same launch"
            : busy ? "Waiting for the launch to answer" : "Close without launching (Escape)"}
        >
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy && !starting}>
            ✕
          </button>
        </Tooltip>
      </header>
      <div className="modal-bleed dispatch-body resident-dispatch">
        {profiles.length === 0 ? (
          <section className="resident-dispatch-empty">
            <p>No resident profiles yet. A profile names the persona, instructions, harness and model a resident runs with.</p>
            <Tooltip label="Open Residents to author a profile">
              <button type="button" className="btn" onClick={() => mode.onEditProfile(null)}>
                Create a profile
              </button>
            </Tooltip>
          </section>
        ) : (
          <>
            <div className="field">
              <span className="field-label" id="resident-dispatch-profile-label">Profile</span>
              <div className="resident-profile-cards" role="radiogroup" aria-labelledby="resident-dispatch-profile-label">
                {profiles.map((candidate) => (
                  <Tooltip key={candidate.id} label={candidate.settings.identity.description || `Launch ${candidate.name}`}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={candidate.id === draft.profileId}
                      className={`resident-profile-card${candidate.id === draft.profileId ? " active" : ""}`}
                      disabled={busy}
                      onClick={() => choose(candidate)}
                    >
                      <span className="resident-profile-card-name">{candidate.name}</span>
                      <span className="resident-profile-card-fact">{residentProfileFact(candidate, personas)}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="resident-dispatch-repo">Repository</label>
              <RepoCombobox
                id="resident-dispatch-repo"
                repos={repos}
                value={repoRoot}
                disabled={busy}
                onChange={(value) => {
                  setError(null);
                  mode.onResidentChange(chooseResidentRepo(draft, value));
                }}
              />
            </div>
            <label className="field">
              <span className="field-label">
                Instructions for this run <span className="field-hint">optional</span>
              </span>
              <textarea
                className="field-input field-textarea resident-run-instructions"
                value={draft.instructions}
                maxLength={RESIDENT_LIMITS.runInstructionsLength}
                disabled={busy}
                placeholder="Focus on the release branch today"
                onChange={(event) => mode.onResidentChange({ ...draft, instructions: event.target.value })}
              />
            </label>
            {profile && (
              <div className="resident-launch-summary">
                <p>
                  <span className="field-label">Launches</span>{" "}
                  <span className="resident-launch-summary-text">
                    {residentLaunchSummary(
                      profile.settings,
                      persona?.name ?? null,
                      AGENT_IDENTITY[profile.settings.execution.agent].label,
                    )}{" "}
                    · revision {profile.revision}
                  </span>
                </p>
                <Tooltip label={`Open ${profile.name} on the Residents page`}>
                  <button type="button" className="btn btn-ghost" onClick={() => mode.onEditProfile(profile.id)}>
                    Edit profile
                  </button>
                </Tooltip>
              </div>
            )}
          </>
        )}
        {starting && (
          <p className="field-hint resident-starting" role="status">
            Starting the resident… This form updates when its session has started. You can close
            it; launching again resumes this same launch rather than starting another.
          </p>
        )}
        {error && <p className="resident-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-foot">
        <span className="actions-spacer" />
        <Tooltip label="Close without launching (Escape)">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy && !starting}>
            Cancel
          </button>
        </Tooltip>
        <Tooltip label={blocked ?? "Launch this resident in the Agent SDK"}>
          <button
            className="btn btn-primary"
            disabled={blocked !== null}
            onClick={() => void launch()}
          >
            {starting ? "Starting…" : busy ? "Launching…" : "Launch resident"}
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
