import type { TourTargetId, TourTargetRegistry } from "./target-registry.ts";

/**
 * Every tour Mission Control can run.
 *
 * One literal union, so a registry entry, a target namespace, a Settings row, a palette row,
 * and a server recipe are all forced to name the same tour. Adding a tour is one member here
 * plus one entry in each registry that keys off it - never a parallel list.
 */
export type TourId = "see-work" | "library";

export type TourSide = "top" | "bottom" | "left" | "right";

/** A term/definition pair rendered under a stop's copy, such as Dispatch's Kind list. */
export interface TourStopDetail {
  label: string;
  description: string;
}

/**
 * One spotlight inside a stop.
 *
 * A stop may hold up to two beats. Back and Next walk beats before they walk stops, while
 * the progress rail counts stops, so a two-beat stop reads as one step to the operator.
 */
export interface TourBeat<Runtime, Navigation> {
  target: TourTargetId;
  side?: TourSide;
  /**
   * Resolve the spotlight element yourself instead of reading `target` from the registry.
   * Returning null centers the popover, which is how a stop whose real surface is not open
   * yet still renders its fallback card.
   */
  resolve?: (context: TourStepContext<Runtime, Navigation>) => HTMLElement | null;
}

/** Where the engine should go after a definition callback runs. */
export type TourCommand =
  /** Stay on the current beat and change nothing. */
  | { kind: "hold" }
  /** Re-render the current beat without re-running its `prepare`. */
  | { kind: "refresh" }
  /** Re-run the current beat's `prepare`, then re-render it. */
  | { kind: "restage" }
  | { kind: "goto"; stopId: string; beat?: number }
  | { kind: "finish" };

export const hold = (): TourCommand => ({ kind: "hold" });
export const refresh = (): TourCommand => ({ kind: "refresh" });
export const restage = (): TourCommand => ({ kind: "restage" });
export const finish = (): TourCommand => ({ kind: "finish" });
export const goTo = (stopId: string, beat = 0): TourCommand => ({ kind: "goto", stopId, beat });

export interface TourStepContext<Runtime, Navigation> {
  runtime: Runtime;
  navigation: Navigation;
  registry: TourTargetRegistry;
  /** The stop being rendered or asked about. */
  stop: TourStep<Runtime, Navigation>;
  /** Which of the stop's beats is current. */
  beat: number;
  /**
   * The current beat's element, resolved on every read, or null for a centered card.
   *
   * Live rather than snapshotted because `prepare` runs before the surface it opens exists.
   * A beat's own `resolve` must therefore not read this, or it would recurse.
   */
  readonly element: HTMLElement | null;
}

export interface TourStep<Runtime, Navigation> {
  /**
   * Stable across renders, reorderings, and refactors. The engine's cursor is this id plus a
   * beat index, never Driver's own array index, so a React refresh in the middle of a
   * transition cannot land the operator on a different stop than the one they asked for.
   */
  id: string;
  title: string;
  description: string;
  details?: readonly TourStopDetail[];
  /** Ordered spotlights. Empty only when `centered` is true. Two at most. */
  targets: readonly TourBeat<Runtime, Navigation>[];
  /** Declare a deliberately targetless, centered stop. */
  centered?: boolean;
  side?: TourSide;
  /** Let the operator interact with the real surface under the spotlight. */
  interactive?: boolean;
  /** Refuse Next until `ready` holds, and disable its button meanwhile. */
  gateNext?: boolean;
  /**
   * Put the route, layout, and overlays into the state this stop describes. Returning false
   * ends the tour: the app refused the transition, which is the dirty-draft dialog's answer.
   */
  prepare?: (context: TourStepContext<Runtime, Navigation>) => boolean;
  /** Whether the real surface this stop points at is actually present and usable. */
  ready?: (context: TourStepContext<Runtime, Navigation>) => boolean;
  /** Replacement copy shown while the stop is not ready. */
  fallback?: (context: TourStepContext<Runtime, Navigation>) => string | null;
  /** Next's label. Undefined keeps Driver's default. */
  nextLabel?: (context: TourStepContext<Runtime, Navigation>) => string | undefined;
  /** Hide Next entirely, because a real control owns this transition. */
  hideNext?: (context: TourStepContext<Runtime, Navigation>) => boolean;
  /** Take Next over. Returning null falls through to the ordinary beat/stop advance. */
  onNext?: (context: TourStepContext<Runtime, Navigation>) => TourCommand | null;
  /** Side effect performed while leaving this stop backwards. */
  onBack?: (context: TourStepContext<Runtime, Navigation>) => void;
  /** Where to go when the runtime changes underneath this stop. Defaults to a refresh. */
  reconcile?: (context: TourStepContext<Runtime, Navigation>) => TourCommand;
  /** A registered app modal that owns the screen here, sharing focus with the popover. */
  appSurface?: (context: TourStepContext<Runtime, Navigation>) => TourTargetId | null;
  /** Whether that modal's own Escape handler should peel first. */
  modalOwnsScreen?: (context: TourStepContext<Runtime, Navigation>) => boolean;
  /** `documentElement.dataset` keys this stop turns on. */
  documentFlags?: (context: TourStepContext<Runtime, Navigation>) => readonly string[];
  /** Keys this stop neither sets nor clears, because the navigator owns them here. */
  retainDocumentFlags?: (context: TourStepContext<Runtime, Navigation>) => readonly string[];
  /** Explicit focus placement. Null falls back to Next, then Exit tour. */
  focusTarget?: (context: TourStepContext<Runtime, Navigation>) => HTMLElement | null;
}

