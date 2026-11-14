import { useCallback, useEffect, useRef, useState } from "react";
import type { DatabaseBackupsConfigPatch } from "@shared/database-backups.ts";
import type { IdleCachePlan, StorageHealth, StorageView } from "@shared/storage-health.ts";
import type { StorageLimitsConfigPatch } from "@shared/storage-limits.ts";
import type { WorktreeActionPreview, WorktreeRiskKey } from "@shared/worktrees.ts";
import {
  api,
  executeWorktreeAction,
  fetchIdleCachePlan,
  fetchStorage,
  previewWorktreeAction,
} from "./lib/api.ts";
import { backupSaveNotice } from "./lib/storage-view.ts";

// Settings > Storage. The live aggregate arrives over SSE as `storage_health`; this hook owns
// what the event does not carry - the backup config - and the two writes. It reads the route
// on open, after each write, and whenever any window saves the config (`storage_config_changed`),
// so the page is right even while the stream is down. That read recomputes on the daemon,
// which is also what publishes a fresh event.
//
// Both sources carry the same aggregate, so the page shows whichever ARRIVED last. Preferring
// the stream whenever it had a value hid the re-read after a write while the stream was down,
// which is the one case the re-read exists for.

export interface StorageState {
  /** The last `GET /api/storage` answer, or null before it lands. */
  view: StorageView | null;
  /** The newest aggregate from either the stream or the route, or null before either. */
  health: StorageHealth | null;
  loadError: string | null;
  saving: boolean;
  savingLimits: boolean;
  backingUp: boolean;
  /** Why the last write failed, or null. Cleared by the next one that succeeds. */
  error: string | null;
  /** What the last write did, or null. */
  notice: string | null;
}

export interface StorageActions {
  /** Save a patch, refusing unless the daemon would delete exactly `expectRemove`. */
  save: (patch: DatabaseBackupsConfigPatch, expectRemove: string[]) => Promise<boolean>;
  saveLimits: (patch: StorageLimitsConfigPatch) => Promise<boolean>;
  backUpNow: () => Promise<void>;
  measure: () => Promise<void>;
}

function failure(result: { error?: string; message?: string }): string {
  return result.message ?? result.error ?? "The daemon refused the request.";
}

/**
 * `live` is `MissionState.storageHealth`. Each source replaces the shown aggregate when it
 * delivers a new value, so neither a stale stream value nor an old route read can outrank a
 * newer answer from the other.
 */
