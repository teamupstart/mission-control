export const TOUR_TARGET_IDS = [
  "line",
  "board",
  "session-detail",
  "dispatch",
  "dispatch-modal",
  "dispatch-kind",
  "dispatch-input",
  "dispatch-workflow",
  "dispatch-submit",
  "demo-task",
  "review-modal",
  "session-actions",
  "complete-modal",
] as const;

export type TourTargetId = (typeof TOUR_TARGET_IDS)[number];

export interface TourTargetRegistry {
  get(id: TourTargetId): HTMLElement | null;
  register(id: TourTargetId, element: HTMLElement): () => void;
}

export function createTourTargetRegistry(): TourTargetRegistry {
  const targets = new Map<TourTargetId, { element: HTMLElement; token: symbol }>();

  return {
    get(id) {
      return targets.get(id)?.element ?? null;
    },
    register(id, element) {
      const token = Symbol(id);
      targets.set(id, { element, token });
      return () => {
        if (targets.get(id)?.token === token) targets.delete(id);
      };
    },
  };
}
