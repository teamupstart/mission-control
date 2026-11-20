import { useState } from "react";
import { SHAPING_LIMIT_RANGES, type ShapingConfigView, type ShapingIntent, type ShapingReferenceStatus } from "@shared/shaping.ts";
import {
  moveShaper,
  shaperEnvironmentStatus,
  shaperReachSummary,
  shapingList,
  type ShapingListGroup,
  type ShapingListRow,
} from "../lib/shaping-settings.ts";
import { ShapingImportDialog, ShapingTestDialog, type ShapingTestRunner } from "./TaskShapingDialogs.tsx";
import { Tooltip } from "./Tooltip.tsx";

const STAGE_COPY: Record<NonNullable<ShapingListGroup["stage"]> | "unsupported", { title: string; hint: string }> = {
  gather: { title: "Gather", hint: "Read each repository and report facts and a summary. They run first." },
  select: { title: "Select", hint: "Choose guidance for the task, with what the gatherers found." },
  unsupported: { title: "Not supported by this build", hint: "Kept exactly as stored and never called. Switch one off or remove it." },
};

const TRANSPORT_LABEL = { command: "Command", mcp: "MCP", http: "HTTP", builtin: "Built in" } as const;

/**
 * Settings > Task shaping, drawn from props alone so a static render can show any state. The
 * panel around it owns the event-stream state and the fetches.
 *
 * Every control writes on click, one write at a time, and shows its change at once; a refused
 * write rolls back and leaves the daemon's reason beside the control that sent it.
 */
