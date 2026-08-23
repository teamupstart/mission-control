import type { TourId } from "./contracts.ts";

/**
 * How long a registered owner lives.
 *
 * `page` targets are ordinary chrome - the Line, the Board, the Dispatch form - and the one
 * rendered owner is always the right one. `task` targets are rendered once per session or
 * task, so the tour's own demo task has to be named before one can be chosen; see
 * `useTourTaskTargetRef`.
 */
export type TourTargetScope = "page" | "task";

/**
 * Every semantic target, grouped by the tour that owns it.
 *
 * Namespacing is what lets two tours both want a target called `line` without either one
 * spotlighting the other's. The scope beside each name replaces what used to be a hardcoded
 * allow-list inside the task-scoped hook: a target is task-scoped because it says so here,
 * not because a literal union in a hook signature happened to list it.
 */
export const TOUR_TARGET_NAMESPACES = {
  "see-work": {
    "line": "page",
    "board": "page",
    "session-detail": "page",
    "dispatch": "page",
    "dispatch-modal": "page",
    "dispatch-kind": "page",
    "dispatch-input": "page",
    "dispatch-workflow": "page",
    "dispatch-submit": "page",
    "demo-task": "task",
    "review-modal": "task",
    "session-actions": "task",
    "complete-modal": "task",
  },
} as const satisfies Record<TourId, Readonly<Record<string, TourTargetScope>>>;

type Namespaces = typeof TOUR_TARGET_NAMESPACES;

/** `<tour>:<name>` for every declared target. A typo cannot type-check. */
export type TourTargetId = {
  [Tour in keyof Namespaces]: `${Tour & string}:${keyof Namespaces[Tour] & string}`;
}[keyof Namespaces];

/** Only the targets whose declared scope is `task`. Derived, never restated. */
export type TourTaskTargetId = {
  [Tour in keyof Namespaces]: {
    [Name in keyof Namespaces[Tour]]: Namespaces[Tour][Name] extends "task"
      ? `${Tour & string}:${Name & string}`
      : never;
  }[keyof Namespaces[Tour]];
}[keyof Namespaces];

export const TOUR_TARGET_IDS: readonly TourTargetId[] = Object.entries(TOUR_TARGET_NAMESPACES)
  .flatMap(([tour, names]) => Object.keys(names).map((name) => `${tour}:${name}` as TourTargetId));

const SCOPES = new Map<string, TourTargetScope>(
  Object.entries(TOUR_TARGET_NAMESPACES).flatMap(([tour, names]) =>
    Object.entries(names).map(([name, scope]) => [`${tour}:${name}`, scope as TourTargetScope]),
  ),
);

/** The declared scope of a target, or null when nothing declares it. */
export function tourTargetScope(id: string): TourTargetScope | null {
  return SCOPES.get(id) ?? null;
}

/** The tour that owns a namespaced target id. */
export function tourTargetOwner(id: string): TourId | null {
  const tour = id.slice(0, id.indexOf(":"));
  return tour in TOUR_TARGET_NAMESPACES ? (tour as TourId) : null;
}

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
