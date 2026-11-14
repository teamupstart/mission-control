import { useEffect, useRef, useState } from "react";
import {
  alwaysKeptCounts,
  backupRetentionLimits,
  DATABASE_BACKUP_INTERVAL_HOURS,
  DatabaseBackupsConfigPatchSchema,
  type BackupRemovalReason,
  type DatabaseBackupKindStatus,
  type DatabaseBackupsConfig,
} from "@shared/database-backups.ts";
import {
  STORAGE_CATEGORIES,
  type IdleCachePlan,
  type IdleCachePoolView,
  type StorageBackupCopy,
  type StorageCategoryId,
  type StorageHealth,
  type StorageProblem,
  type StorageProblemKind,
} from "@shared/storage-health.ts";
import {
  StorageLimitsConfigPatchSchema,
  storageWarnAtBytes,
  type StorageLimitsConfig,
} from "@shared/storage-limits.ts";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { formatBytes, relativeTime } from "../lib/format.ts";
import {
  backupDraftEffect,
  gibField,
  parseGibField,
  parseWholeField,
  spanLabel,
  storageTabForAnchor,
  STORAGE_TABS,
  type StorageTabId,
} from "../lib/storage-view.ts";
import {
  type IdleCacheActions,
  type IdleCacheState,
  type StorageActions,
  type StorageState,
  useIdleCache,
  useStorage,
} from "../useStorage.ts";
import { Tooltip } from "./Tooltip.tsx";
import { ActionDialog } from "./WorktreeSettingsPanel.tsx";

function when(at: number | null): string {
  if (at === null) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(at));
}

function day(at: number | null): string {
  if (at === null) return "none";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(at));
}

function intervalLabel(hours: number): string {
  return hours === 1 ? "Every hour" : `Every ${hours} hours`;
}

function sizeOrUnknown(bytes: number | null): string {
  return bytes === null ? "size unknown" : formatBytes(bytes);
}

const COPY_KIND_LABEL: Record<StorageBackupCopy["kind"], string> = {
  scheduled: "Scheduled",
  preMigration: "Pre-migration",
  manual: "Manual",
};

/** Why saving deletes a copy, as the list of exact targets says it. */
const REMOVAL_REASON: Record<BackupRemovalReason, string> = {
  count: "past its kind's count",
  age: "past its kind's age limit",
  size: "over the size budget, oldest first",
};

const PROBLEM_KIND_LABEL: Record<StorageProblemKind, string> = {
  "backup-failed": "Backup failed",
  "low-free-space": "Low free space",
  "storage-limit": "Near the storage limit",
};

const PROBLEM_TARGET: Record<StorageProblem["link"]["target"], { tab: StorageTabId; label: string }> = {
  backups: { tab: "backups", label: "Open backups" },
  cleanup: { tab: "cleanup", label: "Open cleanup" },
  limits: { tab: "warnings", label: "Open warnings" },
};

/** The size warnings, as opposed to a failed backup: what the Warnings tab and banner are about. */
const SIZE_WARNINGS: ReadonlySet<StorageProblemKind> = new Set(["low-free-space", "storage-limit"]);

// ---------------------------------------------------------------- drafts

type BackupDraft = Record<keyof DatabaseBackupsConfig, string>;

const BACKUP_KEYS = [
  "scheduledCount",
  "preMigrationCount",
  "intervalHours",
  "scheduledMaxAgeDays",
  "preMigrationMaxAgeDays",
  "maxTotalBytes",
] as const satisfies readonly (keyof DatabaseBackupsConfig)[];

function backupDraftOf(config: DatabaseBackupsConfig): BackupDraft {
  return {
    scheduledCount: String(config.scheduledCount),
    preMigrationCount: String(config.preMigrationCount),
    intervalHours: String(config.intervalHours),
    scheduledMaxAgeDays: config.scheduledMaxAgeDays === null ? "" : String(config.scheduledMaxAgeDays),
    preMigrationMaxAgeDays: config.preMigrationMaxAgeDays === null ? "" : String(config.preMigrationMaxAgeDays),
    maxTotalBytes: gibField(config.maxTotalBytes),
  };
}

function backupFieldValue(key: keyof DatabaseBackupsConfig, text: string): number | null | undefined {
  if (key === "maxTotalBytes") return parseGibField(text);
  if (key === "scheduledMaxAgeDays" || key === "preMigrationMaxAgeDays") return parseWholeField(text);
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) ? value : undefined;
}

type LimitsDraft = Record<keyof StorageLimitsConfig, string>;

function limitsDraftOf(config: StorageLimitsConfig): LimitsDraft {
  return {
    limitBytes: gibField(config.limitBytes),
    warnAtPercent: String(config.warnAtPercent),
    freeFloorBytes: gibField(config.freeFloorBytes),
    fleetBanner: String(config.fleetBanner),
    desktopNotification: String(config.desktopNotification),
    poolIdleBudgetBytes: gibField(config.poolIdleBudgetBytes),
    poolKeepWarm: String(config.poolKeepWarm),
  };
}

function limitFieldValue(key: keyof StorageLimitsConfig, text: string): number | boolean | null | undefined {
  if (key === "fleetBanner" || key === "desktopNotification") return text === "true";
  if (key === "limitBytes" || key === "freeFloorBytes" || key === "poolIdleBudgetBytes") return parseGibField(text);
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) ? value : undefined;
}

/**
 * A form draft over a config another window can also save. A save elsewhere replaces only the
 * fields not edited here, so an edit in progress survives it, and a Save sends only the fields
 * edited here, so it never puts another window's value back.
 */