export interface TourDefinition<Runtime, Navigation> {
  id: TourId;
  /** The kicker and progress label. Also the console prefix for a failure. */
  title: string;
  steps: readonly TourStep<Runtime, Navigation>[];
  /** Every `documentElement.dataset` key the engine may set for this tour. */
  documentFlags: readonly string[];
  /** Shown while `onFinish` runs. */
  stopping: { title: string; description: string };
  /** Fallback copy that outranks a stop's own, such as a failed demo task. */
  fallback?: (context: TourStepContext<Runtime, Navigation>) => string | null;
  /**
   * A stable serialization of the runtime fields the tour reacts to. The engine re-checks the
   * active stop whenever this changes, which keeps the reaction explicit instead of firing on
   * every parent render.
   */
  runtimeKey: (runtime: Runtime) => string;
}

export class TourDefinitionError extends Error {}

/**
 * Refuse a definition that cannot be driven, at module load rather than mid-tour.
 *
 * Beats and stops are addressed by id, so a duplicate id is a cursor that means two places at
 * once. A targetless stop is legitimate exactly once - the deliberate centered card - and a
 * silent one is a stop whose target was deleted out from under it.
 */
export function assertTourDefinition<Runtime, Navigation>(
  definition: TourDefinition<Runtime, Navigation>,
): TourDefinition<Runtime, Navigation> {
  if (definition.steps.length === 0) {
    throw new TourDefinitionError(`tour ${definition.id} has no stops`);
  }
  const seen = new Set<string>();
  for (const step of definition.steps) {
    if (seen.has(step.id)) {
      throw new TourDefinitionError(`tour ${definition.id} repeats stop id ${step.id}`);
    }
    seen.add(step.id);
    if (step.targets.length > 2) {
      throw new TourDefinitionError(
        `tour ${definition.id} stop ${step.id} declares ${step.targets.length} beats; two is the maximum`,
      );
    }
    if (step.targets.length === 0 && !step.centered) {
      throw new TourDefinitionError(
        `tour ${definition.id} stop ${step.id} has no target and is not marked centered`,
      );
    }
    const namespace = `${definition.id}:`;
    for (const beat of step.targets) {
      if (!beat.target.startsWith(namespace)) {
        throw new TourDefinitionError(
          `tour ${definition.id} stop ${step.id} points at ${beat.target}, outside its namespace`,
        );
      }
    }
  }
  return definition;
}

/** One Driver screen: a stop paired with the beat of it being spotlighted. */
export interface TourScreen<Runtime, Navigation> {
  stop: TourStep<Runtime, Navigation>;
  stopIndex: number;
  beat: number;
}

/**
 * Where the engine intends to be.
 *
 * A stable stop id plus which of that stop's beats - deliberately NOT Driver's array index.
 * Driver renumbers its screens whenever the flattened list changes, and its active index
 * lags a transition it is still committing, so an index is only ever a statement about the
 * screen list as it was. A stop id still names the same stop after a definition gains a
 * beat, loses one, or reorders, which is what makes this cursor safe to hand to Phase 2.
 *
 * Indexes are still what Driver is *told* - it has no other vocabulary - but they are
 * derived from this cursor at the moment of the call, never stored as the authority.
 */
export interface TourCursor {
  stopId: string;
  beat: number;
}

/** The cursor naming a flattened screen. */
export function cursorAt<Runtime, Navigation>(
  screens: readonly TourScreen<Runtime, Navigation>[],
  index: number,
): TourCursor {
  const screen = screens[index] ?? screens[0];
  return { stopId: screen?.stop.id ?? "", beat: screen?.beat ?? 0 };
}

/**
 * The Driver screen a cursor points at.
 *
 * A cursor naming a beat the stop no longer has falls back to that stop's first beat rather
 * than to a different stop: losing which look of a stop you were on is recoverable, and
 * silently landing on someone else's stop is not.
 */
export function screenIndexOf<Runtime, Navigation>(
  screens: readonly TourScreen<Runtime, Navigation>[],
  cursor: TourCursor,
): number {
  const exact = screens.findIndex(
    (screen) => screen.stop.id === cursor.stopId && screen.beat === cursor.beat,
  );
  if (exact >= 0) return exact;
  const stop = screens.findIndex((screen) => screen.stop.id === cursor.stopId);
  return stop >= 0 ? stop : 0;
}

/** Flatten stops into the screen list Driver drives, preserving stop ownership. */
export function flattenTour<Runtime, Navigation>(
  definition: TourDefinition<Runtime, Navigation>,
): readonly TourScreen<Runtime, Navigation>[] {
  return definition.steps.flatMap((stop, stopIndex) =>
    (stop.targets.length === 0 ? [0] : stop.targets.map((_, beat) => beat))
      .map((beat) => ({ stop, stopIndex, beat })),
  );
}
