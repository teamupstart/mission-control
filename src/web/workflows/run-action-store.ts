import {
  useCallback,
  useRef,
  useSyncExternalStore,
} from "react";
import type { WorkflowRunId } from "@shared/workflow.ts";
import type { RunActionId } from "./run-actions.ts";

interface ActionEntry {
  requestId: string;
  pending: boolean;
  error: string | null;
  refreshViaMountedSurface: boolean;
}

type RunActionRefresh = () => void | Promise<unknown>;

interface RunActionRefreshRegistration {
  refresh: RunActionRefresh;
}

interface RunActionRefreshCycle {
  pending: Set<RunActionRefreshRegistration>;
  completed: Set<RunActionRefreshRegistration>;
  settled: boolean;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

const actions = new Map<string, ActionEntry>();
const listeners = new Map<WorkflowRunId, Set<() => void>>();
const refreshers = new Map<WorkflowRunId, Set<RunActionRefreshRegistration>>();
const refreshCycles = new Map<WorkflowRunId, Set<RunActionRefreshCycle>>();
const revisions = new Map<WorkflowRunId, number>();

const keyOf = (runId: WorkflowRunId, action: RunActionId): string =>
  `${runId}:${action}`;

function notify(runId: WorkflowRunId): void {
  for (const listener of listeners.get(runId) ?? []) listener();
}

function emit(runId: WorkflowRunId): void {
  revisions.set(runId, (revisions.get(runId) ?? 0) + 1);
  notify(runId);
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Workflow action failed";
}

function clearRunActionErrors(runId: WorkflowRunId): void {
  const prefix = `${runId}:`;
  for (const [key, entry] of actions) {
    if (key.startsWith(prefix)) entry.error = null;
  }
}

function removeRefreshCycle(
  runId: WorkflowRunId,
  cycle: RunActionRefreshCycle,
): void {
  const cycles = refreshCycles.get(runId);
  cycles?.delete(cycle);
  if (cycles?.size === 0) refreshCycles.delete(runId);
}

function settleRefreshCycle(
  runId: WorkflowRunId,
  cycle: RunActionRefreshCycle,
): void {
  if (cycle.settled) return;
  cycle.settled = true;
  removeRefreshCycle(runId, cycle);
  cycle.resolve();
}

function failRefreshCycle(
  runId: WorkflowRunId,
  cycle: RunActionRefreshCycle,
  reason: unknown,
): void {
  if (cycle.settled) return;
  cycle.settled = true;
  removeRefreshCycle(runId, cycle);
  cycle.reject(reason);
}

function advanceRefreshCycle(
  runId: WorkflowRunId,
  cycle: RunActionRefreshCycle,
): void {
  if (cycle.settled) return;
  const mounted = refreshers.get(runId) ?? new Set();
  for (const registration of mounted) {
    if (cycle.pending.has(registration) || cycle.completed.has(registration)) continue;
    cycle.pending.add(registration);
    let refreshing: Promise<unknown>;
    try {
      refreshing = Promise.resolve(registration.refresh());
    } catch (caught) {
      refreshing = Promise.reject(caught);
    }
    void refreshing.then(
      () => {
        cycle.pending.delete(registration);
        if (!(refreshers.get(runId)?.has(registration) ?? false)) {
          advanceRefreshCycle(runId, cycle);
          return;
        }
        cycle.completed.add(registration);
        advanceRefreshCycle(runId, cycle);
      },
      (caught) => {
        cycle.pending.delete(registration);
        if (!(refreshers.get(runId)?.has(registration) ?? false)) {
          advanceRefreshCycle(runId, cycle);
          return;
        }
        failRefreshCycle(runId, cycle, caught);
      },
    );
  }
  if (
    mounted.size > 0
    && [...mounted].every((registration) => cycle.completed.has(registration))
  ) {
    settleRefreshCycle(runId, cycle);
  }
}

function refreshMountedSurfaces(
  runId: WorkflowRunId,
  fallback: RunActionRefresh,
  refreshViaMountedSurface: boolean,
): Promise<void> {
  const mounted = refreshers.get(runId);
  if ((mounted?.size ?? 0) === 0 && !refreshViaMountedSurface) {
    try {
      return Promise.resolve(fallback()).then(() => {});
    } catch (caught) {
      return Promise.reject(caught);
    }
  }
  return new Promise<void>((resolve, reject) => {
    const cycle: RunActionRefreshCycle = {
      pending: new Set(),
      completed: new Set(),
      settled: false,
      resolve,
      reject,
    };
    const cycles = refreshCycles.get(runId) ?? new Set();
    cycles.add(cycle);
    refreshCycles.set(runId, cycles);
    advanceRefreshCycle(runId, cycle);
  });
}

function refreshAvailableSurfaces(
  runId: WorkflowRunId,
  fallback: RunActionRefresh,
): Promise<void> {
  const mounted = [...(refreshers.get(runId) ?? [])];
  const callbacks = mounted.length > 0
    ? mounted.map((registration) => registration.refresh)
    : [fallback];
  return Promise.all(callbacks.map((refresh) => {
    try {
      return Promise.resolve(refresh());
    } catch (caught) {
      return Promise.reject(caught);
    }
  })).then(() => {});
}

/**
 * Starts one run action, retaining its request id across a failed response.
 *
 * The entry is module-level because the Runs monitor and session detail live on different
 * pages. Navigating between them must not turn one pending intent into a second request.
 */
export function runAction(
  runId: WorkflowRunId,
  action: RunActionId,
  send: (requestId: string) => Promise<unknown>,
  onSettled: () => void | Promise<unknown>,
): void {
  const key = keyOf(runId, action);
  const existing = actions.get(key);
  if (existing?.pending) return;

  clearRunActionErrors(runId);
  const entry: ActionEntry = existing ?? {
    requestId: crypto.randomUUID(),
    pending: false,
    error: null,
    refreshViaMountedSurface: false,
  };
  entry.pending = true;
  entry.error = null;
  // Remember this action's initiating context, not every run surface ever mounted. If that
  // surface leaves before the POST settles, its refresh cycle waits for the destination. A
  // direct caller with no registered surface still uses its supplied fallback immediately.
  entry.refreshViaMountedSurface = (refreshers.get(runId)?.size ?? 0) > 0;
  actions.set(key, entry);
  emit(runId);

  let sent: Promise<unknown>;
  try {
    sent = send(entry.requestId);
  } catch (caught) {
    sent = Promise.reject(caught);
  }
  void sent.then(
    () => {
      if (actions.get(key) !== entry) return;
      void refreshMountedSurfaces(
        runId,
        onSettled,
        entry.refreshViaMountedSurface,
      ).then(
        () => {
          if (actions.get(key) !== entry) return;
          actions.delete(key);
          emit(runId);
        },
        (caught) => {
          if (actions.get(key) !== entry) return;
          entry.pending = false;
          entry.error = errorMessage(caught);
          emit(runId);
        },
      );
    },
    (caught) => {
      if (actions.get(key) !== entry) return;
      entry.pending = false;
      entry.error = errorMessage(caught);
      emit(runId);
      // The mutation error is the actionable failure. A refresh failure must not replace it
      // or turn the rejected action back into a permanently pending one.
      void refreshAvailableSurfaces(runId, onSettled).catch(() => {});
    },
  );
}

export function isRunActionPending(
  runId: WorkflowRunId,
  action: RunActionId,
): boolean {
  return actions.get(keyOf(runId, action))?.pending ?? false;
}

function runActionError(runId: WorkflowRunId): string | null {
  const prefix = `${runId}:`;
  for (const [key, entry] of [...actions].reverse()) {
    if (key.startsWith(prefix) && entry.error) return entry.error;
  }
  return null;
}

/** Registers the refetch owned by one currently mounted run surface. */
export function registerRunActionRefresh(
  runId: WorkflowRunId,
  refresh: RunActionRefresh,
): () => void {
  const registration = { refresh };
  const runRefreshers = refreshers.get(runId) ?? new Set();
  runRefreshers.add(registration);
  refreshers.set(runId, runRefreshers);
  for (const cycle of refreshCycles.get(runId) ?? []) {
    advanceRefreshCycle(runId, cycle);
  }
  return () => {
    // A component releases its private commit barrier as it unmounts, which resolves the
    // Promise returned by this registration. Remove the registration first so that resolution
    // cannot acknowledge the shared action cycle; a replacement mount takes over below.
    runRefreshers.delete(registration);
    if (runRefreshers.size === 0) refreshers.delete(runId);
    for (const cycle of refreshCycles.get(runId) ?? []) {
      cycle.pending.delete(registration);
      cycle.completed.delete(registration);
      advanceRefreshCycle(runId, cycle);
    }
  };
}

export function dropRunActions(runId: WorkflowRunId): void {
  const prefix = `${runId}:`;
  let changed = revisions.delete(runId);
  for (const cycle of [...(refreshCycles.get(runId) ?? [])]) {
    settleRefreshCycle(runId, cycle);
  }
  for (const key of actions.keys()) {
    if (!key.startsWith(prefix)) continue;
    actions.delete(key);
    changed = true;
  }
  // Run removal is the terminal lifecycle event: notify mounted readers of the reset without
  // calling `emit`, which would immediately recreate the revision entry we just released.
  if (changed) notify(runId);
}

function subscribe(
  runId: WorkflowRunId,
  listener: () => void,
  refresh: RunActionRefresh,
): () => void {
  const runListeners = listeners.get(runId) ?? new Set();
  runListeners.add(listener);
  listeners.set(runId, runListeners);
  const unregisterRefresh = registerRunActionRefresh(runId, refresh);
  return () => {
    runListeners.delete(listener);
    if (runListeners.size === 0) listeners.delete(runId);
    unregisterRefresh();
  };
}

export interface RunActionsController {
  run: (
    action: RunActionId,
    send: (requestId: string) => Promise<unknown>,
  ) => void;
  isPending: (action: RunActionId) => boolean;
  error: string | null;
}

/** Subscribes one mounted surface to the module-level entries for a run. */
export function useRunActions(
  runId: WorkflowRunId,
  onSettled: () => void | Promise<unknown>,
): RunActionsController {
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const refresh = useCallback(
    () => onSettledRef.current(),
    [],
  );
  const subscribeToRun = useCallback(
    (listener: () => void) => subscribe(runId, listener, refresh),
    [refresh, runId],
  );
  const getSnapshot = useCallback(
    () => revisions.get(runId) ?? 0,
    [runId],
  );
  useSyncExternalStore(subscribeToRun, getSnapshot, getSnapshot);

  return {
    run: useCallback(
      (action, send) => runAction(
        runId,
        action,
        send,
        refresh,
      ),
      [refresh, runId],
    ),
    isPending: useCallback(
      (action) => isRunActionPending(runId, action),
      [runId],
    ),
    error: runActionError(runId),
  };
}