export function useStorage(
  live: StorageHealth | null,
  configRevision = 0,
): StorageState & StorageActions {
  const [view, setView] = useState<StorageView | null>(null);
  const [health, setHealth] = useState<StorageHealth | null>(live);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingLimits, setSavingLimits] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Back up now is clickable before the first read lands, so reads can overlap; only the
  // newest one may write.
  const reloadSeq = useRef(0);
  /** Read the aggregate and config again. Resolves to what was read, or null when it failed. */
  const reload = useCallback(async (): Promise<StorageView | null> => {
    const seq = ++reloadSeq.current;
    const next = await fetchStorage();
    if (seq !== reloadSeq.current) return next;
    if (next) {
      setView(next);
      setLoadError(null);
    } else {
      setLoadError("Storage status could not be loaded from the daemon.");
    }
    return next;
  }, []);

  // `configRevision` moves when any window saves the backup config, and on every reconnect.
  useEffect(() => {
    void reload();
  }, [reload, configRevision]);

  useEffect(() => {
    if (live) setHealth(live);
  }, [live]);
  useEffect(() => {
    if (view) setHealth(view.health);
  }, [view]);

  const save = useCallback(async (patch: DatabaseBackupsConfigPatch, expectRemove: string[]): Promise<boolean> => {
    setSaving(true);
    try {
      const result = await api.setDatabaseBackupsConfig({ ...patch, expectRemove });
      if (!result.ok) {
        if (result.status === 409) {
          // The copies moved after the preview. Nothing was saved or deleted; the re-read below
          // puts the current copies on the page, so the list beside Save is right again.
          setError("The kept copies changed after this preview, so nothing was saved or deleted. Check the list of copies saving deletes again, then save.");
          setNotice(null);
          await reload();
          return false;
        }
        setError(`Backup settings were not saved: ${failure(result)}`);
        setNotice(null);
        return false;
      }
      setError(null);
      // The save succeeds once the limits are stored; the prune after it can still fail. Say
      // what the copies read back show, never that they were removed because the save passed.
      const after = await reload();
      setNotice(backupSaveNotice(expectRemove, after?.health.backups.copies ?? null));
      return true;
    } finally {
      setSaving(false);
    }
  }, [reload]);

  const backUpNow = useCallback(async (): Promise<void> => {
    setBackingUp(true);
    try {
      const result = await api.backUpDatabase();
      if (result.ok) {
        setError(null);
        setNotice("Backup taken. The newest manual copy replaces the previous one.");
      } else {
        setError(failure(result));
        setNotice(null);
      }
      await reload();
    } finally {
      setBackingUp(false);
    }
  }, [reload]);

  const saveLimits = useCallback(async (patch: StorageLimitsConfigPatch): Promise<boolean> => {
    setSavingLimits(true);
    try {
      const result = await api.setStorageLimits(patch);
      if (!result.ok) {
        setError(`Storage limits were not saved: ${failure(result)}`);
        setNotice(null);
        return false;
      }
      setError(null);
      setNotice("Storage limits saved. Nothing was removed.");
      await reload();
      return true;
    } finally {
      setSavingLimits(false);
    }
  }, [reload]);

  const measure = useCallback(async (): Promise<void> => {
    const result = await api.measureStorage();
    if (!result.ok) {
      setError(`Measuring could not start: ${failure(result)}`);
      return;
    }
    setError(null);
    await reload();
  }, [reload]);

  return {
    view,
    health,
    loadError,
    saving,
    savingLimits,
    backingUp,
    error,
    notice,
    save,
    saveLimits,
    backUpNow,
    measure,
  };
}

export interface IdleCacheState {
  plan: IdleCachePlan | null;
  /**
   * The plan was read for the current inputs (budget, keep-warm, sizes, slots) and no newer read
   * is pending. Only a current plan may be previewed for removal: one chosen under a budget that
   * has since changed, or that could not be read again, is shown but never acted on.
   */
  current: boolean;
  loading: boolean;
  loadError: string | null;
  /** The removal preview open in the dialog, or null. */
  preview: WorktreeActionPreview | null;
  previewError: string | null;
  /** The preview went stale before Execute: state changed under it. */
  previewChanged: boolean;
  busy: boolean;
  /** What the last accepted removal did, or null. */
  notice: string | null;
}

export interface IdleCacheActions {
  reload: () => Promise<void>;
  /** Build the Worktrees safety preview for exactly the slots the plan chose. */
  requestRemoval: () => Promise<void>;
  executeRemoval: (acks: WorktreeRiskKey[]) => Promise<void>;
  closeRemoval: () => void;
}

/**
 * The idle-cache plan behind the Pool caches and Cleanup tabs, and its one action. Removal is
 * not this page's own mechanism: it is a Worktrees preview of the exact slots the plan chose,
 * executed through the same queue, rechecks and dialog as Settings > Worktrees.
 *
 * `revision` moves whenever the plan's inputs may have: a worktree changed, the limits were
 * saved, or a measurement finished. The plan observes every slot through Git, so it is read
 * only while the Storage page is open.
 */