export function TaskShapingView({
  config,
  references = {},
  pending = null,
  errors = {},
  ready = true,
  onSet,
  onTest,
  repositories,
  live = null,
}: {
  /** Null while the config has not arrived. */
  config: ShapingConfigView | null;
  references?: ShapingReferenceStatus;
  pending?: ShapingIntent | null;
  errors?: Record<string, string>;
  ready?: boolean;
  onSet: (intent: ShapingIntent, key: string) => Promise<boolean>;
  onTest: ShapingTestRunner;
  /** The repositories a dry run may pick from. */
  repositories: () => Promise<string[]>;
  /**
   * Ids of shapers that exist but the list does not draw, such as the folder's, so a move keeps
   * their place. Null until that inventory is known; while it is null, no stored entry is dropped.
   */
  live?: readonly string[] | null;
}): React.JSX.Element {
  const [importing, setImporting] = useState(false);
  const [testing, setTesting] = useState<{ id: string; label: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // A move the stored order cannot hold, refused here before anything is sent.
  const [moveProblem, setMoveProblem] = useState<{ id: string; reason: string } | null>(null);
  const move = (id: string, offset: -1 | 1): void => {
    const result = config && moveShaper(config, id, offset, live);
    if (!result) return;
    if (!result.ok) {
      setMoveProblem({ id, reason: result.reason });
      return;
    }
    setMoveProblem(null);
    void onSet({ kind: "reorder", order: result.order }, `row:${id}`);
  };
  const busy = !ready || pending !== null || config === null;
  const groups = config ? shapingList(config) : [];
  const count = config?.shapers.length ?? 0;

  const row = (entry: ShapingListRow, group: ShapingListGroup, at: number): React.JSX.Element => {
    const key = `row:${entry.id}`;
    const shaper = entry.shaper;
    const environment = shaper ? shaperEnvironmentStatus(shaper, references) : [];
    // An entry that cannot run may only be switched off, never on (`plan.md`).
    const canSwitch = entry.on || entry.problem === null;
    const confirmRemove = removing === entry.id;
    return (
      <div className="shaping-row" key={entry.id} data-anchor={`task-shaping/${entry.id}`} role="group" aria-label={entry.label}>
        <div className="shaping-row-copy">
          <div className="shaping-row-title">
            <strong>{entry.label}</strong>
            <code className="shaping-row-id">{entry.id}</code>
            <span className="shaping-chip">{entry.origin === "registered" ? "Registered" : "Found on disk"}</span>
            {shaper && <span className="shaping-chip">{TRANSPORT_LABEL[shaper.transport.type]}</span>}
          </div>
          {shaper && <p className="shaping-row-reach">{shaperReachSummary(shaper)}</p>}
          {entry.path && <p className="shaping-row-path">{entry.path}</p>}
          {environment.length > 0 && (
            <ul className="shaping-env" aria-label={`Environment variables ${entry.label} names`}>
              {environment.map(({ name, status }) => (
                <li key={name} className={status ? `is-${status}` : undefined}>
                  <code>{name}</code>
                  {status && <span>{status === "set" ? "set" : "not set"}</span>}
                </li>
              ))}
            </ul>
          )}
          {entry.problem && <p className="shaping-row-problem">{entry.problem}</p>}
          {errors[key] && <p role="alert">{errors[key]}</p>}
          {moveProblem?.id === entry.id && <p role="alert">{moveProblem.reason}</p>}
        </div>
        <div className="shaping-row-actions">
          {group.stage !== null && (
            <>
              <Tooltip label="Run it earlier in its stage">
                <button type="button" className="btn btn-ghost shaping-move" aria-label={`Move ${entry.label} up`}
                  disabled={busy || at === 0}
                  onClick={() => move(entry.id, -1)}>↑</button>
              </Tooltip>
              <Tooltip label="Run it later in its stage">
                <button type="button" className="btn btn-ghost shaping-move" aria-label={`Move ${entry.label} down`}
                  disabled={busy || at === group.rows.length - 1}
                  onClick={() => move(entry.id, 1)}>↓</button>
              </Tooltip>
              <Tooltip label="Run this shaper once against a repository and see what it would add. Nothing is saved.">
                <button type="button" className="btn btn-ghost" aria-label={`Dry-run ${entry.label}`} disabled={!ready}
                  onClick={() => setTesting({ id: entry.id, label: entry.label })}>Dry run</button>
              </Tooltip>
            </>
          )}
          {entry.origin === "registered" && (confirmRemove ? (
            <>
              <Tooltip label="Keep this shaper">
                <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>Keep</button>
              </Tooltip>
              <Tooltip label="Delete this shaper's stored definition and its on or off choice">
                <button type="button" className="btn btn-danger" aria-label={`Confirm removing ${entry.label}`} disabled={busy}
                  onClick={() => { setRemoving(null); void onSet({ kind: "remove", id: entry.id }, key); }}>Remove</button>
              </Tooltip>
            </>
          ) : (
            <Tooltip label="Remove this shaper. Asks once more first.">
              <button type="button" className="btn btn-ghost" aria-label={`Remove ${entry.label}`} disabled={busy}
                onClick={() => setRemoving(entry.id)}>Remove</button>
            </Tooltip>
          ))}
          <Tooltip label={!canSwitch
            ? "This build cannot run it, so it cannot be switched on."
            : entry.problem !== null
              ? "Stored on, but this build never runs it. Switch it off."
              : `Switch ${entry.label} ${entry.on ? "off" : "on"} immediately in every window.`}>
            <button type="button" className={`settings-grant ${entry.on ? "is-on" : "is-off"}`}
              disabled={busy || !canSwitch} aria-label={`${entry.label}: ${entry.on ? "on" : "off"}`} aria-pressed={entry.on}
              onClick={() => void onSet({ kind: "enable", id: entry.id, enabled: !entry.on }, key)}>
              <span className="settings-grant-dot" aria-hidden />{entry.on ? "On" : "Off"}
            </button>
          </Tooltip>
        </div>
      </div>
    );
  };

  return (
    <section className="settings-section task-shaping" aria-label="Task shaping">
      <p className="settings-hint">
        Shapers are programs and services that gather context about a task&apos;s repositories and choose
        guidance for it. A shaper you register is stored switched off: dry-run it, then switch it on. Every
        change applies at once in every open window.
      </p>
      {config && <ShapingSettingsForm config={config} busy={busy} error={errors.settings ?? null} onSet={onSet} />}
      <div className="feature-flag-list shaping-list" data-anchor="task-shaping/shapers">
        <div className="settings-pane-head shaping-list-head">
          <div className="settings-pane-title-row">
            <h3 className="settings-pane-title">Shapers</h3>
            <span className="settings-pane-count">{count}</span>
          </div>
          <span data-anchor="task-shaping/import">
            <Tooltip label="Paste or choose a shaper manifest and review what it runs or calls before saving it">
              <button type="button" className="btn" disabled={busy} onClick={() => setImporting(true)}>Import manifest…</button>
            </Tooltip>
          </span>
        </div>
        {config === null && <p className="feature-flag-empty">Loading shapers…</p>}
        {config !== null && count === 0 && (
          <p className="feature-flag-empty">No shapers registered. Import a manifest to add one.</p>
        )}
        {config !== null && count > 0 && groups.map((group) => {
          const copy = STAGE_COPY[group.stage ?? "unsupported"];
          return (
            <div className="shaping-stage" key={group.stage ?? "unsupported"} role="group" aria-label={copy.title}>
              <div className="shaping-stage-head">
                <h4>{copy.title}</h4>
                <p>{copy.hint}</p>
              </div>
              {group.rows.length === 0
                ? <p className="feature-flag-empty">None at this stage.</p>
                : group.rows.map((entry, at) => row(entry, group, at))}
            </div>
          );
        })}
      </div>
      {importing && config && (
        <ShapingImportDialog config={config} busy={busy} error={errors.import ?? null}
          onClose={() => setImporting(false)}
          onSave={async (shaper) => {
            const saved = await onSet({ kind: "upsert", shaper }, "import");
            if (saved) setImporting(false);
          }} />
      )}
      {testing && (
        <ShapingTestDialog id={testing.id} label={testing.label} repositories={repositories} onTest={onTest}
          onClose={() => setTesting(null)} />
      )}
    </section>
  );
}

type SettingsIntent = Extract<ShapingIntent, { kind: "settings" }>;

/**
 * The budget as the field shows it: whole KiB as written, otherwise to three decimals. The text is
 * for reading, not for storing: a budget saved through the API need not be a whole number of KiB,
 * so the form keeps the stored byte count until the operator edits this field.
 */
function kib(bytes: number): string {
  const value = bytes / 1024;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

/** The form's three fields, as typed. */
interface SettingsFields {
  user: string;
  deadlineMs: string;
  totalKiB: string;
}

/**
 * The caller identity and the two budgets. A field the operator types in holds a draft until it
 * is saved; every other field keeps showing the confirmed config, so a change another window
 * makes appears here at once. A save sends only the fields typed in here, so it never writes this
 * window's stale copy of a value another window has changed since.
 */
function ShapingSettingsForm({ config, busy, error, onSet }: {
  config: ShapingConfigView;
  busy: boolean;
  error: string | null;
  onSet: (intent: ShapingIntent, key: string) => Promise<boolean>;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Partial<SettingsFields>>({});
  const confirmed: SettingsFields = { user: config.caller.user, deadlineMs: String(config.limits.deadlineMs), totalKiB: kib(config.limits.totalBytes) };
  const shown: SettingsFields = { ...confirmed, ...draft };
  const deadline = SHAPING_LIMIT_RANGES.deadlineMs;
  const total = SHAPING_LIMIT_RANGES.totalBytes;
  const deadlineMs = Number(shown.deadlineMs);
  // An untouched field keeps the exact stored bytes: its text is a rounded rendering of them, and
  // reading that text back would silently rewrite, say, 1,025 bytes as 1,024 on an unrelated save.
  const totalBytes = shown.totalKiB === kib(config.limits.totalBytes)
    ? config.limits.totalBytes
    : Math.round(Number(shown.totalKiB) * 1024);
  const deadlineProblem = shown.deadlineMs.trim() === "" || !Number.isInteger(deadlineMs) || deadlineMs < deadline.min || deadlineMs > deadline.max
    ? `A whole number of milliseconds from ${deadline.min} to ${deadline.max.toLocaleString()}.` : null;
  const totalProblem = shown.totalKiB.trim() === "" || !Number.isFinite(totalBytes) || totalBytes < total.min || totalBytes > total.max
    ? `From ${total.min / 1024} to ${total.max / 1024} KiB.` : null;
  const userProblem = shown.user.trim().length > 256 ? "At most 256 characters." : null;
  // Only a field typed in here counts as a change, so an untouched field is never sent.
  const changed = {
    user: draft.user !== undefined && shown.user.trim() !== config.caller.user,
    deadlineMs: draft.deadlineMs !== undefined && deadlineMs !== config.limits.deadlineMs,
    totalBytes: draft.totalKiB !== undefined && totalBytes !== config.limits.totalBytes,
  };
  const dirty = changed.user || changed.deadlineMs || changed.totalBytes;
  const edited = Object.keys(draft).length > 0;
  const valid = !deadlineProblem && !totalProblem && !userProblem;
  const edit = (patch: Partial<SettingsFields>) => setDraft((current) => ({ ...current, ...patch }));
  const save = async (): Promise<void> => {
    const intent: SettingsIntent = { kind: "settings" };
    if (changed.user) intent.caller = { user: shown.user.trim() };
    const limits: NonNullable<SettingsIntent["limits"]> = {};
    if (changed.deadlineMs) limits.deadlineMs = deadlineMs;
    if (changed.totalBytes) limits.totalBytes = totalBytes;
    if (Object.keys(limits).length > 0) intent.limits = limits;
    // Saved or refused, the fields go back to showing the daemon's config: a refusal is a
    // roll back, with its reason below.
    await onSet(intent, "settings");
    setDraft({});
  };
  return (
    <form className="shaping-settings" aria-label="Caller identity and budgets"
      onSubmit={(event) => { event.preventDefault(); if (dirty && valid && !busy) void save(); }}>
      <div className="shaping-field" data-anchor="task-shaping/identity">
        <label htmlFor="shaping-caller-user">Caller identity</label>
        <input id="shaping-caller-user" className="field-input" type="text" value={shown.user} placeholder="you@example.com" maxLength={300}
          disabled={busy} onChange={(event) => edit({ user: event.target.value })} aria-describedby="shaping-caller-user-hint" />
        <p className="settings-hint" id="shaping-caller-user-hint">
          Sent to shapers that reference {"{caller.user}"}. Declared, not verified, and not a secret.
        </p>
        {userProblem && <p className="shaping-field-problem">{userProblem}</p>}
      </div>
      <div className="shaping-field-row" data-anchor="task-shaping/limits">
        <div className="shaping-field">
          <label htmlFor="shaping-deadline">Step deadline (ms)</label>
          <input id="shaping-deadline" className="field-input" type="number" inputMode="numeric" min={deadline.min} max={deadline.max} step={1}
            value={shown.deadlineMs} disabled={busy} onChange={(event) => edit({ deadlineMs: event.target.value })}
            aria-describedby="shaping-deadline-hint" />
          <p className="settings-hint" id="shaping-deadline-hint">
            How long all shapers together may take for one task, at most {deadline.max / 1000} s.
          </p>
          {deadlineProblem && <p className="shaping-field-problem">{deadlineProblem}</p>}
        </div>
        <div className="shaping-field">
          <label htmlFor="shaping-total">Context budget (KiB)</label>
          <input id="shaping-total" className="field-input" type="number" inputMode="decimal" min={total.min / 1024} max={total.max / 1024} step="any"
            value={shown.totalKiB} disabled={busy} onChange={(event) => edit({ totalKiB: event.target.value })}
            aria-describedby="shaping-total-hint" />
          <p className="settings-hint" id="shaping-total-hint">
            The most text shaping may add to a worker&apos;s first prompt, at most {total.max / 1024} KiB.
          </p>
          {totalProblem && <p className="shaping-field-problem">{totalProblem}</p>}
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="shaping-settings-actions">
        <Tooltip label="Put back the saved values">
          <button type="button" className="btn btn-ghost" disabled={!edited || busy} onClick={() => setDraft({})}>Reset</button>
        </Tooltip>
        <Tooltip label="Save the caller identity and budgets for every window">
          <button type="submit" className="btn" disabled={!dirty || !valid || busy}>Save</button>
        </Tooltip>
      </div>
    </form>
  );
}
