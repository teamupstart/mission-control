import { useEffect, useRef, useState } from "react";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { RESIDENT_LIMITS, residentLaunchSummary, residentProfileChoiceName, type ResidentProfile } from "@shared/residents.ts";
import type { DispatchMode } from "../lib/dispatch-mode.ts";
import { fetchRepos } from "../lib/api.ts";
import { DispatchModeToggle } from "../components/DispatchModeToggle.tsx";
import { Overlay, OVERLAY_IDS } from "../components/Overlay.tsx";
import { RepoCombobox } from "../components/RepoCombobox.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import {
  chooseResidentRepo,
  residentAttemptMatches,
  residentDispatchRepo,
  residentRetryWithoutProfile,
  retryResidentAttempt,
  selectResidentProfile,
  type ResidentDispatchDraft,
} from "./dispatch-draft.ts";
import { launchResident, residentLaunchCanGrantControl } from "./launch.ts";
import { residentProfileFact } from "./ResidentsPage.tsx";
import { residentMcpRefLabel, useResidentMcpCatalog } from "./mcp-catalog.ts";

type ResidentMode = Extract<DispatchMode, { kind: "resident" }>;

/** How often a launch not yet accepted is replayed - the same request id - to read its outcome. */
const ACCEPTANCE_REPLAY_MS = 1_500;

/**
 * Dispatch > Resident: choose a profile, a repository and optional run instructions, read
 * what the launch will carry, and launch it.
 *
 * The same dialog as Single and Ensemble - one overlay id, one accessible name, one mode
 * toggle - with a body of its own, because a resident launch has no task text, kind, crew or
 * after-work to choose: its profile decides them. The submit is `launchResident`, the one
 * browser launch call.
 *
 * Like a task dispatch, the form closes once the daemon accepts the launch - the run's task
 * exists - rather than once its session has started. A resident still starting answers
 * `pending`; how its startup ends is shown on its task, as a dispatched task's is. A `pending`
 * answer that is not yet accepted has no task to show a failure on, so the form stays open
 * and replays it until it is accepted or answers definitively.
 */