export function useIdleCache(enabled: boolean, revision: string): IdleCacheState & IdleCacheActions {
  const [loaded, setLoaded] = useState<{ plan: IdleCachePlan; revision: string } | null>(null);
  const plan = loaded?.plan ?? null;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorktreeActionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewChanged, setPreviewChanged] = useState(false);
  /** The plan revision the open preview was built from. */
  const [previewRevision, setPreviewRevision] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);
  const latestRevision = useRef(revision);
  latestRevision.current = revision;

  const read = useCallback(async (forRevision: string): Promise<void> => {
    const mine = ++seq.current;
    setLoading(true);
    const next = await fetchIdleCachePlan();
    if (mine !== seq.current) return;
    setLoading(false);
    if (next) {
      setLoaded({ plan: next, revision: forRevision });
      setLoadError(null);
    } else {
      // The plan's current inputs could not be read, so the last one is no longer the plan for
      // them: drop it rather than leave a removal chosen under an older budget on offer.
      setLoaded(null);
      setLoadError("The pool-cache plan could not be read from the daemon, so nothing is offered for removal.");
    }
  }, []);
  const reload = useCallback(() => read(latestRevision.current), [read]);

  useEffect(() => {
    if (enabled) void read(revision);
  }, [enabled, revision, read]);

  const current = loaded !== null && loaded.revision === revision && !loading && loadError === null;

  const markPreviewStale = useCallback(() => {
    setPreviewChanged(true);
    setPreviewError("The cleanup plan changed while this preview was open (the budget, a size or a slot moved), so it cannot run. Preview again from the current plan.");
  }, []);

  // An open preview belongs to the plan it was built from. When that plan's inputs move, it is
  // marked stale at once, which disables Execute in the dialog until a new preview replaces it.
  useEffect(() => {
    if (preview && previewRevision !== null && previewRevision !== revision) markPreviewStale();
  }, [preview, previewRevision, revision, markPreviewStale]);

  const requestRemoval = useCallback(async (): Promise<void> => {
    if (!plan || !current || plan.remove.length === 0) return;
    const builtFor = latestRevision.current;
    setBusy(true);
    setPreview(null);
    setPreviewError(null);
    setPreviewChanged(false);
    const result = await previewWorktreeAction({
      action: "trimIdle",
      slotIds: plan.remove.map((slot) => slot.slotId),
    });
    setBusy(false);
    if (!result.ok) {
      setPreviewError(result.error);
      return;
    }
    const { ok: _ok, ...next } = result;
    setPreview(next);
    setPreviewRevision(builtFor);
    // The inputs moved while the preview was being built: it opens already stale.
    if (builtFor !== latestRevision.current) markPreviewStale();
  }, [plan, current, markPreviewStale]);

  const executeRemoval = useCallback(async (acks: WorktreeRiskKey[]): Promise<void> => {
    if (!preview) return;
    // Only the plan the preview was built from may run: a budget, size or slot that moved since
    // could mean these slots are no longer the ones over the budget.
    if (!current || previewRevision !== latestRevision.current) {
      markPreviewStale();
      return;
    }
    setBusy(true);
    setPreviewError(null);
    const result = await executeWorktreeAction(preview.token, acks);
    setBusy(false);
    if (!result.ok) {
      setPreviewChanged(result.status === 409);
      setPreviewError(result.error);
      return;
    }
    const count = preview.affected.length;
    setPreview(null);
    setPreviewChanged(false);
    setPreviewRevision(null);
    setNotice(`Removing ${count} idle ${count === 1 ? "slot" : "slots"} in the background. Progress is listed in Settings > Worktrees.`);
    void reload();
  }, [preview, previewRevision, current, reload, markPreviewStale]);

  const closeRemoval = useCallback(() => {
    setPreview(null);
    setPreviewRevision(null);
    setPreviewError(null);
    setPreviewChanged(false);
  }, []);

  return {
    plan,
    current,
    loading,
    loadError,
    preview,
    previewError,
    previewChanged,
    busy,
    notice,
    reload,
    requestRemoval,
    executeRemoval,
    closeRemoval,
  };
}
