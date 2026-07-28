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
}

const actions = new Map<string, ActionEntry>();
const listeners = new Map<WorkflowRunId, Set<() => void>>();
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
  onSettled: () => void,
): void {
  const key = keyOf(runId, action);
  const existing = actions.get(key);
  if (existing?.pending) return;

  const entry: ActionEntry = existing ?? {
    requestId: crypto.randomUUID(),
    pending: false,
    error: null,
  };
  entry.pending = true;
  entry.error = null;
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
      actions.delete(key);
      emit(runId);
      onSettled();
    },
    (caught) => {
      if (actions.get(key) !== entry) return;
      entry.pending = false;
      entry.error = errorMessage(caught);
      emit(runId);
      onSettled();
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

export function dropRunActions(runId: WorkflowRunId): void {
  const prefix = `${runId}:`;
  let changed = revisions.delete(runId);
  for (const key of actions.keys()) {
    if (!key.startsWith(prefix)) continue;
    actions.delete(key);
    changed = true;
  }
  // Run removal is the terminal lifecycle event: notify mounted readers of the reset without
  // calling `emit`, which would immediately recreate the revision entry we just released.
  if (changed) notify(runId);
}

function subscribe(runId: WorkflowRunId, listener: () => void): () => void {
  const runListeners = listeners.get(runId) ?? new Set();
  runListeners.add(listener);
  listeners.set(runId, runListeners);
  return () => {
    runListeners.delete(listener);
    if (runListeners.size === 0) listeners.delete(runId);
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
  onSettled: () => void,
): RunActionsController {
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const subscribeToRun = useCallback(
    (listener: () => void) => subscribe(runId, listener),
    [runId],
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
        () => onSettledRef.current(),
      ),
      [runId],
    ),
    isPending: useCallback(
      (action) => isRunActionPending(runId, action),
      [runId],
    ),
    error: runActionError(runId),
  };
}
