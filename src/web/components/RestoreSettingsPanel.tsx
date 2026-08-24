import { useEffect, useRef } from "react";
import {
  SETTINGS_RESTORE_CONFIRMATION,
  type SettingsBackupPublicItem,
  type SettingsRestorePreview,
} from "@shared/settings-backups.ts";
import {
  canSubmitSettingsRestore,
  type SettingsRestoreActions,
  type SettingsRestoreState,
  useSettingsRestore,
} from "../useSettingsRestore.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

function when(value: string | null): string {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function bytes(value: number | null): string {
  if (value === null) return "Unknown size";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
}

function snapshotLabel(item: SettingsBackupPublicItem): string {
  return item.status === "ready"
    ? `${item.kind === "daily" ? "Daily" : "Safety"} snapshot from ${when(item.createdAt)}`
    : `Unavailable snapshot ${item.id}`;
}

function ChangeCount({ label, value }: { label: string; value: number }): React.JSX.Element {
  return <li><span>{label}</span><strong>{value}</strong></li>;
}

function RestorePreview({ preview }: { preview: SettingsRestorePreview }): React.JSX.Element {
  const catalogChanges = [
    ["Personas", preview.personas.added + preview.personas.changed + preview.personas.archived + preview.personas.reactivated],
    ["Session actions", preview.sessionActions.added + preview.sessionActions.changed + preview.sessionActions.archived + preview.sessionActions.reactivated],
    ["Workflow commands", preview.workflowCommandsChanged],
    ["Workflows", preview.workflows.added + preview.workflows.changed + preview.workflows.archived + preview.workflows.reactivated],
    ["Workflow versions inserted", preview.workflowVersions.inserted],
  ] as const;
  return (
    <section className="restore-preview" aria-labelledby="restore-preview-title">
      <div className="restore-preview-head">
        <div>
          <span className="restore-eyebrow">Verified preview</span>
          <h3 id="restore-preview-title">What this restore changes</h3>
        </div>
        <span className={preview.blockers.length ? "restore-badge blocked" : "restore-badge ready"}>
          {preview.blockers.length ? "Blocked" : "Ready"}
        </span>
      </div>

      <ol className="restore-sequence" aria-label="Restore sequence">
        <li><span>1</span><strong>Read verified snapshot</strong></li>
        <li><span>2</span><strong>Capture safety snapshot</strong></li>
        <li><span>3</span><strong>Rebuild current settings</strong></li>
      </ol>

      <div className="restore-preview-grid">
        <div>
          <h4>Settings domains</h4>
          <ul className="restore-tag-list">
            {preview.settingsDomains.map((domain) => <li key={domain}>{domain.replaceAll("-", " ")}</li>)}
          </ul>
        </div>
        <div>
          <h4>Catalog changes</h4>
          <ul className="restore-count-list">
            {catalogChanges.map(([label, value]) => <ChangeCount key={label} label={label} value={value} />)}
          </ul>
        </div>
      </div>

      {preview.externalEffects.length > 0 && (
        <div className="restore-note">
          <strong>Reconciliation after commit</strong>
          <p>{preview.externalEffects.join(" and ")} will be reconciled from the restored settings.</p>
        </div>
      )}
      <div className="restore-note">
        <strong>Not restored</strong>
        <ul>{preview.exclusions.map((item) => <li key={item}>{item}</li>)}</ul>
      </div>
      {preview.warnings.length > 0 && (
        <div className="restore-alert" role="alert">
          <strong>Warnings</strong>
          <ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      )}
      {preview.blockers.length > 0 && (
        <div className="restore-alert" role="alert">
          <strong>Resolve before restoring</strong>
          <ul>{preview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

export function RestoreSettingsPanelView({
  state,
  actions,
}: {
  state: SettingsRestoreState;
  actions: SettingsRestoreActions;
}): React.JSX.Element {
  const restoreButton = useRef<HTMLButtonElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const ready = state.list?.snapshots.filter((item) => item.status === "ready") ?? [];
  const unavailable = state.list?.snapshots.filter((item) => item.status !== "ready") ?? [];
  const selected = ready.find((item) => item.id === state.selectedId) ?? null;
  const preview = state.preview?.status === "ready" || state.preview?.status === "preflight_blocked"
    ? state.preview.preview
    : null;

  useEffect(() => {
    if (state.error || state.result) feedback.current?.focus();
  }, [state.error, state.result]);

  const closeDialog = (): void => {
    actions.closeDialog();
    restoreButton.current?.focus();
  };

  return (
    <section className="settings-section restore-settings" data-anchor="restore/snapshots">
      <p className="settings-hint settings-blurb">
        Mission Control keeps one owner-only snapshot per day in its local state directory.
        Choose a verified snapshot, inspect the bounded preview, then confirm the restore.
      </p>

      <div className="restore-status-grid" aria-label="Automatic backup status">
        <article>
          <span>Automatic backups</span>
          <strong>{state.list?.lastError ? "Needs attention" : state.list ? "Healthy" : "Checking"}</strong>
        </article>
        <article>
          <span>Retention</span>
          <strong>{state.list ? `${state.list.retention.daily} daily + ${state.list.retention.preRestore} safety` : "Checking"}</strong>
        </article>
        <article>
          <span>Last successful snapshot</span>
          <strong>{when(state.list?.lastSuccessfulSnapshot?.createdAt ?? null)}</strong>
        </article>
      </div>

      {state.list?.lastError && (
        <div className="restore-alert" role="alert">
          <strong>Last automatic backup failed</strong>
          <p>{state.list.lastError.message}</p>
        </div>
      )}
      {state.listError && (
        <div className="restore-alert restore-retry" role="alert">
          <div><strong>Snapshots could not be loaded</strong><p>{state.listError}</p></div>
          <Tooltip label="Try loading the settings snapshot history again">
            <button type="button" className="btn btn-ghost" onClick={actions.reload}>Retry</button>
          </Tooltip>
        </div>
      )}
      {state.error && (
        <div className="restore-alert" role="alert" tabIndex={-1} ref={feedback}>
          <strong>Restore could not continue</strong>
          <p>{state.error}</p>
        </div>
      )}
      {state.result && (
        <div className="restore-success" role="status" tabIndex={-1} ref={feedback}>
          <strong>Settings restored</strong>
          <p>Safety snapshot {state.result.safetySnapshotId} was captured before the change.</p>
        </div>
      )}

      <div className="restore-list-head">
        <div><span className="restore-eyebrow">Owner-only local history</span><h3>Settings snapshots</h3></div>
        <Tooltip label="Refresh the verified settings snapshot history">
          <button type="button" className="btn btn-ghost" onClick={actions.reload} disabled={state.loading}>
            {state.loading ? "Refreshing…" : "Refresh"}
          </button>
        </Tooltip>
      </div>

      {state.loading && !state.list ? (
        <p className="restore-empty" role="status">Loading settings snapshots…</p>
      ) : state.list && state.list.snapshots.length === 0 ? (
        <p className="restore-empty">No settings snapshots are available yet. The first is captured after the daemon starts.</p>
      ) : (
        <div className="restore-table-wrap">
          <table className="restore-table">
            <caption>Settings snapshots, newest first</caption>
            <thead><tr><th scope="col">Use</th><th scope="col">Snapshot</th><th scope="col">Contents</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {state.list?.snapshots.map((item) => (
                <tr key={item.id} className={item.id === state.selectedId ? "selected" : undefined}>
                  <td>
                    <Tooltip label={item.status === "ready" ? "Select this verified snapshot" : `This snapshot is unavailable: ${item.reason}`}>
                      <input
                        type="radio"
                        name="restore-snapshot"
                        aria-label={`Select ${snapshotLabel(item)}`}
                        checked={item.id === state.selectedId}
                        disabled={item.status !== "ready" || state.restoring}
                        onChange={() => actions.select(item.id)}
                      />
                    </Tooltip>
                  </td>
                  <td><strong>{item.status === "ready" ? when(item.createdAt) : item.id}</strong><small>{bytes(item.size)}</small></td>
                  <td>{item.status === "ready" ? `${item.counts.personas} personas · ${item.counts.workflowDefinitions} workflows` : "Metadata only"}</td>
                  <td>{item.status === "ready" ? <span className="restore-badge ready">Verified</span> : <span className="restore-badge blocked">Unavailable</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unavailable.length > 0 && (
        <details className="restore-unavailable">
          <Tooltip label="Show why these snapshots cannot be restored">
            <summary>{unavailable.length} unavailable snapshot{unavailable.length === 1 ? "" : "s"}</summary>
          </Tooltip>
          <ul>{unavailable.map((item) => <li key={item.id}><strong>{item.id}</strong>: {item.reason}</li>)}</ul>
        </details>
      )}

      <div className="restore-primary-action">
        <div>
          <strong>{selected ? snapshotLabel(selected) : "Choose a verified snapshot"}</strong>
          <span>The preview never exposes raw settings values.</span>
        </div>
        <Tooltip label="Verify the selected snapshot and preview its bounded changes">
          <button type="button" className="btn btn-primary" onClick={actions.preview} disabled={!selected || state.previewing || state.restoring}>
            {state.previewing ? "Building preview…" : "Preview restore"}
          </button>
        </Tooltip>
      </div>

      {preview && <RestorePreview preview={preview} />}
      {state.preview && state.preview.status !== "ready" && state.preview.status !== "preflight_blocked" && (
        <div className="restore-alert" role="alert"><strong>Snapshot cannot be restored</strong><p>{state.preview.reason}</p></div>
      )}
      {state.preview?.status === "ready" && (
        <div className="restore-confirm-row">
          <div><strong>Preview verified</strong><span>A fresh safety snapshot is captured before commit.</span></div>
          <Tooltip label="Open the final restore confirmation">
            <button ref={restoreButton} type="button" className="btn btn-danger" onClick={actions.openDialog}>Restore settings</button>
          </Tooltip>
        </div>
      )}

      {state.dialogOpen && selected && state.preview?.status === "ready" && (
        <Overlay
          id={OVERLAY_IDS.restoreSettings}
          onClose={closeDialog}
          className="modal restore-confirm-modal"
          role="dialog"
          ariaLabel="Confirm settings restore"
          ariaModal
          closable={!state.restoring}
        >
          <div className="modal-head"><div><span className="restore-eyebrow">Final confirmation</span><h3>Replace current settings?</h3></div></div>
          <div className="modal-body">
            <p>This restores <strong>{snapshotLabel(selected)}</strong> and rebuilds settings and Library catalogs in this daemon.</p>
            <div className="restore-note"><strong>Safety first</strong><p>A pre-restore snapshot is captured automatically. Tasks, runs, sessions, reviews, repositories, credentials, and archives are not replaced.</p></div>
            <label className="restore-confirm-label" htmlFor="restore-confirmation">
              Type <code>{SETTINGS_RESTORE_CONFIRMATION}</code> to continue
            </label>
            <input
              autoFocus
              id="restore-confirmation"
              value={state.confirmation}
              onChange={(event) => actions.setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={state.restoring}
            />
          </div>
          <div className="modal-foot">
            <Tooltip label="Close without restoring settings">
              <button type="button" className="btn btn-ghost" onClick={closeDialog} disabled={state.restoring}>Cancel</button>
            </Tooltip>
            <Tooltip label="Capture a safety snapshot and restore the verified settings">
              <button type="button" className="btn btn-danger" onClick={actions.restore} disabled={!canSubmitSettingsRestore(state)}>
                {state.restoring ? "Restoring…" : "Restore settings"}
              </button>
            </Tooltip>
          </div>
        </Overlay>
      )}
    </section>
  );
}

export function RestoreSettingsPanel(): React.JSX.Element {
  const restore = useSettingsRestore();
  return <RestoreSettingsPanelView {...restore} />;
}
