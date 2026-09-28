import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorktreesConfig, WorktreesConfigPatch } from "@shared/protocol.ts";
import type {
  WorktreeActionPreview,
  WorktreeActionRequest,
  WorktreeInventory,
  WorktreeOperationView,
  WorktreeRiskKey,
} from "@shared/worktrees.ts";
import {
  dismissWorktreeOperation,
  executeWorktreeAction,
  fetchWorktrees,
  previewWorktreeAction,
  updateWorktreesConfig,
} from "./lib/api.ts";

const BACKSTOP_MS = 60_000;

function mergeConfig(current: WorktreesConfig, patch: WorktreesConfigPatch): WorktreesConfig {
  const repositories = { ...current.repositories };
  for (const [key, value] of Object.entries(patch.repositories ?? {})) {
    if (value === null) {
      delete repositories[key];
      continue;
    }
    const next = Object.assign({}, repositories[key], value);
    if (value.setupArgv === null) delete next.setupArgv;
    repositories[key] = next as WorktreesConfig["repositories"][string];
  }
  return { ...current, ...patch, repositories } as WorktreesConfig;
}

export interface WorktreesState {
  inventory: WorktreeInventory | null;
  loading: boolean;
  error: string | null;
  preview: WorktreeActionPreview | null;
  previewError: string | null;
  previewChanged: boolean;
  busy: boolean;
  /** Background cleanups: queued, running, or failed and not yet dismissed. */
  operations: WorktreeOperationView[];
  refresh: () => Promise<void>;
  updateConfig: (patch: WorktreesConfigPatch) => Promise<void>;
  requestPreview: (request: WorktreeActionRequest) => Promise<void>;
  executePreview: (acks: WorktreeRiskKey[]) => Promise<boolean>;
  discardPreview: () => void;
  dismissOperation: (id: string) => Promise<void>;
}

/** An accepted Execute, shown until an inventory read that began after it lands. */
interface SubmittedOperation {
  view: WorktreeOperationView;
  /** The last read sequence issued before submission; any later read already includes it. */
  readSeq: number;
}

export function useWorktrees(revision = 0, enabled = true): WorktreesState {
  const [inventory, setInventoryState] = useState<WorktreeInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorktreeActionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewChanged, setPreviewChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<SubmittedOperation[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const inventoryRef = useRef<WorktreeInventory | null>(null);
  const readSeq = useRef(0);
  const writeChain = useRef(Promise.resolve());

  const setInventory = useCallback((next: WorktreeInventory | null): void => {
    inventoryRef.current = next;
    setInventoryState(next);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    const seq = ++readSeq.current;
    const controller = new AbortController();
    setLoading(true);
    const next = await fetchWorktrees(controller.signal);
    if (seq !== readSeq.current) return;
    setLoading(false);
    if (!next) {
      // KEEP what we already observed. A refresh can fail for a moment - the daemon is busy
      // shelling out to git for somebody else, a request is aborted - and throwing the last
      // good inventory away for that turns every blip into a full outage: `disabled={!config}`
      // greys out the whole panel, and the maximum-slots box falls back to its hardcoded 16,
      // which is not the operator's setting and is not labelled as a placeholder. Somebody
      // reading it is told their maximum is 16 when it is 4.
      //
      // The panel was already written for this: `inventory && error` renders the failure as a
      // banner ABOVE data it still trusts, and `!inventory && error` is the real outage state.
      // Only the second was ever reachable after a first successful load. Now both are, and
      // which one an operator sees matches which thing actually happened.
      setError("Worktree inventory is unavailable.");
      return;
    }
    setInventory(next);
    setError(null);
    setSubmitted((current) => current.filter((entry) => entry.readSeq >= seq));
  }, [enabled, setInventory]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), BACKSTOP_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh, revision]);

  // A worktrees_changed invalidation refreshes the inventory and leaves an open preview
  // alone. Background cleanups publish one as each finishes, and closing whatever dialog the
  // operator had moved on to would make queueing the next one impossible. The preview is
  // not trusted anyway: Execute rebuilds it from fresh state and refuses if it moved.

  const updateConfig = useCallback(async (patch: WorktreesConfigPatch): Promise<void> => {
    const before = inventoryRef.current;
    if (!before) return;
    const optimistic = { ...before, config: mergeConfig(before.config, patch) };
    setInventory(optimistic);
    setPreview(null);
    setPreviewError(null);
    setPreviewChanged(false);
    const operation = writeChain.current.then(async () => {
      const result = await updateWorktreesConfig(patch);
      if (!result.ok) {
        if (inventoryRef.current === optimistic) setInventory(before);
        setError(`That policy change did not stick: ${result.error}`);
        return;
      }
      setError(null);
      await refresh();
    });
    writeChain.current = operation.catch(() => {});
    await operation;
  }, [refresh, setInventory]);

  const requestPreview = useCallback(async (request: WorktreeActionRequest): Promise<void> => {
    setBusy(true);
    setPreview(null);
    setPreviewError(null);
    setPreviewChanged(false);
    const result = await previewWorktreeAction(request);
    setBusy(false);
    if (!result.ok) {
      setPreviewError(result.error);
      return;
    }
    const { ok: _ok, ...next } = result;
    setPreview(next);
  }, []);

  const executePreview = useCallback(async (acks: WorktreeRiskKey[]): Promise<boolean> => {
    if (!preview) return false;
    setBusy(true);
    setPreviewError(null);
    const result = await executeWorktreeAction(preview.token, acks);
    setBusy(false);
    if (!result.ok) {
      setPreviewChanged(result.status === 409);
      setPreviewError(result.error);
      return false;
    }
    // Accepted, not finished. The dialog closes now and the work shows as pending on its
    // slots; the inventory refresh that follows is deliberately not awaited.
    setSubmitted((current) => [...current, { view: result.operation, readSeq: readSeq.current }]);
    setPreview(null);
    setPreviewChanged(false);
    void refresh();
    return true;
  }, [preview, refresh]);

  const discardPreview = useCallback(() => {
    setPreview(null);
    setPreviewError(null);
    setPreviewChanged(false);
  }, []);

  const dismissOperation = useCallback(async (id: string): Promise<void> => {
    setDismissed((current) => new Set(current).add(id));
    const result = await dismissWorktreeOperation(id);
    if (!result.ok) {
      // The daemon still holds the record, so hiding it here would hide it for good: every
      // later refresh would filter it out again. Put it back and say why.
      setDismissed((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setError(`That cleanup report could not be dismissed: ${result.error}`);
      return;
    }
    void refresh();
  }, [refresh]);

  const operations = useMemo(() => {
    const observed = inventory?.operations ?? [];
    const known = new Set(observed.map((entry) => entry.id));
    return [...observed, ...submitted.map((entry) => entry.view).filter((entry) => !known.has(entry.id))]
      .filter((entry) => !dismissed.has(entry.id));
  }, [inventory, submitted, dismissed]);

  return {
    inventory,
    loading,
    error,
    preview,
    previewError,
    previewChanged,
    busy,
    operations,
    refresh,
    updateConfig,
    requestPreview,
    executePreview,
    discardPreview,
    dismissOperation,
  };
}
