import { useEffect, useState } from "react";
import type { WorkflowConfig } from "@shared/workflow.ts";
import type { WorkflowSettingsState } from "../useWorkflowSettings.ts";
import { resolveRepo } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "../workflows/WorkflowConfirmModal.tsx";

// The Workflow subsystem's settings, as a settings category.
//
// It used to be a floating drawer hanging off the Workflows page header - a parallel
// settings surface with no rail row, no scope badge, no deep link and no search coverage,
// so the one switch in this app that can type into somebody's live agent session was the
// one switch you could not find by searching for it. Same routes, same config blob, same
// consent copy; what changed is that it is now where every other subsystem's settings are.
//
// The two confirmations go through the overlay registry (`WorkflowConfirmModal`) rather
// than `window.confirm`, for that component's own reason: a native dialog is invisible to
// the registry, so the fleet's global key handler stays live behind it.

/** The retention boxes as typed text, so a half-entered number is not a config write. */
interface RetentionDraft {
  rawEvidenceDays: string;
  completedRunDays: string;
  maxCompletedRuns: string;
}

function draftOf(config: WorkflowConfig): RetentionDraft {
  return {
    rawEvidenceDays: String(config.retention.rawEvidenceDays),
    completedRunDays: String(config.retention.completedRunDays),
    maxCompletedRuns: String(config.retention.maxCompletedRuns),
  };
}

/**
 * The ranges the daemon's own schema enforces, restated here so the panel refuses locally
 * with a sentence instead of bouncing off a 400. Kept as one table because the number in
 * the message and the number in the `min`/`max` attributes have to be the same number.
 */
const RETENTION_FIELDS = [
  {
    key: "rawEvidenceDays",
    label: "Raw evidence days",
    hint: "Days before raw evidence is compacted out of an eligible finished run.",
    min: 1,
    max: 365,
  },
  {
    key: "completedRunDays",
    label: "Completed run days",
    hint: "Days before a finished run family may be removed entirely.",
    min: 30,
    max: 3_650,
  },
  {
    key: "maxCompletedRuns",
    label: "Newest completed runs kept",
    hint: "This many newest finished runs are kept whatever their age.",
    min: 100,
    max: 10_000,
  },
] as const satisfies readonly {
  key: keyof RetentionDraft;
  label: string;
  hint: string;
  min: number;
  max: number;
}[];

/**
 * The typed retention boxes as numbers, or the sentence saying which one is out of range.
 *
 * Pure, and exported, because the interesting cases cannot be reached by rendering: a
 * static render types nothing, and this is the gate deciding whether a shortening confirm
 * is even offered.
 */
export function readRetention(
  draft: RetentionDraft,
): { ok: true; value: WorkflowConfig["retention"] } | { ok: false; error: string } {
  const out = {} as WorkflowConfig["retention"];
  for (const field of RETENTION_FIELDS) {
    const value = Number(draft[field.key]);
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      return {
        ok: false,
        error: `${field.label} must be a whole number between ${field.min} and ${field.max}.`,
      };
    }
    out[field.key] = value;
  }
  return { ok: true, value: out };
}

/** Whether the new limits would let the next sweep remove more than the current ones. */
export function retentionShortens(
  next: WorkflowConfig["retention"],
  current: WorkflowConfig["retention"],
): boolean {
  return RETENTION_FIELDS.some((field) => next[field.key] < current[field.key]);
}

