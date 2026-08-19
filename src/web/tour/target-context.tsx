import { createContext, useCallback, useContext, useEffect, useRef } from "react";

import type { TourTargetId, TourTargetRegistry } from "./target-registry.ts";

interface TourTargetContextValue {
  registry: TourTargetRegistry;
  activeTaskId: string | null;
}

const TourTargetContext = createContext<TourTargetContextValue | null>(null);

export function TourTargetHost({
  registry,
  activeTaskId = null,
  children,
}: {
  registry: TourTargetRegistry;
  activeTaskId?: string | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <TourTargetContext.Provider value={{ registry, activeTaskId }}>
      {children}
    </TourTargetContext.Provider>
  );
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

/** Register an App-owned target that sits above TourTargetHost in the component tree. */
export function useOwnedTourTargetRef<T extends HTMLElement>(
  registry: TourTargetRegistry,
  id: TourTargetId,
): (element: T | null) => void {
  return useRegistryTargetRef<T>(registry, id, true);
}

/** Register only the rendered owner belonging to the demo task for this tour run. */
export function useTourTaskTargetRef<T extends HTMLElement>(
  id: Extract<
    TourTargetId,
    "demo-task" | "review-modal" | "session-actions" | "complete-modal"
  >,
  taskId: string | null | undefined,
): (element: T | null) => void {
  const context = useContext(TourTargetContext);
  return useRegistryTargetRef<T>(
    context?.registry ?? null,
    id,
    Boolean(taskId && taskId === context?.activeTaskId),
  );
}

/** Whether this rendered owner belongs to the task created for the active tour run. */
export function useIsTourTask(taskId: string | null | undefined): boolean {
  const context = useContext(TourTargetContext);
  return Boolean(taskId && taskId === context?.activeTaskId);
}
