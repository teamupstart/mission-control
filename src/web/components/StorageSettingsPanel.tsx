import { useEffect, useState } from "react";
import {
  DATABASE_BACKUP_INTERVAL_HOURS,
  DatabaseBackupsConfigPatchSchema,
  type DatabaseBackupKindStatus,
  type DatabaseBackupsConfig,
} from "@shared/database-backups.ts";
import type {
  StorageBackupCopy,
  StorageHealth,
  StorageProblem,
  StorageProblemKind,
} from "@shared/storage-health.ts";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { formatBytes } from "../lib/format.ts";
import { type StorageActions, type StorageState, useStorage } from "../useStorage.ts";
import { Tooltip } from "./Tooltip.tsx";

function when(at: number | null): string {
  if (at === null) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(at));
}

function intervalLabel(hours: number): string {
  return hours === 1 ? "Every hour" : `Every ${hours} hours`;
}

const COPY_KIND_LABEL: Record<StorageBackupCopy["kind"], string> = {
  scheduled: "Scheduled",
  preMigration: "Pre-migration",
  manual: "Manual",
};

const PROBLEM_KIND_LABEL: Record<StorageProblemKind, string> = {
  "backup-failed": "Backup failed",
};

const COUNT_FIELDS = [
  {
    key: "scheduledCount",
    label: "Scheduled copies kept",
    min: 1,
    max: 48,
    hint: "How many scheduled copies are kept, 1 to 48. Older ones are deleted when you save",
  },
  {
    key: "preMigrationCount",
    label: "Pre-migration copies kept",
    min: 1,
    max: 10,
    hint: "How many copies taken before a schema upgrade are kept, 1 to 10",
  },
] as const;

type Draft = Record<keyof DatabaseBackupsConfig, string>;

function draftOf(config: DatabaseBackupsConfig): Draft {
  return {
    scheduledCount: String(config.scheduledCount),
    preMigrationCount: String(config.preMigrationCount),
    intervalHours: String(config.intervalHours),
  };
}

function KindStatus({
  label,
  status,
}: {
  label: string;
  status: DatabaseBackupKindStatus;
}): React.JSX.Element {
  return (
    <article aria-label={`${label} backups`}>
      <span>{label}</span>
      <strong>Last success: {when(status.lastSuccessAt)}</strong>
      {status.lastFailure ? (
        <small className="storage-failure">
          Last failure: {when(status.lastFailure.at)} - {status.lastFailure.message}
        </small>
      ) : (
        <small>No failures recorded</small>
      )}
    </article>
  );
}

