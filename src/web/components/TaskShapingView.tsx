import { useRef, useState } from "react";
import { SHAPING_LIMIT_RANGES, shapingViewHasRevisions, type ShapingConfigView, type ShapingIntent, type ShapingReferenceStatus } from "@shared/shaping.ts";
import {
  moveIntent,
  shaperEnvironmentStatus,
  shaperReach,
  shapingList,
  type ShapingListGroup,
  type ShapingListRow,
} from "../lib/shaping-settings.ts";
import { EarlierRefusals, ShapingImportDialog, ShapingTestDialog, type ShapingTestRunner } from "./TaskShapingDialogs.tsx";
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
  earlier = {},
  outcomeArrivals = {},
  onDismiss,
  ready = true,
  onSet,
  onTest,
  repositories,
  readFolderIds,
}: {
  /** Null while the config has not arrived. */
  config: ShapingConfigView | null;
  references?: ShapingReferenceStatus;
  pending?: ShapingIntent | null;
  errors?: Record<string, string>;
  /** Older refusals under each control, newest first, kept apart from its current one. */
  earlier?: Record<string, string[]>;
  /** When each control's latest outcome arrived, in arrival order. */
  outcomeArrivals?: Record<string, number>;
  /** Clears the outcomes shown under one control, for those drawn above the list. */
  onDismiss?: (key: string) => void;
  ready?: boolean;
  onSet: (intent: ShapingIntent, key: string) => Promise<boolean>;
  onTest: ShapingTestRunner;
  /** The repositories a dry run may pick from. */
  repositories: () => Promise<string[]>;
  /**
   * Reads, now, the ids of the shapers folder's shapers, or null when the read fails. Asked when
   * a removal is confirmed, so the confirmation can say that a folder shaper with the same id
   * stays switched off rather than taking over.
   */
  readFolderIds?: () => Promise<readonly string[] | null>;
}): React.JSX.Element {
  const [importing, setImporting] = useState(false);
  // Numbers each opening of the import dialog. A save answers after the stream may already have
  // freed the dialog, and by then the operator may have closed it and opened a new one: the
  // answer closes only the dialog that sent it.
  const importSession = useRef(0);
  // How far the import outcomes had arrived when the dialog opened: any that arrives after it,
  // from a save sent by a dialog closed meanwhile and an earlier one arriving late included, is
  // shown in the open dialog, which covers the list.
  const importOpenedAt = useRef(0);
  const openImport = (): void => {
    importSession.current += 1;
    importOpenedAt.current = outcomeArrivals.import ?? 0;
    setImporting(true);
  };
  // Each of these is bound to the revision of the entry the operator was shown: when another
  // window replaces that shaper, the confirmation or dialog no longer applies to what is stored,
  // and the daemon refuses any intent still carrying the old revision.
  const [testing, setTesting] = useState<{ id: string; label: string; revision: string | null } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; revision: string | null; folder: boolean | null } | null>(null);
  const confirmRemoval = (entry: ShapingListRow): void => {
    setRemoving({ id: entry.id, revision: entry.revision, folder: null });
    if (!readFolderIds) return;
    void readFolderIds().then((ids) => setRemoving((current) => current?.id === entry.id && current.revision === entry.revision
      ? { ...current, folder: ids === null ? null : ids.includes(entry.id) } : current));
  };
  const busy = !ready || pending !== null || config === null;
  const groups = config ? shapingList(config) : [];
  const listed = new Set(groups.flatMap((group) => group.rows.map((entry) => `row:${entry.id}`)));
  const orphans = config === null ? [] : [...new Set([...Object.keys(errors), ...Object.keys(earlier)])]
    .filter((key) => key.startsWith("row:") && !listed.has(key)).sort();
  const count = config?.shapers.length ?? 0;

  const row = (entry: ShapingListRow, group: ShapingListGroup, at: number): React.JSX.Element => {
    if (entry.duplicate) {
      // A repeat of an id an earlier entry owns: information only. Every intent naming this id,
      // and every revision, belongs to the owning row, so no control here can act on it.
      return (
        <div className="shaping-row" key={`${entry.id}:repeat:${at}`} role="group" aria-label={`${entry.label} (repeated id)`}>
          <div className="shaping-row-copy">
            <div className="shaping-row-title">
              <strong>{entry.label}</strong>
              <code className="shaping-row-id">{entry.id}</code>
              <span className="shaping-chip">Repeated id</span>
            </div>
            {entry.problem && <p className="shaping-row-problem">{entry.problem}</p>}
            <p className="shaping-row-note">
              It never runs. Removing the shaper that owns the id {entry.id} removes this entry too.
            </p>
          </div>
        </div>
      );
    }
    const key = `row:${entry.id}`;
    const shaper = entry.shaper;
    const environment = shaper ? shaperEnvironmentStatus(shaper, references) : [];
    // An entry that cannot run may only be switched off, never on (`plan.md`).
    const canSwitch = entry.on || entry.problem === null;
    // Without the daemon's revision nothing here can say which definition it acts on: a view from
    // a daemon older than this dashboard carries none, and an import still being drawn has none yet.
    const unbound = entry.revision === null;
    // A confirmation opened for an earlier definition of this id does not apply to its replacement.
    const confirmRemove = removing?.id === entry.id && removing.revision === entry.revision;
    return (
      <div className="shaping-row" key={entry.id} data-anchor={`task-shaping/${entry.id}`} role="group" aria-label={entry.label}>
        <div className="shaping-row-copy">
          <div className="shaping-row-title">
            <strong>{entry.label}</strong>
            <code className="shaping-row-id">{entry.id}</code>
            <span className="shaping-chip">Registered</span>
            {shaper && <span className="shaping-chip">{TRANSPORT_LABEL[shaper.transport.type]}</span>}
          </div>
          {shaper && shaperReach(shaper).map((line) => (
            <p className="shaping-row-reach" key={line.label + ":" + line.value}>{line.label + ": " + line.value}</p>
          ))}
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
          <EarlierRefusals messages={earlier[key]} />
          {entry.repeats > 0 && (
            <p className="shaping-row-note">
              {entry.repeats === 1
                ? `Another stored entry repeats the id ${entry.id}. Removing this shaper removes it too.`
                : `${entry.repeats} more stored entries repeat the id ${entry.id}. Removing this shaper removes them too.`}
            </p>
          )}
          {confirmRemove && removing.folder && (
            <p className="shaping-row-note">
              A shaper in the shapers folder also has the id {entry.id}. Removing this registration leaves that one
              switched off; switch it on afterwards if you want it to run.
            </p>
          )}
        </div>
        <div className="shaping-row-actions">
          {group.stage !== null && (
            <>
              <Tooltip label="Run it earlier in its stage">
                <button type="button" className="btn btn-ghost shaping-move" aria-label={`Move ${entry.label} up`}
                  disabled={busy || at === 0}
                  onClick={() => { const intent = config && moveIntent(config, entry.id, -1); if (intent) void onSet(intent, key); }}>↑</button>
              </Tooltip>
              <Tooltip label="Run it later in its stage">
                <button type="button" className="btn btn-ghost shaping-move" aria-label={`Move ${entry.label} down`}
                  disabled={busy || at === group.rows.length - 1}
                  onClick={() => { const intent = config && moveIntent(config, entry.id, 1); if (intent) void onSet(intent, key); }}>↓</button>
              </Tooltip>
              <Tooltip label="Run this shaper once against a repository and see what it would add. Nothing is saved.">
                {/* Only with the daemon's revision: an optimistic import has none yet, and a dry run
                    sent without one could run a replacement written before its frame arrives. */}
                <button type="button" className="btn btn-ghost" aria-label={`Dry-run ${entry.label}`} disabled={!ready || entry.revision === null}
                  onClick={() => setTesting({ id: entry.id, label: entry.label, revision: entry.revision })}>Dry run</button>
              </Tooltip>
            </>
          )}
          {confirmRemove ? (
            <>
              <Tooltip label="Keep this shaper">
                <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>Keep</button>
              </Tooltip>
              <Tooltip label="Delete this shaper's stored definition and its on or off choice">
                <button type="button" className="btn btn-danger" aria-label={`Confirm removing ${entry.label}`} disabled={busy || unbound}
                  onClick={() => { setRemoving(null); void onSet({ kind: "remove", id: entry.id, expect: entry.revision ?? undefined }, key); }}>Remove</button>
              </Tooltip>
            </>
          ) : (
            <Tooltip label="Remove this shaper. Asks once more first.">
              <button type="button" className="btn btn-ghost" aria-label={`Remove ${entry.label}`} disabled={busy || unbound}
                onClick={() => confirmRemoval(entry)}>Remove</button>
            </Tooltip>
          )}
          <Tooltip label={unbound
            ? "Unavailable until the daemon says which definition this is. Reload the page."
            : !canSwitch
            ? "This build cannot run it, so it cannot be switched on."
            : entry.problem !== null
              ? "Stored on, but this build never runs it. Switch it off."
              : `Switch ${entry.label} ${entry.on ? "off" : "on"} immediately in every window.`}>
            <button type="button" className={`settings-grant ${entry.on ? "is-on" : "is-off"}`}
              disabled={busy || !canSwitch || unbound} aria-label={`${entry.label}: ${entry.on ? "on" : "off"}`} aria-pressed={entry.on}
              onClick={() => void onSet({ kind: "enable", id: entry.id, enabled: !entry.on, expect: entry.revision ?? undefined }, key)}>
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
      {config && <ShapingSettingsForm config={config} busy={busy} error={errors.settings ?? null} earlier={earlier.settings} onSet={onSet} />}
      <div className="feature-flag-list shaping-list" data-anchor="task-shaping/shapers">
        <div className="settings-pane-head shaping-list-head">
          <div className="settings-pane-title-row">
            <h3 className="settings-pane-title">Shapers</h3>
            <span className="settings-pane-count">{count}</span>
          </div>
          <span data-anchor="task-shaping/import">
            <Tooltip label="Paste or choose a shaper manifest and review what it runs or calls before saving it">
              <button type="button" className="btn" disabled={busy} onClick={openImport}>Import manifest…</button>
            </Tooltip>
          </span>
        </div>
        {/* The dialog is the only other place an import's outcome shows. A stream frame can free it
            before the answer lands, and the operator may close it then: a refusal that arrives
            afterwards is shown here, beside the button that opens the dialog again. */}
        {config !== null && count > 0 && !shapingViewHasRevisions(config) && (
          // A daemon older than this dashboard sends no revisions, so no row can say which
          // definition an action would act on.
          <p className="shaping-list-outcome shaping-revisions-missing" role="status">
            The daemon did not say which definition each shaper is, so switching, removing and dry runs
            are unavailable here. Reload the page to load the dashboard that matches it.
          </p>
        )}
        {/* A row's outcome is drawn inside the row. One for a shaper no longer listed, such as a
            removal refused because another window removed it first, would vanish with its row,
            so it is shown here instead. */}
        {orphans.length > 0 && (
          <div className="shaping-list-outcome" role="group" aria-label="Shapers no longer listed">
            {orphans.map((key) => (
              <div key={key} className="shaping-orphan-outcome">
                <div className="shaping-orphan-copy">
                  {errors[key] && <p role="alert">{errors[key]}</p>}
                  <EarlierRefusals messages={earlier[key]} />
                </div>
                {onDismiss && <DismissOutcome label={key.slice("row:".length)} onDismiss={() => onDismiss(key)} />}
              </div>
            ))}
          </div>
        )}
        {!importing && (errors.import || earlier.import) && (
          <div className="shaping-list-outcome" role="group" aria-label="Last import">
            <div className="shaping-orphan-outcome">
              <div className="shaping-orphan-copy">
                {errors.import && <p role="alert">{errors.import}</p>}
                <EarlierRefusals messages={earlier.import} />
              </div>
              {onDismiss && <DismissOutcome label="the last import" onDismiss={() => onDismiss("import")} />}
            </div>
          </div>
        )}
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
        <ShapingImportDialog config={config} busy={busy} saving={pending?.kind === "upsert"} error={errors.import ?? null} earlier={earlier.import}
          fresh={(outcomeArrivals.import ?? 0) > importOpenedAt.current}
          onClose={() => setImporting(false)}
          onSave={async (shaper) => {
            const session = importSession.current;
            const saved = await onSet({ kind: "upsert", shaper }, "import");
            // Closing is the dialog's to do, and only for the dialog that sent this save.
            return saved && importSession.current === session;
          }} />
      )}
      {testing && (
        <ShapingTestDialog id={testing.id} label={testing.label} revision={testing.revision}
          current={groups.flatMap((group) => group.rows).find((entry) => entry.id === testing.id && !entry.duplicate)?.revision ?? null}
          repositories={repositories} onTest={onTest} onClose={() => setTesting(null)} />
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
/** Clears an outcome drawn above the list, which has no row or dialog of its own to go with. */
function DismissOutcome({ label, onDismiss }: { label: string; onDismiss: () => void }): React.JSX.Element {
  return (
    <Tooltip label="Clear this message. Nothing is changed.">
      <button type="button" className="btn btn-ghost shaping-outcome-dismiss" aria-label={`Dismiss the outcome for ${label}`}
        onClick={onDismiss}>Dismiss</button>
    </Tooltip>
  );
}

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
function ShapingSettingsForm({ config, busy, error, earlier, onSet }: {
  config: ShapingConfigView;
  busy: boolean;
  error: string | null;
  earlier?: readonly string[];
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
  // The typed KiB is checked against the input's own bounds before rounding: 64.0001 rounds to
  // the maximum in bytes, but the browser still refuses to submit a field above its max.
  const typedKiB = Number(shown.totalKiB);
  const totalProblem = shown.totalKiB.trim() === "" || !Number.isFinite(typedKiB)
    || typedKiB < total.min / 1024 || typedKiB > total.max / 1024 || totalBytes < total.min || totalBytes > total.max
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
  // Bumped by every edit of a field, so a save's answer clears only the edits it sent: typing a
  // field away and back to the submitted text while the save is in flight is a new edit.
  const generations = useRef<Partial<Record<keyof SettingsFields, number>>>({});
  const edit = (patch: Partial<SettingsFields>) => {
    for (const field of Object.keys(patch) as Array<keyof SettingsFields>) {
      generations.current[field] = (generations.current[field] ?? 0) + 1;
    }
    setDraft((current) => ({ ...current, ...patch }));
  };
  const save = async (): Promise<void> => {
    const intent: SettingsIntent = { kind: "settings" };
    if (changed.user) intent.caller = { user: shown.user.trim() };
    const limits: NonNullable<SettingsIntent["limits"]> = {};
    if (changed.deadlineMs) limits.deadlineMs = deadlineMs;
    if (changed.totalBytes) limits.totalBytes = totalBytes;
    if (Object.keys(limits).length > 0) intent.limits = limits;
    // Saved or refused, the submitted fields go back to showing the daemon's config: a refusal is
    // a roll back, with its reason below. Only the edits this save sent are cleared: the stream
    // can free the form before the reply lands, and an edit made in that interval, even one that
    // types the same text again, is a new draft, not part of this save. Only fields the intent
    // carries count as sent: a draft that matched the stored value was left out, and stays a
    // draft whatever the reply says.
    const sentFields: Array<keyof SettingsFields> = [];
    if (intent.caller) sentFields.push("user");
    if (intent.limits?.deadlineMs !== undefined) sentFields.push("deadlineMs");
    if (intent.limits?.totalBytes !== undefined) sentFields.push("totalKiB");
    const submitted = Object.fromEntries(sentFields.map((field) => [field, generations.current[field]])) as
      Partial<Record<keyof SettingsFields, number>>;
    await onSet(intent, "settings");
    setDraft((current) => {
      const next = { ...current };
      for (const field of Object.keys(submitted) as Array<keyof SettingsFields>) {
        if (generations.current[field] === submitted[field]) delete next[field];
      }
      return next;
    });
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
      <EarlierRefusals messages={earlier} />
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