export function ResidentDispatch({
  mode,
  onClose,
}: {
  mode: ResidentMode;
  onClose: () => void;
}): React.JSX.Element {
  const { resident: draft, profiles, personas } = mode;
  const { catalog: mcpCatalog } = useResidentMcpCatalog();
  const [repos, setRepos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The daemon answered before the run's task existed; the form replays the launch until it
   * does. Closable meanwhile: the draft keeps the outstanding launch and its request id, so
   * Launch again resumes it rather than starting another.
   */
  const [awaitingTask, setAwaitingTask] = useState(false);
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
  // An earlier launch may be running (its answer was lost) and the form now asks for something
  // else: the operator chooses before anything is sent, so that run is neither hidden nor
  // collided with.
  const changedAfterUncertain = draft.uncertain !== null
    && !residentAttemptMatches(draft.uncertain, draft, profile);
  const uncertainProfile = draft.uncertain
    ? profiles.find((candidate) => candidate.id === draft.uncertain!.profileId) ?? null
    : null;
  // The outstanding launch's profile was archived: the form keeps the exact retry of that
  // launch, which the daemon still answers, and nothing else.
  const archivedRetry = residentRetryWithoutProfile(draft, profile);
  const blocked = busy
    ? "Waiting for the launch to answer"
    : !profile && !archivedRetry
      ? "Choose a resident profile"
      : null;

  async function launch(from: ResidentDispatchDraft = draft): Promise<void> {
    const profileId = profile?.id ?? (from === draft ? archivedRetry?.profileId : undefined);
    if (!profileId || blocked) return;
    setBusy(true);
    setError(null);
    const input = {
      repoRoot: residentDispatchRepo(from, profile).trim(),
      ...(from.instructions.trim() ? { instructions: from.instructions } : {}),
      requestId: from.requestId,
    };
    // Recorded BEFORE it is sent: from here until a definitive answer, this launch is
    // outstanding. Closing the form keeps it, and its profile-sourced repository is frozen as
    // sent, so reopening after the default changes still replays exactly this request.
    const submitted: ResidentDispatchDraft = {
      ...from,
      uncertain: {
        requestId: input.requestId,
        profileId,
        profileName: profile?.name ?? archivedRetry?.profileName ?? "",
        repoRoot: input.repoRoot,
        instructions: from.instructions,
      },
    };
    mode.onResidentChange(submitted);
    const request = { ...input, repoRoot: input.repoRoot || null, answerWhen: "accepted" as const };
    // Still inside the Launch click: the one call that may arm session control for this run.
    // Answered on acceptance, so the form closes as soon as the run's task exists.
    let answer = await launchResident(profileId, request, { profile });
    // Answered before its task existed: keep the SAME request id and replay it. The replay is
    // idempotent - it reads the one run this id reserved and never starts another.
    while (answer.state === "pending" && !answer.accepted) {
      if (!mounted.current) return;
      setAwaitingTask(true);
      await new Promise((resolve) => setTimeout(resolve, ACCEPTANCE_REPLAY_MS));
      if (!mounted.current) return;
      answer = await launchResident(profileId, request);
    }
    if (!mounted.current) return;
    setAwaitingTask(false);
    setBusy(false);
    switch (answer.state) {
      case "pending":
      case "launched":
        // Accepted: the daemon owns this run now, so a later Launch is a new resident, and the
        // form closes whatever the run's session control turns out to be. Whether control was
        // granted is read on the resident's Console band and in the dock, as it is for a
        // launch from either; the note above already said what this click can ask for.
        mode.onResidentLaunched(submitted);
        return;
      case "failed":
        setError(`The resident did not start: ${answer.error}`);
        // A failed launch is definitive; the next attempt is a new launch.
        mode.onResidentChange({ ...submitted, requestId: crypto.randomUUID(), uncertain: null });
        return;
      case "refused":
        setError(answer.error);
        if (answer.code === "unavailable") {
          // No answer: the daemon may have received it. The outstanding record stays, with the
          // id, so an exact retry replays it and a changed launch cannot hide or collide with it.
          return;
        }
        // A refusal created nothing, and a reused id would be a conflict on the next try.
        mode.onResidentChange({ ...submitted, requestId: crypto.randomUUID(), uncertain: null });
        return;
    }
  }

  return (
    <Overlay
      id={OVERLAY_IDS.dispatch}
      onClose={onClose}
      className="modal dispatch-modal dispatch-modal-resident"
      role="dialog"
      ariaLabel="Dispatch an agent"
      ariaModal
      // Closable while awaiting the task: nothing is lost, the draft keeps its request id.
      closable={!busy || awaitingTask}
    >
      <header className="modal-head">
        <h2>Dispatch an agent</h2>
        <DispatchModeToggle mode="resident" onChange={mode.onLaunchModeChange} />
        <Tooltip
          label={awaitingTask
            ? "Close; launching again resumes this same launch"
            : busy ? "Waiting for the launch to answer" : "Close without launching (Escape)"}
        >
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy && !awaitingTask}>
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
                  <Tooltip key={candidate.id} label={candidate.settings.identity.description || `Launch ${residentProfileChoiceName(candidate)}`}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={candidate.id === draft.profileId}
                      className={`resident-profile-card${candidate.id === draft.profileId ? " active" : ""}`}
                      disabled={busy}
                      onClick={() => choose(candidate)}
                    >
                      <span className="resident-profile-card-name">
                        {candidate.name}
                        {candidate.builtin && <em className="resident-builtin-tag">built-in</em>}
                      </span>
                      <span className="resident-profile-card-fact">{residentProfileFact(candidate, personas)}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="resident-dispatch-repo">Repository <span className="field-hint">optional</span></label>
              <RepoCombobox
                placeholder="No repository"
                id="resident-dispatch-repo"
                repos={repos}
                value={repoRoot}
                disabled={busy}
                onChange={(value) => {
                  setError(null);
                  mode.onResidentChange(chooseResidentRepo(draft, value));
                }}
              />
              <Tooltip label="Launch in a private working directory without a repository">
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => mode.onResidentChange(chooseResidentRepo(draft, ""))}>No repository</button>
              </Tooltip>
              {!repoRoot.trim() && <p className="field-hint">A private working directory is created for this run and removed when it ends.</p>}
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
                      mcpCatalog ? profile.settings.mcp.selected.map((ref) => residentMcpRefLabel(mcpCatalog, ref)) : undefined,
                    )}{" "}
                    · revision {profile.revision}
                  </span>
                </p>
                <Tooltip label={`Open ${profile.name} on the Residents page`}>
                  <button type="button" className="btn btn-ghost" onClick={() => mode.onEditProfile(profile.id)}>
                    {/* A built-in is read-only; its page offers Duplicate to edit. */}
                    {profile.builtin ? "View profile" : "Edit profile"}
                  </button>
                </Tooltip>
              </div>
            )}
            {profile?.settings.authority.controlOtherSessions && (
              <p className="field-hint resident-control-note" role="note">
                {residentLaunchCanGrantControl()
                  ? "Control other sessions is on: this Launch click asks for session control for this run, kept through a restart until its conversation changes or you turn it off. The resident's Console band reads control granted once it is applied, or control not granted if it cannot be."
                  : "Control other sessions is on, but only a Launch click in the Mission Control desktop app grants it. Launched from here, this resident starts without session control."}
              </p>
            )}
          </>
        )}
        {changedAfterUncertain && draft.uncertain && (
          <div className="resident-conflict" role="alert">
            <p>
              An earlier launch of {uncertainProfile?.name ?? draft.uncertain.profileName} in{" "}
              <code>{draft.uncertain.repoRoot || "no repository"}</code> may already be running: its answer never
              arrived. Retry it exactly, or launch this changed request as a separate resident.
            </p>
            <div className="resident-conflict-actions">
              <Tooltip label="Put the form back on the earlier launch and retry it; it never starts twice">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    mode.onResidentChange(retryResidentAttempt(draft, draft.uncertain!));
                  }}
                >
                  Retry the earlier launch
                </button>
              </Tooltip>
              <Tooltip label="Start a separate resident with what the form says now; check the board for the earlier one">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !profile}
                  onClick={() => {
                    const next = { ...draft, requestId: crypto.randomUUID(), uncertain: null };
                    mode.onResidentChange(next);
                    void launch(next);
                  }}
                >
                  Launch as a new resident
                </button>
              </Tooltip>
            </div>
          </div>
        )}
        {archivedRetry && !awaitingTask && (
          <p className="field-hint resident-archived-retry" role="status">
            {archivedRetry.profileName} was archived after this launch was sent, and its answer never
            arrived, so its resident may already be running. Launch resident retries exactly that
            launch; it never starts a second resident.
          </p>
        )}
        {awaitingTask && (
          <p className="field-hint resident-starting" role="status">
            Preparing the resident… This form closes once its task is created. You can close it;
            launching again resumes this same launch rather than starting another.
          </p>
        )}
        {error && <p className="resident-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-foot">
        <span className="actions-spacer" />
        <Tooltip label="Close without launching (Escape)">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy && !awaitingTask}>
            Cancel
          </button>
        </Tooltip>
        <Tooltip
          label={changedAfterUncertain
            ? "An earlier launch may be running; choose above"
            : blocked ?? "Launch this resident in the Agent SDK"}
        >
          <button
            data-dialog-default
            className="btn btn-primary"
            disabled={blocked !== null || changedAfterUncertain}
            onClick={() => void launch()}
          >
            {awaitingTask ? "Preparing…" : busy ? "Launching…" : "Launch resident"}
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