function ProblemLink({
  problem,
  onNavigate,
}: {
  problem: StorageProblem;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const { link } = problem;
  switch (link.target) {
    case "backups":
      return (
        <Tooltip label="Show backup status and settings">
          <button type="button" className="btn btn-ghost" onClick={() => onNavigate("storage", "storage/backups")}>
            Open backups
          </button>
        </Tooltip>
      );
  }
}

export function StorageSettingsPanelView({
  state,
  actions,
  onNavigate,
}: {
  state: StorageState;
  actions: StorageActions;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const config = state.view?.config ?? null;
  const [draft, setDraft] = useState<Draft | null>(config ? draftOf(config) : null);
  useEffect(() => {
    if (config) setDraft(draftOf(config));
  }, [config?.scheduledCount, config?.preMigrationCount, config?.intervalHours]);

  // Only the fields edited here: this page's config can be stale after another window saved,
  // and sending an untouched field would put that window's value back.
  const edited = draft && config
    ? Object.fromEntries(
        (["scheduledCount", "preMigrationCount", "intervalHours"] as const)
          .filter((key) => draft[key] !== String(config[key]))
          .map((key) => [key, Number(draft[key])]),
      )
    : null;
  const patch = edited ? DatabaseBackupsConfigPatchSchema.safeParse(edited) : null;
  const changed = Boolean(edited && Object.keys(edited).length > 0);
  const busy = state.saving || state.backingUp;
  const health = state.health;
  const copies = health?.backups.copies ?? [];
  const problems = health?.problems ?? [];

  return (
    <>
      <section className="settings-section storage-settings" data-anchor="storage/backups">
        <h3>Database backups</h3>
        <p className="settings-hint settings-blurb">
          Full copies of Mission Control&apos;s database, kept on this machine. A count is
          never 0, so each kind always keeps its newest copy, and Back up now keeps exactly one
          manual copy outside the scheduled count. Restoring stays offline, through{" "}
          <code>npm run recover:database</code>.
        </p>

        {state.loadError && <p className="settings-error" role="alert">{state.loadError}</p>}
        {state.error && <p className="settings-error" role="alert">{state.error}</p>}
        {state.notice && <p className="settings-hint" role="status">{state.notice}</p>}

        <div className="storage-config-row">
          <Tooltip label="How often a scheduled copy is taken, by wall clock">
            <label>
              <span>Backup interval</span>
              <select
                className="settings-select"
                value={draft?.intervalHours ?? "1"}
                disabled={!draft || busy}
                onChange={(event) => setDraft((current) => current && {
                  ...current,
                  intervalHours: event.target.value,
                })}
              >
                {DATABASE_BACKUP_INTERVAL_HOURS.map((hours) => (
                  <option key={hours} value={String(hours)}>{intervalLabel(hours)}</option>
                ))}
              </select>
            </label>
          </Tooltip>
          {COUNT_FIELDS.map((field) => (
            <Tooltip key={field.key} label={field.hint}>
              <label>
                <span>{field.label}</span>
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  value={draft?.[field.key] ?? ""}
                  disabled={!draft || busy}
                  onChange={(event) => setDraft((current) => current && {
                    ...current,
                    [field.key]: event.target.value,
                  })}
                />
              </label>
            </Tooltip>
          ))}
          <Tooltip label="Save the interval and counts, and delete copies above the new counts">
            <button
              type="button"
              className="btn"
              disabled={!changed || !patch?.success || busy}
              onClick={() => { if (patch?.success) void actions.save(patch.data); }}
            >
              {state.saving ? "Saving…" : "Save"}
            </button>
          </Tooltip>
        </div>
        {draft && patch && !patch.success && (
          <p className="settings-error">Scheduled copies must be 1 to 48, and pre-migration copies 1 to 10.</p>
        )}

        <div className="storage-status-grid" aria-label="Backup status">
          {health ? (
            <>
              <KindStatus label="Scheduled" status={health.backups.status.scheduled} />
              <KindStatus label="Manual" status={health.backups.status.manual} />
              <article aria-label="Total backup size">
                <span>Total size</span>
                <strong>{formatBytes(health.backups.totalBytes)}</strong>
                <small>{copies.length} kept {copies.length === 1 ? "copy" : "copies"}</small>
              </article>
            </>
          ) : (
            <p className="settings-hint" role="status">Checking backups…</p>
          )}
        </div>

        <div className="storage-primary-action">
          <Tooltip label="Take a manual copy of the database now">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void actions.backUpNow()}>
              {state.backingUp ? "Backing up…" : "Back up now"}
            </button>
          </Tooltip>
        </div>

        {copies.length === 0 ? (
          <p className="settings-hint">No copies are kept yet. The first scheduled copy is taken a few minutes after the daemon starts.</p>
        ) : (
          <table className="storage-copies">
            <caption>Kept copies, newest first</caption>
            <thead>
              <tr><th scope="col">Kind</th><th scope="col">Taken</th><th scope="col">Size</th></tr>
            </thead>
            <tbody>
              {copies.map((copy) => (
                <tr key={copy.filename}>
                  <td>{COPY_KIND_LABEL[copy.kind]}</td>
                  <td>{when(copy.at)}</td>
                  <td>{formatBytes(copy.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="settings-section storage-problems" data-anchor="storage/problems">
        <h3>Problems</h3>
        {problems.length === 0 ? (
          <p className="settings-hint">No storage problems.</p>
        ) : (
          <ul className="storage-problem-list" aria-label="Storage problems">
            {problems.map((problem) => (
              <li key={problem.id}>
                <div>
                  <strong>{PROBLEM_KIND_LABEL[problem.kind]}</strong>
                  <span>{problem.message}</span>
                </div>
                <ProblemLink problem={problem} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function StorageSettingsPanel({
  health,
  onNavigate,
}: {
  health: StorageHealth | null;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const { save, backUpNow, ...state } = useStorage(health);
  return (
    <StorageSettingsPanelView
      state={state}
      actions={{ save, backUpNow }}
      onNavigate={onNavigate}
    />
  );
}
