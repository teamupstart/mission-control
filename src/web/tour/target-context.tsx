import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";

import {
  tourTargetScope,
  type TourRunTargetId,
  type TourTargetId,
  type TourTargetRegistry,
  type TourTaskTargetId,
} from "./target-registry.ts";

interface TourTargetContextValue {
  registry: TourTargetRegistry;
  /** The task the active tour run created, if it has created one. */
  activeTaskId: string | null;
  /**
   * The workflow run the active tour run singled out, if it singled one out.
   *
   * The same idea as `activeTaskId` and deliberately beside it rather than in a second
   * provider: a tour narrows a per-resource target to ONE rendered owner, and the kinds of
   * resource it can narrow by are a short list held in one place.
   */
  activeRunId: string | null;
}

const TourTargetContext = createContext<TourTargetContextValue | null>(null);

export function TourTargetHost({
  registry,
  activeTaskId = null,
  activeRunId = null,
  children,
}: {
  registry: TourTargetRegistry;
  activeTaskId?: string | null;
  activeRunId?: string | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo(
    () => ({ registry, activeTaskId, activeRunId }),
    [activeRunId, activeTaskId, registry],
  );
  return <TourTargetContext.Provider value={value}>{children}</TourTargetContext.Provider>;
}

function useRegistryTargetRef<T extends HTMLElement>(
  registry: TourTargetRegistry | null,
  id: TourTargetId,
  enabled: boolean,
): (element: T | null) => void {
  const unregisterRef = useRef<(() => void) | null>(null);

  const ref = useCallback(
    (element: T | null): void => {
      unregisterRef.current?.();
      unregisterRef.current = element && registry && enabled
        ? registry.register(id, element)
        : null;
    },
    [enabled, id, registry],
  );

  useEffect(() => () => unregisterRef.current?.(), []);
  return ref;
}

/**
 * Gives an owning component a semantic ref without exposing Driver.js or a selector contract.
 *
 * Registration cleanup is identity-safe in the registry. The local unregister ref makes that
 * guarantee useful to React callback refs: a replacement mount may register before an older
 * owner's `null` callback arrives, and that stale callback may remove only its own entry.
 */
export function useTourTargetRef<T extends HTMLElement>(
  id: TourTargetId,
): (element: T | null) => void {
  const context = useContext(TourTargetContext);
  return useRegistryTargetRef<T>(context?.registry ?? null, id, true);
}

/**
 * Register only the rendered owner belonging to the workflow run this tour run selected.
 *
 * The Library tour's stage ladder is drawn by one component with two call sites - a session's
 * Workflows tab and every Board tile - so "the ladder" names several owners at once and the
 * tour has to say which run's. Scope is read from the namespace table for the same reason the
 * task hook reads it there: a cast reaching this call site is still refused at runtime.
 */
export function useTourRunTargetRef<T extends HTMLElement>(
  id: TourRunTargetId,
  runId: string | null | undefined,
): (element: T | null) => void {
  const context = useContext(TourTargetContext);
  return useRegistryTargetRef<T>(
    context?.registry ?? null,
    id,
    tourTargetScope(id) === "run" && Boolean(runId && runId === context?.activeRunId),
  );
}

/** Register an App-owned target that sits above TourTargetHost in the component tree. */
export function useOwnedTourTargetRef<T extends HTMLElement>(
  registry: TourTargetRegistry,
  id: TourTargetId,
): (element: T | null) => void {
  return useRegistryTargetRef<T>(registry, id, true);
}

/**
 * Register only the rendered owner belonging to the task this tour run created.
 *
 * The eligible ids are derived from each target's declared scope in the namespace table, so a
 * tour that adds a task-scoped target does not also have to be added to a union here. The
 * runtime scope check makes the same refusal at the one call site a cast could reach.
 */
export function useTourTaskTargetRef<T extends HTMLElement>(
  id: TourTaskTargetId,
  taskId: string | null | undefined,
): (element: T | null) => void {
  const context = useContext(TourTargetContext);
  return useRegistryTargetRef<T>(
    context?.registry ?? null,
    id,
    tourTargetScope(id) === "task" && Boolean(taskId && taskId === context?.activeTaskId),
  );
}

/** Whether this rendered owner belongs to the task created for the active tour run. */
export function useIsTourTask(taskId: string | null | undefined): boolean {
  const context = useContext(TourTargetContext);
  return Boolean(taskId && taskId === context?.activeTaskId);
}