export function WorkflowSettingsPanel({
  state,
}: {
  state: WorkflowSettingsState;
}): React.JSX.Element {
  const { config, status, update, error } = state;
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [retention, setRetention] = useState<RetentionDraft>({
    rawEvidenceDays: "",
    completedRunDays: "",
    maxCompletedRuns: "",
  });
  // Adopt the daemon's values once, when the first read lands. Keyed on the config object
  // rather than on its numbers so a later poll cannot overwrite a half-typed box - the
  // boxes are a draft the operator applies, not a mirror of what is stored.
  const [adopted, setAdopted] = useState(false);
  useEffect(() => {
    if (config && !adopted) {
      setRetention(draftOf(config));
      setAdopted(true);
    }
  }, [config, adopted]);

  const liveEnabled = config?.liveEnabled ?? false;
  const allowlist = config?.repoAllowlist ?? [];

  const save = async (next: WorkflowConfig): Promise<void> => {
    setBusy(true);
    setLocalError(null);
    try {
      await update(next);
    } finally {
      setBusy(false);
    }
  };

  const toggleLive = (enabled: boolean): void => {
    if (!config) return;
    if (!enabled) {
      void save({ ...config, liveEnabled: false });
      return;
    }
    setConfirm({
      title: "Enable Live workflow delivery",
      body:
        "Mission Control may paste deterministic Persona repair instructions into agent " +
        "sessions running in the allowlisted repositories below. Preview bindings stay " +
        "read-only.",
      confirmLabel: "Enable Live delivery",
      confirmHint: "Allow repair packets to be typed into allowlisted sessions",
      onConfirm: () => void save({ ...config, liveEnabled: true }),
    });
  };

  const addRepo = async (): Promise<void> => {
    const trimmed = path.trim();
    if (!config || !trimmed || busy) return;
    setBusy(true);
    setLocalError(null);
    try {
      const resolved = await resolveRepo(trimmed);
      if (!resolved.ok) {
        setLocalError(resolved.error);
        return;
      }
      if (config.repoAllowlist.includes(resolved.repoRoot)) {
        setLocalError(`${resolved.repoRoot} is already allowed.`);
        return;
      }
      setPath("");
      await update({ ...config, repoAllowlist: [...config.repoAllowlist, resolved.repoRoot] });
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "Could not resolve repository");
    } finally {
      setBusy(false);
    }
  };

  const applyRetention = (): void => {
    if (!config || busy) return;
    const read = readRetention(retention);
    if (!read.ok) {
      setLocalError(read.error);
      return;
    }
    setLocalError(null);
    const next = { ...config, retention: read.value };
    if (!retentionShortens(read.value, config.retention)) {
      void save(next);
      return;
    }
    setConfirm({
      title: "Shorten Workflow retention",
      body:
        "The next sweep can permanently compact evidence, or delete eligible completed and " +
        "cancelled run history, that today's limits would have kept. Active, waiting, " +
        "blocked, failed, orphaned and delivery-uncertain work is never age-pruned.",
      confirmLabel: "Shorten retention",
      confirmHint: "Save the shorter limits and let the next sweep act on them",
      danger: true,
      onConfirm: () => void save(next),
    });
  };

  return (
    <section className="settings-section">
      <p className="settings-hint">
        Review workflows run Personas over a session's submitted work and route their
        verdicts back to it. What is configured here is the subsystem: whether repairs may be
        typed into a live session, where that is allowed, and how much run history is kept.
        The workflows themselves - stages, Personas, bindings - are authored on the{" "}
        <strong>Workflows</strong> page.
      </p>

      {/* The daemon has not answered. Said out loud, on the Inspector panel's rule: the
          fallbacks below are "off" and "no repos", the safe posture, and drawing them as
          the daemon's answer tells the operator nothing can be pasted anywhere while the
          stored config may well have Live enabled. */}
      {!config && (
        <p className="settings-warn wf-settings-unknown">
          Can't reach the daemon, so what Workflow delivery is actually set to is unknown.
          The controls below are showing defaults, not its current state.
        </p>
      )}

      <Tooltip label="Allow repair packets to be typed into sessions in the repositories below">
        <label className="alert-row wf-settings-live" data-anchor="workflows/live-delivery">
          <input
            type="checkbox"
            checked={liveEnabled}
            disabled={!config || busy}
            onChange={(event) => toggleLive(event.target.checked)}
          />
          <span>Enable Live workflow delivery</span>
        </label>
      </Tooltip>

      {liveEnabled && (
        <p className="settings-warn wf-settings-live-warn">
          Live bindings write into a real terminal pane. A repair packet is typed into the
          agent's own composer, in the repositories listed below and nowhere else.
        </p>
      )}

      <div className="wf-settings-repos" data-anchor="workflows/allowlist">
        <p className="settings-group-label">Allowed repositories</p>
        {/* The scope-of-consent sentence sits with the list, not with the switch: it is
            about the grant. "I turned Live on and it still previews" reads as a bug
            without it. */}
        <p className="settings-hint">
          Live delivery only sends in these repositories - their worktrees count too,
          wherever they live on disk. Removing one keeps existing bindings visible and
          refuses their next delivery; nothing is silently downgraded to Preview.
        </p>
        {!config ? null : allowlist.length === 0 ? (
          <p className="settings-hint wf-settings-empty">
            No repositories yet - Live delivery has nowhere to send.
          </p>
        ) : (
          <ul className="wf-settings-repo-list">
            {allowlist.map((repo) => (
              <li key={repo}>
                <code>{repo}</code>
                <Tooltip label={`Stop Live delivery from sending in ${repo}`}>
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => void save({
                      ...config,
                      repoAllowlist: config.repoAllowlist.filter((item) => item !== repo),
                    })}
                  >
                    Remove
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
        <div className="wf-settings-add">
          <label className="sr-only" htmlFor="workflow-allowlist-path">
            Repository path to allow
          </label>
          <input
            id="workflow-allowlist-path"
            className="field-input"
            value={path}
            disabled={!config || busy}
            placeholder="/path/to/repository"
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addRepo();
            }}
          />
          <Tooltip label="Resolve this path to its repository root and allow Live delivery there">
            <button
              className="btn"
              disabled={!config || busy || !path.trim()}
              onClick={() => void addRepo()}
            >
              Add repository
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="wf-settings-retention" data-anchor="workflows/retention">
        <p className="settings-group-label">Run retention</p>
        <p className="settings-hint">
          Active, waiting, blocked, failed, orphaned and delivery-uncertain work is never
          age-pruned. Completed and cancelled runs go through the two stages below.
        </p>
        <div className="wf-settings-retention-grid">
          {RETENTION_FIELDS.map((field) => (
            <Tooltip key={field.key} label={field.hint}>
              <label>
                <span>{field.label}</span>
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  value={retention[field.key]}
                  disabled={!config || busy}
                  onChange={(event) => setRetention((draft) => ({
                    ...draft,
                    [field.key]: event.target.value,
                  }))}
                />
              </label>
            </Tooltip>
          ))}
        </div>
        <Tooltip label="Save these retention limits - shortening one asks first">
          <button className="btn" disabled={!config || busy} onClick={applyRetention}>
            Apply retention
          </button>
        </Tooltip>
      </div>

      <div className="wf-settings-health" data-anchor="workflows/health">
        <p className="settings-group-label">Workflow health</p>
        <p className="settings-hint">
          Counters only, refreshed while this panel is open. No prompt, diff, transcript,
          Persona guidance, model output or delivery payload passes through here.
        </p>
        {status ? (
          <dl className="wf-settings-health-grid">
            <div><dt>Retained runs</dt><dd>{status.retainedRunCount}</dd></div>
            <div><dt>Active runs</dt><dd>{status.activeRuns}</dd></div>
            <div><dt>Queued Persona calls</dt><dd>{status.queuedPersonaCalls}</dd></div>
            <div><dt>Running Persona calls</dt><dd>{status.runningPersonaCalls}</dd></div>
            <div><dt>Waiting deliveries</dt><dd>{status.waitingDeliveries}</dd></div>
            <div><dt>Uncertain deliveries</dt><dd>{status.uncertainDeliveries}</dd></div>
            <div><dt>Inspector gates</dt><dd>{status.inspectorGates}</dd></div>
            <div>
              <dt>Last recovery</dt>
              <dd>
                {status.lastRecoveryAt
                  ? new Date(status.lastRecoveryAt).toLocaleString()
                  : "Not yet run"}
              </dd>
            </div>
            <div>
              <dt>Last retention sweep</dt>
              <dd>
                {status.lastRetentionAt
                  ? new Date(status.lastRetentionAt).toLocaleString()
                  : "Not yet run"}
              </dd>
            </div>
            <div><dt>Last compacted</dt><dd>{status.lastRetentionCompacted}</dd></div>
            <div><dt>Last deleted</dt><dd>{status.lastRetentionDeleted}</dd></div>
            <div><dt>Last sweep error</dt><dd>{status.lastRetentionError ?? "None"}</dd></div>
          </dl>
        ) : (
          // "has not answered", not "has not answered YET": a null status is the pre-poll
          // instant AND a daemon that has stopped answering, and the second is the one
          // where a still-loading sentence would be read as a delay rather than a gap.
          <p className="settings-hint wf-settings-empty">
            Workflow health is unavailable - the daemon has not answered.
          </p>
        )}
      </div>

      {(localError ?? error) && (
        <p className="settings-error" role="alert">{localError ?? error}</p>
      )}

      {confirm && (
        <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />
      )}
    </section>
  );
}