function useDraft<Config extends object, Key extends keyof Config & string>(
  config: Config | null,
  keys: readonly Key[],
  draftOf: (config: Config) => Record<Key, string>,
): [Record<Key, string> | null, (key: Key, value: string) => void, Key[]] {
  const [draft, setDraft] = useState<Record<Key, string> | null>(config ? draftOf(config) : null);
  const adopted = useRef<Config | null>(config);
  const signature = config ? JSON.stringify(draftOf(config)) : "";
  useEffect(() => {
    if (!config) return;
    const previous = adopted.current;
    adopted.current = config;
    setDraft((current) => {
      const next = draftOf(config);
      if (!current || !previous) return next;
      const before = draftOf(previous);
      for (const key of keys) {
        if (current[key] !== before[key]) next[key] = current[key];
      }
      return next;
    });
    // `signature` stands in for the config's values; the object itself is new on every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const edited = draft && config
    ? keys.filter((key) => draft[key] !== draftOf(config)[key])
    : [];
  const set = (key: Key, value: string) => setDraft((current) => current && { ...current, [key]: value });
  return [draft, set, edited];
}

// ---------------------------------------------------------------- shared pieces

function Problems({
  problems,
  onOpen,
}: {
  problems: StorageProblem[];
  onOpen: (tab: StorageTabId) => void;
}): React.JSX.Element {
  return (
    <section className="storage-band" data-anchor="storage/problems" aria-label="Problems">
      <h3>Problems</h3>
      {problems.length === 0 ? (
        <p className="settings-hint">No storage problems.</p>
      ) : (
        <ul className="storage-problem-list" aria-label="Storage problems">
          {problems.map((problem) => {
            const target = PROBLEM_TARGET[problem.link.target];
            return (
              <li key={problem.id} className={problem.kind === "storage-limit" ? "is-warn" : undefined}>
                <div>
                  <strong>{PROBLEM_KIND_LABEL[problem.kind]}</strong>
                  <span>{problem.message}</span>
                </div>
                <Tooltip label={`Show the ${STORAGE_TABS.find((tab) => tab.id === target.tab)!.label} tab`}>
                  <button type="button" className="btn btn-ghost" onClick={() => onOpen(target.tab)}>
                    {target.label}
                  </button>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Meter({
  label,
  detail,
  segments,
  ticks,
  ariaLabel,
}: {
  label: React.ReactNode;
  detail: React.ReactNode;
  segments: Array<{ key: string; className: string; share: number }>;
  ticks: Array<{ key: string; at: number; danger?: boolean }>;
  ariaLabel: string;
}): React.JSX.Element {
  return (
    <div className="storage-meter">
      <div className="storage-meter-head"><span>{label}</span><span>{detail}</span></div>
      <div className="storage-bar" role="img" aria-label={ariaLabel}>
        {segments.filter((segment) => segment.share > 0).map((segment) => (
          <i
            key={segment.key}
            className={segment.className}
            style={{ width: `${Math.min(100, segment.share * 100)}%` }}
          />
        ))}
        {ticks.map((tick) => (
          <b
            key={tick.key}
            className={`storage-tick${tick.danger ? " is-danger" : ""}`}
            style={{ left: `${Math.min(100, Math.max(0, tick.at * 100))}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function categoryBytes(health: StorageHealth, id: StorageCategoryId): number | null {
  return health.usage.categories.find((category) => category.id === id)?.bytes ?? null;
}

function VolumeMeter({ health }: { health: StorageHealth }): React.JSX.Element {
  const { volume, limits, usage } = health;
  if (!volume) {
    return <p className="settings-hint" role="status">Free space has not been checked yet.</p>;
  }
  const mine = Math.min(usage.totalBytes ?? 0, volume.totalBytes);
  const free = Math.min(volume.freeBytes, volume.totalBytes - mine);
  const others = Math.max(0, volume.totalBytes - mine - free);
  const total = volume.totalBytes || 1;
  const low = limits.freeFloorBytes !== null && volume.freeBytes < limits.freeFloorBytes;
  return (
    <Meter
      label={<><strong>Volume</strong> · {formatBytes(volume.totalBytes)}</>}
      detail={(
        <>
          <strong className={low ? "storage-red" : undefined}>{formatBytes(volume.freeBytes)} free</strong>
          {limits.freeFloorBytes !== null && <> · warns below {formatBytes(limits.freeFloorBytes)} free</>}
        </>
      )}
      ariaLabel={`Volume: Mission Control ${formatBytes(mine)}, everything else ${formatBytes(others)}, free ${formatBytes(volume.freeBytes)}`}
      segments={[
        { key: "mine", className: "storage-seg-mine", share: mine / total },
        { key: "others", className: "storage-seg-others", share: others / total },
        { key: "free", className: "storage-seg-free", share: free / total },
      ]}
      ticks={limits.freeFloorBytes === null ? [] : [{
        key: "floor",
        at: (volume.totalBytes - limits.freeFloorBytes) / total,
        danger: true,
      }]}
    />
  );
}

function UsageMeter({ health }: { health: StorageHealth }): React.JSX.Element | null {
  const { usage, limits } = health;
  if (usage.totalBytes === null) return null;
  const warnAt = storageWarnAtBytes(limits);
  const track = Math.max(limits.limitBytes ?? 0, usage.totalBytes) || 1;
  const near = warnAt !== null && usage.totalBytes >= warnAt;
  return (
    <Meter
      label={<><strong>Mission Control</strong> · <code>{usage.root}</code></>}
      detail={limits.limitBytes === null ? (
        <><strong>{formatBytes(usage.totalBytes)}</strong> · no size limit set</>
      ) : (
        <>
          <strong className={near ? "storage-amber" : undefined}>{formatBytes(usage.totalBytes)}</strong>
          {" "}of {formatBytes(limits.limitBytes)} limit · warns at {formatBytes(warnAt!)}
        </>
      )}
      ariaLabel={`Mission Control uses ${formatBytes(usage.totalBytes)}${limits.limitBytes === null ? "" : ` of a ${formatBytes(limits.limitBytes)} limit`}`}
      segments={usage.categories.map((category) => ({
        key: category.id,
        className: `storage-seg-${category.id}`,
        share: category.bytes / track,
      }))}
      ticks={warnAt === null ? [] : [{ key: "warn", at: warnAt / track }]}
    />
  );
}

function MeasureLine({
  health,
  onMeasure,
  now,
}: {
  health: StorageHealth;
  onMeasure: () => void;
  now: number;
}): React.JSX.Element {
  const { usage } = health;
  let text: string;
  if (usage.measuring) text = "Measuring the state directory. This can take a few minutes on large pools.";
  else if (usage.measuredAt === null) text = "Not measured yet. The first measurement runs a few minutes after the daemon starts.";
  else text = `Measured ${relativeTime(usage.measuredAt, now)}${usage.durationMs === null ? "" : `, in ${Math.max(1, Math.round(usage.durationMs / 1000))}s`}.`;
  return (
    <div className="storage-measure" role="status">
      <span>{text}</span>
      {usage.error && <span className="storage-red">{usage.error}</span>}
      <Tooltip label="Walk the state directory again and refresh every size">
        <button type="button" className="btn btn-ghost" disabled={usage.measuring} onClick={onMeasure}>
          {usage.measuring ? "Measuring…" : usage.measuredAt === null ? "Measure now" : "Measure again"}
        </button>
      </Tooltip>
    </div>
  );
}

/** An idle total that leaves out unmeasured slots, worded as the lower bound it is. */
function idleTotal(bytes: number, unmeasured: number, idle: number): string {
  if (unmeasured === 0) return formatBytes(bytes);
  if (unmeasured >= idle) return "size unknown";
  return `at least ${formatBytes(bytes)}`;
}

/**
 * Said wherever the plan has idle slots the last measurement did not size: until they are
 * measured, whether the idle caches fit the budget is unknown, and nothing here claims they do.
 */
function UnmeasuredNote({ plan, onMeasure }: { plan: IdleCachePlan; onMeasure: () => void }): React.JSX.Element | null {
  if (plan.unmeasuredIdle === 0) return null;
  const count = plan.unmeasuredIdle;
  return (
    <div className="storage-effect" role="status">
      <strong>
        {count} idle {count === 1 ? "slot has" : "slots have"} not been measured yet,
      </strong>{" "}
      so whether the idle caches fit the budget is unknown. Measuring sizes every slot; the plan is
      read again when it finishes.{" "}
      <Tooltip label="Walk the state directory now and size every idle slot">
        <button type="button" className="settings-link" onClick={onMeasure}>Measure now</button>
      </Tooltip>
    </div>
  );
}

function SlotStrip({ pool, label }: { pool: IdleCachePoolView; label: string }): React.JSX.Element {
  const staying = Math.max(0, pool.idle - pool.remove);
  const room = Math.max(0, pool.maxSlots - pool.leased - pool.idle - pool.quarantined - pool.other);
  const cells: Array<{ key: string; className: string }> = [
    ...Array.from({ length: pool.leased }, (_, index) => ({ key: `l${index}`, className: "is-leased" })),
    ...Array.from({ length: staying }, (_, index) => ({ key: `i${index}`, className: "is-idle" })),
    ...Array.from({ length: pool.remove }, (_, index) => ({ key: `r${index}`, className: "is-go" })),
    ...Array.from({ length: pool.quarantined }, (_, index) => ({ key: `q${index}`, className: "is-quarantined" })),
    ...Array.from({ length: pool.other }, (_, index) => ({ key: `o${index}`, className: "is-other" })),
    ...Array.from({ length: room }, (_, index) => ({ key: `e${index}`, className: "is-room" })),
  ].slice(0, 48);
  return (
    <div className="storage-slots" role="img" aria-label={label}>
      {cells.map((cell) => <i key={cell.key} className={cell.className} />)}
    </div>
  );
}

// ---------------------------------------------------------------- tabs

function OverviewTab({
  health,
  idle,
  onOpen,
  onMeasure,
  now,
}: {
  health: StorageHealth;
  idle: IdleCacheState;
  onOpen: (tab: StorageTabId) => void;
  onMeasure: () => void;
  now: number;
}): React.JSX.Element {
  const { usage } = health;
  const plan = idle.plan;
  const reclaimable = (id: StorageCategoryId): string => {
    if (id === "pools") {
      if (!plan) return "…";
      if (plan.budgetBytes === null) return "No budget set";
      if (plan.unmeasuredIdle > 0 && plan.remove.length === 0) return "Unknown until measured";
      return plan.unmeasuredIdle > 0 ? `at least ${formatBytes(plan.freesBytes)}` : formatBytes(plan.freesBytes);
    }
    if (id === "backups") return "Within limits";
    return "None";
  };
  return (
    <>
      <Problems problems={health.problems} onOpen={onOpen} />
      <section className="storage-band" aria-label="Disk use">
        <h3>Disk use</h3>
        <VolumeMeter health={health} />
        <UsageMeter health={health} />
        {usage.totalBytes !== null && (
          <table className="storage-copies storage-table">
            <caption>What is in the state directory</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">What it is</th>
                <th scope="col" className="storage-num">Size</th>
                <th scope="col" className="storage-num">Share</th>
                <th scope="col">Limit</th>
                <th scope="col" className="storage-num">Reclaimable</th>
                <th scope="col"><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {STORAGE_CATEGORIES.map((category) => {
                const bytes = categoryBytes(health, category.id) ?? 0;
                return (
                  <tr key={category.id}>
                    <th scope="row">
                      <span className={`storage-swatch storage-seg-${category.id}`} aria-hidden="true" />
                      {category.label}
                      {category.roots.length > 0 && <small>{category.roots.join(", ")}</small>}
                    </th>
                    <td className="storage-muted">{category.description}</td>
                    <td className="storage-num">{formatBytes(bytes)}</td>
                    <td className="storage-num storage-muted">{usage.totalBytes ? Math.round((bytes / usage.totalBytes) * 100) : 0}%</td>
                    <td className="storage-muted">{category.policy}</td>
                    <td className="storage-num">{reclaimable(category.id)}</td>
                    <td>
                      {category.cleanup && (
                        <Tooltip label={`Show the ${STORAGE_TABS.find((tab) => tab.id === category.cleanup)!.label} tab`}>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            aria-label={`Open ${category.label}`}
                            onClick={() => onOpen(category.cleanup)}
                          >
                            Open
                          </button>
                        </Tooltip>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr className="storage-total">
                <th scope="row">Total</th>
                <td />
                <td className="storage-num">{formatBytes(usage.totalBytes)}</td>
                <td className="storage-num storage-muted">100%</td>
                <td />
                <td />
                <td />
              </tr>
            </tbody>
          </table>
        )}
        <MeasureLine health={health} onMeasure={onMeasure} now={now} />
      </section>
    </>
  );
}

function KindStatus({ label, status }: { label: string; status: DatabaseBackupKindStatus }): React.JSX.Element {
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

function BackupsTab({
  state,
  actions,
  now,
}: {
  state: StorageState;
  actions: StorageActions;
  now: number;
}): React.JSX.Element {
  const config = state.view?.config ?? null;
  const [draft, set, editedKeys] = useDraft(config, BACKUP_KEYS, backupDraftOf);
  const busy = state.saving || state.backingUp;
  const health = state.health;
  const copies = health?.backups.copies ?? [];

  const edited = draft
    ? Object.fromEntries(editedKeys.map((key) => [key, backupFieldValue(key, draft[key])]))
    : {};
  const patch = DatabaseBackupsConfigPatchSchema.safeParse(edited);
  const changed = editedKeys.length > 0;
  const draftConfig = config ? { ...config, ...(patch.success ? patch.data : {}) } : null;
  const effect = draftConfig ? backupDraftEffect(copies, draftConfig, now) : null;
  // What the draft protects, from the same rule the prune applies: a pre-migration count of 1
  // protects one copy, and the page must not promise the second.
  const protectedPreMigration = draftConfig
    ? alwaysKeptCounts(backupRetentionLimits(draftConfig).counts).preMigration
    : null;
  const going = new Set(effect?.plan.remove.map((copy) => copy.filename) ?? []);
  const always = new Set(effect?.plan.alwaysKept ?? []);
  const kindCount = (kind: StorageBackupCopy["kind"]) => copies.filter((copy) => copy.kind === kind);

  const field = (key: (typeof BACKUP_KEYS)[number], label: string, placeholder?: string, width = "storage-input") => (
    <input
      className={width}
      inputMode="decimal"
      aria-label={label}
      placeholder={placeholder}
      value={draft?.[key] ?? ""}
      disabled={!draft || busy}
      onChange={(event) => set(key, event.target.value)}
    />
  );

  return (
    <section className="storage-band storage-settings" aria-label="Database backups">
      <h3>Database backups</h3>
      <p className="settings-hint settings-blurb">
        Full copies of Mission Control&apos;s database, kept on this machine. A copy is deleted when
        it passes its kind&apos;s count or age, or when all copies together pass the size budget,
        oldest first. Back up now keeps exactly one manual copy outside the counts. Restoring stays
        offline, through <code>npm run recover:database</code>.
      </p>

      <table className="storage-policy" aria-label="Backup limits by kind">
        <thead>
          <tr><th scope="col">Kind</th><th scope="col">Keep at most</th><th scope="col">Delete after</th><th scope="col" className="storage-num">Now</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Scheduled</th>
            <td><span className="storage-field">{field("scheduledCount", "Scheduled copies kept")}<em>copies, 1 to 48</em></span></td>
            <td><span className="storage-field">{field("scheduledMaxAgeDays", "Scheduled maximum age in days", "No limit")}<em>days</em></span></td>
            <td className="storage-num">{kindCount("scheduled").length} · {formatBytes(kindCount("scheduled").reduce((total, copy) => total + copy.bytes, 0))}</td>
          </tr>
          <tr>
            <th scope="row">Pre-migration</th>
            <td><span className="storage-field">{field("preMigrationCount", "Pre-migration copies kept")}<em>copies, 1 to 10</em></span></td>
            <td><span className="storage-field">{field("preMigrationMaxAgeDays", "Pre-migration maximum age in days", "No limit")}<em>days</em></span></td>
            <td className="storage-num">{kindCount("preMigration").length} · {formatBytes(kindCount("preMigration").reduce((total, copy) => total + copy.bytes, 0))}</td>
          </tr>
          <tr>
            <th scope="row">Manual</th>
            <td className="storage-muted">1 copy</td>
            <td className="storage-muted">Never</td>
            <td className="storage-num">{kindCount("manual").length}</td>
          </tr>
        </tbody>
      </table>

      <div className="storage-config-row">
        <Tooltip label="How often a scheduled copy is taken, by wall clock">
          <label>
            <span>Backup interval</span>
            <select
              className="settings-select"
              value={draft?.intervalHours ?? "1"}
              disabled={!draft || busy}
              onChange={(event) => set("intervalHours", event.target.value)}
            >
              {DATABASE_BACKUP_INTERVAL_HOURS.map((hours) => (
                <option key={hours} value={String(hours)}>{intervalLabel(hours)}</option>
              ))}
            </select>
          </label>
        </Tooltip>
        <Tooltip label="The most all copies' file sizes may add up to. Empty is no limit">
          <label>
            <span>Size budget, all copies</span>
            <span className="storage-field">{field("maxTotalBytes", "Backup size budget in GiB", "No limit")}<em>GiB</em></span>
          </label>
        </Tooltip>
        <Tooltip label="Save the backup limits, and delete the copies they no longer keep">
          <button
            type="button"
            className="btn"
            disabled={!changed || !patch.success || busy}
            onClick={() => {
              // The exact deletions shown above; the daemon refuses the save if its own differ.
              if (patch.success) void actions.save(patch.data, effect?.plan.remove.map((copy) => copy.filename) ?? []);
            }}
          >
            {state.saving ? "Saving…" : "Save"}
          </button>
        </Tooltip>
      </div>
      {draft && !patch.success && (
        <p className="settings-error">
          Scheduled copies must be 1 to 48, pre-migration copies 1 to 10, ages 1 to 365 days, and the
          size budget at least 0.25 GiB.
        </p>
      )}

      <div className="storage-keep" role="group" aria-label="Always kept">
        <strong>Always kept</strong>
        <span className="storage-chip">Newest scheduled copy</span>
        {protectedPreMigration !== null && (
          <span className="storage-chip">
            {protectedPreMigration === 1 ? "Newest pre-migration copy" : `${protectedPreMigration} newest pre-migration copies`}
          </span>
        )}
        <span className="storage-chip">Newest manual copy</span>
        <p>
          No age or size limit can delete these, so there is always a recent point to restore to. Each
          kind&apos;s own count still decides how many it keeps: a pre-migration count of 1 keeps only
          the newest.
        </p>
      </div>

      {effect && changed && patch.success && (
        <div className="storage-effect" role="status">
          <strong>
            {effect.plan.remove.length === 0
              ? "Saving deletes no copies."
              : `Saving deletes ${effect.plan.remove.length} ${effect.plan.remove.length === 1 ? "copy" : "copies"}, freeing ${formatBytes(effect.removedDiskBytes)} on disk.`}
          </strong>
          {effect.plan.remove.length > 0 && effect.removedDiskBytes !== effect.removedBytes && (
            <span> Their file sizes add up to {formatBytes(effect.removedBytes)}, which is what the size budget counts; some are sparse and hold less on disk.</span>
          )}
          {effect.plan.remove.length > 0 && (
            <ul className="storage-rows storage-delete-list" aria-label="Copies saving deletes">
              {effect.plan.remove.map((copy) => (
                <li key={copy.filename}>
                  <code>{copy.filename}</code>
                  <span className="storage-why">
                    {COPY_KIND_LABEL[copy.kind]}, taken {when(copy.at)} · {REMOVAL_REASON[copy.reason]}
                    {copy.diskBytes !== copy.bytes && ` · file size ${formatBytes(copy.bytes)}`}
                  </span>
                  <span className="storage-size">{formatBytes(copy.diskBytes)} on disk</span>
                </li>
              ))}
            </ul>
          )}
          {effect.plan.remove.length > 0 && (
            <ul>
              {spanLabel(effect.scheduledReach.before) !== spanLabel(effect.scheduledReach.after) && (
                <li>Scheduled copies reach back {spanLabel(effect.scheduledReach.before)} now, {spanLabel(effect.scheduledReach.after)} after saving.</li>
              )}
              {effect.preMigrationOldest.before !== effect.preMigrationOldest.after && (
                <li>The oldest pre-migration copy is from {day(effect.preMigrationOldest.before)} now, {day(effect.preMigrationOldest.after)} after saving.</li>
              )}
            </ul>
          )}
          <span>Fewer copies shorten how far back you can restore.</span>
        </div>
      )}
      {effect?.plan.overBudget && (
        <p className="settings-error">The copies that are always kept are larger than the size budget, so the budget cannot be met.</p>
      )}

      {copies.length > 0 && (
        <div className="storage-strip" role="img" aria-label={`${copies.length} kept copies, oldest to newest${going.size > 0 ? `; ${going.size} would be deleted` : ""}`}>
          {[...copies].reverse().map((copy) => (
            <i
              key={copy.filename}
              className={`storage-strip-${copy.kind}${going.has(copy.filename) ? " is-go" : ""}${always.has(copy.filename) ? " is-always" : ""}`}
            />
          ))}
        </div>
      )}

      <div className="storage-status-grid" aria-label="Backup status">
        {health ? (
          <>
            <KindStatus label="Scheduled" status={health.backups.status.scheduled} />
            <KindStatus label="Manual" status={health.backups.status.manual} />
            <article aria-label="Total backup size">
              <span>Total size</span>
              <strong>{formatBytes(health.backups.totalBytes)}</strong>
              <small>
                {copies.length} kept {copies.length === 1 ? "copy" : "copies"}
                {config?.maxTotalBytes !== null && config?.maxTotalBytes !== undefined && ` · budget ${formatBytes(config.maxTotalBytes)}`}
              </small>
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
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Taken</th>
              <th scope="col">Size</th>
              {going.size > 0 && <th scope="col">On save</th>}
            </tr>
          </thead>
          <tbody>
            {copies.map((copy) => (
              <tr key={copy.filename} className={going.has(copy.filename) ? "is-going" : undefined}>
                <td>{COPY_KIND_LABEL[copy.kind]}</td>
                <td>{when(copy.at)}</td>
                <td>{formatBytes(copy.bytes)}</td>
                {going.size > 0 && (
                  <td>{going.has(copy.filename) ? <span className="storage-red">Deleted</span> : always.has(copy.filename) ? "Always kept" : "Kept"}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PoolsTab({
  state,
  actions,
  idle,
  limits,
  onNavigate,
}: {
  state: StorageState;
  actions: StorageActions;
  idle: IdleCacheState;
  limits: StorageLimitsConfig | null;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const onMeasure = () => void actions.measure();
  const keys = ["poolIdleBudgetBytes", "poolKeepWarm"] as const;
  const [draft, set, editedKeys] = useDraft(limits, keys, limitsDraftOf);
  const edited = draft ? Object.fromEntries(editedKeys.map((key) => [key, limitFieldValue(key, draft[key])])) : {};
  const patch = StorageLimitsConfigPatchSchema.safeParse(edited);
  const plan = idle.plan;
  return (
    <section className="storage-band" aria-label="Worktree pool caches">
      <h3>Worktree pool caches</h3>
      <p className="settings-hint settings-blurb">
        A released native slot stays on disk so the next lease in its repository starts warm, with
        its dependencies and build output already in place. The idle-cache budget caps how much
        those warm slots may hold across every pool.
      </p>
      {plan && plan.budgetBytes !== null && (
        <Meter
          label={<><strong>Idle caches</strong> across {plan.pools.length} {plan.pools.length === 1 ? "pool" : "pools"}</>}
          detail={<><strong className={plan.idleBytes > plan.budgetBytes ? "storage-amber" : undefined}>{plan.unmeasuredIdle > 0 ? "at least " : ""}{formatBytes(plan.idleBytes)}</strong> of {formatBytes(plan.budgetBytes)} budget</>}
          ariaLabel={`Idle caches ${plan.unmeasuredIdle > 0 ? "at least " : ""}${formatBytes(plan.idleBytes)} against a ${formatBytes(plan.budgetBytes)} budget`}
          segments={[
            { key: "within", className: "storage-seg-pools", share: Math.min(plan.idleBytes, plan.budgetBytes) / Math.max(plan.idleBytes, plan.budgetBytes) },
            { key: "over", className: "storage-seg-over", share: Math.max(0, plan.idleBytes - plan.budgetBytes) / Math.max(plan.idleBytes, plan.budgetBytes) },
          ]}
          ticks={[{ key: "budget", at: plan.budgetBytes / Math.max(plan.idleBytes, plan.budgetBytes) }]}
        />
      )}
      <div className="storage-config-row">
        <Tooltip label="The most space idle slots may hold across every pool. Empty is no budget">
          <label>
            <span>Idle-cache budget, all pools</span>
            <span className="storage-field">
              <input
                className="storage-input"
                inputMode="decimal"
                aria-label="Idle-cache budget in GiB"
                placeholder="No budget"
                value={draft?.poolIdleBudgetBytes ?? ""}
                disabled={!draft || state.savingLimits}
                onChange={(event) => set("poolIdleBudgetBytes", event.target.value)}
              />
              <em>GiB</em>
            </span>
          </label>
        </Tooltip>
        <Tooltip label="How many of each pool's most recently used idle slots the budget never removes">
          <label>
            <span>Keep warm in each pool</span>
            <span className="storage-field">
              <input
                className="storage-input"
                inputMode="numeric"
                aria-label="Warm idle slots kept per pool"
                value={draft?.poolKeepWarm ?? ""}
                disabled={!draft || state.savingLimits}
                onChange={(event) => set("poolKeepWarm", event.target.value)}
              />
              <em>idle slots</em>
            </span>
          </label>
        </Tooltip>
        <Tooltip label="Save the idle-cache budget. Saving removes nothing">
          <button
            type="button"
            className="btn"
            disabled={editedKeys.length === 0 || !patch.success || state.savingLimits}
            onClick={() => { if (patch.success) void actions.saveLimits(patch.data); }}
          >
            {state.savingLimits ? "Saving…" : "Save"}
          </button>
        </Tooltip>
      </div>
      {draft && !patch.success && <p className="settings-error">The budget must be at least 0.25 GiB, and warm slots 0 to 64.</p>}
      <p className="settings-hint">
        Idle means released and not quarantined. Leased and quarantined slots never count against
        the budget and are never removed here. The budget never removes anything by itself: the
        Cleanup tab previews what it would remove, and nothing goes until you execute that preview.
        Pool maximums stay in{" "}
        <Tooltip label="Open Settings > Worktrees, where each pool's maximum is set">
          <button type="button" className="settings-link" onClick={() => onNavigate("worktrees")}>Worktrees</button>
        </Tooltip>.
      </p>

      {idle.loadError && <p className="settings-error" role="alert">{idle.loadError}</p>}
      {!plan && !idle.loadError && <p className="settings-hint" role="status">Observing pools…</p>}
      {plan && plan.budgetBytes !== null && <UnmeasuredNote plan={plan} onMeasure={onMeasure} />}
      {plan && plan.pools.length === 0 && <p className="settings-hint">No native pools yet.</p>}
      {plan && plan.pools.length > 0 && (
        <table className="storage-copies storage-table">
          <caption>Native pools. Outlined slots are idle slots the budget would remove.</caption>
          <thead>
            <tr>
              <th scope="col">Pool</th>
              <th scope="col">Slots</th>
              <th scope="col" className="storage-num">Size</th>
              <th scope="col" className="storage-num">Idle cache</th>
              <th scope="col" className="storage-num">Over budget</th>
            </tr>
          </thead>
          <tbody>
            {plan.pools.map((pool) => (
              <tr key={pool.poolId}>
                <th scope="row">{pool.name}<small>{pool.path}</small></th>
                <td>
                  <SlotStrip
                    pool={pool}
                    label={`${pool.leased} leased, ${pool.idle} idle, ${pool.quarantined} quarantined, maximum ${pool.maxSlots}`}
                  />
                  <small className="storage-muted">{pool.leased} leased · {pool.idle} idle · {pool.quarantined} quarantined</small>
                </td>
                <td className="storage-num">{sizeOrUnknown(pool.bytes)}</td>
                <td className="storage-num">{idleTotal(pool.idleBytes, pool.unmeasuredIdle, pool.idle)}</td>
                <td className="storage-num">
                  {pool.remove > 0 ? `${pool.remove} · ${formatBytes(pool.removeBytes)}` : "None"}
                  {pool.blocked > 0 && <small className="storage-red">{pool.blocked} blocked</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="storage-effect">
        <strong>Removing a warm slot makes a later session slower.</strong> The next session that
        needs one in that repository creates a fresh slot and installs its dependencies again, which
        takes minutes rather than seconds.
      </div>
      <p className="storage-note">
        A slot is removed whole, with <code>git worktree remove</code>, after the same owner,
        process, repository and archive checks Worktrees uses. Storage never picks through a
        slot&apos;s ignored files: <code>.env</code> files, local databases and editor state live
        there too.
      </p>
    </section>
  );
}

function CleanupTab({
  health,
  idle,
  idleActions,
  onOpen,
  onMeasure,
  now,
}: {
  health: StorageHealth;
  idle: IdleCacheState;
  idleActions: IdleCacheActions;
  onOpen: (tab: StorageTabId) => void;
  onMeasure: () => void;
  now: number;
}): React.JSX.Element {
  const plan: IdleCachePlan | null = idle.plan;
  return (
    <section className="storage-band" aria-label="Cleanup">
      <h3>Cleanup</h3>
      <p className="settings-hint settings-blurb">
        What your limits would remove right now, path by path. Nothing is removed until you preview
        it and execute that preview.
      </p>
      {idle.notice && <p className="settings-hint" role="status">{idle.notice}</p>}
      {plan && !idle.current && !idle.loadError && (
        <p className="settings-hint" role="status">Reading the plan again for the current limits and slots; removal waits for it.</p>
      )}
      {idle.previewError && !idle.preview && <p className="settings-error" role="alert">{idle.previewError}</p>}
      {idle.loadError && <p className="settings-error" role="alert">{idle.loadError}</p>}
      {!plan && !idle.loadError && <p className="settings-hint" role="status">Observing pools…</p>}
      {plan && plan.budgetBytes === null && (
        <div className="storage-effect">
          <strong>No idle-cache budget is set,</strong> so nothing in the native pools is offered for
          removal.{" "}
          <Tooltip label="Show the Pool caches tab, where the idle-cache budget is set">
            <button type="button" className="settings-link" onClick={() => onOpen("pools")}>Set one in Pool caches</button>
          </Tooltip>.
        </div>
      )}
      {plan && plan.budgetBytes !== null && (
        <>
          <UnmeasuredNote plan={plan} onMeasure={onMeasure} />
          <div className="storage-summary" role="group" aria-label="Cleanup summary">
            <div><span>Frees</span><strong className="storage-green">{formatBytes(plan.freesBytes)}</strong></div>
            <div><span>Removes</span><strong>{plan.remove.length} idle {plan.remove.length === 1 ? "slot" : "slots"}</strong></div>
            <div><span>Blocked</span><strong className={plan.blocked.length > 0 ? "storage-red" : undefined}>{plan.blocked.length}</strong></div>
            <div><span>Idle caches after</span><strong>{plan.unmeasuredIdle > 0 ? "at least " : ""}{formatBytes(plan.afterIdleBytes)} of {formatBytes(plan.budgetBytes)} budget</strong></div>
          </div>
          <details className="storage-group" open>
            <Tooltip label="Show or hide the idle slots this cleanup removes">
              <summary><strong>Idle pool slots</strong><span>least recently used first</span><em>{formatBytes(plan.freesBytes)}</em></summary>
            </Tooltip>
            {plan.remove.length === 0 ? (
              <p className="settings-hint">
                {plan.unmeasuredIdle > 0
                  ? "Nothing is offered until the unmeasured idle slots are sized."
                  : "The idle caches already fit the budget."}
              </p>
            ) : (
              <ul className="storage-rows" aria-label="Idle slots to remove">
                {plan.remove.map((slot) => (
                  <li key={slot.slotId}>
                    <code>{slot.path}</code>
                    <span className="storage-why">Idle, last used {slot.lastUsedAt === null ? "at an unknown time" : relativeTime(slot.lastUsedAt, now)}</span>
                    <span className="storage-size">{sizeOrUnknown(slot.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
          {plan.blocked.length > 0 && (
            <details className="storage-group is-blocked" open>
              <Tooltip label="Show or hide the slots the budget chose but cannot remove, and why">
              <summary><strong>Blocked, left in place</strong><span>rechecked when the cleanup runs</span><em>{formatBytes(plan.blocked.reduce((total, slot) => total + (slot.bytes ?? 0), 0))}</em></summary>
              </Tooltip>
              <ul className="storage-rows" aria-label="Blocked slots">
                {plan.blocked.map((slot) => (
                  <li key={slot.slotId} className="is-blocked">
                    <code>{slot.path}</code>
                    <span className="storage-why">{slot.reason}</span>
                    <span className="storage-size">{sizeOrUnknown(slot.bytes)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {plan && (
        <details className="storage-group">
          <Tooltip label="Show or hide what this cleanup never touches">
            <summary><strong>Never touched here</strong><span>out of scope for this cleanup</span><em /></summary>
          </Tooltip>
          <ul className="storage-plain">
            <li><b>{plan.untouched.leased} leased {plan.untouched.leased === 1 ? "slot" : "slots"}</b> ({formatBytes(plan.untouched.leasedBytes)}): a session holds each one.</li>
            <li><b>{plan.untouched.quarantined} quarantined {plan.untouched.quarantined === 1 ? "slot" : "slots"}</b> ({formatBytes(plan.untouched.quarantinedBytes)}): they need operator action in Worktrees.</li>
            <li><b>{plan.untouched.warm} warm {plan.untouched.warm === 1 ? "slot" : "slots"}</b> ({formatBytes(plan.untouched.warmBytes)}): the most recently used {plan.keepWarm} in each pool.</li>
            <li><b>Database backups</b> ({formatBytes(health.backups.totalBytes)}): kept by their own limits, which delete what they no longer keep when saved and after every capture.</li>
            <li><b>Live database, app updates, workflow evidence, archives and logs</b>: not cleaned from here.</li>
          </ul>
        </details>
      )}
      <div className="storage-preview-foot">
        <span>Owner, processes, Git state and task retention are checked again before each removal.</span>
        <Tooltip label="Build the Worktrees safety preview for exactly these slots">
          <button
            type="button"
            className="btn btn-danger"
            disabled={!plan || !idle.current || plan.remove.length === 0 || idle.busy}
            onClick={() => void idleActions.requestRemoval()}
          >
            {idle.busy && !idle.preview ? "Previewing…" : "Preview removal"}
          </button>
        </Tooltip>
      </div>
      {idle.preview && (
        <ActionDialog
          preview={idle.preview}
          error={idle.previewError}
          changed={idle.previewChanged}
          busy={idle.busy}
          onClose={idleActions.closeRemoval}
          onExecute={(acks) => void idleActions.executeRemoval(acks)}
          onRefresh={() => {
            idleActions.closeRemoval();
            void idleActions.reload();
          }}
        />
      )}
    </section>
  );
}

function WarningsTab({
  state,
  actions,
  health,
}: {
  state: StorageState;
  actions: StorageActions;
  health: StorageHealth;
}): React.JSX.Element {
  const keys = ["limitBytes", "warnAtPercent", "freeFloorBytes", "fleetBanner", "desktopNotification"] as const;
  const [draft, set, editedKeys] = useDraft(health.limits, keys, limitsDraftOf);
  const edited = draft ? Object.fromEntries(editedKeys.map((key) => [key, limitFieldValue(key, draft[key])])) : {};
  const patch = StorageLimitsConfigPatchSchema.safeParse(edited);
  const [permission, setPermission] = useState<string | null>(
    typeof Notification === "undefined" ? null : Notification.permission,
  );
  const { usage, volume, limits } = health;
  const warnAt = storageWarnAtBytes(limits);
  const sizeWarning = health.problems.some((problem) => problem.kind === "storage-limit");
  const spaceWarning = health.problems.some((problem) => problem.kind === "low-free-space");
  const disabled = !draft || state.savingLimits;

  const setNotify = (checked: boolean) => {
    set("desktopNotification", String(checked));
    if (checked && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().then(setPermission);
    }
  };

  return (
    <section className="storage-band" aria-label="Limits and warnings">
      <h3>Limits and warnings</h3>
      <p className="settings-hint settings-blurb">
        Warn before Mission Control grows past a size, or before the volume it lives on runs short of
        free space. A limit only warns: crossing it deletes nothing.
      </p>
      <div className="storage-status-grid" aria-label="Warning status">
        <article aria-label="Mission Control size" className={sizeWarning ? "is-warn" : undefined}>
          <span>Mission Control</span>
          <strong>{usage.totalBytes === null ? "Not measured yet" : formatBytes(usage.totalBytes)}</strong>
          <small>{limits.limitBytes === null ? "No size limit set" : `Limit ${formatBytes(limits.limitBytes)} · warns from ${formatBytes(warnAt!)}`}</small>
        </article>
        <article aria-label="Free space" className={spaceWarning ? "is-danger" : undefined}>
          <span>Free on its volume</span>
          <strong>{volume ? formatBytes(volume.freeBytes) : "Not checked yet"}</strong>
          <small>{limits.freeFloorBytes === null ? "No free-space floor set" : `Floor ${formatBytes(limits.freeFloorBytes)}`}</small>
        </article>
        <article aria-label="Warnings now">
          <span>Warnings now</span>
          <strong>{sizeWarning || spaceWarning ? [spaceWarning && "Low free space", sizeWarning && "Near the limit"].filter(Boolean).join(", ") : "None"}</strong>
          <small>Shown on the Storage rail{limits.fleetBanner ? " and the fleet" : ""}</small>
        </article>
      </div>
      <div className="storage-config-row">
        <Tooltip label="Warn when Mission Control uses this much. Empty is no limit">
          <label>
            <span>Storage limit</span>
            <span className="storage-field">
              <input className="storage-input" inputMode="decimal" aria-label="Storage limit in GiB" placeholder="No limit" value={draft?.limitBytes ?? ""} disabled={disabled} onChange={(event) => set("limitBytes", event.target.value)} />
              <em>GiB</em>
            </span>
          </label>
        </Tooltip>
        <Tooltip label="Start warning at this share of the limit, 50 to 100">
          <label>
            <span>Warn at</span>
            <span className="storage-field">
              <input className="storage-input" inputMode="numeric" aria-label="Warn at percent of the limit" value={draft?.warnAtPercent ?? ""} disabled={disabled} onChange={(event) => set("warnAtPercent", event.target.value)} />
              <em>% of limit</em>
            </span>
          </label>
        </Tooltip>
        <Tooltip label="Warn when the volume has less than this free. Empty is no floor">
          <label>
            <span>Free-space floor</span>
            <span className="storage-field">
              <input className="storage-input" inputMode="decimal" aria-label="Free-space floor in GiB" placeholder="No floor" value={draft?.freeFloorBytes ?? ""} disabled={disabled} onChange={(event) => set("freeFloorBytes", event.target.value)} />
              <em>GiB free</em>
            </span>
          </label>
        </Tooltip>
      </div>
      <fieldset className="storage-checks">
        <legend>Warn me with</legend>
        <label>
          <Tooltip label="Show a banner above the fleet while a size or free-space warning stands">
            <input type="checkbox" checked={draft?.fleetBanner === "true"} disabled={disabled} onChange={(event) => set("fleetBanner", String(event.target.checked))} />
          </Tooltip>
          A banner on the fleet
        </label>
        <label>
          <Tooltip label="Send one desktop notification when a size or free-space warning starts">
            <input type="checkbox" checked={draft?.desktopNotification === "true"} disabled={disabled} onChange={(event) => setNotify(event.target.checked)} />
          </Tooltip>
          A desktop notification when a warning starts
        </label>
      </fieldset>
      {draft?.desktopNotification === "true" && permission === "denied" && (
        <p className="settings-hint">This browser blocks notifications from Mission Control, so only the banner and the rail will show warnings.</p>
      )}
      <p className="settings-hint">The Storage rail dot always shows a standing warning.</p>
      {draft && !patch.success && (
        <p className="settings-error">Limits must be at least 0.25 GiB, and the warning 50 to 100% of the limit.</p>
      )}
      <div className="storage-primary-action">
        <Tooltip label="Save the limits and warning channels. Saving removes nothing">
          <button
            type="button"
            className="btn"
            disabled={editedKeys.length === 0 || !patch.success || state.savingLimits}
            onClick={() => { if (patch.success) void actions.saveLimits(patch.data); }}
          >
            {state.savingLimits ? "Saving…" : "Save limits"}
          </button>
        </Tooltip>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- panel

export function StorageSettingsPanelView({
  state,
  actions,
  idle,
  idleActions,
  onNavigate,
  jumpAnchor = null,
  jumpRequestId = null,
  now = Date.now(),
}: {
  state: StorageState;
  actions: StorageActions;
  idle: IdleCacheState;
  idleActions: IdleCacheActions;
  onNavigate: SettingsNavigate;
  jumpAnchor?: string | null;
  jumpRequestId?: number | null;
  now?: number;
}): React.JSX.Element {
  // A deep link chooses the tab its control lives on in the same render it arrives, so the
  // settings page's flash finds the control on the first try; recording it waits for the effect.
  const [selection, setSelection] = useState<{ tab: StorageTabId; seen: number | null }>({ tab: "overview", seen: null });
  const jumpTab = jumpAnchor ? storageTabForAnchor(jumpAnchor) : null;
  const unseen = jumpRequestId !== null && jumpRequestId !== selection.seen;
  const tab = unseen && jumpTab ? jumpTab : selection.tab;
  useEffect(() => {
    if (jumpRequestId === null || jumpRequestId === selection.seen) return;
    setSelection((current) => ({ tab: jumpTab ?? current.tab, seen: jumpRequestId }));
  }, [jumpRequestId, jumpTab, selection.seen]);
  const tabRefs = useRef(new Map<StorageTabId, HTMLButtonElement>());
  const choose = (next: StorageTabId, focus = false) => {
    setSelection((current) => ({ ...current, tab: next }));
    if (focus) tabRefs.current.get(next)?.focus();
  };
  const onTabKey = (event: React.KeyboardEvent) => {
    const index = STORAGE_TABS.findIndex((entry) => entry.id === tab);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    choose(STORAGE_TABS[(index + step + STORAGE_TABS.length) % STORAGE_TABS.length]!.id, true);
  };

  const health = state.health;
  const badge = (id: StorageTabId): React.ReactNode => {
    if (!health) return null;
    if (id === "backups") return <small>{formatBytes(health.backups.totalBytes)}</small>;
    if (id === "pools") {
      const bytes = categoryBytes(health, "pools");
      return bytes === null ? null : <small>{formatBytes(bytes)}</small>;
    }
    if (id === "cleanup") {
      return idle.plan && idle.plan.freesBytes > 0 ? <small className="storage-green">{formatBytes(idle.plan.freesBytes)}</small> : null;
    }
    if (id === "warnings" && health.problems.some((problem) => SIZE_WARNINGS.has(problem.kind))) {
      return <span className="storage-tab-dot" role="img" aria-label="A warning is standing" />;
    }
    return null;
  };
  const anchor = STORAGE_TABS.find((entry) => entry.id === tab)!.anchor;

  return (
    <div className="settings-section storage-panel">
      {state.loadError && <p className="settings-error" role="alert">{state.loadError}</p>}
      {state.error && <p className="settings-error" role="alert">{state.error}</p>}
      {state.notice && <p className="settings-hint" role="status">{state.notice}</p>}
      <div className="storage-tabs" role="tablist" aria-label="Storage views" onKeyDown={onTabKey}>
        {STORAGE_TABS.map((entry) => (
          <Tooltip key={entry.id} label={entry.hint}>
          <button
            ref={(element) => {
              if (element) tabRefs.current.set(entry.id, element);
              else tabRefs.current.delete(entry.id);
            }}
            id={`storage-tab-${entry.id}`}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            aria-controls={`storage-tabpanel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className={`storage-tab${tab === entry.id ? " is-active" : ""}`}
            onClick={() => choose(entry.id)}
          >
            {entry.label}
            {badge(entry.id)}
          </button>
          </Tooltip>
        ))}
      </div>
      <div
        className="storage-tabpanel"
        role="tabpanel"
        id={`storage-tabpanel-${tab}`}
        aria-labelledby={`storage-tab-${tab}`}
        data-anchor={anchor}
      >
        {!health ? (
          <p className="settings-hint" role="status">Checking storage…</p>
        ) : tab === "overview" ? (
          <OverviewTab health={health} idle={idle} onOpen={choose} onMeasure={() => void actions.measure()} now={now} />
        ) : tab === "backups" ? (
          <BackupsTab state={state} actions={actions} now={now} />
        ) : tab === "pools" ? (
          <PoolsTab state={state} actions={actions} idle={idle} limits={health.limits} onNavigate={onNavigate} />
        ) : tab === "cleanup" ? (
          <CleanupTab health={health} idle={idle} idleActions={idleActions} onOpen={choose} onMeasure={() => void actions.measure()} now={now} />
        ) : (
          <WarningsTab state={state} actions={actions} health={health} />
        )}
      </div>
    </div>
  );
}

export function StorageSettingsPanel({
  health,
  configRevision = 0,
  worktreesRevision = 0,
  onNavigate,
  jumpAnchor = null,
  jumpRequestId = null,
}: {
  health: StorageHealth | null;
  configRevision?: number;
  worktreesRevision?: number;
  onNavigate: SettingsNavigate;
  jumpAnchor?: string | null;
  jumpRequestId?: number | null;
}): React.JSX.Element {
  const storage = useStorage(health, configRevision);
  const { save, saveLimits, backUpNow, measure, ...state } = storage;
  const shown = state.health;
  // The plan reads sizes, the budget and every slot, so it is re-read whenever any of them move.
  const planRevision = [
    worktreesRevision,
    shown?.limits.poolIdleBudgetBytes ?? "none",
    shown?.limits.poolKeepWarm ?? "none",
    shown?.usage.measuredAt ?? "unmeasured",
  ].join(":");
  const { reload, requestRemoval, executeRemoval, closeRemoval, ...idle } = useIdleCache(true, planRevision);
  return (
    <StorageSettingsPanelView
      state={state}
      actions={{ save, saveLimits, backUpNow, measure }}
      idle={idle}
      idleActions={{ reload, requestRemoval, executeRemoval, closeRemoval }}
      onNavigate={onNavigate}
      jumpAnchor={jumpAnchor}
      jumpRequestId={jumpRequestId}
    />
  );
}
